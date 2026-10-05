import { randomUUID } from 'node:crypto';
import type { PCM } from '../../pcm/models/pcmModel';
import type { EntryPreparationRepository } from '../../pcm/entry/repositories/entryPreparationRepository';
import type { PlcSignalOperationalControl } from '../../plcSignals/services/plcSignalRuntime';
import { communicationLog } from '../../modbus/services/communicationLog';
import { MachineModbusSession } from '../../modbus/sessions/machineModbusSession';
import type { MachineConfig } from '../models/lineModel';
import type { LineRepositoryContract } from '../repositories/lineRepository';

const COMMAND_CODE = 'REINICIAR_ESTACAO';
const CHIP_COUNT = 20;

export class StationTestResetError extends Error {
    constructor(public readonly status: 400 | 409 | 503, message: string) { super(message); }
}

interface RuntimeControl {
    pause(): Promise<void>;
    resume(acceptInitialRequests?: boolean): void;
}

interface ResetSession {
    readHoldingRegisters(address: number, count: number): Promise<number[]>;
    readCoils(address: number, count?: number): Promise<boolean[]>;
    writeCoil(address: number, value: boolean): Promise<void>;
    writeRegisters(address: number, values: number[]): Promise<void>;
    confirmReconciled(): void;
    dispose(): void;
}

export interface StationTestResetResult {
    removedTrays: number;
    tray: { entryId: string; serialNumber: string; chipCount: number; status: 'ready' };
    machines: Array<{ machineId: string; coils: number[]; registerRanges: Array<{ start: number; count: number }> }>;
}

function requestId(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
        throw new StationTestResetError(400, 'requestId inválido.');
    }
    return value;
}

function registerRanges(machine: MachineConfig): Array<{ start: number; count: number }> {
    const config = machine.modbus!;
    const map = config.map;
    if (machine.protocol === 'result-handshake-v1') {
        const positionCount = map.positionCountRegister ?? map.serialStartRegister + map.serialRegisterCount;
        const positionStart = map.positionStartRegister ?? positionCount + 1;
        const end = Math.max(map.serialStartRegister + map.serialRegisterCount,
            positionStart + (map.positionRegisterCount ?? 4));
        return [{ start: map.qrEntrySequenceRegister, count: end - map.qrEntrySequenceRegister }];
    }
    const ranges = [
        { start: map.qrEntrySequenceRegister, count: map.serialRegisterCount },
        { start: map.outputSerialStartRegister, count: map.serialRegisterCount }
    ];
    return ranges.filter((range, index) => ranges.findIndex(candidate => candidate.start === range.start
        && candidate.count === range.count) === index);
}

/** Reset destrutivo e explícito, destinado somente à validação controlada da linha. */
export class StationTestResetService {
    private running = false;

    constructor(private readonly lineId: string, private readonly stationId: string, private readonly stationName: string,
        private readonly lines: LineRepositoryContract, private readonly preparations: EntryPreparationRepository,
        private readonly runtimes: RuntimeControl, private readonly plcSignals: PlcSignalOperationalControl,
        private readonly traySerial = 'BANDEJA-TESTE-01', private readonly chipPrefix = 'CHIP-TESTE',
        private readonly createSession: (machine: MachineConfig) => ResetSession = machine => new MachineModbusSession(machine)) {}

    async execute(body: unknown): Promise<StationTestResetResult> {
        const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const id = requestId(raw.requestId);
        if (this.running) throw new StationTestResetError(409, 'Já existe um reinício de teste em andamento.');
        this.running = true;
        let paused = false;
        communicationLog.add('LINE', 'SYSTEM', 'STATION_TEST_RESET_STARTED',
            'Reset de teste iniciado: os runtimes serão pausados antes de limpar a comunicação.',
            { lineId: this.lineId, requestId: id });
        try {
            const line = await this.lines.get(this.lineId);
            if (!line) throw new StationTestResetError(503, 'Configuração da linha não encontrada.');
            const machines = line.machines.filter(machine => machine.modbus?.enabled
                && machine.protocol !== 'unmapped');
            if (!machines.length) throw new StationTestResetError(503, 'Nenhuma comunicação Modbus de máquina está habilitada.');
            this.assertTestSerialFits(machines);

            await this.runtimes.pause(); paused = true;
            const command = await this.plcSignals.executeByCode(COMMAND_CODE, id, 'ADMIN - reset de teste');
            if (command.status !== 'completed') {
                throw new StationTestResetError(503, command.error
                    || `O comando ${COMMAND_CODE} terminou com estado ${command.status}.`);
            }

            const cleared = await Promise.all(machines.map(machine => this.clearMachine(machine)));
            const tray = this.newReadyTray();
            const removedTrays = await this.preparations.replaceLineForTest(this.lineId, tray);
            const result: StationTestResetResult = {
                removedTrays,
                tray: { entryId: tray.entryId!, serialNumber: tray.serialNumber, chipCount: CHIP_COUNT, status: 'ready' },
                machines: cleared
            };
            communicationLog.add('LINE', 'SYSTEM', 'STATION_TEST_RESET_COMPLETED',
                `Reset de teste concluido. ${removedTrays} bandeja(s) removida(s); ${tray.serialNumber} pronta para liberar.`,
                { lineId: this.lineId, requestId: id, ...result });
            return result;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Falha desconhecida no reset de teste.';
            communicationLog.add('LINE', 'SYSTEM', 'STATION_TEST_RESET_FAILED',
                `Reset de teste interrompido: ${message}`, { lineId: this.lineId, requestId: id }, 'error');
            if (error instanceof StationTestResetError) throw error;
            throw new StationTestResetError(503, `Reset de teste não concluído: ${message}`);
        } finally {
            if (paused) this.runtimes.resume(true);
            this.running = false;
        }
    }

