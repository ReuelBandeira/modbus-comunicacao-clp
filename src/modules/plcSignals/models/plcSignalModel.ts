import type { IndexDescription } from 'mongodb';

export type PlcReadType = 'coil' | 'discrete_input' | 'holding_register' | 'input_register';
export type PlcBehavior = 'warn' | 'pause_entry' | 'block_line' | 'record_stop';
export type PlcSeverity = 'info' | 'warning' | 'critical';
export type PlcAlarmSeverity = 'info' | 'warning' | 'critical' | 'emergency';
export type PlcSignalAction = 'none' | 'line_started' | 'line_stopped'
    | 'ifts_start' | 'ifts_passage' | 'ifts_finish' | 'ifts_retry' | 'ifts_reset';
export type PlcCommandType = 'coil' | 'holding_register';
export type PlcCommandMode = 'maintained' | 'pulse';
export type PlcCommandScope = 'line' | 'machine';
export type PlcButtonStyle = 'primary' | 'success' | 'warning' | 'danger';
export type PlcBusinessAction = 'plc_only';
export type PlcLineStatusColor = 'gray' | 'green' | 'yellow' | 'red' | 'blue';
export type PlcProductionState = 'stopped' | 'running' | 'warning' | 'emergency';
export interface PlcLineStatusMapping { value: number; label: string; color: PlcLineStatusColor; }
export interface PlcAggregateStatusMapping extends PlcLineStatusMapping { blocksEntry: boolean; productionState?: PlcProductionState; }
export interface PlcMachineStatus { ihmMachineId: string; mappings: PlcLineStatusMapping[]; }

export interface PlcDevice {
    plcId: string; lineId: string; name: string; host: string; port: number; unitId: number;
    timeoutMs: number; enabled: boolean; createdAt: Date; updatedAt: Date;
}

export interface PlcSignal {
    signalId: string; lineId: string; plcId?: string; machineId?: string; label: string; plcAddress: string;
    readType: PlcReadType; address: number; bit?: number; activeValue: boolean; triggerValue?: number; pollingMs: number;
    severity: PlcSeverity; behavior: PlcBehavior; requiresAcknowledgment: boolean; enabled: boolean;
    downtimeReasonId?: string; onActivateAction?: PlcSignalAction; onDeactivateAction?: PlcSignalAction;
    aggregateStatusMappings?: PlcAggregateStatusMapping[];
    machineStatus?: PlcMachineStatus;
    createdAt: Date; updatedAt: Date;
}
export interface PlcCommand {
    commandId: string; lineId: string; plcId?: string; machineId?: string; label: string; plcAddress: string;
    replicaPlcIds?: string[];
    commandType: PlcCommandType; address: number; value: number; ackSignalId?: string; ackTimeoutMs: number;
    code?: string; scope?: PlcCommandScope; targetMachineId?: string; mode?: PlcCommandMode; pulseMs?: number;
    resetValue?: number; visible?: boolean; requiresConfirmation?: boolean; buttonStyle?: PlcButtonStyle; order?: number;
    businessAction?: PlcBusinessAction; interlocks?: PlcCommandInterlock[];
    enabled: boolean; createdAt: Date; updatedAt: Date;
}
export interface PlcCommandInterlock {
    signalId: string; requiredActive?: boolean; blockedValues?: number[]; message: string;
}
export type PlcCommandExecutionStatus = 'requested' | 'validating' | 'sending' | 'waiting_ack'
    | 'acknowledged' | 'completing' | 'completed' | 'failed' | 'uncertain';
