import type { MachineAssignment, ProcessResult } from '../../pcm/workflow/models/workflowModel';
import type { LineCoordinatorService } from '../../pcm/workflow/services/lineCoordinatorService';
import { decodeBooleanRegisters, decodeTextRegisters, decodeUint32, encodeTextRegisters } from '../../modbus/services/registerCodec';
import { MachineCommunicationError, MachineModbusSession } from '../../modbus/sessions/machineModbusSession';
import { RisingEdgeDetector } from '../../modbus/services/risingEdgeDetector';
import type { MachineConfig } from '../models/lineModel';
import { communicationLog } from '../../modbus/services/communicationLog';
import { WorkflowError } from '../../pcm/workflow/errors/workflowError';
import { enforcedPlcPulseMs } from '../../modbus/services/pulseTiming';

interface MailboxCoordinator {
    activeAssignment(lineId: string, machineId: string): Promise<MachineAssignment | null>;
    activeAssignments(lineId: string, machineId: string): Promise<MachineAssignment[]>;
    assignmentBySerial(lineId: string, machineId: string, serialNumber: string): Promise<MachineAssignment | null>;
    clearCommunicationFault(lineId: string, machineId: string, entrySequence: number): Promise<MachineAssignment>;
    arriveNext(lineId: string, machineId: string): Promise<MachineAssignment>;
    acknowledgeIdentification(lineId: string, machineId: string, entrySequence: number): Promise<MachineAssignment>;
    mailboxAssignment(lineId: string, machineId: string, entrySequence?: number): Promise<MachineAssignment>;
    resultBySequence(lineId: string, machineId: string, entrySequence: number,
        result: ProcessResult, data?: Record<string, unknown>): Promise<MachineAssignment>;
    passageBySequence(lineId: string, machineId: string, entrySequence: number): Promise<MachineAssignment>;
    recordCommunicationFault(lineId: string, machineId: string, entrySequence: number,
        data: Record<string, unknown>): Promise<MachineAssignment>;
}

interface MailboxSession {
    readHoldingRegisters(address: number, count: number): Promise<number[]>;
    readCoils(address: number, count?: number): Promise<boolean[]>;
    writeCoil(address: number, value: boolean): Promise<void>;
    writeRegisters(address: number, values: number[]): Promise<void>;
    confirmReconciled(): void;
    dispose(): void;
}

const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
});
const empty = (values: number[]) => values.every(value => value === 0);
const same = (left: number[], right: number[]) => left.length === right.length && left.every((value, index) => value === right[index]);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Protocolo de uma unica area de holding registers na CLP.
 * M1: Node escreve o QR; a CLP confirma a saida pela Coil 1 e zera a propria area.
 * IFTS: Node entrega o QR na entrada e valida novamente o QR publicado na saida.
 * Estações convencionais posteriores: CLP escreve e o Node confirma persistencia zerando toda a area.
 */
export class ZeroMailboxRuntime {
    private readonly config;
    private readonly session: MailboxSession;
    private readonly startAddress: number;
    private readonly registerCount: number;
    private readonly outputStartAddress: number;
    private readonly positionCountAddress: number;
    private readonly positionStartAddress: number;
    private readonly positionRegisterCount: number;
    private readonly requestEdge: RisingEdgeDetector;
    private readonly exitEdge = new RisingEdgeDetector(false);
    private controller?: AbortController;
    private task?: Promise<void>;
    private lastError = '';
    private outbound?: { assignment: MachineAssignment; payload: number[]; writeAttempted: boolean; written: boolean;
        exitArmed: boolean; exitObserved: boolean; resultPersisted: boolean; phaseStartedAt: number; timeoutReported: boolean };
    private requestOpen = false;
    private waitRequestRelease = false;
    private waitExitRelease = false;
    private candidate?: { key: string; reads: number };
    private clearingKey?: string;
    private emptyReconciled = false;
    private pendingAck?: { assignment: MachineAssignment; startedAt: number; timeoutReported: boolean };
    private correlationKey?: string;
    private parallelOutputCandidate?: { key: string; reads: number };
    private parallelOutputAcknowledged = '';
    private outputAckBlockedKey = '';
    private parallelOutputIdleReconciled = false;
    private readonly observedCoils = new Map<number, boolean>();

