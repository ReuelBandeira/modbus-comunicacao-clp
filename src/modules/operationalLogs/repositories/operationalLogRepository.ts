import type { Collection, Filter } from 'mongodb';
import type { OperationalLogCategory, OperationalLogEvent, OperationalLogOutcome } from '../models/operationalLogModel';

export interface OperationalLogQuery {
    lineId: string;
    from: Date;
    to: Date;
    category?: OperationalLogCategory;
    outcome?: OperationalLogOutcome;
    actor?: string;
    search?: string;
    limit: number;
}

export class OperationalLogRepository {
    constructor(private readonly collection: Collection<OperationalLogEvent>) {}

    async insert(value: OperationalLogEvent) { await this.collection.insertOne(value); }

    list(query: OperationalLogQuery): Promise<OperationalLogEvent[]> {
        const filter: Filter<OperationalLogEvent> = { lineId: query.lineId,
            occurredAt: { $gte: query.from, $lte: query.to } };
        if (query.category) filter.category = query.category;
        if (query.outcome) filter.outcome = query.outcome;
        const clauses: Filter<OperationalLogEvent>[] = [];
        if (query.actor) {
            const escaped = query.actor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            clauses.push({ $or: [{ 'actor.id': { $regex: escaped, $options: 'i' } },
                { 'actor.label': { $regex: escaped, $options: 'i' } }] });
        }
        if (query.search) {
            const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            clauses.push({ $or: [
                { description: { $regex: escaped, $options: 'i' } },
                { action: { $regex: escaped, $options: 'i' } },
                { resource: { $regex: escaped, $options: 'i' } },
                { 'actor.label': { $regex: escaped, $options: 'i' } }
            ] });
        }
        if (clauses.length) filter.$and = clauses;
        return this.collection.find(filter, { projection: { _id: 0 } }).sort({ occurredAt: -1 }).limit(query.limit).toArray();
    }
}