    private assertTestSerialFits(machines: MachineConfig[]): void {
        if (!this.traySerial || /\s|[\x00-\x1f\x7f]/u.test(this.traySerial)) {
            throw new StationTestResetError(503, 'PCM_TEST_RESET_TRAY_SERIAL inválido.');
        }
        const capacity = Math.min(...machines.filter(machine => machine.protocol !== 'result-handshake-v1')
            .map(machine => machine.modbus!.map.serialRegisterCount * 2));
        if (Number.isFinite(capacity) && Buffer.byteLength(this.traySerial, 'utf8') > capacity) {
            throw new StationTestResetError(503,
                `QR de teste excede a capacidade configurada de ${capacity} bytes do mailbox.`);
        }
    }

    private newReadyTray(): PCM {
        const now = new Date();
        return {
            entryId: randomUUID(), serialNumber: this.traySerial, enteredAt: now,
            preparation: {
                lineId: this.lineId, stationId: this.stationId, stationName: this.stationName,
                status: 'ready', active: true, version: CHIP_COUNT,
                trayScannedAt: now, updatedAt: now, completedAt: now,
                chips: Array.from({ length: CHIP_COUNT }, (_, index) => ({
                    position: index + 1,
                    serialNumber: `${this.chipPrefix}-${String(index + 1).padStart(2, '0')}`,
                    scannedAt: now
                }))
            }
        };
    }

    private async clearMachine(machine: MachineConfig) {
        const config = machine.modbus!;
        const coils = [...new Set([config.map.requestQrCoil, config.map.resultReadyCoil, config.map.resultAckCoil])];
        const ranges = registerRanges(machine);
        const session = this.createSession(machine);
        communicationLog.add(machine.machineId, 'SYSTEM', 'PLC_HANDSHAKE_RESET_STARTED',
            `Limpando handshake de ${machine.name}.`, { coils, registerRanges: ranges });
        try {
            for (const coil of coils) {
                await session.writeCoil(coil, false);
                const readback = (await session.readCoils(coil, 1))[0];
                if (readback !== false) throw new Error(`M${coil} permaneceu TRUE após a limpeza.`);
                session.confirmReconciled();
                communicationLog.add(machine.machineId, 'NODE_TO_PLC', 'PLC_COIL_RESET',
                    `M${coil} foi gravado em FALSE e conferido.`, {
                        modbusWriteFunction: 'FC05', modbusReadbackFunction: 'FC01', coil, value: false, readback
                    });
            }
            for (const range of ranges) {
                const zeros = Array<number>(range.count).fill(0);
                await session.writeRegisters(range.start, zeros);
                const readback = await session.readHoldingRegisters(range.start, range.count);
                if (readback.some(value => value !== 0)) {
                    throw new Error(`D${range.start}-D${range.start + range.count - 1} não ficou zerado.`);
                }
                session.confirmReconciled();
                communicationLog.add(machine.machineId, 'NODE_TO_PLC', 'PLC_MAILBOX_RESET',
                    `D${range.start}-D${range.start + range.count - 1} foi zerado e conferido.`, {
                        modbusWriteFunction: 'FC16', modbusReadbackFunction: 'FC03',
                        address: range.start, count: range.count, registers: zeros, readback
                    });
            }
            communicationLog.add(machine.machineId, 'SYSTEM', 'PLC_HANDSHAKE_RESET_COMPLETED',
                `Handshake de ${machine.name} limpo e verificado.`, { coils, registerRanges: ranges });
            return { machineId: machine.machineId, coils, registerRanges: ranges };
        } finally {
            session.dispose();
        }
    }
}
