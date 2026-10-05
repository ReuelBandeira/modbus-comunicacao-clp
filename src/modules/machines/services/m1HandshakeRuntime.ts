import type { MachineAssignment, ProcessResult } from '../../pcm/workflow/models/workflowModel';
import type { LineCoordinatorService } from '../../pcm/workflow/services/lineCoordinatorService';
import { WorkflowError } from '../../pcm/workflow/errors/workflowError';
import type { MachineConfig } from '../models/lineModel';
import { MachineModbusSession } from '../../modbus/sessions/machineModbusSession';
import { MachineModbusMemory } from '../../modbus/server/machineModbusMemory';
import type { MachineMemoryServer } from '../../modbus/server/machineModbusServer';
import { decodeUint32 } from '../../modbus/services/registerCodec';
import { RisingEdgeDetector } from '../../modbus/services/risingEdgeDetector';

interface HandshakeCoordinator {
    activeAssignment(lineId: string, machineId: string): Promise<MachineAssignment | null>;
    arriveNext(lineId: string, machineId: string): Promise<MachineAssignment>;
    acknowledgeIdentification(lineId: string, machineId: string, entrySequence: number): Promise<MachineAssignment>;
    resultBySequence(lineId: string, machineId: string, entrySequence: number, result: ProcessResult,
        data?: Record<string, unknown>): Promise<MachineAssignment>;
    passageBySequence(lineId: string, machineId: string, entrySequence: number): Promise<MachineAssignment>;
}

export interface HandshakeRuntimeDependencies {
    session?: MachineModbusSession;
    memory?: MachineModbusMemory;
    server?: MachineMemoryServer;
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
});

/** Handshake completo de qualquer estação: entrega QR pela memória do Node e recebe resultado da CLP. */
export class M1HandshakeRuntime {
    private readonly config;
    private readonly session: MachineModbusSession;
    readonly memory: MachineModbusMemory;
    private readonly server: MachineMemoryServer;
    private readonly requestEdge: RisingEdgeDetector;
    private requestOpen = false;
    private emptyQueueLogged = false;
    private offered?: MachineAssignment;
    private resultAcknowledgedSequence?: number;
    private recoveryChecked = false;
    private controller?: AbortController;
    private task?: Promise<void>;
    private lastError = '';

    constructor(private readonly lineId: string, private readonly machine: MachineConfig,
        private readonly coordinator: HandshakeCoordinator | LineCoordinatorService, dependencies: HandshakeRuntimeDependencies = {}) {
        if (!['m1-qr-handshake-v1', 'result-handshake-v1'].includes(machine.protocol) || !machine.modbus) {
            throw new Error('Protocolo de QR e resultado não configurado.');
        }
        this.config = machine.modbus;
        this.session = dependencies.session ?? new MachineModbusSession(machine);
        this.memory = dependencies.memory ?? new MachineModbusMemory(this.config);
        if (!dependencies.server) throw new Error('O runtime legado exige um servidor Modbus injetado explicitamente.');
        this.server = dependencies.server;
        this.requestEdge = new RisingEdgeDetector(this.config.acceptInitialRequest);
    }

    async start(): Promise<void> {
        if (this.controller) return;
        await this.server.start();
        this.controller = new AbortController();
        this.task = this.loop(this.controller.signal);
        console.info(`[MODBUS][${this.machine.machineId}] runtime legado ativo; CLP ${this.machine.host}:${this.machine.port}`);
    }
    async stop(): Promise<void> {
        this.controller?.abort();
        await this.task;
        this.controller = undefined; this.task = undefined;
        this.session.dispose();
        await this.server.stop();
    }
    private async loop(signal: AbortSignal) {
        let retry = this.config.reconnectInitialMs;
        while (!signal.aborted) {
            try {
                await this.pollOnce();
                retry = this.config.reconnectInitialMs;
                this.lastError = '';
                await wait(this.config.pollingMs, signal);
            } catch (error) {
                const message = (error as Error).message;
                if (message !== this.lastError) console.error(`[MODBUS][${this.machine.machineId}] ${message}`);
                this.lastError = message;
                await wait(retry, signal);
                retry = Math.min(this.config.reconnectMaxMs, retry * 2);
            }
        }
    }

    async pollOnce(): Promise<void> {
        const map = this.config.map;
        const request = (await this.session.readCoils(map.requestQrCoil, 1))[0];
        const resultReady = (await this.session.readCoils(map.resultReadyCoil, 1))[0];
        if (this.requestEdge.update(request)) {
            this.requestOpen = true;
            console.info(`[MODBUS][${this.machine.machineId}] REQUEST_QR false -> true`);
        }
        if (!this.recoveryChecked) {
            this.recoveryChecked = true;
            const active = await this.coordinator.activeAssignment(this.lineId, this.machine.machineId);
            if (request && active && !active.identificationAcknowledgedAt) {
                this.offered = active; this.requestOpen = true;
                console.info(`[MODBUS][${this.machine.machineId}] retomando entrega pendente sequence=${active.entrySequence}`);
            }
        }
        await this.handleResult(resultReady);
        await this.handleQr(request);
    }

