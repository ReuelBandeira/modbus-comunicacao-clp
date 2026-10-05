import { isIP } from 'node:net';
import { WorkflowError } from '../../pcm/workflow/errors/workflowError';
import { MachineModbusSession, type MachineConnection } from '../sessions/machineModbusSession';

export interface MachineConnectionProbeResult {
    ok: boolean;
    message: string;
    host: string;
    port: number;
    unitId: number;
    latencyMs: number;
    requestQr?: boolean;
}

interface ProbeSession {
    readCoils(address: number, count?: number): Promise<boolean[]>;
    dispose(): void;
}

function integer(value: unknown, min: number, max: number, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new WorkflowError(400, `${label}: informe um inteiro de ${min} a ${max}.`);
    }
    return value;
}

export class MachineConnectionProbe {
    constructor(private readonly createSession: (connection: MachineConnection) => ProbeSession =
        connection => new MachineModbusSession(connection)) {}

    async execute(input: unknown): Promise<MachineConnectionProbeResult> {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new WorkflowError(400, 'Informe os dados da máquina.');
        const body = input as Record<string, unknown>;
        const host = typeof body.host === 'string' ? body.host.trim() : '';
        if (!isIP(host)) throw new WorkflowError(400, 'Informe um IP válido da máquina.');
        const port = integer(body.port, 1, 65535, 'Porta');
        const unitId = integer(body.unitId, 1, 247, 'Unit ID');
        const timeoutMs = integer(body.timeoutMs, 100, 10000, 'Timeout');
        const requestQrCoil = integer(body.requestQrCoil ?? 0, 0, 65535, 'Coil de solicitação');
        const startedAt = performance.now();
        const session = this.createSession({ host, port, unitId, timeoutMs });
        try {
            const requestQr = (await session.readCoils(requestQrCoil, 1))[0];
            const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
            return { ok: true, message: `Modbus respondeu pela FC01 no coil ${requestQrCoil}.`,
                host, port, unitId, latencyMs, requestQr };
        } catch {
            const latencyMs = Math.max(0, Math.round(performance.now() - startedAt));
            return { ok: false, message: 'Não foi possível obter resposta Modbus. Verifique IP, porta, Unit ID e disponibilidade da CLP.',
                host, port, unitId, latencyMs };
        } finally {
            session.dispose();
        }
    }
}
