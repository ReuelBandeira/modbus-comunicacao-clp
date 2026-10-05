import type { Collection } from 'mongodb';
import type { Operator } from '../models/operatorModel';

export class OperatorRepository {
    constructor(private readonly collection: Collection<Operator>) {}
    create(value: Operator): Promise<unknown> { return this.collection.insertOne(value); }
    list(): Promise<Operator[]> { return this.collection.find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray(); }
    get(registration: string): Promise<Operator | null> {
        return this.collection.findOne({ registration }, { projection: { _id: 0 } });
    }
    async update(currentRegistration: string, value: Operator): Promise<Operator | null> {
        return this.collection.findOneAndUpdate({ registration: currentRegistration }, { $set: value },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    async remove(registration: string): Promise<boolean> {
        return (await this.collection.deleteOne({ registration })).deletedCount === 1;
    }
}