    private async handleQr(request: boolean) {
        if (!request && !this.memory.acknowledged) {
            this.requestOpen = false;
            this.emptyQueueLogged = false;
            if (!this.memory.ready) { this.memory.reset(); this.offered = undefined; }
        }
        if (this.memory.acknowledged && this.offered && !this.offered.identificationAcknowledgedAt) {
            const acknowledged = await this.coordinator.acknowledgeIdentification(
                this.lineId, this.machine.machineId, this.offered.entrySequence);
            this.offered = acknowledged;
            if (this.memory.ready) {
                this.memory.setReady(false);
                console.info(`[MODBUS][${this.machine.machineId}] QR_ACK confirmou leitura sequence=${acknowledged.entrySequence}`);
            }
        }
        if (!request || !this.requestOpen || this.memory.ready || this.memory.acknowledged) return;
        const active = await this.coordinator.activeAssignment(this.lineId, this.machine.machineId);
        if (active?.identificationAcknowledgedAt) {
            this.requestOpen = false;
            console.warn(`[MODBUS][${this.machine.machineId}] novo pedido ignorado: sequence=${active.entrySequence} ainda está em processamento`);
            return;
        }
        try {
            this.offered = active ?? await this.coordinator.arriveNext(this.lineId, this.machine.machineId);
            this.memory.prepare(this.offered.entrySequence, this.offered.serialNumber);
            this.emptyQueueLogged = false;
            console.info(`[MODBUS][${this.machine.machineId}] REQUEST_QR=true; QR disponibilizado para a CLP: ${this.offered.serialNumber} (sequence=${this.offered.entrySequence})`);
            console.info(`[MODBUS][${this.machine.machineId}] QR_READY sequence=${this.offered.entrySequence}`);
        } catch (error) {
            if (error instanceof WorkflowError && error.status === 409) {
                if (!this.emptyQueueLogged) console.info(`[MODBUS][${this.machine.machineId}] REQUEST_QR=true; nenhum QR aguardando na fila.`);
                this.emptyQueueLogged = true;
                return; // mantém o pedido aberto até chegar uma unidade.
            }
            throw error;
        }
    }

    private async handleResult(resultReady: boolean) {
        const map = this.config.map;
        if (!resultReady) {
            if (this.resultAcknowledgedSequence !== undefined) {
                await this.setResultAck(false);
                console.info(`[MODBUS][${this.machine.machineId}] RESULT_ACK reset sequence=${this.resultAcknowledgedSequence}`);
                this.resultAcknowledgedSequence = undefined;
            }
            return;
        }
        if (this.resultAcknowledgedSequence !== undefined) return;
        const entrySequence = decodeUint32(
            await this.session.readHoldingRegisters(map.resultEntrySequenceRegister, 2), this.config.wordOrder);
        const resultValue = (await this.session.readHoldingRegisters(map.resultRegister, 1))[0];
        const errorCode = (await this.session.readHoldingRegisters(map.errorCodeRegister, 1))[0];
        const cycleTime = decodeUint32(await this.session.readHoldingRegisters(map.cycleTimeRegister, 2), this.config.wordOrder);
        const stillReady = (await this.session.readCoils(map.resultReadyCoil, 1))[0];
        if (!stillReady) return;
        const result: ProcessResult = resultValue === this.config.resultOkValue ? 'OK'
            : resultValue === this.config.resultErrorValue ? 'NAO'
                : (() => { throw new Error(`RESULT inválido recebido da CLP: ${resultValue}.`); })();
        await this.coordinator.resultBySequence(this.lineId, this.machine.machineId, entrySequence, result,
            { errorCode, cycleTimeMs: cycleTime, modbusResult: resultValue });
        if (this.config.completePassageOnResult) {
            await this.coordinator.passageBySequence(this.lineId, this.machine.machineId, entrySequence);
        }
        await this.setResultAck(true);
        this.resultAcknowledgedSequence = entrySequence;
        this.memory.reset();
        this.offered = undefined;
        this.requestOpen = false;
        console.info(`[MODBUS][${this.machine.machineId}] resultado persistido sequence=${entrySequence} result=${result} errorCode=${errorCode}`);
    }

    private async setResultAck(value: boolean) {
        const current = (await this.session.readCoils(this.config.map.resultAckCoil, 1))[0];
        this.session.confirmReconciled();
        if (current !== value) await this.session.writeCoil(this.config.map.resultAckCoil, value);
    }
}