    constructor(private readonly lineId: string, private readonly machine: MachineConfig,
        private readonly stationIndex: number,
        private readonly coordinator: MailboxCoordinator | LineCoordinatorService,
        session?: MailboxSession, acceptInitialRequestOverride = false) {
        if (!machine.modbus || !['m1-qr-handshake-v1', 'ifts-qr-handshake-v1', 'result-handshake-v1'].includes(machine.protocol)) {
            throw new Error('Protocolo mailbox-zero nao configurado.');
        }
        this.config = machine.modbus;
        this.session = session ?? new MachineModbusSession(machine);
        const map = this.config.map;
        this.startAddress = map.qrEntrySequenceRegister;
        this.outputStartAddress = map.outputSerialStartRegister ?? this.startAddress + map.serialRegisterCount;
        this.positionCountAddress = map.positionCountRegister ?? map.serialStartRegister + map.serialRegisterCount;
        this.positionStartAddress = map.positionStartRegister ?? this.positionCountAddress + 1;
        this.positionRegisterCount = map.positionRegisterCount ?? 4;
        this.registerCount = stationIndex === 0 || machine.protocol === 'ifts-qr-handshake-v1' ? map.serialRegisterCount
            : this.positionStartAddress + this.positionRegisterCount - this.startAddress;
        if (this.registerCount < 1 || this.registerCount > 123) throw new Error('Mailbox deve possuir de 1 a 123 registers continuos.');
        this.requestEdge = new RisingEdgeDetector(this.config.acceptInitialRequest || acceptInitialRequestOverride);
    }

    start(): void {
        if (this.controller) return;
        this.controller = new AbortController(); this.task = this.loop(this.controller.signal);
        communicationLog.add(this.machine.machineId, 'SYSTEM', 'RUNTIME_STARTED',
            `Monitoramento iniciado em ${this.machine.host}:${this.machine.port}.`, {
                host: this.machine.host, port: this.machine.port, unitId: this.machine.unitId,
                mailbox: { startAddress: this.startAddress, registerCount: this.registerCount }
            });
        console.info(`[MODBUS][${this.machine.machineId}] mailbox-zero ativo na CLP ${this.machine.host}:${this.machine.port}, HR ${this.startAddress}..${this.startAddress + this.registerCount - 1}`);
    }

    async stop(): Promise<void> {
        this.controller?.abort(); await this.task;
        this.controller = undefined; this.task = undefined; this.session.dispose();
    }

    private async loop(signal: AbortSignal) {
        let retry = this.config.reconnectInitialMs;
        while (!signal.aborted) {
            try {
                await this.pollOnce(); retry = this.config.reconnectInitialMs;
                communicationLog.markSuccess(this.machine.machineId); this.lastError = '';
                await wait(this.config.pollingMs, signal);
            } catch (error) {
                const message = (error as Error).message;
                if (message !== this.lastError) {
                    communicationLog.add(this.machine.machineId, 'SYSTEM', 'COMMUNICATION_ERROR', message, undefined, 'error');
                    console.error(`[MODBUS][${this.machine.machineId}] ${message}`);
                }
                if (error instanceof MachineCommunicationError) communicationLog.markFailure(this.machine.machineId, message);
                this.lastError = message; await wait(retry, signal); retry = Math.min(this.config.reconnectMaxMs, retry * 2);
            }
        }
    }

    async pollOnce(): Promise<void> {
        if (this.machine.protocol === 'ifts-qr-handshake-v1'
            || this.stationIndex === 0 && this.config.inFlightCapacity > 1) await this.pollParallelOutbound();
        else if (this.stationIndex === 0) await this.pollOutbound();
        else await this.pollInbound();
    }

