import type { Collection } from 'mongodb';
import type { PlcAlarmDefinition, PlcAlarmOccurrence, PlcCommand, PlcCommandExecution, PlcDevice, PlcSignal,
    PlcSignalActionExecution } from '../models/plcSignalModel';

export class PlcSignalRepository {
    constructor(private readonly signals: Collection<PlcSignal>, private readonly commands: Collection<PlcCommand>,
        private readonly devices: Collection<PlcDevice>, private readonly executions?: Collection<PlcCommandExecution>,
        private readonly signalActionExecutions?: Collection<PlcSignalActionExecution>,
        private readonly alarmDefinitions?: Collection<PlcAlarmDefinition>,
        private readonly alarmOccurrences?: Collection<PlcAlarmOccurrence>) {}
    devicesFor(lineId: string) { return this.devices.find({ lineId }, { projection: { _id: 0 } }).sort({ name: 1 }).toArray(); }
    device(lineId: string, plcId: string) { return this.devices.findOne({ lineId, plcId }, { projection: { _id: 0 } }); }
    signalsFor(lineId: string) { return this.signals.find({ lineId }, { projection: { _id: 0 } }).sort({ label: 1 }).toArray(); }
    commandsFor(lineId: string) { return this.commands.find({ lineId }, { projection: { _id: 0 } }).sort({ label: 1 }).toArray(); }
    signal(lineId: string, signalId: string) { return this.signals.findOne({ lineId, signalId }, { projection: { _id: 0 } }); }
    command(lineId: string, commandId: string) { return this.commands.findOne({ lineId, commandId }, { projection: { _id: 0 } }); }
    commandByCode(lineId: string, code: string) { return this.commands.findOne({ lineId, code }, { projection: { _id: 0 } }); }
    async saveSignal(value: PlcSignal) { await this.signals.replaceOne({ lineId: value.lineId, signalId: value.signalId }, value, { upsert: true }); }
    async saveCommand(value: PlcCommand) { await this.commands.replaceOne({ lineId: value.lineId, commandId: value.commandId }, value, { upsert: true }); }
    async saveDevice(value: PlcDevice) { await this.devices.replaceOne({ lineId: value.lineId, plcId: value.plcId }, value, { upsert: true }); }
    async deviceInUse(lineId: string, plcId: string) {
        return await this.signals.countDocuments({ lineId, plcId }, { limit: 1 }) > 0
            || await this.commands.countDocuments({ lineId, $or: [{ plcId }, { replicaPlcIds: plcId }] }, { limit: 1 }) > 0;
    }
    async signalInUse(lineId: string, signalId: string) {
        return await this.commands.countDocuments({ lineId, $or: [
            { ackSignalId: signalId }, { 'interlocks.signalId': signalId }
        ] }, { limit: 1 }) > 0 || (this.alarmDefinitions
            ? await this.alarmDefinitions.countDocuments({ lineId, signalId }, { limit: 1 }) > 0 : false);
    }
    async removeDevice(lineId: string, plcId: string) { return (await this.devices.deleteOne({ lineId, plcId })).deletedCount === 1; }
    async removeSignal(lineId: string, signalId: string) { return (await this.signals.deleteOne({ lineId, signalId })).deletedCount === 1; }
    async removeCommand(lineId: string, commandId: string) { return (await this.commands.deleteOne({ lineId, commandId })).deletedCount === 1; }
    executionByRequest(lineId: string, requestId: string) {
        return this.executions?.findOne({ lineId, requestId }, { projection: { _id: 0 } }) ?? Promise.resolve(null);
    }
    async createExecution(value: PlcCommandExecution) {
        if (!this.executions) return;
        await this.executions.insertOne(value as PlcCommandExecution & { _id?: never });
    }
    async saveExecution(value: PlcCommandExecution) {
        if (!this.executions) return;
        await this.executions.replaceOne({ lineId: value.lineId, executionId: value.executionId }, value, { upsert: true });
    }
    executionHistory(lineId: string, limit = 50) {
        return this.executions?.find({ lineId }, { projection: { _id: 0 } }).sort({ requestedAt: -1 }).limit(limit).toArray()
            ?? Promise.resolve([]);
    }
    async saveSignalActionExecution(value: PlcSignalActionExecution) {
        if (!this.signalActionExecutions) return;
        await this.signalActionExecutions.replaceOne({ lineId: value.lineId, executionId: value.executionId }, value, { upsert: true });
    }
    signalActionHistory(lineId: string, limit = 50) {
        return this.signalActionExecutions?.find({ lineId }, { projection: { _id: 0 } }).sort({ occurredAt: -1 }).limit(limit).toArray()
            ?? Promise.resolve([]);
    }
    alarmDefinitionsFor(lineId: string) {
        return this.alarmDefinitions?.find({ lineId }, { projection: { _id: 0 } }).sort({ code: 1 }).toArray() ?? Promise.resolve([]);
    }
    alarmDefinition(lineId: string, alarmId: string) {
        return this.alarmDefinitions?.findOne({ lineId, alarmId }, { projection: { _id: 0 } }) ?? Promise.resolve(null);
    }
    async saveAlarmDefinition(value: PlcAlarmDefinition) {
        if (!this.alarmDefinitions) return;
        await this.alarmDefinitions.replaceOne({ lineId: value.lineId, alarmId: value.alarmId }, value, { upsert: true });
    }
    async removeAlarmDefinition(lineId: string, alarmId: string) {
        if (!this.alarmDefinitions) return false;
        return (await this.alarmDefinitions.deleteOne({ lineId, alarmId })).deletedCount === 1;
    }
    activeAlarmOccurrences(lineId: string) {
        return this.alarmOccurrences?.find({ lineId, clearedAt: { $exists: false } }, { projection: { _id: 0 } })
            .sort({ openedAt: -1 }).toArray() ?? Promise.resolve([]);
    }
    activeAlarmOccurrence(lineId: string, alarmId: string) {
        return this.alarmOccurrences?.findOne({ lineId, alarmId, deduplicationKey: `${lineId}:${alarmId}:active` },
            { projection: { _id: 0 } }) ?? Promise.resolve(null);
    }
    alarmHistory(lineId: string, limit = 100) {
        return this.alarmOccurrences?.find({ lineId }, { projection: { _id: 0 } }).sort({ openedAt: -1 }).limit(limit).toArray()
            ?? Promise.resolve([]);
    }
    async saveAlarmOccurrence(value: PlcAlarmOccurrence) {
        if (!this.alarmOccurrences) return;
        await this.alarmOccurrences.replaceOne({ lineId: value.lineId, occurrenceId: value.occurrenceId }, value, { upsert: true });
    }
    alarmOccurrence(lineId: string, occurrenceId: string) {
        return this.alarmOccurrences?.findOne({ lineId, occurrenceId }, { projection: { _id: 0 } }) ?? Promise.resolve(null);
    }
}
