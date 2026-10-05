import type { Collection } from 'mongodb';
import type { DowntimeEvent, DowntimeReason, OeeConfiguration, ProductionCalendarException, ProductionPeriod, ShiftBreak } from '../models/availabilityModel';

export class AvailabilityRepository {
    constructor(private readonly reasons: Collection<DowntimeReason>, private readonly breaks: Collection<ShiftBreak>,
        private readonly calendar: Collection<ProductionCalendarException>, private readonly events: Collection<DowntimeEvent>,
        private readonly periods: Collection<ProductionPeriod>, private readonly configurations: Collection<OeeConfiguration>) {}

    configuration(lineId: string): Promise<OeeConfiguration | null> {
        return this.configurations.findOne({ lineId }, { projection: { _id: 0 } });
    }
    async saveConfiguration(value: OeeConfiguration) {
        await this.configurations.updateOne({ lineId: value.lineId }, { $set: value }, { upsert: true });
        return value;
    }

    listReasons(): Promise<DowntimeReason[]> { return this.reasons.find({}, { projection: { _id: 0 } }).sort({ name: 1 }).toArray(); }
    reason(id: string): Promise<DowntimeReason | null> { return this.reasons.findOne({ reasonId: id }, { projection: { _id: 0 } }); }
    async createReason(value: DowntimeReason) { await this.reasons.insertOne(value); }
    updateReason(id: string, value: Omit<DowntimeReason, 'reasonId' | 'createdAt'>) {
        return this.reasons.findOneAndUpdate({ reasonId: id }, { $set: value },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    async removeReason(id: string) { return (await this.reasons.deleteOne({ reasonId: id })).deletedCount === 1; }
    async reasonInUse(id: string) { return await this.events.countDocuments({ 'reason.reasonId': id }, { limit: 1 }) > 0; }

    listBreaks(): Promise<ShiftBreak[]> { return this.breaks.find({}, { projection: { _id: 0 } }).sort({ shiftId: 1, startTime: 1 }).toArray(); }
    breakById(id: string): Promise<ShiftBreak | null> { return this.breaks.findOne({ breakId: id }, { projection: { _id: 0 } }); }
    async createBreak(value: ShiftBreak) { await this.breaks.insertOne(value); }
    updateBreak(id: string, value: Omit<ShiftBreak, 'breakId' | 'createdAt'>) {
        return this.breaks.findOneAndUpdate({ breakId: id }, { $set: value },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    async removeBreak(id: string) { return (await this.breaks.deleteOne({ breakId: id })).deletedCount === 1; }

    listCalendar(lineId: string, from?: string, to?: string): Promise<ProductionCalendarException[]> {
        const date = from && to ? { $gte: from, $lte: to } : undefined;
        return this.calendar.find({ lineId, ...(date ? { date } : {}) }, { projection: { _id: 0 } })
            .sort({ date: -1, shiftId: 1 }).toArray();
    }
    async createCalendar(value: ProductionCalendarException) { await this.calendar.insertOne(value); }
    async removeCalendar(id: string) { return (await this.calendar.deleteOne({ exceptionId: id })).deletedCount === 1; }

    openEvent(lineId: string): Promise<DowntimeEvent | null> {
        return this.events.findOne({ lineId, status: 'open' }, { projection: { _id: 0 } });
    }
    eventByStartRequest(requestId: string): Promise<DowntimeEvent | null> {
        return this.events.findOne({ startRequestId: requestId }, { projection: { _id: 0 } });
    }
    eventByEndRequest(requestId: string): Promise<DowntimeEvent | null> {
        return this.events.findOne({ endRequestId: requestId }, { projection: { _id: 0 } });
    }
    async createEvent(value: DowntimeEvent) { await this.events.insertOne(value); }
    addPlcSignals(lineId: string, eventId: string, signals: Array<{ signalId: string; label: string }>,
        activeSignalIds: string[], updatedAt: Date) {
        return this.events.findOneAndUpdate({ lineId, eventId, status: 'open', source: 'plc' },
            { $addToSet: { sourceSignals: { $each: signals }, activeSourceSignalIds: { $each: activeSignalIds } }, $set: { updatedAt } },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    replacePlcSignals(lineId: string, eventId: string, signals: Array<{ signalId: string; label: string }>,
        activeSignalIds: string[], notes: string, updatedAt: Date) {
        return this.events.findOneAndUpdate({ lineId, eventId, status: 'open', source: 'plc' },
            { $set: { sourceSignals: signals, activeSourceSignalIds: activeSignalIds, notes, updatedAt } },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    removePlcSignal(lineId: string, eventId: string, signalId: string, updatedAt: Date) {
        return this.events.findOneAndUpdate({ lineId, eventId, status: 'open', source: 'plc' },
            { $pull: { activeSourceSignalIds: signalId }, $set: { updatedAt } },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    closePlcEventWithoutSignals(lineId: string, eventId: string, requestId: string, endedAt: Date) {
        return this.events.findOneAndUpdate({ lineId, eventId, status: 'open', source: 'plc', activeSourceSignalIds: { $size: 0 } },
            { $set: { status: 'closed', endedAt, endRequestId: requestId, updatedAt: endedAt } },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    closeEvent(lineId: string, requestId: string, endedAt: Date): Promise<DowntimeEvent | null> {
        return this.events.findOneAndUpdate({ lineId, status: 'open' },
            { $set: { status: 'closed', endedAt, endRequestId: requestId, updatedAt: endedAt } },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    closeEventById(lineId: string, eventId: string, requestId: string, endedAt: Date): Promise<DowntimeEvent | null> {
        return this.events.findOneAndUpdate({ lineId, eventId, status: 'open' },
            { $set: { status: 'closed', endedAt, endRequestId: requestId, updatedAt: endedAt } },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    classifyEvent(lineId: string, eventId: string, reason: DowntimeEvent['reason'], notes: string | undefined, updatedAt: Date) {
        return this.events.findOneAndUpdate({ lineId, eventId, status: 'open', source: 'plc' },
            { $set: { reason, classificationPending: false, ...(notes ? { notes } : {}), updatedAt } },
            { returnDocument: 'after', includeResultMetadata: false, projection: { _id: 0 } });
    }
    eventsBetween(lineId: string, from: Date, to: Date): Promise<DowntimeEvent[]> {
        return this.events.find({ lineId, startedAt: { $lt: to }, $or: [
            { endedAt: { $gt: from } }, { status: 'open' }
        ] }, { projection: { _id: 0 } }).sort({ startedAt: 1 }).toArray();
    }
    recentEvents(lineId: string, limit = 20): Promise<DowntimeEvent[]> {
        return this.events.find({ lineId }, { projection: { _id: 0 } }).sort({ startedAt: -1 }).limit(limit).toArray();
    }
    period(lineId: string, date: string, shiftId: string): Promise<ProductionPeriod | null> {
        return this.periods.findOne({ lineId, operationalDate: date, shiftId }, { projection: { _id: 0 } });
    }
    async createPeriod(value: ProductionPeriod) { await this.periods.insertOne(value); }
    periodsBetween(lineId: string, from: Date, to: Date): Promise<ProductionPeriod[]> {
        return this.periods.find({ lineId, plannedStartAt: { $lt: to }, plannedEndAt: { $gt: from } },
            { projection: { _id: 0 } }).sort({ plannedStartAt: 1 }).toArray();
    }
}
