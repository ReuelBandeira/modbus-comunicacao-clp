import type { Collection } from 'mongodb';
import type { Shift } from '../models/shiftModel';

export class ShiftRepository {
    constructor(private readonly collection: Collection<Shift>) {}
    list(): Promise<Shift[]> {
        return this.collection.find({}, { projection: { _id: 0 } }).sort({ startTime: 1, name: 1 }).toArray();
    }
    get(shiftId: string): Promise<Shift | null> {
        return this.collection.findOne({ shiftId }, { projection: { _id: 0 } });
    }
    async create(value: Shift): Promise<void> { await this.collection.insertOne(value); }
    update(shiftId: string, value: Pick<Shift, 'name' | 'startTime' | 'endTime' | 'active' | 'updatedAt'>): Promise<Shift | null> {
        return this.collection.findOneAndUpdate({ shiftId }, { $set: value },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    async remove(shiftId: string): Promise<boolean> {
        return (await this.collection.deleteOne({ shiftId })).deletedCount === 1;
    }
}
