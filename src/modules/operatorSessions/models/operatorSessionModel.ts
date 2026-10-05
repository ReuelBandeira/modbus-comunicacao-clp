import type { IndexDescription } from 'mongodb';

export interface OperatorStationSession {
    sessionId: string;
    stationId: string;
    operator: { name: string; registration: string };
    // Opcional apenas para compatibilidade com sessoes criadas antes do vinculo de turno.
    shift?: { shiftId: string; name: string; startTime: string; endTime: string };
    status: 'active' | 'ended';
    startedAt: Date;
    endedAt?: Date;
    endReason?: 'operator_exit' | 'shift_change';
    entryRequestId: string;
    exitRequestId?: string;
    createdAt: Date;
    updatedAt: Date;
}

export const operatorSessionsCollection = 'pcm_operator_station_sessions';
export const operatorSessionIndexes: IndexDescription[] = [
    { key: { sessionId: 1 }, name: 'uq_pcm_operator_session_id', unique: true },
    { key: { stationId: 1, 'operator.registration': 1 }, name: 'uq_pcm_active_operator_station', unique: true,
        partialFilterExpression: { status: 'active' } },
    { key: { entryRequestId: 1 }, name: 'uq_pcm_operator_session_entry_request', unique: true },
    { key: { exitRequestId: 1 }, name: 'uq_pcm_operator_session_exit_request', unique: true, sparse: true },
    { key: { 'shift.shiftId': 1, status: 1 }, name: 'ix_pcm_operator_active_shift' },
    { key: { stationId: 1, startedAt: -1, endedAt: 1 }, name: 'ix_pcm_operator_station_history' }
];
