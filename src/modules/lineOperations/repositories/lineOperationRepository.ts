import type { Collection } from 'mongodb';
import type { LineOperationState } from '../models/lineOperationModel';

export interface LineOperationRepositoryContract {
    current(lineId: string): Promise<LineOperationState | null>;
    save(state: LineOperationState): Promise<void>;
}

export class LineOperationRepository implements LineOperationRepositoryContract {
    constructor(private readonly collection: Collection<LineOperationState>) {}
    current(lineId: string): Promise<LineOperationState | null> {
        return this.collection.findOne({ lineId }, { projection: { _id: 0 } });
    }
    async save(state: LineOperationState): Promise<void> {
        await this.collection.replaceOne({ lineId: state.lineId }, state, { upsert: true });
    }
}
