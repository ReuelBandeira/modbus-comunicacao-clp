import type { MachineAssignment, ProcessResult } from '../../pcm/workflow/models/workflowModel';
import type { LineCoordinatorService } from '../../pcm/workflow/services/lineCoordinatorService';
import { decodeUint32 } from '../../modbus/services/registerCodec';
import { MachineModbusSession } from '../../modbus/sessions/machineModbusSession';
import type { MachineConfig } from '../models/lineModel';

interface ResultCoordinator {
    arrive(lineId: string, machineId: string, cycleId: string): Promise<MachineAssignment>;
    resultBySequence(lineId: string, machineId: string, sequence: number, result: ProcessResult, data?: Record<string, unknown>): Promise<MachineAssignment>;
    passageBySequence(lineId: string, machineId: string, sequence: number): Promise<MachineAssignment>;
}
const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) return resolve(); const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
});

/** Estações posteriores: recebe sequência + OK/NÃO da CLP e confirma com RESULT_ACK. */
export class ResultHandshakeRuntime {
    private readonly config; private readonly session: MachineModbusSession;
    private acknowledgedSequence?: number; private controller?: AbortController; private task?: Promise<void>; private lastError = '';
    constructor(private readonly lineId: string, private readonly machine: MachineConfig,
        private readonly coordinator: ResultCoordinator | LineCoordinatorService, session?: MachineModbusSession) {
        if (machine.protocol !== 'result-handshake-v1' || !machine.modbus) throw new Error('Protocolo de resultado não configurado.');
        this.config = machine.modbus; this.session = session ?? new MachineModbusSession(machine);
    }
    start(): void {
        if (this.controller) return; this.controller = new AbortController(); this.task = this.loop(this.controller.signal);
        console.info(`[MODBUS][${this.machine.machineId}] runtime de resultado ativo; CLP ${this.machine.host}:${this.machine.port}`);
    }
    async stop(): Promise<void> {
        this.controller?.abort(); await this.task; this.controller = undefined; this.task = undefined; this.session.dispose();
    }
    private async loop(signal: AbortSignal) {
        let retry = this.config.reconnectInitialMs;
        while (!signal.aborted) try {
            await this.pollOnce(); retry = this.config.reconnectInitialMs; this.lastError = ''; await wait(this.config.pollingMs, signal);
        } catch (error) {
            const message = (error as Error).message;
            if (message !== this.lastError) console.error(`[MODBUS][${this.machine.machineId}] ${message}`);
            this.lastError = message; await wait(retry, signal); retry = Math.min(this.config.reconnectMaxMs, retry * 2);
        }
    }
    async pollOnce(): Promise<void> {
        const map = this.config.map, ready = (await this.session.readCoils(map.resultReadyCoil, 1))[0];
        if (!ready) {
            if (this.acknowledgedSequence !== undefined) { await this.setAck(false); this.acknowledgedSequence = undefined; }
            return;
        }
        if (this.acknowledgedSequence !== undefined) return;
        const sequence = decodeUint32(await this.session.readHoldingRegisters(map.resultEntrySequenceRegister, 2), this.config.wordOrder);
        const resultValue = (await this.session.readHoldingRegisters(map.resultRegister, 1))[0];
        const errorCode = (await this.session.readHoldingRegisters(map.errorCodeRegister, 1))[0];
        const cycleTimeMs = decodeUint32(await this.session.readHoldingRegisters(map.cycleTimeRegister, 2), this.config.wordOrder);
        if (!(await this.session.readCoils(map.resultReadyCoil, 1))[0]) return;
        const result: ProcessResult = resultValue === this.config.resultOkValue ? 'OK' : resultValue === this.config.resultErrorValue ? 'NAO'
            : (() => { throw new Error(`RESULT inválido recebido da CLP: ${resultValue}.`); })();
        const assignment = await this.coordinator.arrive(this.lineId, this.machine.machineId, `entry-${sequence}`);
        if (assignment.entrySequence !== sequence) throw new Error(`Sequência ${sequence} não corresponde à próxima bandeja (${assignment.entrySequence}).`);
        await this.coordinator.resultBySequence(this.lineId, this.machine.machineId, sequence, result, { errorCode, cycleTimeMs, modbusResult: resultValue });
        if (this.config.completePassageOnResult) await this.coordinator.passageBySequence(this.lineId, this.machine.machineId, sequence);
        await this.setAck(true); this.acknowledgedSequence = sequence;
        console.info(`[MODBUS][${this.machine.machineId}] resultado persistido sequence=${sequence} result=${result}`);
    }
    private async setAck(value: boolean) {
        const current = (await this.session.readCoils(this.config.map.resultAckCoil, 1))[0];
        this.session.confirmReconciled(); if (current !== value) await this.session.writeCoil(this.config.map.resultAckCoil, value);
    }
}
