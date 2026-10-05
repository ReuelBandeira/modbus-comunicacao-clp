import type { Collection } from 'mongodb';
import type { PCM } from '../models/pcmModel';
import type { PcmWorkflow } from '../workflow/models/workflowModel';
import type { LineSnapshot } from '../workflow/dtos/lineDashboardDto';

export interface PcmWorkflowRepositoryContract {
    byRequest(key: string): Promise<PCM | null>;
    byOperation(lineId: string, machineId: string, operationId: string): Promise<PCM | null>;
    byStageCycleId(lineId: string, machineId: string, cycleId: string): Promise<PCM | null>;
    active(lineId: string, machineId: string): Promise<PCM | null>;
    activeMany(lineId: string, machineId: string): Promise<PCM[]>;
    bySequence(lineId: string, entrySequence: number): Promise<PCM | null>;
    firstWaiting(lineId: string, machineId: string): Promise<PCM | null>;
    save(lineId: string, entrySequence: number, version: number, workflow: PcmWorkflow): Promise<boolean>;
    list(lineId: string, limit: number): Promise<PCM[]>;
    get(serialNumber: string): Promise<PCM | null>;
    hasInProgress(lineId: string): Promise<boolean>;
    completedBetween(lineId: string, from: Date, to: Date): Promise<PCM[]>;
    snapshot(lineId: string): Promise<LineSnapshot>;
}

