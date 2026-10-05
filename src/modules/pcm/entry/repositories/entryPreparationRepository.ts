import type { Collection } from 'mongodb';
import type { PCM, PcmChipIdentification, PcmPreparation, PcmPreparationStatus } from '../../models/pcmModel';
import type { PcmWorkflow } from '../../workflow/models/workflowModel';

export class EntryPreparationRepository {
    constructor(private readonly collection: Collection<PCM>) {}

    current(lineId: string, stationId: string): Promise<PCM | null> {
        return this.collection.findOne({ 'preparation.lineId': lineId, 'preparation.stationId': stationId,
            'preparation.active': true });
    }

    byEntryId(entryId: string): Promise<PCM | null> {
        return this.collection.findOne({ entryId });
    }

    byStartRequestId(requestId: string): Promise<PCM | null> {
        return this.collection.findOne({ 'preparation.startRequestId': requestId });
    }

    async insert(pcm: PCM): Promise<void> { await this.collection.insertOne(pcm); }

    /** Uso exclusivo do reset de testes; documentos de outras linhas nao sao alterados. */
    async replaceLineForTest(lineId: string, pcm: PCM): Promise<number> {
        const filter = { $or: [{ 'preparation.lineId': lineId }, { 'workflow.lineId': lineId }] };
        const previous = await this.collection.find(filter).toArray();
        const removed = await this.collection.deleteMany(filter);
        try {
            await this.collection.insertOne(pcm);
        } catch (error) {
            if (previous.length) await this.collection.insertMany(previous, { ordered: false });
            throw error;
        }
        return removed.deletedCount;
    }

    async appendChip(entryId: string, version: number, chip: PcmChipIdentification,
        status: PcmPreparationStatus, completedAt?: Date): Promise<boolean> {
        const result = await this.collection.updateOne({ entryId, 'preparation.active': true,
            'preparation.status': 'scanning', 'preparation.version': version }, {
            $push: { 'preparation.chips': chip },
            $set: { 'preparation.status': status, 'preparation.updatedAt': chip.scannedAt,
                ...(completedAt ? { 'preparation.completedAt': completedAt } : {}) },
            $inc: { 'preparation.version': 1 }
        });
        return result.modifiedCount === 1;
    }

    async undoLast(entryId: string, version: number, updatedAt: Date): Promise<boolean> {
        const result = await this.collection.updateOne({ entryId, 'preparation.active': true,
            'preparation.version': version, 'preparation.chips.0': { $exists: true } }, {
            $pop: { 'preparation.chips': 1 },
            $set: { 'preparation.status': 'scanning', 'preparation.updatedAt': updatedAt },
            $unset: { 'preparation.completedAt': '' }, $inc: { 'preparation.version': 1 }
        });
        return result.modifiedCount === 1;
    }

    async cancel(entryId: string, version: number, updatedAt: Date): Promise<boolean> {
        const result = await this.collection.updateOne({ entryId, 'preparation.active': true,
            'preparation.version': version }, { $set: { 'preparation.status': 'cancelled',
                'preparation.active': false, 'preparation.updatedAt': updatedAt },
            $inc: { 'preparation.version': 1 } });
        return result.modifiedCount === 1;
    }

    async release(entryId: string, version: number, workflow: PcmWorkflow, releasedAt: Date,
        requestId?: string): Promise<boolean> {
        const result = await this.collection.updateOne({ entryId, 'preparation.active': true,
            'preparation.status': 'ready', 'preparation.version': version,
            'preparation.chips.19': { $exists: true }, 'preparation.chips.20': { $exists: false } }, {
            $set: { workflow, 'preparation.status': 'released', 'preparation.active': false,
                'preparation.updatedAt': releasedAt, 'preparation.releasedAt': releasedAt,
                ...(requestId ? { 'preparation.releaseRequestId': requestId } : {}) },
            $inc: { 'preparation.version': 1 }
        });
        return result.modifiedCount === 1;
    }
}
