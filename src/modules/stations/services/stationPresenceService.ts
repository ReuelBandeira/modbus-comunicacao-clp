import { WorkflowError } from '../../pcm/workflow/errors/workflowError';

export interface StationPresenceStatus {
    role: 'end-of-line';
    connected: boolean;
    required: boolean;
    satisfied: boolean;
    lastSeen: Date | null;
    timeoutMs: number;
}

export class StationPresenceService {
    private lastSeen?: Date;

    constructor(private readonly requirement: () => Promise<boolean>, private readonly timeoutMs = 15_000) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) {
            throw new Error('Timeout do heartbeat deve estar entre 5000 e 300000 ms.');
        }
    }

    async heartbeat(value: unknown, at = new Date()): Promise<StationPresenceStatus> {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || (value as Record<string, unknown>).role !== 'end-of-line'
            || Object.keys(value as Record<string, unknown>).some(key => key !== 'role')) {
            throw new WorkflowError(400, 'Heartbeat inválido para a estação de Final de Linha.');
        }
        this.lastSeen = at;
        return this.status(at);
    }

    async status(at = new Date()): Promise<StationPresenceStatus> {
        const required = await this.requirement();
        const connected = !!this.lastSeen && at.getTime() - this.lastSeen.getTime() <= this.timeoutMs;
        return { role: 'end-of-line', connected, required, satisfied: !required || connected,
            lastSeen: this.lastSeen ?? null, timeoutMs: this.timeoutMs };
    }

    async assertAvailable(): Promise<void> {
        const status = await this.status();
        if (!status.satisfied) throw new WorkflowError(409,
            'Bipagem bloqueada: a estação de Final de Linha está desconectada.');
    }
}
