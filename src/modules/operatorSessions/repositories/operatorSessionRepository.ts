import type { Collection } from 'mongodb';
import type { OperatorStationSession } from '../models/operatorSessionModel';

export class OperatorSessionRepository {
    constructor(private readonly collection: Collection<OperatorStationSession>) {}

    active(stationId: string): Promise<OperatorStationSession[]> {
        return this.collection.find({ stationId, status: 'active' }, { projection: { _id: 0 } })
            .sort({ startedAt: 1 }).toArray();
    }
    activeForShift(stationId: string, shiftId: string): Promise<OperatorStationSession[]> {
        return this.collection.find({ stationId, status: 'active', 'shift.shiftId': shiftId }, { projection: { _id: 0 } })
            .sort({ startedAt: 1 }).toArray();
    }
    activeByOperator(stationId: string, registration: string): Promise<OperatorStationSession | null> {
        return this.collection.findOne({ stationId, 'operator.registration': registration, status: 'active' },
            { projection: { _id: 0 } });
    }
    async hasActiveForShift(shiftId: string): Promise<boolean> {
        return await this.collection.countDocuments({ status: 'active', $or: [
            { 'shift.shiftId': shiftId },
            { shift: { $exists: false } }
        ] }) > 0;
    }
    async endOutsideShift(stationId: string, shiftId: string | null, endedAt: Date): Promise<number> {
        const result = await this.collection.updateMany({ stationId, status: 'active',
            ...(shiftId ? { 'shift.shiftId': { $ne: shiftId } } : {}) },
        { $set: { status: 'ended', endedAt, updatedAt: endedAt, endReason: 'shift_change' } });
        return result.modifiedCount;
    }
    byEntryRequest(requestId: string): Promise<OperatorStationSession | null> {
        return this.collection.findOne({ entryRequestId: requestId }, { projection: { _id: 0 } });
    }
    byExitRequest(requestId: string): Promise<OperatorStationSession | null> {
        return this.collection.findOne({ exitRequestId: requestId }, { projection: { _id: 0 } });
    }
    async create(value: OperatorStationSession): Promise<void> { await this.collection.insertOne(value); }
    exit(sessionId: string, stationId: string, requestId: string, endedAt: Date): Promise<OperatorStationSession | null> {
        return this.collection.findOneAndUpdate({ sessionId, stationId, status: 'active', exitRequestId: { $exists: false } },
            { $set: { status: 'ended', endedAt, updatedAt: endedAt, endReason: 'operator_exit', exitRequestId: requestId } },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
}
