import type { Collection, Filter } from 'mongodb';
import type { TestResultCycle, TestResultSummary } from '../models/testResultModel';

export interface TestResultQuery {
    model?: string;
    from?: Date;
    to?: Date;
    limit: number;
}

export interface TestResultRepositoryContract {
    insert(value: TestResultCycle): Promise<void>;
    byCycleId(cycleId: string): Promise<TestResultCycle | null>;
    list(query: TestResultQuery): Promise<TestResultSummary[]>;
}

export class TestResultRepository implements TestResultRepositoryContract {
    constructor(private readonly collection: Collection<TestResultCycle>) {}

    async insert(value: TestResultCycle) {
        await this.collection.insertOne(value as TestResultCycle & { _id?: never });
    }

    byCycleId(cycleId: string) {
        return this.collection.findOne({ cycleId }, { projection: { _id: 0 } });
    }

    async list(query: TestResultQuery): Promise<TestResultSummary[]> {
        const filter: Filter<TestResultCycle> = {};
        if (query.model) filter.model = query.model;
        if (query.from || query.to) filter.finishedAt = {
            ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {})
        };
        const values = await this.collection.find(filter, { projection: { _id: 0, positions: 0, sourceFiles: 0 } })
            .sort({ receivedAt: -1 }).limit(query.limit).toArray();
        return values as unknown as TestResultSummary[];
    }
}
