import type { LineConfig } from '../../../machines/models/lineModel';
import type { PCM } from '../../models/pcmModel';
import type { MachineCommunicationHealth } from '../../../modbus/services/communicationLog';

export interface LineSnapshot {
    totals: { total: number; inProgress: number; completed: number; rejected: number; removed: number; quarantined: number };
    active: PCM[];
    queues: { machineId: string; count: number; next: PCM }[];
    waiting: { machineId: string; count: number }[];
    recent: PCM[];
}

export interface LineDashboard {
    line: LineConfig;
    snapshot: LineSnapshot;
    communication: MachineCommunicationHealth[];
    capturedAt: Date;
}

export type Json<T> = T extends Date ? string : T extends (infer U)[] ? Json<U>[]
    : T extends object ? { [K in keyof T]: Json<T[K]> } : T;
