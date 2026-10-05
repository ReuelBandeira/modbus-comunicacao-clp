import type { IndexDescription } from 'mongodb';

export type LineOperationStatus = 'stopped' | 'checking' | 'starting' | 'running' | 'failed';

export interface LineOperationCheck {
    key: 'operators' | 'end_of_line' | 'bridge' | 'plcs';
    label: string;
    ok: boolean;
    detail: string;
    actionable?: boolean;
}

export interface LineOperationState {
    lineId: string;
    status: LineOperationStatus;
    checks: LineOperationCheck[];
    updatedAt: Date;
    operationId?: string;
    startRequestId?: string;
    startedAt?: Date;
    stoppedAt?: Date;
    error?: string;
}

export const lineOperationsCollection = 'pcm_line_operations';
export const lineOperationIndexes: IndexDescription[] = [
    { key: { lineId: 1 }, name: 'uq_pcm_line_operation', unique: true },
    { key: { startRequestId: 1 }, name: 'uq_pcm_line_operation_start_request', unique: true, sparse: true }
];
