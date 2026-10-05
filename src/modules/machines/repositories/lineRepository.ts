import type { Collection } from 'mongodb';
import type { LineConfig, LineCounter } from '../models/lineModel';
import { WorkflowError } from '../../pcm/workflow/errors/workflowError';

export interface LineRepositoryContract {
    create(config: LineConfig): Promise<void>;
    get(lineId: string): Promise<LineConfig | null>;
    update(config: LineConfig, expectedRevision: number): Promise<boolean>;
    updateMinimumOperators(lineId: string, minimumOperators: number, expectedRevision: number, updatedAt: Date): Promise<boolean>;
    nextSequence(lineId: string): Promise<number>;
}

export class LineRepository implements LineRepositoryContract {
    constructor(private readonly lines: Collection<LineConfig>, private readonly counters: Collection<LineCounter>) {}
    async create(config: LineConfig): Promise<void> {
        try { await this.lines.insertOne(config); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) throw new WorkflowError(409, 'Linha já cadastrada. Use PUT para editar sua configuração.');
            throw error;
        }
    }
    async get(lineId: string): Promise<LineConfig | null> {
        const line = await this.lines.findOne({ lineId }, { projection: { _id: 0 } });
        // Cadastros da primeira versão ainda não possuem revisão.
        return line ? { ...line, minimumOperators: line.minimumOperators ?? 3, revision: line.revision ?? 1 } : null;
    }
    async update(config: LineConfig, expectedRevision: number): Promise<boolean> {
        const revisionFilter = expectedRevision === 1
            ? { $or: [{ revision: 1 }, { revision: { $exists: false } }] }
            : { revision: expectedRevision };
        const result = await this.lines.updateOne({ lineId: config.lineId, ...revisionFilter }, { $set: config });
        return result.matchedCount === 1;
    }
    async updateMinimumOperators(lineId: string, minimumOperators: number, expectedRevision: number, updatedAt: Date): Promise<boolean> {
        const revisionFilter = expectedRevision === 1
            ? { $or: [{ revision: 1 }, { revision: { $exists: false } }] }
            : { revision: expectedRevision };
        const result = await this.lines.updateOne({ lineId, ...revisionFilter }, {
            $set: { minimumOperators, updatedAt, revision: expectedRevision + 1 }
        });
        return result.matchedCount === 1;
    }
    async nextSequence(lineId: string): Promise<number> {
        const counter = await this.counters.findOneAndUpdate({ _id: lineId }, { $inc: { value: 1 } },
            { upsert: true, returnDocument: 'after', includeResultMetadata: false });
        if (!counter || !Number.isSafeInteger(counter.value) || counter.value < 1) throw new Error('Sequência de entrada inválida.');
        return counter.value;
    }
}