export class PcmWorkflowRepository implements PcmWorkflowRepositoryContract {
    constructor(private readonly collection: Collection<PCM>) {}
    async snapshot(lineId: string): Promise<LineSnapshot> {
        const [result] = await this.collection.aggregate<{
            totals: LineSnapshot['totals'][];
            active: LineSnapshot['active']; queues: LineSnapshot['queues'];
            waiting: LineSnapshot['waiting']; recent: LineSnapshot['recent'];
        }>([
            { $match: { 'workflow.lineId': lineId } },
            { $project: { _id: 0 } },
            { $facet: {
                totals: [{ $group: { _id: null, total: { $sum: 1 },
                    inProgress: { $sum: { $cond: [{ $eq: ['$workflow.status', 'in_progress'] }, 1, 0] } },
                    completed: { $sum: { $cond: [{ $eq: ['$workflow.status', 'completed'] }, 1, 0] } },
                    removed: { $sum: { $cond: [{ $eq: ['$workflow.status', 'removed'] }, 1, 0] } },
                    quarantined: { $sum: { $cond: [{ $eq: ['$workflow.status', 'quarantined'] }, 1, 0] } },
                    rejected: { $sum: { $cond: [{ $and: [
                        { $eq: ['$workflow.quality', 'rejected'] },
                        { $not: [{ $in: ['$workflow.status', ['removed', 'quarantined']] }] }
                    ] }, 1, 0] } }
                } }, { $project: { _id: 0 } }],
                active: [{ $match: { 'workflow.activeMachineId': { $type: 'string' } } }],
                queues: [
                    { $match: { 'workflow.status': 'in_progress', 'workflow.activeMachineId': { $exists: false } } },
                    { $sort: { 'workflow.entrySequence': 1 } },
                    { $group: { _id: '$workflow.nextMachineId', count: { $sum: 1 }, next: { $first: '$$ROOT' } } },
                    { $project: { _id: 0, machineId: '$_id', count: 1, next: 1 } }
                ],
                waiting: [
                    { $unwind: '$workflow.stages' }, { $match: { 'workflow.stages.state': 'waiting' } },
                    { $group: { _id: '$workflow.stages.machineId', count: { $sum: 1 } } },
                    { $project: { _id: 0, machineId: '$_id', count: 1 } }
                ],
                recent: [{ $sort: { 'workflow.entrySequence': -1 } }, { $limit: 50 }]
            } }
        ]).toArray();
        return { totals: result?.totals[0] ?? { total: 0, inProgress: 0, completed: 0, rejected: 0, removed: 0, quarantined: 0 },
            active: result?.active ?? [], queues: result?.queues ?? [], waiting: result?.waiting ?? [], recent: result?.recent ?? [] };
    }
    async hasInProgress(lineId: string): Promise<boolean> {
        return await this.collection.findOne({ 'workflow.lineId': lineId, 'workflow.status': 'in_progress' },
            { projection: { _id: 1 } }) !== null;
    }
    completedBetween(lineId: string, from: Date, to: Date): Promise<PCM[]> {
        return this.collection.aggregate<PCM>([
            { $match: { 'workflow.lineId': lineId, 'workflow.status': 'completed' } },
            { $set: { reportCompletedAt: { $ifNull: ['$workflow.completedAt', { $max: '$workflow.stages.passedAt' }] } } },
            { $match: { reportCompletedAt: { $gte: from, $lt: to } } },
            { $unset: 'reportCompletedAt' }, { $project: { _id: 0 } }
        ]).toArray();
    }
    byRequest(key: string): Promise<PCM | null> { return this.collection.findOne({ 'workflow.requestKeys': key }); }
    byOperation(lineId: string, machineId: string, operationId: string): Promise<PCM | null> {
        return this.collection.findOne({ 'workflow.lineId': lineId,
            'workflow.stages': { $elemMatch: { machineId, operationId } } });
    }
    byStageCycleId(lineId: string, machineId: string, cycleId: string): Promise<PCM | null> {
        return this.collection.findOne({ 'workflow.lineId': lineId,
            'workflow.stages': { $elemMatch: { machineId, cycleId } } });
    }
    active(lineId: string, machineId: string): Promise<PCM | null> {
        return this.collection.findOne({ 'workflow.lineId': lineId, 'workflow.activeMachineId': machineId },
            { sort: { 'workflow.entrySequence': 1 } });
    }
    activeMany(lineId: string, machineId: string): Promise<PCM[]> {
        return this.collection.find({ 'workflow.lineId': lineId, 'workflow.activeMachineId': machineId },
            { projection: { _id: 0 } }).sort({ 'workflow.entrySequence': 1 }).toArray();
    }
    bySequence(lineId: string, entrySequence: number): Promise<PCM | null> {
        return this.collection.findOne({ 'workflow.lineId': lineId, 'workflow.entrySequence': entrySequence });
    }
    firstWaiting(lineId: string, machineId: string): Promise<PCM | null> {
        // Inclui bandejas ainda na etapa anterior: nunca ultrapassa a primeira da fila física.
        return this.collection.findOne({ 'workflow.lineId': lineId,
            'workflow.stages': { $elemMatch: { machineId, state: 'waiting' } } },
        { sort: { 'workflow.entrySequence': 1 } });
    }
    async save(lineId: string, entrySequence: number, version: number, workflow: PcmWorkflow): Promise<boolean> {
        try {
            const result = await this.collection.updateOne({ 'workflow.lineId': lineId,
                'workflow.entrySequence': entrySequence, 'workflow.version': version },
                { $set: { workflow: { ...workflow, version: version + 1 } } });
            return result.matchedCount === 1;
        } catch (error) {
            // Conflito de reserva/ciclo: o coordenador relê o estado, sem escolher outra bandeja às cegas.
            if ((error as { code?: number }).code === 11000) return false;
            throw error;
        }
    }
    list(lineId: string, limit: number): Promise<PCM[]> {
        return this.collection.find({ 'workflow.lineId': lineId }, { projection: { _id: 0 } })
            .sort({ 'workflow.entrySequence': -1 }).limit(limit).toArray();
    }
    get(serialNumber: string): Promise<PCM | null> {
        return this.collection.findOne({ serialNumber }, { projection: { _id: 0 },
            sort: { 'workflow.entrySequence': -1, enteredAt: -1 } });
    }
}
