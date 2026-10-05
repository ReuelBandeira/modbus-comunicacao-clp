import type { Collection } from 'mongodb';
import type { IhmMachine } from '../models/ihmMachineModel';

export interface IhmMachineRepositoryContract {
    list(lineId: string, enabledOnly?: boolean): Promise<IhmMachine[]>;
    get(lineId: string, ihmMachineId: string): Promise<IhmMachine | null>;
    create(value: IhmMachine): Promise<unknown>;
    update(value: IhmMachine): Promise<boolean>;
    remove(lineId: string, ihmMachineId: string): Promise<boolean>;
}

export class IhmMachineRepository implements IhmMachineRepositoryContract {
    constructor(private readonly collection: Collection<IhmMachine>) {}
    list(lineId: string, enabledOnly = false) {
        return this.collection.find({ lineId, ...(enabledOnly ? { enabled: true } : {}) }, { projection: { _id: 0 } })
            .sort({ order: 1, name: 1 }).toArray();
    }
    get(lineId: string, ihmMachineId: string) {
        return this.collection.findOne({ lineId, ihmMachineId }, { projection: { _id: 0 } });
    }
    create(value: IhmMachine) { return this.collection.insertOne(value as IhmMachine & { _id?: never }); }
    async update(value: IhmMachine) {
        return (await this.collection.replaceOne({ lineId: value.lineId, ihmMachineId: value.ihmMachineId }, value)).matchedCount === 1;
    }
    async remove(lineId: string, ihmMachineId: string) {
        return (await this.collection.deleteOne({ lineId, ihmMachineId })).deletedCount === 1;
    }
}