export interface PlcCommandExecutionStep { name: string; status: 'completed' | 'failed'; at: Date; message?: string; }
export interface PlcCommandExecution {
    executionId: string; requestId: string; lineId: string; commandId: string; commandCode: string;
    label: string; status: PlcCommandExecutionStatus; requestedBy?: string; requestedAt: Date; updatedAt: Date;
    completedAt?: Date; error?: string; steps: PlcCommandExecutionStep[];
    dispatches?: Array<{ plcId: string; plcName?: string; status: PlcCommandExecutionStatus; error?: string }>;
    warning?: string;
}
export interface PlcSignalState {
    signalId: string; plcId?: string; label: string; active: boolean; value: number | boolean;
    readAt: Date; changedAt: Date; behavior: PlcBehavior; error?: string;
}
export type PlcSignalTransition = 'activated' | 'deactivated';
export type PlcSignalActionExecutionStatus = 'pending' | 'completed' | 'failed';
export interface PlcSignalActionExecution {
    executionId: string; lineId: string; signalId: string; signalLabel: string; transition: PlcSignalTransition;
    action: Exclude<PlcSignalAction, 'none'>; previousActive: boolean; currentActive: boolean;
    value: number | boolean; status: PlcSignalActionExecutionStatus; occurredAt: Date; updatedAt: Date;
    completedAt?: Date; error?: string;
}
export interface PlcAlarmDefinition {
    alarmId: string; lineId: string; code: string; signalId: string; ihmMachineId?: string;
    title: string; description?: string; instruction?: string; severity: PlcAlarmSeverity;
    activeValues: number[]; requiresAcknowledgment: boolean; blocksEntry: boolean;
    activationDelayMs: number; clearDelayMs: number; enabled: boolean; createdAt: Date; updatedAt: Date;
}
export type PlcAlarmOccurrenceStatus = 'active' | 'acknowledged' | 'cleared';
export interface PlcAlarmOccurrence {
    occurrenceId: string; lineId: string; alarmId: string; code: string; signalId: string; signalLabel: string;
    deduplicationKey: string;
    ihmMachineId?: string; title: string; description?: string; instruction?: string; severity: PlcAlarmSeverity;
    value: number; status: PlcAlarmOccurrenceStatus; blocksEntry: boolean; requiresAcknowledgment: boolean;
    openedAt: Date; updatedAt: Date; acknowledgedAt?: Date; acknowledgedBy?: string; clearedAt?: Date;
}
export const plcSignalsCollection = 'pcm_plc_signals';
export const plcCommandsCollection = 'pcm_plc_commands';
export const plcDevicesCollection = 'pcm_plc_devices';
export const plcCommandExecutionsCollection = 'pcm_plc_command_executions';
export const plcSignalActionExecutionsCollection = 'pcm_plc_signal_action_executions';
export const plcAlarmDefinitionsCollection = 'pcm_plc_alarm_definitions';
export const plcAlarmOccurrencesCollection = 'pcm_plc_alarm_occurrences';
export const plcDeviceIndexes: IndexDescription[] = [
    { key: { lineId: 1, plcId: 1 }, name: 'uq_pcm_plc_device', unique: true },
    { key: { lineId: 1, host: 1, port: 1, unitId: 1 }, name: 'uq_pcm_plc_endpoint', unique: true }
];
export const plcSignalIndexes: IndexDescription[] = [
    { key: { lineId: 1, signalId: 1 }, name: 'uq_pcm_plc_signal', unique: true },
    { key: { lineId: 1, plcId: 1, enabled: 1 }, name: 'ix_pcm_plc_signal_device' }
];
export const plcCommandIndexes: IndexDescription[] = [
    { key: { lineId: 1, commandId: 1 }, name: 'uq_pcm_plc_command', unique: true },
    { key: { lineId: 1, code: 1 }, name: 'uq_pcm_plc_command_code', unique: true,
        partialFilterExpression: { code: { $type: 'string' } } }
];
export const plcCommandExecutionIndexes: IndexDescription[] = [
    { key: { lineId: 1, executionId: 1 }, name: 'uq_pcm_plc_execution', unique: true },
    { key: { lineId: 1, requestId: 1 }, name: 'uq_pcm_plc_execution_request', unique: true },
    { key: { lineId: 1, requestedAt: -1 }, name: 'ix_pcm_plc_execution_history' }
];
export const plcSignalActionExecutionIndexes: IndexDescription[] = [
    { key: { lineId: 1, executionId: 1 }, name: 'uq_pcm_plc_signal_action_execution', unique: true },
    { key: { lineId: 1, signalId: 1, occurredAt: -1 }, name: 'ix_pcm_plc_signal_action_history' }
];
export const plcAlarmDefinitionIndexes: IndexDescription[] = [
    { key: { lineId: 1, alarmId: 1 }, name: 'uq_pcm_plc_alarm_definition', unique: true },
    { key: { lineId: 1, code: 1 }, name: 'uq_pcm_plc_alarm_code', unique: true },
    { key: { lineId: 1, signalId: 1, enabled: 1 }, name: 'ix_pcm_plc_alarm_signal' }
];
export const plcAlarmOccurrenceIndexes: IndexDescription[] = [
    { key: { lineId: 1, occurrenceId: 1 }, name: 'uq_pcm_plc_alarm_occurrence', unique: true },
    { key: { deduplicationKey: 1 }, name: 'uq_pcm_plc_alarm_deduplication', unique: true },
    { key: { lineId: 1, clearedAt: 1, openedAt: -1 }, name: 'ix_pcm_plc_alarm_active' },
    { key: { lineId: 1, alarmId: 1, openedAt: -1 }, name: 'ix_pcm_plc_alarm_history' }
];
