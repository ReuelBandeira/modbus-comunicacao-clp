import type { IndexDescription } from 'mongodb';
import type { PcmWorkflow } from '../workflow/models/workflowModel';

export type PcmPreparationStatus = 'scanning' | 'ready' | 'released' | 'cancelled';

export interface PcmChipIdentification {
    position: number;
    serialNumber: string;
    scannedAt: Date;
    requestId?: string;
}

export interface PcmPreparation {
    lineId: string;
    stationId: string;
    stationName: string;
    status: PcmPreparationStatus;
    active: boolean;
    version: number;
    trayScannedAt: Date;
    updatedAt: Date;
    completedAt?: Date;
    releasedAt?: Date;
    startRequestId?: string;
    releaseRequestId?: string;
    chips: PcmChipIdentification[];
}

export interface PCM {
    entryId?: string;
    serialNumber: string;
    enteredAt: Date;
    preparation?: PcmPreparation;
    workflow?: PcmWorkflow;
}

// Mantém o nome físico da collection para preservar os dados existentes.
export const pcmCollection = 'pcm_line_entries';

// Fonte única dos índices da entidade PCM, usados na conexão e na migration.
export const pcmIndexes: IndexDescription[] = [
    { key: { entryId: 1 }, name: 'uq_pcm_entry_id', unique: true, sparse: true },
    { key: { 'preparation.startRequestId': 1 }, name: 'uq_pcm_preparation_start_request', unique: true, sparse: true },
    { key: { serialNumber: 1, enteredAt: -1 }, name: 'ix_pcm_line_entries_serial' },
    { key: { 'preparation.lineId': 1, 'preparation.stationId': 1 }, name: 'uq_pcm_active_preparation_station', unique: true,
        partialFilterExpression: { 'preparation.active': true } },
    { key: { 'preparation.lineId': 1, serialNumber: 1 }, name: 'uq_pcm_active_preparation_serial', unique: true,
        partialFilterExpression: { 'preparation.active': true } },
    { key: { 'preparation.chips.serialNumber': 1 }, name: 'ix_pcm_preparation_chip_serial' },
    { key: { 'workflow.lineId': 1, serialNumber: 1, 'workflow.status': 1 }, name: 'uq_pcm_active_serial', unique: true,
        partialFilterExpression: { 'workflow.status': 'in_progress' } },
    { key: { 'workflow.lineId': 1, 'workflow.entrySequence': 1 }, name: 'uq_pcm_line_sequence', unique: true,
        partialFilterExpression: { 'workflow.entrySequence': { $type: 'number' } } },
    { key: { 'workflow.lineId': 1, 'workflow.activeMachineId': 1, 'workflow.entrySequence': 1 }, name: 'ix_pcm_active_machine' },
    { key: { 'workflow.requestKeys': 1 }, name: 'uq_pcm_machine_cycle', unique: true, sparse: true },
    { key: { 'workflow.lineId': 1, 'workflow.stages.machineId': 1, 'workflow.stages.cycleId': 1 },
        name: 'ix_pcm_stage_cycle' },
    { key: { 'workflow.lineId': 1, 'workflow.status': 1 }, name: 'ix_pcm_line_status' },
    { key: { 'workflow.lineId': 1, 'workflow.completedAt': 1, 'workflow.quality': 1 }, name: 'ix_pcm_line_completion' }
];

export const pcmObsoleteIndexes = ['uq_pcm_line_entries_serial', 'uq_pcm_active_machine'];
