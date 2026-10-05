import type { IndexDescription } from 'mongodb';

export type DowntimeClassification = 'planned' | 'unplanned';
export type PhysicalLineState = 'RUNNING' | 'STOPPED' | 'TRANSITION' | 'UNKNOWN';
export type PhysicalLineStrategy = 'serial_any_running' | 'all_required' | 'reference_signal';

export interface PhysicalMonitoringConfiguration {
    enabled: boolean;
    strategy: PhysicalLineStrategy;
    stopConfirmationMs: number;
    resumeConfirmationMs: number;
    defaultReasonId?: string;
    referenceSignalId?: string;
    manualContingencyEnabled: boolean;
    manualContingencyRequiresAdmin: boolean;
}

export interface PhysicalLineStateSnapshot {
    state: PhysicalLineState;
    strategy: PhysicalLineStrategy;
    signals: Array<{ signalId: string; label: string; plcId?: string; value?: number; productionState?: string; error?: string }>;
    reason: string;
    capturedAt: Date;
}

export interface DowntimeReason {
    reasonId: string;
    code: string;
    name: string;
    classification: DowntimeClassification;
    countsAgainstAvailability: boolean;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface ShiftBreak {
    breakId: string;
    shiftId: string;
    name: string;
    startTime: string;
    endTime: string;
    excludeFromPlannedTime: boolean;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export interface ProductionCalendarException {
    exceptionId: string;
    lineId: string;
    shiftId: string;
    date: string;
    productionEnabled: boolean;
    notes?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface DowntimeEvent {
    eventId: string;
    lineId: string;
    status: 'open' | 'closed';
    startedAt: Date;
    endedAt?: Date;
    reason: Pick<DowntimeReason, 'reasonId' | 'code' | 'name' | 'classification' | 'countsAgainstAvailability'>;
    source: 'manual' | 'plc' | 'system';
    /** Identifica o sinal que abriu a parada automática, permitindo fechá-la sem tocar em paradas manuais. */
    sourceSignalId?: string;
    /** Todos os sinais CLP que participaram da parada, preservados no histórico. */
    sourceSignals?: Array<{ signalId: string; label: string }>;
    /** Identificadores dos sinais que ainda mantêm a parada aberta. */
    activeSourceSignalIds?: string[];
    /** Parada automática aguardando o operador informar o motivo definitivo. */
    classificationPending?: boolean;
    notes?: string;
    startRequestId: string;
    endRequestId?: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface ProductionPeriod {
    periodId: string;
    lineId: string;
    shiftId: string;
    operationalDate: string;
    shift: { name: string; startTime: string; endTime: string };
    // Opcional apenas para períodos gravados antes do suporte a cancelamento no calendário.
    productionEnabled?: boolean;
    plannedStartAt: Date;
    plannedEndAt: Date;
    excludedBreaks: Array<{ name: string; startAt: Date; endAt: Date }>;
    createdAt: Date;
}

export interface OeeConfiguration {
    lineId: string;
    idealCycleTimeMs?: number;
    physicalMonitoring?: PhysicalMonitoringConfiguration;
    updatedAt: Date;
}

export const downtimeReasonsCollection = 'pcm_downtime_reasons';
export const shiftBreaksCollection = 'pcm_shift_breaks';
export const productionCalendarCollection = 'pcm_production_calendar';
export const downtimeEventsCollection = 'pcm_downtime_events';
export const productionPeriodsCollection = 'pcm_production_periods';
export const oeeConfigurationsCollection = 'pcm_oee_configurations';

export const downtimeReasonIndexes: IndexDescription[] = [
    { key: { reasonId: 1 }, name: 'uq_pcm_downtime_reason_id', unique: true },
    { key: { code: 1 }, name: 'uq_pcm_downtime_reason_code', unique: true },
    { key: { active: 1, name: 1 }, name: 'ix_pcm_downtime_reason_status' }
];
export const shiftBreakIndexes: IndexDescription[] = [
    { key: { breakId: 1 }, name: 'uq_pcm_shift_break_id', unique: true },
    { key: { shiftId: 1, active: 1, startTime: 1 }, name: 'ix_pcm_shift_break_schedule' }
];
export const productionCalendarIndexes: IndexDescription[] = [
    { key: { exceptionId: 1 }, name: 'uq_pcm_calendar_exception_id', unique: true },
    { key: { lineId: 1, date: 1, shiftId: 1 }, name: 'uq_pcm_calendar_line_date_shift', unique: true }
];
export const downtimeEventIndexes: IndexDescription[] = [
    { key: { eventId: 1 }, name: 'uq_pcm_downtime_event_id', unique: true },
    { key: { lineId: 1 }, name: 'uq_pcm_open_downtime_line', unique: true,
        partialFilterExpression: { status: 'open' } },
    { key: { startRequestId: 1 }, name: 'uq_pcm_downtime_start_request', unique: true },
    { key: { endRequestId: 1 }, name: 'uq_pcm_downtime_end_request', unique: true, sparse: true },
    { key: { lineId: 1, startedAt: -1, endedAt: 1 }, name: 'ix_pcm_downtime_period' },
    { key: { 'reason.reasonId': 1, startedAt: -1 }, name: 'ix_pcm_downtime_reason_period' }
];
export const productionPeriodIndexes: IndexDescription[] = [
    { key: { periodId: 1 }, name: 'uq_pcm_production_period_id', unique: true },
    { key: { lineId: 1, operationalDate: 1, shiftId: 1 }, name: 'uq_pcm_production_period_occurrence', unique: true },
    { key: { lineId: 1, plannedStartAt: 1, plannedEndAt: 1 }, name: 'ix_pcm_production_period_range' }
];
export const oeeConfigurationIndexes: IndexDescription[] = [
    { key: { lineId: 1 }, name: 'uq_pcm_oee_configuration_line', unique: true }
];