    private observeCoil(address: number, value: boolean, role: string, activeMeaning: string): void {
        const previous = this.observedCoils.get(address);
        if (previous === undefined) {
            communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'PLC_COIL_OBSERVED',
                `M${address} (${role}) observado em ${String(value).toUpperCase()}.`, {
                    modbusFunction: 'FC01', coil: address, role, value, activeMeaning
                });
        } else if (previous !== value) {
            communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'PLC_COIL_CHANGED',
                `M${address} (${role}) mudou de ${String(previous).toUpperCase()} para ${String(value).toUpperCase()}. ${value ? activeMeaning : 'Sinal desativado pela CLP.'}`, {
                    modbusFunction: 'FC01', coil: address, role, previousValue: previous, value, activeMeaning
                });
        }
        this.observedCoils.set(address, value);
    }

    private async writeMailbox(address: number, payload: number[], event: string,
        assignment: MachineAssignment, message: string): Promise<void> {
        await this.session.writeRegisters(address, payload);
        this.session.confirmReconciled();
        communicationLog.add(this.machine.machineId, 'NODE_TO_PLC', event, message, {
            sequence: assignment.entrySequence, serial: assignment.serialNumber,
            modbusWriteFunction: 'FC16', address, count: payload.length, registers: payload,
            writeConfirmed: true, captureConfirmationSource: 'request-coil-falling-edge'
        });
    }

    /** Célula paralela: M0 pede QR, M1 publica o QR de saída e o Node confirma com pulso em M2. */
    private async pollParallelOutbound() {
        const request = (await this.session.readCoils(this.config.map.requestQrCoil, 1))[0];
        const outputReady = (await this.session.readCoils(this.config.map.resultReadyCoil, 1))[0];
        this.observeCoil(this.config.map.requestQrCoil, request, 'REQ_INFO_BANDEJA',
            'CLP solicitou os dados da próxima bandeja.');
        this.observeCoil(this.config.map.resultReadyCoil, outputReady, 'QR_SAIDA_PRONTO',
            'CLP informou que o QR de saída está pronto para leitura.');
        const risingRequest = this.requestEdge.update(request);
        const inputRegisters = await this.session.readHoldingRegisters(this.startAddress, this.registerCount);
        if (!request) { this.waitRequestRelease = false; this.requestOpen = false; }
        else if (!this.waitRequestRelease && risingRequest) {
            this.requestOpen = true;
            communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'REQUEST_QR',
                `CLP solicitou a próxima bandeja para ${this.machine.name}.`, {
                    coil: this.config.map.requestQrCoil, value: true,
                    capacity: this.machine.protocol === 'ifts-qr-handshake-v1' ? 1 : this.config.inFlightCapacity
                });
        }
        await this.handleParallelOutput(outputReady);

        if (!this.outbound) {
            const pending = (await this.coordinator.activeAssignments(this.lineId, this.machine.machineId))
                .find(item => !item.identificationAcknowledgedAt);
            if (pending) {
                const payload = this.payload(pending);
                if (!request) {
                    await this.coordinator.acknowledgeIdentification(this.lineId, this.machine.machineId, pending.entrySequence);
                    communicationLog.add(this.machine.machineId, 'SYSTEM', 'QR_CAPTURE_RECOVERED',
                        `Captura do QR da sequência ${pending.entrySequence} recuperada com M${this.config.map.requestQrCoil} inativo.`, {
                            sequence: pending.entrySequence, serial: pending.serialNumber,
                            coil: this.config.map.requestQrCoil, value: false,
                            confirmationSource: 'request-coil-inactive-after-restart',
                            inputMailboxCleanupOwner: 'plc'
                        });
                } else if (same(inputRegisters, payload)) {
                    this.outbound = { assignment: pending, payload, writeAttempted: true, written: true,
                        exitArmed: false, exitObserved: false, resultPersisted: false,
                        phaseStartedAt: pending.startedAt?.getTime() ?? Date.now(), timeoutReported: false };
                } else if (request && this.requestOpen && !this.waitRequestRelease) {
                    this.outbound = { assignment: pending, payload, writeAttempted: true, written: false,
                        exitArmed: false, exitObserved: false, resultPersisted: false,
                        phaseStartedAt: Date.now(), timeoutReported: false };
                    await this.writeMailbox(this.startAddress, payload, 'MAILBOX_REWRITTEN', pending,
                        `Node restaurou o QR da sequência ${pending.entrySequence} após reinício do handshake.`);
                    this.outbound.written = true;
                }
            }
        }
        if (this.outbound) {
            const item = this.outbound;
            if (!request && item.written) {
                item.assignment = await this.coordinator.acknowledgeIdentification(this.lineId,
                    this.machine.machineId, item.assignment.entrySequence);
                communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'QR_CAPTURED',
                    `CLP baixou M${this.config.map.requestQrCoil} e confirmou a captura do QR da sequência ${item.assignment.entrySequence}.`, {
                        sequence: item.assignment.entrySequence, serial: item.assignment.serialNumber,
                        coil: this.config.map.requestQrCoil, value: false,
                        confirmationSource: 'request-coil-falling-edge',
                        inputMailboxCleanupOwner: 'plc'
                    });
                this.session.confirmReconciled(); this.outbound = undefined; this.waitRequestRelease = false; return;
            }
            if (same(inputRegisters, item.payload)) {
                this.session.confirmReconciled(); item.written = true;
                await this.reportTimeout(item, 'aguardando-captura-do-qr'); return;
            }
            if (item.written) await this.reportTimeout(item, 'aguardando-captura-do-qr');
            return;
        }
        if (!this.requestOpen || this.waitRequestRelease || !request) return;
        try {
            const assignment = await this.coordinator.arriveNext(this.lineId, this.machine.machineId);
            const item: NonNullable<ZeroMailboxRuntime['outbound']> = {
                assignment, payload: this.payload(assignment), writeAttempted: true, written: false,
                exitArmed: false, exitObserved: false, resultPersisted: false,
                phaseStartedAt: Date.now(), timeoutReported: false
            };
            this.outbound = item;
            await this.writeMailbox(this.startAddress, item.payload, 'MAILBOX_WRITTEN', assignment,
                `Node gravou o QR da sequência ${assignment.entrySequence} para ${this.machine.name}; aguardando M${this.config.map.requestQrCoil} retornar para FALSE.`);
            item.written = true;
        } catch (error) {
            if (error instanceof WorkflowError && error.status === 409) return;
            throw error;
        }
    }

    private async handleParallelOutput(outputReady: boolean) {
        if (!outputReady) {
            if (!this.parallelOutputIdleReconciled) {
                const faulted = (await this.coordinator.activeAssignments(this.lineId, this.machine.machineId))
                    .filter(item => item.communicationState === 'correlation_error');
                for (const item of faulted) {
                    await this.coordinator.clearCommunicationFault(this.lineId, this.machine.machineId, item.entrySequence);
                }
                this.parallelOutputIdleReconciled = true;
            }
            this.parallelOutputCandidate = undefined; this.parallelOutputAcknowledged = '';
            this.outputAckBlockedKey = '';
            this.correlationKey = undefined; return;
        }
        this.parallelOutputIdleReconciled = false;
        const registers = await this.session.readHoldingRegisters(this.outputStartAddress, this.config.map.serialRegisterCount);
        if (empty(registers)) return;
        const key = registers.join(',');
        if (this.parallelOutputAcknowledged === key) return;
        if (this.parallelOutputCandidate?.key !== key) {
            this.parallelOutputCandidate = { key, reads: 1 };
            communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'PLC_MAILBOX_OBSERVED',
                `CLP gravou dados em D${this.outputStartAddress}-D${this.outputStartAddress + registers.length - 1}; aguardando segunda leitura igual.`, {
                    modbusFunction: 'FC03', address: this.outputStartAddress,
                    count: registers.length, registers, confirmationReadsRequired: 2
                });
            return;
        }
        if (++this.parallelOutputCandidate.reads < 2) return;
        const serial = decodeTextRegisters(registers, this.config.byteOrder);
        if (!serial) {
            if (this.correlationKey !== key) {
                communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'OUTPUT_QR_PENDING',
                    `M${this.config.map.resultReadyCoil} está ativo, mas o QR em D${this.outputStartAddress}-D${this.outputStartAddress + registers.length - 1} ainda está vazio; aguardando a CLP concluir a gravação.`, {
                        coil: this.config.map.resultReadyCoil, address: this.outputStartAddress,
                        count: registers.length, registers
                    });
                this.correlationKey = key;
            }
            return;
        }
        const assignment = await this.coordinator.assignmentBySerial(this.lineId, this.machine.machineId, serial);
        const active = (await this.coordinator.activeAssignments(this.lineId, this.machine.machineId))
            .filter(item => item.identificationAcknowledgedAt).sort((left, right) => left.entrySequence - right.entrySequence);
        const validState = assignment && ['processing', 'result_recorded', 'completed'].includes(assignment.state);
        if (!assignment?.identificationAcknowledgedAt || !validState) {
            if (this.correlationKey !== key) {
                const expected = active[0];
                if (expected) await this.coordinator.recordCommunicationFault(this.lineId, this.machine.machineId,
                    expected.entrySequence, {
                        protocol: 'modbus-tcp', handshake: 'parallel-cell-output-qr', communicationState: 'correlation_error',
                        protocolError: 'output-qr-unknown', expectedSerial: expected.serialNumber, reportedSerial: serial
                    });
                communicationLog.add(this.machine.machineId, 'SYSTEM', 'OUTPUT_QR_UNKNOWN',
                    `M1 informou saída para um QR que não está confirmado na célula: ${serial || '(vazio)'}.`, {
                        serial, expectedSerial: expected?.serialNumber,
                        coil: this.config.map.resultReadyCoil, address: this.outputStartAddress
                    }, 'error');
                this.correlationKey = key;
            }
            return;
        }
        if (active.length && active[0]!.entrySequence !== assignment.entrySequence) {
            if (this.correlationKey !== key) {
                await this.coordinator.recordCommunicationFault(this.lineId, this.machine.machineId, active[0]!.entrySequence, {
                    protocol: 'modbus-tcp', handshake: 'parallel-cell-output-qr', communicationState: 'correlation_error',
                    protocolError: 'output-out-of-order', expectedSerial: active[0]!.serialNumber, reportedSerial: serial
                });
                communicationLog.add(this.machine.machineId, 'SYSTEM', 'OUTPUT_OUT_OF_ORDER',
                    `Saída fora de ordem. Esperado ${active[0]!.serialNumber}; recebido ${serial}.`, {
                        expectedSerial: active[0]!.serialNumber, reportedSerial: serial
                    }, 'error');
                this.correlationKey = key;
            }
            return;
        }
        if (this.machine.protocol === 'ifts-qr-handshake-v1' && assignment.state === 'processing') {
            if (this.correlationKey !== key) {
                communicationLog.add(this.machine.machineId, 'SYSTEM', 'OUTPUT_BEFORE_IFTS_RESULT',
                    `A CLP informou a saída do QR ${serial}, mas o resultado do IFTS ainda não foi recebido.`, {
                        sequence: assignment.entrySequence, serial, coil: this.config.map.resultReadyCoil
                    }, 'error');
                this.correlationKey = key;
            }
            return;
        }
        this.correlationKey = undefined;
        const outputAckMode = this.config.outputAckMode ?? 'pulse';
        if (outputAckMode === 'plc-reset') {
            const ackActive = (await this.session.readCoils(this.config.map.resultAckCoil, 1))[0];
            if (ackActive) {
                if (this.outputAckBlockedKey !== key) {
                    communicationLog.add(this.machine.machineId, 'SYSTEM', 'OUTPUT_ACK_WAITING_PLC_RESET',
                        `M${this.config.map.resultAckCoil} ainda esta ativo; aguardando a CLP limpar o ACK antes da proxima saida.`, {
                            serial, coil: this.config.map.resultAckCoil, value: true, outputAckMode
                        }, 'error');
                    this.outputAckBlockedKey = key;
                }
                return;
            }
            this.outputAckBlockedKey = '';
        }
        if (this.machine.protocol !== 'ifts-qr-handshake-v1' && assignment.state === 'processing') await this.coordinator.resultBySequence(this.lineId,
            this.machine.machineId, assignment.entrySequence, 'OK', {
                protocol: 'modbus-tcp', handshake: 'parallel-cell-output-qr',
                confirmationSource: 'output-ready-coil', reportedSerial: serial,
                outputReadyCoil: this.config.map.resultReadyCoil
            });
        if (!['completed', 'skipped'].includes(assignment.state)) {
            await this.coordinator.passageBySequence(this.lineId, this.machine.machineId, assignment.entrySequence);
        }
        this.session.confirmReconciled();
        if (outputAckMode === 'pulse') {
            let ackRaised = false;
            try {
                await this.session.writeCoil(this.config.map.resultAckCoil, true);
                ackRaised = true;
                const pulseMs = enforcedPlcPulseMs(this.config.outputAckPulseMs);
                await pause(pulseMs);
            } finally {
                if (ackRaised) await this.session.writeCoil(this.config.map.resultAckCoil, false);
            }
        } else {
            await this.session.writeCoil(this.config.map.resultAckCoil, true);
        }
        this.parallelOutputAcknowledged = key;
        communicationLog.add(this.machine.machineId, 'NODE_TO_PLC',
            outputAckMode === 'pulse' ? 'OUTPUT_ACK_PULSE' : 'OUTPUT_ACK_SET',
            outputAckMode === 'pulse'
                ? `Saída do QR ${serial} persistida; pulso M${this.config.map.resultAckCoil} enviado à CLP.`
                : `Saída do QR ${serial} persistida; M${this.config.map.resultAckCoil} ativado para a CLP limpar.`, {
                sequence: assignment.entrySequence, serial, coil: this.config.map.resultAckCoil,
                outputAckMode,
                ...(outputAckMode === 'pulse' ? { pulseMs: enforcedPlcPulseMs(this.config.outputAckPulseMs) } : {})
            });
    }

    private payload(assignment: MachineAssignment): number[] {
        return encodeTextRegisters(assignment.serialNumber,
            this.config.map.serialRegisterCount, this.config.byteOrder);
    }

    private finishOutbound(item: NonNullable<ZeroMailboxRuntime['outbound']>) {
        communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'EXIT_CONFIRMED',
            `Saída confirmada pela Coil ${this.config.map.resultReadyCoil}; CLP zerou o mailbox da sequência ${item.assignment.entrySequence}.`, {
                sequence: item.assignment.entrySequence, serial: item.assignment.serialNumber,
                coil: this.config.map.resultReadyCoil, address: this.startAddress,
                registers: Array<number>(this.registerCount).fill(0)
            });
        console.info(`[MODBUS][${this.machine.machineId}] passagem confirmada sequence=${item.assignment.entrySequence}`);
        this.outbound = undefined; this.waitRequestRelease = true; this.waitExitRelease = true; this.requestOpen = false;
    }

    private async confirmExit(item: NonNullable<ZeroMailboxRuntime['outbound']>, registers: number[]) {
        if (!item.resultPersisted) {
            await this.coordinator.resultBySequence(this.lineId, this.machine.machineId,
                item.assignment.entrySequence, 'OK', {
                    protocol: 'modbus-tcp', handshake: 'serial-only-exit-coil-plc-clear',
                    confirmationSource: 'exit-coil-rising-edge', exitCoil: this.config.map.resultReadyCoil
                });
            item.resultPersisted = true;
            communicationLog.add(this.machine.machineId, 'SYSTEM', 'RESULT_PERSISTED',
                'Saída física registrada; aguardando a CLP zerar o QR antes de liberar a próxima estação.', {
                    sequence: item.assignment.entrySequence, serial: item.assignment.serialNumber
                });
        }
        if (empty(registers)) {
            await this.coordinator.passageBySequence(this.lineId, this.machine.machineId,
                item.assignment.entrySequence);
            this.session.confirmReconciled(); this.finishOutbound(item); return;
        }
        if (!same(registers, item.payload)) throw new Error('Mailbox da CLP foi alterado parcialmente antes da confirmação de saída.');
        // A limpeza pertence ao programa da CLP. O PCM apenas aguarda HR0-HR31 zerarem.
        this.session.confirmReconciled();
    }

    private async reportTimeout(item: NonNullable<ZeroMailboxRuntime['outbound']>, phase: string) {
        if (item.timeoutReported || Date.now() - item.phaseStartedAt < (this.config.phaseTimeoutMs ?? 120000)) return;
        await this.coordinator.recordCommunicationFault(this.lineId, this.machine.machineId,
            item.assignment.entrySequence, {
                protocol: 'modbus-tcp', communicationState: 'timeout', phase,
                timeoutMs: this.config.phaseTimeoutMs ?? 120000, serial: item.assignment.serialNumber
            });
        item.timeoutReported = true;
        communicationLog.add(this.machine.machineId, 'SYSTEM', 'PHASE_TIMEOUT',
            `Tempo excedido na fase ${phase}; a linha permanece bloqueada sem perder a bandeja.`, {
                sequence: item.assignment.entrySequence, phase, timeoutMs: this.config.phaseTimeoutMs ?? 120000
            }, 'error');
    }

    private async pollOutbound() {
        const request = (await this.session.readCoils(this.config.map.requestQrCoil, 1))[0];
        const exit = (await this.session.readCoils(this.config.map.resultReadyCoil, 1))[0];
        this.observeCoil(this.config.map.requestQrCoil, request, 'REQ_INFO_BANDEJA',
            'CLP solicitou os dados da próxima bandeja.');
        this.observeCoil(this.config.map.resultReadyCoil, exit, 'CONFIRMAR_SAIDA',
            'CLP informou a saída física da bandeja.');
        const risingRequest = this.requestEdge.update(request);
        const risingExit = this.exitEdge.update(exit);
        if (!request) { this.waitRequestRelease = false; this.requestOpen = false; }
        else if (!this.waitRequestRelease && risingRequest) {
            this.requestOpen = true;
            communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'REQUEST_QR',
                'CLP solicitou a próxima bandeja.', { coil: this.config.map.requestQrCoil, value: true });
        }
        if (!exit) this.waitExitRelease = false;

        const registers = await this.session.readHoldingRegisters(this.startAddress, this.registerCount);
        if (!this.outbound) {
            const active = await this.coordinator.activeAssignment(this.lineId, this.machine.machineId);
            if (active) {
                const payload = this.payload(active);
                const recoveredExit = active.state === 'processing'
                    && Boolean(active.identificationAcknowledgedAt) && empty(registers) && exit;
                if (same(registers, payload) || active.state === 'result_recorded' && empty(registers) || recoveredExit) {
                    this.session.confirmReconciled();
                    this.outbound = { assignment: active, payload, writeAttempted: true, written: true,
                        exitArmed: recoveredExit || !exit,
                        exitObserved: active.state === 'result_recorded' || recoveredExit,
                        resultPersisted: active.state === 'result_recorded',
                        phaseStartedAt: active.startedAt?.getTime() ?? Date.now(), timeoutReported: false };
                    if (recoveredExit) communicationLog.add(this.machine.machineId, 'SYSTEM', 'EXIT_RECOVERED',
                        'Saída recuperada após reinício: QR havia sido confirmado, memória está vazia e Coil de saída permanece ativa.', {
                            sequence: active.entrySequence, serial: active.serialNumber
                        });
                } else if (empty(registers) && request) this.requestOpen = true;
            }
        }
        if (this.outbound) {
            const item = this.outbound;
            if (item.written && !exit) item.exitArmed = true;
            if (risingExit && item.exitArmed && !this.waitExitRelease) {
                item.exitObserved = true;
                item.phaseStartedAt = Date.now(); item.timeoutReported = false;
                communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'EXIT_COIL',
                    'CLP confirmou a saída física da bandeja.', {
                        sequence: item.assignment.entrySequence, coil: this.config.map.resultReadyCoil, value: true
                    });
            }
            if (item.exitObserved) {
                await this.confirmExit(item, registers);
                if (this.outbound) await this.reportTimeout(item, 'aguardando-limpeza-do-qr');
                return;
            }
            if (same(registers, item.payload)) {
                this.session.confirmReconciled(); item.written = true;
                if (!item.assignment.identificationAcknowledgedAt) {
                    item.assignment = await this.coordinator.acknowledgeIdentification(this.lineId,
                        this.machine.machineId, item.assignment.entrySequence);
                }
                await this.reportTimeout(item, item.exitArmed ? 'aguardando-coil-de-saida' : 'armando-coil-de-saida');
                return;
            }
            if (empty(registers) && item.writeAttempted) {
                if (!item.written && request) {
                    throw new Error('Escrita do QR sem confirmacao; a CLP ainda mantem REQUEST_QR ativo.');
                }
                this.session.confirmReconciled();
                return;
            }
            if (!empty(registers)) throw new Error('Mailbox da CLP foi alterado parcialmente durante a entrega do QR.');
            if (item.written) return;
        }
        if (!this.requestOpen || this.waitRequestRelease || this.waitExitRelease) return;
        if (!empty(registers)) throw new Error('REQUEST_QR ativo, mas o mailbox da CLP nao esta zerado.');
        const assignment = await this.coordinator.arriveNext(this.lineId, this.machine.machineId);
        const item: NonNullable<ZeroMailboxRuntime['outbound']> = {
            assignment, payload: this.payload(assignment), writeAttempted: true, written: false,
            exitArmed: false, exitObserved: false, resultPersisted: false,
            phaseStartedAt: Date.now(), timeoutReported: false
        };
        this.outbound = item;
        await this.writeMailbox(this.startAddress, item.payload, 'MAILBOX_WRITTEN', assignment,
            `Node gravou o QR da sequência ${assignment.entrySequence} na CLP; aguardando M${this.config.map.requestQrCoil} retornar para FALSE.`);
        item.written = true;
        console.info(`[MODBUS][${this.machine.machineId}] QR gravado sequence=${assignment.entrySequence}`);
    }

    private parse(registers: number[]) {
        const map = this.config.map;
        const at = (address: number) => address - this.startAddress;
        const sequence = decodeUint32(registers.slice(at(map.qrEntrySequenceRegister), at(map.qrEntrySequenceRegister) + 2), this.config.wordOrder);
        const byteLength = registers[at(map.serialLengthRegister)];
        if (byteLength < 1 || byteLength > map.serialRegisterCount * 2) throw new Error(`SERIAL_LENGTH invalido no mailbox: ${byteLength}.`);
        const serialRegisters = registers.slice(at(map.serialStartRegister), at(map.serialStartRegister) + map.serialRegisterCount);
        const decoded = decodeTextRegisters(serialRegisters, this.config.byteOrder);
        const serial = Buffer.from(decoded, 'utf8').subarray(0, byteLength).toString('utf8');
        if (!serial || Buffer.byteLength(serial, 'utf8') !== byteLength) throw new Error('Serial incompleto ou UTF-8 invalido no mailbox.');
        const positionCount = registers[at(this.positionCountAddress)];
        const positionRegisters = registers.slice(at(this.positionStartAddress), at(this.positionStartAddress) + this.positionRegisterCount);
        const positions = positionCount <= positionRegisters.length * 16
            ? decodeBooleanRegisters(positionRegisters, positionCount) : [];
        return { sequence, serial, positionCount, positions };
    }

    private async clear(registers: number[], key: string) {
        const firstAttempt = this.clearingKey !== key;
        this.clearingKey = key;
        try {
            await this.session.writeRegisters(this.startAddress, Array<number>(registers.length).fill(0));
            if (firstAttempt) communicationLog.add(this.machine.machineId, 'NODE_TO_PLC', 'ACK_ZERO',
                'Node zerou o mailbox após persistir os dados.', {
                    address: this.startAddress, registers: Array<number>(registers.length).fill(0)
                });
        } catch (error) {
            throw error;
        }
    }

    private async pollInbound() {
        const registers = await this.session.readHoldingRegisters(this.startAddress, this.registerCount);
        if (empty(registers)) {
            if (!this.emptyReconciled || this.clearingKey) {
                const active = await this.coordinator.activeAssignment(this.lineId, this.machine.machineId);
                if (active?.state === 'result_recorded') {
                    await this.coordinator.passageBySequence(this.lineId, this.machine.machineId, active.entrySequence);
                    communicationLog.add(this.machine.machineId, 'SYSTEM', 'ACK_CONFIRMED',
                        'Mailbox zerado confirmado; etapa concluída e próxima estação liberada.', {
                            sequence: active.entrySequence, serial: active.serialNumber, address: this.startAddress
                        });
                    console.info(`[MODBUS][${this.machine.machineId}] ACK confirmado sequence=${active.entrySequence}`);
                }
            }
            this.emptyReconciled = true;
            if (this.clearingKey) this.session.confirmReconciled();
            this.clearingKey = undefined; this.pendingAck = undefined;
            this.candidate = undefined; this.correlationKey = undefined; return;
        }
        this.emptyReconciled = false;
        const key = registers.join(',');
        if (this.clearingKey) {
            if (this.clearingKey !== key) throw new Error('CLP alterou o mailbox antes de concluir a confirmacao anterior.');
            if (this.pendingAck && !this.pendingAck.timeoutReported
                && Date.now() - this.pendingAck.startedAt >= (this.config.phaseTimeoutMs ?? 120000)) {
                await this.coordinator.recordCommunicationFault(this.lineId, this.machine.machineId,
                    this.pendingAck.assignment.entrySequence, {
                        protocol: 'modbus-tcp', communicationState: 'timeout', phase: 'aguardando-ack-zero',
                        timeoutMs: this.config.phaseTimeoutMs ?? 120000,
                        serial: this.pendingAck.assignment.serialNumber
                    });
                this.pendingAck.timeoutReported = true;
                communicationLog.add(this.machine.machineId, 'SYSTEM', 'PHASE_TIMEOUT',
                    'Tempo excedido aguardando a confirmação do mailbox zerado.', {
                        sequence: this.pendingAck.assignment.entrySequence,
                        timeoutMs: this.config.phaseTimeoutMs ?? 120000
                    }, 'error');
            }
            this.session.confirmReconciled(); await this.clear(registers, key); return;
        }
        if (this.candidate?.key !== key) {
            this.candidate = { key, reads: 1 };
            communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'PLC_MAILBOX_OBSERVED',
                `CLP gravou dados em D${this.startAddress}-D${this.startAddress + registers.length - 1}; aguardando segunda leitura igual.`, {
                    modbusFunction: 'FC03', address: this.startAddress,
                    count: registers.length, registers, confirmationReadsRequired: 2
                });
            return;
        }
        if (++this.candidate.reads < 2) return;

        const message = this.parse(registers);
        communicationLog.add(this.machine.machineId, 'PLC_TO_NODE', 'MAILBOX_RECEIVED',
            `CLP publicou a sequência ${message.sequence} e ${message.positionCount} posições.`, {
                sequence: message.sequence, serial: message.serial, positionCount: message.positionCount,
                positions: message.positions, address: this.startAddress, registers
            });
        // A sequência é interna ao PCM. A CLP não a recebe na M1 e, portanto,
        // não pode reproduzi-la com segurança nas estações seguintes.
        const assignment = await this.coordinator.mailboxAssignment(this.lineId, this.machine.machineId);
        const serialMatch = assignment.serialNumber === message.serial;
        if (!serialMatch) {
            if (this.correlationKey !== key) {
                await this.coordinator.recordCommunicationFault(this.lineId, this.machine.machineId,
                    assignment.entrySequence, {
                        protocol: 'modbus-tcp', handshake: 'mailbox-zero', communicationState: 'correlation_error',
                        expectedSerial: assignment.serialNumber, reportedSerial: message.serial,
                        internalSequence: assignment.entrySequence, reportedSequence: message.sequence,
                        sequenceValidation: 'diagnostic-only'
                    });
                communicationLog.add(this.machine.machineId, 'SYSTEM', 'CORRELATION_ERROR',
                    `QR divergente. Esperado ${assignment.serialNumber}; recebido ${message.serial}.`, {
                        expectedSerial: assignment.serialNumber, reportedSerial: message.serial,
                        internalSequence: assignment.entrySequence, reportedSequence: message.sequence
                    }, 'error');
                this.correlationKey = key;
            }
            return;
        }
        const expectedPositionCount = this.config.expectedPositionCount ?? 20;
        if (message.positionCount !== expectedPositionCount || message.positions.length !== expectedPositionCount) {
            if (this.correlationKey !== key) {
                await this.coordinator.recordCommunicationFault(this.lineId, this.machine.machineId,
                    assignment.entrySequence, {
                        protocol: 'modbus-tcp', handshake: 'mailbox-zero', communicationState: 'protocol_error',
                        protocolError: 'position-count-mismatch', expectedPositionCount,
                        reportedPositionCount: message.positionCount, reportedSerial: message.serial,
                        internalSequence: assignment.entrySequence, reportedSequence: message.sequence,
                        sequenceValidation: 'diagnostic-only'
                    });
                communicationLog.add(this.machine.machineId, 'SYSTEM', 'PROTOCOL_ERROR',
                    `Quantidade de posições inválida. Esperado ${expectedPositionCount}; recebido ${message.positionCount}.`, {
                        expectedPositionCount, reportedPositionCount: message.positionCount,
                        serial: message.serial, sequence: assignment.entrySequence
                    }, 'error');
                this.correlationKey = key;
            }
            return;
        }
        this.correlationKey = undefined;
        const result: ProcessResult = message.positions.every(Boolean) ? 'OK' : 'NAO';
        await this.coordinator.resultBySequence(this.lineId, this.machine.machineId, assignment.entrySequence, result, {
            protocol: 'modbus-tcp', handshake: 'mailbox-zero', reportedSerial: message.serial,
            reportedSequence: message.sequence, serialMatch, sequenceValidation: 'diagnostic-only',
            positionCount: message.positionCount, positions: message.positions
        });
        this.pendingAck = { assignment, startedAt: Date.now(), timeoutReported: false };
        await this.clear(registers, key);
        console.info(`[MODBUS][${this.machine.machineId}] resultado persistido sequence=${assignment.entrySequence} result=${result}; aguardando ACK zerado`);
    }
}
