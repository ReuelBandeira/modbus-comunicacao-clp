export type StageState = 'waiting' | 'processing' | 'result_recorded' | 'completed' | 'skipped' | 'cancelled';
export type ProcessResult = 'OK' | 'NAO';
export type MachineAction = 'EXECUTE' | 'BYPASS';
export type WorkflowStatus = 'in_progress' | 'completed' | 'removed' | 'quarantined';
export type TrayInterventionAction = 'remove' | 'quarantine';

export interface TrayIntervention {
    interventionId: string;
    action: TrayInterventionAction;
    reason: string;
    notes?: string;
    actorRole: 'ADMIN';
    requestedAt: Date;
    activeMachineId?: string;
    physicalRemovalConfirmed: boolean;
}

export interface TrayManualAdvance {
    advanceId: string;
    fromMachineId: string;
    toMachineId: string;
    reason: string;
    notes?: string;
    actorRole: 'ADMIN';
    requestedAt: Date;
    physicalMovementConfirmed: boolean;
}

export interface PcmStage {
    machineId: string;
    state: StageState;
    operationId?: string;
    cycleId?: string;
    action?: MachineAction;
    result?: ProcessResult;
    data?: Record<string, unknown>;
    startedAt?: Date;
    resultAt?: Date;
    passedAt?: Date;
    identificationAcknowledgedAt?: Date;
    communicationState?: 'correlation_error' | 'protocol_error' | 'timeout' | 'connection_error';
    communicationErrorAt?: Date;
    communicationData?: Record<string, unknown>;
    cancelledAt?: Date;
}

export interface PcmWorkflow {
    lineId: string;
    lineRevision?: number;
    entrySequence: number;
    version: number;
    status: WorkflowStatus;
    completedAt?: Date;
    endedAt?: Date;
    intervention?: TrayIntervention;
    manualAdvances?: TrayManualAdvance[];
    quality: 'pending' | 'approved' | 'rejected';
    blockedByMachine?: string;
    nextMachineId?: string;
    activeMachineId?: string;
    requestKeys?: string[];
    stages: PcmStage[];
}

export interface MachineAssignment {
    serialNumber: string;
    entrySequence: number;
    machineId: string;
    cycleId: string;
    operationId: string;
    action: MachineAction;
    state: StageState;
    blockedByMachine?: string;
    startedAt?: Date;
    identificationAcknowledgedAt?: Date;
    communicationState?: PcmStage['communicationState'];
}
