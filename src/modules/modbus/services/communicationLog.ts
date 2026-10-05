export type CommunicationDirection = 'PLC_TO_NODE' | 'NODE_TO_PLC' | 'SYSTEM';
export type CommunicationLevel = 'info' | 'error';

export interface CommunicationLogRecord {
    id: number;
    timestamp: Date;
    machineId: string;
    direction: CommunicationDirection;
    level: CommunicationLevel;
    event: string;
    message: string;
    data?: unknown;
}

export interface MachineCommunicationHealth {
    machineId: string;
    status: 'online' | 'offline';
    changedAt: Date;
    lastSuccessAt?: Date;
    error?: string;
}

export class CommunicationLog {
    private records: CommunicationLogRecord[] = [];
    private machineHealth = new Map<string, MachineCommunicationHealth>();
    private nextId = 1;

    constructor(private readonly capacity = 500) {
        if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Capacidade do log deve ser positiva.');
    }

    add(machineId: string, direction: CommunicationDirection, event: string, message: string,
        data?: unknown, level: CommunicationLevel = 'info'): CommunicationLogRecord {
        const record: CommunicationLogRecord = {
            id: this.nextId++, timestamp: new Date(), machineId, direction, level, event, message, ...(data === undefined ? {} : { data })
        };
        this.records.push(record);
        if (this.records.length > this.capacity) this.records.splice(0, this.records.length - this.capacity);
        return record;
    }

    list(): CommunicationLogRecord[] {
        return this.records.map(record => ({ ...record }));
    }

    markSuccess(machineId: string): void {
        const now = new Date(), previous = this.machineHealth.get(machineId);
        this.machineHealth.set(machineId, {
            machineId, status: 'online', changedAt: previous?.status === 'online' ? previous.changedAt : now,
            lastSuccessAt: now
        });
        if (previous?.status === 'offline') this.add(machineId, 'SYSTEM', 'COMMUNICATION_RESTORED',
            'Comunicação Modbus restabelecida.', undefined, 'info');
    }

    markFailure(machineId: string, error: string): void {
        const now = new Date(), previous = this.machineHealth.get(machineId);
        this.machineHealth.set(machineId, {
            machineId, status: 'offline', changedAt: previous?.status === 'offline' ? previous.changedAt : now,
            lastSuccessAt: previous?.lastSuccessAt, error
        });
    }

    health(): MachineCommunicationHealth[] {
        return [...this.machineHealth.values()].map(item => ({ ...item }));
    }
}

export const communicationLog = new CommunicationLog();
