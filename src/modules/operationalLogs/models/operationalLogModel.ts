import type { IndexDescription } from 'mongodb';

export type OperationalLogCategory = 'authentication' | 'production' | 'operators' | 'shifts' | 'oee'
    | 'plc' | 'configuration' | 'integration' | 'system';
export type OperationalLogOutcome = 'success' | 'failure';
export type OperationalActorType = 'admin' | 'operator' | 'station' | 'system' | 'unknown';

export interface OperationalLogEvent {
    eventId: string;
    lineId: string;
    category: OperationalLogCategory;
    action: string;
    description: string;
    outcome: OperationalLogOutcome;
    actor: { type: OperationalActorType; id: string; label: string };
    resource?: string;
    method?: string;
    path?: string;
    httpStatus?: number;
    durationMs?: number;
    requestId?: string;
    details?: Record<string, string | number | boolean>;
    occurredAt: Date;
    expiresAt: Date;
}

export const operationalLogsCollection = 'pcm_operational_logs';
export const operationalLogIndexes: IndexDescription[] = [
    { key: { eventId: 1 }, name: 'uq_pcm_operational_log_event', unique: true },
    { key: { lineId: 1, occurredAt: -1 }, name: 'ix_pcm_operational_log_line_date' },
    { key: { lineId: 1, category: 1, outcome: 1, occurredAt: -1 }, name: 'ix_pcm_operational_log_filters' },
    { key: { lineId: 1, 'actor.id': 1, occurredAt: -1 }, name: 'ix_pcm_operational_log_actor' },
    { key: { expiresAt: 1 }, name: 'ttl_pcm_operational_log_retention', expireAfterSeconds: 0 }
];
