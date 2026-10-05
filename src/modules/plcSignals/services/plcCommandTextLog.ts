import { appendFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { PlcCommand, PlcCommandExecution } from '../models/plcSignalModel';

export type PlcCommandTextLogEvent = 'REQUESTED' | 'REJECTED' | 'PREFLIGHT_STARTED' | 'PREFLIGHT_COMPLETED'
    | 'WRITE_STARTED' | 'WRITE_COMPLETED' | 'PULSE_RESET_STARTED' | 'PULSE_RESET_COMPLETED'
    | 'ACK_WAIT_STARTED' | 'ACK_RECEIVED' | 'COMPLETED' | 'FAILED';

export interface PlcCommandTextLogDetails {
    targetId?: string;
    logId?: string;
    host?: string;
    port?: number;
    unitId?: number;
    connectionTimeoutMs?: number;
    attempt?: number;
    observedValue?: number | boolean;
    step?: string;
    attemptedValue?: number;
    durationMs?: number;
    totalDurationMs?: number;
    outcomeUnknown?: boolean;
    waitsForAck?: boolean;
    error?: string;
    reason?: string;
}

/**
 * Auditoria append-only dos comandos CLP. Cada linha do arquivo .txt e um JSON
 * independente, facilitando leitura humana, filtros e importacao posterior.
 * Falhas ao gravar o log sao reportadas no console, mas nunca alteram o comando.
 */
export class PlcCommandTextLog {
    private pending: Promise<void> = Promise.resolve();

    constructor(readonly directory = process.env.PLC_COMMAND_LOG_DIR?.trim() || path.resolve(process.cwd(), 'logs')) {}

    add(event: PlcCommandTextLogEvent, execution: PlcCommandExecution, command: PlcCommand,
        details: PlcCommandTextLogDetails = {}): void {
        const timestamp = new Date();
        const record = {
            timestamp: timestamp.toISOString(), event,
            executionId: execution.executionId, requestId: execution.requestId, lineId: execution.lineId,
            commandId: command.commandId, commandCode: execution.commandCode, label: command.label,
            requestedBy: execution.requestedBy ?? 'Sistema', status: execution.status,
            plcId: command.plcId, machineId: command.machineId, targetMachineId: command.targetMachineId,
            plcAddress: command.plcAddress, modbusAddress: command.address,
            commandType: command.commandType, functionCode: command.commandType === 'coil' ? 'FC05' : 'FC16',
            mode: command.mode ?? 'maintained', commandValue: command.value,
            pulseMs: command.pulseMs, resetValue: command.resetValue,
            ackSignalId: command.ackSignalId, ackTimeoutMs: command.ackTimeoutMs,
            ...details
        };
        const file = path.join(this.directory, `plc-commands-${timestamp.toISOString().slice(0, 10)}.txt`);
        const line = `${JSON.stringify(record)}\n`;
        this.pending = this.pending.then(async () => {
            await mkdir(this.directory, { recursive: true });
            await appendFile(file, line, 'utf8');
        }).catch(error => {
            console.error('[PLC_COMMAND_LOG] Nao foi possivel gravar o log:', error instanceof Error ? error.message : error);
        });
    }

    flush(): Promise<void> { return this.pending; }
}
