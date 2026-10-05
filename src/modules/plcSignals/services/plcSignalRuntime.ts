import { randomUUID } from 'node:crypto';
import type { PhysicalLineStateSnapshot, PhysicalMonitoringConfiguration } from '../../availability/models/availabilityModel';
import type { AvailabilityService } from '../../availability/services/availabilityService';
import type { LineConfig } from '../../machines/models/lineModel';
import type { LineRepositoryContract } from '../../machines/repositories/lineRepository';
import { communicationLog } from '../../modbus/services/communicationLog';
import { MachineCommunicationError, MachineModbusSession, type MachineConnection } from '../../modbus/sessions/machineModbusSession';
import type { PlcAlarmDefinition, PlcAlarmOccurrence, PlcBusinessAction, PlcCommand, PlcCommandExecution, PlcCommandExecutionStatus, PlcDevice, PlcSignal,
    PlcSignalAction, PlcSignalActionExecution, PlcSignalState } from '../models/plcSignalModel';
import { PlcSignalRepository } from '../repositories/plcSignalRepository';
import type { PlcCommandTextLog, PlcCommandTextLogDetails, PlcCommandTextLogEvent } from './plcCommandTextLog';
import { PlcSignalError } from './plcSignalService';
import { aggregatePhysicalLineState } from './physicalLineState';
import type { OperationalLogService } from '../../operationalLogs/services/operationalLogService';
import { enforcedPlcPulseMs } from '../../modbus/services/pulseTiming';

export interface PlcBusinessActionContext { command: PlcCommand; execution: PlcCommandExecution; }
export interface PlcBusinessActionHandler {
    before?(context: PlcBusinessActionContext): Promise<void>;
    after?(context: PlcBusinessActionContext): Promise<void>;
}
export interface PlcSignalActionContext { signal: PlcSignal; execution: PlcSignalActionExecution; }
export type PlcSignalActionHandler = (context: PlcSignalActionContext) => Promise<void>;
export interface PlcSignalOperationalControl {
    blocksEntry(): boolean;
    states(): PlcSignalState[];
    execute(commandId: string): Promise<PlcCommandExecution>;
    executeByCode(code: string, requestId: string, requestedBy?: string): Promise<PlcCommandExecution>;
    preflightByCode(code: string): Promise<{ commandCode: string; label: string; targets: string[] }>;
    operational(): Promise<unknown>;
    lineStatus(): Promise<unknown>;
    alarms(): Promise<unknown>;
    acknowledgeAlarm(occurrenceId: string, acknowledgedBy?: string): Promise<PlcAlarmOccurrence>;
}
type PlcTarget = MachineConnection & { id: string; logId: string };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class PlcSignalRuntime implements PlcSignalOperationalControl {
    private readonly state = new Map<string, PlcSignalState>();
    private readonly lastPolledAt = new Map<string, number>();
    private readonly lastOeeSyncAt = new Map<string, number>();
    private readonly oeeSyncStatus = new Map<string, string>();
    private readonly transitionBaseline = new Map<string, boolean>();
    private physicalMonitoring?: PhysicalMonitoringConfiguration;
    private physicalPending?: { state: 'RUNNING' | 'STOPPED'; since: number };
    private physicalConfirmedState?: 'RUNNING' | 'STOPPED';
    private physicalLastSignature = ''; private physicalLastSyncAt = 0;
    private readonly sessions = new Map<string, { fingerprint: string; session: MachineModbusSession }>();
    private readonly executingTargets = new Set<string>();
    private readonly activeAlarms = new Map<string, PlcAlarmOccurrence>();
    private readonly alarmPending = new Map<string, { active: boolean; since: number }>();
    private readonly alarmLocks = new Map<string, Promise<void>>();
    private controller?: AbortController; private task?: Promise<void>;
    private signals: PlcSignal[] = []; private devices: PlcDevice[] = []; private alarmDefinitions: PlcAlarmDefinition[] = [];
    private configurationLoadedAt = 0; private alarmOccurrencesLoaded = false;
    private line?: LineConfig; private lineLoadedAt = 0;
    constructor(private readonly lineId: string, private readonly lines: LineRepositoryContract, private readonly repository: PlcSignalRepository,
        private readonly availability?: AvailabilityService,
        private readonly businessActions: Partial<Record<PlcBusinessAction, PlcBusinessActionHandler>> = {},
        private readonly signalActions: Partial<Record<Exclude<PlcSignalAction, 'none'>, PlcSignalActionHandler>> = {},
        private readonly commandTextLog?: PlcCommandTextLog,
        private readonly operationalLog?: OperationalLogService) {}
    start() { if (!this.controller) { this.controller = new AbortController(); this.task = this.loop(this.controller.signal); } }
    async stop() {
        this.controller?.abort(); await this.task; this.controller = undefined; this.task = undefined;
        this.sessions.forEach(item => item.session.dispose()); this.sessions.clear();
    }
    states() { return [...this.state.values()]; }
    private mappedValue(signal: PlcSignal, value: boolean | number) {
        const raw = typeof value === 'boolean' ? Number(value) : value;
        return typeof value === 'number' && signal.bit !== undefined
            ? Number(Boolean(value & (1 << signal.bit))) : raw;
    }
    private aggregateStatusStates() {
        return this.signals.filter(item => item.enabled && item.aggregateStatusMappings?.length).map(signal => {
            const state = this.state.get(signal.signalId);
            const stale = !!state && Date.now() - state.readAt.getTime() > Math.max(1_000, signal.pollingMs * 3);
            const value = state ? this.mappedValue(signal, state.value) : undefined;
            const mapping = value === undefined ? undefined : signal.aggregateStatusMappings!.find(entry => entry.value === value);
            return { signal, state, stale, value, mapping };
        });
    }
    blocksEntry() {
        const aggregate = this.aggregateStatusStates();
        return aggregate.some(item => !item.state || !!item.state.error || item.stale || !item.mapping || item.mapping.blocksEntry)
            || [...this.activeAlarms.values()].some(item => item.blocksEntry)
            || this.states().some(item => item.active && ['block_line', 'pause_entry'].includes(item.behavior));
    }
    private async loop(signal: AbortSignal) {
        while (!signal.aborted) {
            try { await this.poll(); } catch (error) { console.error(`[MODBUS][SIGNALS] ${(error as Error).message}`); }
            await sleep(100);
        }
    }
    private async loadConfiguration() {
        const now = Date.now();
        if (now - this.lineLoadedAt >= 1000) { this.line = await this.lines.get(this.lineId) ?? undefined; this.lineLoadedAt = now; }
        if (now - this.configurationLoadedAt >= 1000) {
            const [signals, devices, alarms, availabilityConfiguration] = await Promise.all([
                this.repository.signalsFor(this.lineId), this.repository.devicesFor(this.lineId),
                this.repository.alarmDefinitionsFor?.(this.lineId) ?? Promise.resolve([]),
                this.availability?.configuration?.() ?? Promise.resolve(undefined)
            ]);
            this.signals = signals; this.devices = devices; this.alarmDefinitions = alarms;
            this.physicalMonitoring = availabilityConfiguration?.physicalMonitoring;
            if (!this.alarmOccurrencesLoaded) {
                const occurrences = await (this.repository.activeAlarmOccurrences?.(this.lineId) ?? Promise.resolve([]));
                occurrences.forEach(item => this.activeAlarms.set(item.alarmId, item));
                this.alarmOccurrencesLoaded = true;
            }
            await this.closeOrphanedAlarms();
            this.configurationLoadedAt = now;
        }
    }
    private async poll() {
        await this.loadConfiguration();
        await Promise.all(this.signals.filter(item => item.enabled).map(async item => {
            const now = Date.now(), lastRead = this.lastPolledAt.get(item.signalId) ?? 0;
            if (now - lastRead < item.pollingMs) return;
            this.lastPolledAt.set(item.signalId, now);
            const target = this.targetForSignal(item);
            if (!target) {
                this.recordMissingTarget(item); return;
            }
            const previous = this.state.get(item.signalId), session = this.session(target);
            try {
                const raw = await this.read(session, item);
                const evaluated = typeof raw === 'boolean' ? raw : item.bit === undefined ? raw !== 0 : Boolean(raw & (1 << item.bit));
                const active = typeof raw === 'number' && item.bit === undefined && item.triggerValue !== undefined
                    ? raw === item.triggerValue : evaluated === item.activeValue;
                const changed = !previous || previous.value !== raw
                    || previous.active !== active || previous.error !== undefined;
                const readAt = new Date();
                this.state.set(item.signalId, { signalId: item.signalId, plcId: item.plcId, label: item.label, active, value: raw,
                    readAt, changedAt: changed ? readAt : previous.changedAt, behavior: item.behavior });
                communicationLog.markSuccess(target.logId);
                const alarmValue = typeof raw === 'boolean' ? Number(raw)
                    : item.bit === undefined ? raw : Number(Boolean(raw & (1 << item.bit)));
                try { await this.reconcileAlarms(item, alarmValue); }
                catch (alarmError) {
                    communicationLog.add(target.logId, 'SYSTEM', 'PLC_ALARM_SYNC_ERROR',
                        `${item.label}: leitura confirmada, mas o alarme não foi persistido. ${(alarmError as Error).message}`,
                        { signalId: item.signalId }, 'error');
                }
                if (changed) communicationLog.add(target.logId, 'PLC_TO_NODE', 'PLC_SIGNAL_READ',
                    `${item.label}: ${String(raw)} (${active ? 'ATIVO' : 'inativo'}).`, {
                        signalId: item.signalId, plcId: item.plcId, plcAddress: item.plcAddress, readType: item.readType,
                        modbusAddress: item.address, ...(item.bit === undefined ? {} : { bit: item.bit }),
                        activeValue: item.activeValue, ...(item.triggerValue === undefined ? {} : { triggerValue: item.triggerValue })
                    });
                const previousActive = this.transitionBaseline.get(item.signalId);
                this.transitionBaseline.set(item.signalId, active);
                if (previousActive !== undefined && previousActive !== active) {
                    await this.executeSignalAction(item, previousActive, active, raw, target.logId);
                }
                const lastOeeSync = this.lastOeeSyncAt.get(item.signalId) ?? 0;
                if (!this.physicalMonitoring?.enabled && item.behavior === 'record_stop' && item.downtimeReasonId
                    && (changed || now - lastOeeSync >= 5000)) {
                    this.lastOeeSyncAt.set(item.signalId, now); await this.synchronizeOee(item, active, target.logId);
                }
            } catch (error) { this.recordReadError(item, target.logId, previous, error); }
        }));
        await this.synchronizePhysicalState();
    }
    private async closeOrphanedAlarms() {
        const enabledSignals = new Set(this.signals.filter(item => item.enabled).map(item => item.signalId));
        const configured = new Set(this.alarmDefinitions.filter(item => item.enabled && enabledSignals.has(item.signalId)).map(item => item.alarmId));
        for (const [alarmId, occurrence] of this.activeAlarms) {
            if (configured.has(alarmId)) continue;
            await this.withAlarmLock(alarmId, async () => {
                const active = this.activeAlarms.get(alarmId); if (!active) return;
                const now = new Date(); active.status = 'cleared'; active.clearedAt = now; active.updatedAt = now;
                active.deduplicationKey = `${this.lineId}:${active.alarmId}:${active.occurrenceId}`;
                await this.repository.saveAlarmOccurrence?.(active); this.activeAlarms.delete(alarmId); this.alarmPending.delete(alarmId);
            });
        }
    }
    private async withAlarmLock<T>(alarmId: string, action: () => Promise<T>): Promise<T> {
        const previous = this.alarmLocks.get(alarmId) ?? Promise.resolve();
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const queued = previous.then(() => gate); this.alarmLocks.set(alarmId, queued);
        await previous;
        try { return await action(); }
        finally { release(); if (this.alarmLocks.get(alarmId) === queued) this.alarmLocks.delete(alarmId); }
    }
    private async reconcileAlarms(signal: PlcSignal, value: number) {
        for (const alarm of this.alarmDefinitions.filter(item => item.enabled && item.signalId === signal.signalId)) {
            await this.withAlarmLock(alarm.alarmId, async () => {
                const configured = this.alarmDefinitions.find(item => item.alarmId === alarm.alarmId && item.enabled
                    && item.signalId === signal.signalId);
                if (!configured || !this.signals.some(item => item.signalId === signal.signalId && item.enabled)) return;
                const shouldBeActive = configured.activeValues.includes(value), current = this.activeAlarms.get(configured.alarmId);
                if (shouldBeActive === !!current) { this.alarmPending.delete(configured.alarmId); return; }
                const delay = shouldBeActive ? configured.activationDelayMs : configured.clearDelayMs;
                const pending = this.alarmPending.get(configured.alarmId), nowMs = Date.now();
                if (delay > 0 && (!pending || pending.active !== shouldBeActive)) {
                    this.alarmPending.set(configured.alarmId, { active: shouldBeActive, since: nowMs }); return;
                }
                if (delay > 0 && pending && nowMs - pending.since < delay) return;
                this.alarmPending.delete(configured.alarmId);
                const now = new Date();
                if (shouldBeActive) {
                    const occurrence: PlcAlarmOccurrence = {
                        occurrenceId: randomUUID(), lineId: this.lineId, alarmId: configured.alarmId, code: configured.code,
                        deduplicationKey: `${this.lineId}:${configured.alarmId}:active`,
                        signalId: signal.signalId, signalLabel: signal.label, ...(configured.ihmMachineId ? { ihmMachineId: configured.ihmMachineId } : {}),
                        title: configured.title, ...(configured.description ? { description: configured.description } : {}),
                        ...(configured.instruction ? { instruction: configured.instruction } : {}), severity: configured.severity, value,
                        status: 'active', blocksEntry: configured.blocksEntry, requiresAcknowledgment: configured.requiresAcknowledgment,
                        openedAt: now, updatedAt: now
                    };
                    try { await this.repository.saveAlarmOccurrence?.(occurrence); this.activeAlarms.set(configured.alarmId, occurrence); }
                    catch (error) {
                        if ((error as { code?: number }).code !== 11000) throw error;
                        const existing = await this.repository.activeAlarmOccurrence?.(this.lineId, configured.alarmId);
                        if (!existing) throw error;
                        this.activeAlarms.set(configured.alarmId, existing); return;
                    }
                    communicationLog.add(signal.plcId ? `plc:${signal.plcId}` : signal.machineId || 'PLC', 'SYSTEM',
                        'PLC_ALARM_OPENED', `${configured.code} · ${configured.title} · valor ${value}.`,
                        { alarmId: configured.alarmId, occurrenceId: occurrence.occurrenceId, signalId: signal.signalId, value },
                        ['critical', 'emergency'].includes(configured.severity) ? 'error' : undefined);
                    this.recordOperational({ category: 'plc', action: 'PLC_ALARM_OPENED',
                        description: `Alarme ${configured.code} aberto: ${configured.title}.`,
                        outcome: ['critical', 'emergency'].includes(configured.severity) ? 'failure' : 'success',
                        resource: configured.ihmMachineId ?? signal.label,
                        details: { alarmId: configured.alarmId, occurrenceId: occurrence.occurrenceId, value } });
                } else if (current) {
                    current.status = 'cleared'; current.clearedAt = now; current.updatedAt = now;
                    current.deduplicationKey = `${this.lineId}:${current.alarmId}:${current.occurrenceId}`;
                    await this.repository.saveAlarmOccurrence?.(current); this.activeAlarms.delete(configured.alarmId);
                    communicationLog.add(signal.plcId ? `plc:${signal.plcId}` : signal.machineId || 'PLC', 'SYSTEM',
                        'PLC_ALARM_CLEARED', `${configured.code} · ${configured.title} normalizado · valor ${value}.`,
                        { alarmId: configured.alarmId, occurrenceId: current.occurrenceId, signalId: signal.signalId, value });
                    this.recordOperational({ category: 'plc', action: 'PLC_ALARM_CLEARED',
                        description: `Alarme ${configured.code} normalizado: ${configured.title}.`, resource: configured.ihmMachineId ?? signal.label,
                        details: { alarmId: configured.alarmId, occurrenceId: current.occurrenceId, value } });
                }
            });
        }
    }
    private async executeSignalAction(item: PlcSignal, previousActive: boolean, active: boolean,
        value: number | boolean, logId: string) {
        const configured = active ? item.onActivateAction : item.onDeactivateAction;
        if (!configured || configured === 'none') return;
        const now = new Date(), execution: PlcSignalActionExecution = {
            executionId: randomUUID(), lineId: this.lineId, signalId: item.signalId, signalLabel: item.label,
            transition: active ? 'activated' : 'deactivated', action: configured,
            previousActive, currentActive: active, value, status: 'pending', occurredAt: now, updatedAt: now
        };
        try {
            await this.repository.saveSignalActionExecution(execution);
            const handler = this.signalActions[configured];
            if (!handler) throw new Error(`A regra ${configured} não possui executor configurado.`);
            await handler({ signal: item, execution });
            execution.status = 'completed'; execution.updatedAt = new Date(); execution.completedAt = execution.updatedAt;
            await this.repository.saveSignalActionExecution(execution);
            communicationLog.add(logId, 'SYSTEM', 'PLC_SIGNAL_ACTION_COMPLETED',
                `${item.label}: regra ${configured} executada na transição para ${active ? 'ATIVO' : 'inativo'}.`,
                { executionId: execution.executionId, signalId: item.signalId, action: configured });
        } catch (error) {
            execution.status = 'failed'; execution.updatedAt = new Date(); execution.completedAt = execution.updatedAt;
            execution.error = (error as Error).message;
            try { await this.repository.saveSignalActionExecution(execution); }
            catch (persistenceError) { execution.error += ` Falha ao persistir resultado: ${(persistenceError as Error).message}`; }
            communicationLog.add(logId, 'SYSTEM', 'PLC_SIGNAL_ACTION_FAILED',
                `${item.label}: falha ao executar ${configured}. ${execution.error}`,
                { executionId: execution.executionId, signalId: item.signalId, action: configured }, 'error');
        }
    }
    private targetForSignal(item: Pick<PlcSignal | PlcCommand, 'plcId' | 'machineId'>): PlcTarget | undefined {
        if (item.plcId) {
            const device = this.devices.find(value => value.plcId === item.plcId && value.enabled);
            if (device) return { id: device.plcId, logId: `plc:${device.plcId}`, host: device.host, port: device.port,
                unitId: device.unitId, timeoutMs: device.timeoutMs };
        }
        // Compatibilidade temporária com sinais criados antes do cadastro independente de CLPs.
        const machine = item.machineId ? this.line?.machines.find(value => value.machineId === item.machineId) : undefined;
        return machine ? { id: `legacy:${machine.machineId}`, logId: machine.machineId, host: machine.host, port: machine.port,
            unitId: machine.unitId, timeoutMs: machine.timeoutMs } : undefined;
    }
    private recordMissingTarget(item: PlcSignal) {
        const previous = this.state.get(item.signalId), message = 'CLP vinculada não está cadastrada ou está inativa.', now = new Date();
        this.state.set(item.signalId, { signalId: item.signalId, plcId: item.plcId, label: item.label, active: false, value: false,
            readAt: now, changedAt: previous?.error === message ? previous.changedAt : now, behavior: item.behavior, error: message });
        if (previous?.error !== message) communicationLog.add(item.plcId ? `plc:${item.plcId}` : item.machineId || 'PLC', 'SYSTEM',
            'PLC_SIGNAL_CONFIGURATION_ERROR', `${item.label}: ${message}`, { signalId: item.signalId }, 'error');
    }
    private recordReadError(item: PlcSignal, logId: string, previous: PlcSignalState | undefined, error: unknown) {
        const message = (error as Error).message, changed = !previous || previous.error !== message, now = new Date();
        this.state.set(item.signalId, { signalId: item.signalId, plcId: item.plcId, label: item.label, active: false, value: false,
            readAt: now, changedAt: changed ? now : previous.changedAt, behavior: item.behavior, error: message });
        communicationLog.markFailure(logId, message);
        if (changed) communicationLog.add(logId, 'SYSTEM', 'PLC_SIGNAL_READ_ERROR',
            `${item.label}: leitura do sinal não confirmada. ${message}`, { signalId: item.signalId, plcAddress: item.plcAddress }, 'error');
    }
    private async synchronizeOee(item: PlcSignal, active: boolean, logId: string) {
        try {
            const result = await this.availability?.reconcilePlcSignal(item.signalId, active, item.downtimeReasonId!, item.label);
            if (result?.action === 'blocked') {
                if (this.oeeSyncStatus.get(item.signalId) !== 'blocked') communicationLog.add(logId, 'SYSTEM', 'OEE_STOP_SYNC_BLOCKED',
                    `${item.label}: já existe outra parada aberta; o evento da CLP não substituiu o histórico atual.`, { signalId: item.signalId }, 'error');
                this.oeeSyncStatus.set(item.signalId, 'blocked');
            } else if (result?.action !== 'unchanged') {
                this.oeeSyncStatus.set(item.signalId, result?.action || 'unavailable');
                const description = result?.action === 'opened' ? 'parada registrada no OEE.'
                    : result?.action === 'joined' ? 'sinal incluído na parada já aberta no OEE.'
                    : result?.action === 'updated' ? 'sinal normalizado; a parada continua por outro sinal.'
                    : 'parada automática encerrada no OEE.';
                communicationLog.add(logId, 'SYSTEM', 'OEE_STOP_SYNCHRONIZED',
                    `${item.label}: ${description}`,
                    { signalId: item.signalId });
            }
        } catch (error) {
            const message = (error as Error).message;
            if (this.oeeSyncStatus.get(item.signalId) !== `error:${message}`) communicationLog.add(logId, 'SYSTEM', 'OEE_STOP_SYNC_ERROR',
                `${item.label}: leitura confirmada, mas a parada não foi sincronizada no OEE. ${message}`,
                { signalId: item.signalId }, 'error');
            this.oeeSyncStatus.set(item.signalId, `error:${message}`);
        }
    }
    private async synchronizePhysicalState() {
        const configuration = this.physicalMonitoring;
        if (!configuration?.enabled || !this.availability) {
            this.physicalPending = undefined; this.physicalConfirmedState = undefined; return;
        }
        const inputs = this.aggregateStatusStates()
            .filter(item => item.signal.aggregateStatusMappings?.some(mapping => mapping.productionState))
            .map(item => ({ signalId: item.signal.signalId, label: item.signal.label, plcId: item.signal.plcId,
                ...(item.value === undefined ? {} : { value: item.value }),
                ...(item.mapping?.productionState ? { productionState: item.mapping.productionState } : {}),
                ...(!item.state ? { error: 'aguardando leitura' }
                    : item.state.error ? { error: item.state.error }
                    : item.stale ? { error: 'leitura desatualizada' }
                    : !item.mapping ? { error: `valor ${item.value} não mapeado` }
                    : !item.mapping.productionState ? { error: 'estado produtivo não mapeado' } : {}) }));
        const now = Date.now();
        let snapshot = aggregatePhysicalLineState(inputs, configuration.strategy, configuration.referenceSignalId, new Date(now));
        if (snapshot.state === 'RUNNING' || snapshot.state === 'STOPPED') {
            const emergency = snapshot.signals.some(item => item.productionState === 'emergency');
            const delay = emergency ? 0 : snapshot.state === 'STOPPED'
                ? configuration.stopConfirmationMs : configuration.resumeConfirmationMs;
            if (this.physicalConfirmedState === snapshot.state) this.physicalPending = undefined;
            else if (this.physicalPending?.state !== snapshot.state) this.physicalPending = { state: snapshot.state, since: now };
            if (this.physicalPending && now - this.physicalPending.since < delay) {
                const remaining = Math.max(0, delay - (now - this.physicalPending.since));
                snapshot = { ...snapshot, state: 'TRANSITION',
                    reason: `${snapshot.reason} Confirmação em ${(remaining / 1000).toFixed(1)} s.` };
            } else if (this.physicalPending) {
                this.physicalConfirmedState = this.physicalPending.state; this.physicalPending = undefined;
            }
        } else this.physicalPending = undefined;
        const signature = JSON.stringify({ state: snapshot.state, reason: snapshot.reason,
            signals: snapshot.signals.map(item => [item.signalId, item.value, item.productionState, item.error]) });
        if (signature === this.physicalLastSignature && now - this.physicalLastSyncAt < 5000) return;
        try {
            const result = await this.availability.reconcilePhysicalLineState(snapshot);
            if (signature !== this.physicalLastSignature || result.action !== 'unchanged') {
                communicationLog.add('line', 'SYSTEM', 'PHYSICAL_LINE_STATE',
                    `${snapshot.state}: ${snapshot.reason}`, { state: snapshot.state, strategy: snapshot.strategy,
                        action: result.action, signalIds: snapshot.signals.map(item => item.signalId) },
                    snapshot.state === 'UNKNOWN' || snapshot.state === 'STOPPED' ? 'error' : undefined);
            }
            this.physicalLastSignature = signature; this.physicalLastSyncAt = now;
        } catch (error) {
            const message = (error as Error).message;
            if (this.oeeSyncStatus.get('physical') !== `error:${message}`) communicationLog.add('line', 'SYSTEM',
                'PHYSICAL_LINE_STATE_ERROR', `Estado físico calculado, mas não sincronizado no OEE. ${message}`,
                { state: snapshot.state }, 'error');
            this.oeeSyncStatus.set('physical', `error:${message}`); this.physicalLastSyncAt = now;
        }
    }
    private session(target: PlcTarget) {
        const fingerprint = `${target.host}:${target.port}:${target.unitId}:${target.timeoutMs}`;
        const current = this.sessions.get(target.id);
        if (current?.fingerprint === fingerprint) return current.session;
        current?.session.dispose();
        const session = new MachineModbusSession(target);
        this.sessions.set(target.id, { fingerprint, session });
        return session;
    }
    private async read(session: MachineModbusSession, item: PlcSignal) {
        if (item.readType === 'coil') return (await session.readCoils(item.address))[0];
        if (item.readType === 'discrete_input') return (await session.readDiscreteInputs(item.address))[0];
        if (item.readType === 'input_register') return (await session.readInputRegisters(item.address, 1))[0];
        return (await session.readHoldingRegisters(item.address, 1))[0];
    }
    private machineStatuses() {
        return this.signals.filter(item => item.enabled && item.machineStatus).map(signal => {
            const state = this.state.get(signal.signalId), base = { ihmMachineId: signal.machineStatus!.ihmMachineId,
                signalId: signal.signalId, signalLabel: signal.label };
            if (!state) return { ...base, status: 'Aguardando leitura', color: 'gray' as const };
            if (state.error) return { ...base, status: 'Sem comunicação', color: 'red' as const,
                error: state.error, readAt: state.readAt };
            if (Date.now() - state.readAt.getTime() > Math.max(1_000, signal.pollingMs * 3)) {
                return { ...base, status: 'Leitura desatualizada', color: 'red' as const,
                    error: 'O status da máquina não foi atualizado no prazo esperado.', readAt: state.readAt };
            }
            const raw = typeof state.value === 'boolean' ? Number(state.value) : state.value;
            const value = this.mappedValue(signal, state.value);
            const mapping = signal.machineStatus!.mappings.find(item => item.value === value);
            return { ...base, value, rawValue: raw, status: mapping?.label ?? `Estado ${value}`,
                color: mapping?.color ?? 'gray' as const, readAt: state.readAt };
        });
    }
    async operational() {
        await this.loadConfiguration();
        const commands = (await this.repository.commandsFor(this.lineId)).filter(item => item.enabled && item.visible !== false)
            .sort((left, right) => (left.order ?? 0) - (right.order ?? 0) || left.label.localeCompare(right.label));
        const activeAlarms = [...this.activeAlarms.values()].sort((left, right) => right.openedAt.getTime() - left.openedAt.getTime());
        return {
            commands: commands.map(command => {
                const blockedReasons = this.commandFailures(command);
                const targets = [this.targetForSignal(command), ...(command.replicaPlcIds ?? []).map(plcId =>
                    this.targetForSignal({ plcId }))].filter((target): target is PlcTarget => !!target);
                if (!targets.length) blockedReasons.unshift('Nenhuma CLP vinculada está disponível.');
                if (targets.length && targets.every(target => this.executingTargets.has(target.id))) {
                    blockedReasons.unshift('Todas as CLPs disponíveis estão executando outro comando.');
                }
                return { ...command, available: blockedReasons.length === 0, blockedReasons };
            }),
            states: this.states(), machineStatuses: this.machineStatuses(),
            history: await this.repository.executionHistory(this.lineId, 30),
            signalActionHistory: await this.repository.signalActionHistory(this.lineId, 30), activeAlarms,
            alarmHistory: await (this.repository.alarmHistory?.(this.lineId, 30) ?? Promise.resolve([]))
        };
    }
    async alarms() {
        await this.loadConfiguration();
        return { active: [...this.activeAlarms.values()].sort((left, right) => right.openedAt.getTime() - left.openedAt.getTime()),
            history: await (this.repository.alarmHistory?.(this.lineId, 100) ?? Promise.resolve([])) };
    }
    async acknowledgeAlarm(occurrenceId: string, acknowledgedBy = 'IHM Principal') {
        await this.loadConfiguration();
        const id = occurrenceId.trim();
        if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new PlcSignalError(400, 'Identificador da ocorrência inválido.');
        const occurrence = [...this.activeAlarms.values()].find(item => item.occurrenceId === id)
            ?? await this.repository.alarmOccurrence?.(this.lineId, id);
        if (!occurrence) throw new PlcSignalError(404, 'Ocorrência de alarme não encontrada.');
        return this.withAlarmLock(occurrence.alarmId, async () => {
            const current = this.activeAlarms.get(occurrence.alarmId)
                ?? await this.repository.alarmOccurrence?.(this.lineId, id);
            if (!current || current.clearedAt) throw new PlcSignalError(409, 'O alarme já foi normalizado.');
            if (!current.requiresAcknowledgment) throw new PlcSignalError(409, 'Este alarme não exige reconhecimento.');
            if (!current.acknowledgedAt) {
                const now = new Date(); current.status = 'acknowledged'; current.acknowledgedAt = now;
                current.acknowledgedBy = acknowledgedBy.trim().slice(0, 100) || 'IHM Principal'; current.updatedAt = now;
                await this.repository.saveAlarmOccurrence?.(current); this.activeAlarms.set(current.alarmId, current);
            }
            return current;
        });
    }
    async lineStatus() {
        await this.loadConfiguration();
        const aggregate = this.aggregateStatusStates();
        if (aggregate.length) {
            const valid = aggregate.filter(item => item.state && !item.state.error && !item.stale && item.mapping);
            const critical = valid.filter(item => item.mapping!.color === 'red');
            const invalid = aggregate.filter(item => !item.state || item.state.error || item.stale || !item.mapping);
            const warning = valid.filter(item => item.mapping!.color === 'yellow');
            const signalIds = aggregate.map(item => item.signal.signalId);
            const readDates = aggregate.flatMap(item => item.state ? [item.state.readAt.getTime()] : []);
            const common = { configured: true, aggregate: true, signalIds,
                readAt: readDates.length ? new Date(Math.min(...readDates)) : undefined };
            if (critical.length) {
                return { ...common, label: critical.map(item => item.signal.label).join(' · '),
                    status: [...new Set(critical.map(item => item.mapping!.label))].join(' · '), color: 'red',
                    values: aggregate.map(item => ({ signalId: item.signal.signalId, value: item.value })) };
            }
            if (invalid.length) {
                const labels = invalid.map(item => item.signal.label).join(' · ');
                const details = invalid.map(item => !item.state ? `${item.signal.label}: aguardando leitura`
                    : item.state.error ? `${item.signal.label}: ${item.state.error}`
                    : item.stale ? `${item.signal.label}: leitura desatualizada`
                    : `${item.signal.label}: valor ${item.value} não mapeado`);
                return { ...common, label: labels, status: 'Falha de comunicação/status', color: 'red',
                    error: details.join(' · '), values: aggregate.map(item => ({ signalId: item.signal.signalId, value: item.value })) };
            }
            if (warning.length) {
                return { ...common, label: warning.map(item => item.signal.label).join(' · '),
                    status: [...new Set(warning.map(item => item.mapping!.label))].join(' · '), color: 'yellow',
                    values: aggregate.map(item => ({ signalId: item.signal.signalId, value: item.value })) };
            }
            const values = valid.map(item => item.value!);
            if (new Set(values).size === 1) {
                const mapping = valid[0]!.mapping!;
                return { ...common, label: `Status agregado · ${aggregate.length} CLPs`, value: values[0],
                    status: mapping.label, color: mapping.color,
                    values: aggregate.map(item => ({ signalId: item.signal.signalId, value: item.value })) };
            }
            return { ...common, label: `Status agregado · ${aggregate.length} CLPs`, status: 'Transição/divergência', color: 'blue',
                values: aggregate.map(item => ({ signalId: item.signal.signalId, value: item.value })) };
        }
        return { configured: false, label: 'Status da linha', status: 'Não configurado', color: 'gray' };
    }
    async execute(commandId: string) {
        await this.loadConfiguration();
        const command = await this.repository.command(this.lineId, commandId);
        if (!command) throw new PlcSignalError(404, 'Comando ativo não encontrado.');
        return this.executeReplicatedCommand(command, randomUUID());
    }
    async executeByCode(code: string, requestId: string, requestedBy?: string) {
        if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(code)) throw new PlcSignalError(400, 'Código de comando inválido.');
        if (!/^[A-Za-z0-9_-]{1,100}$/.test(requestId)) throw new PlcSignalError(400, 'requestId inválido.');
        await this.loadConfiguration();
        const replay = await this.repository.executionByRequest(this.lineId, requestId);
        if (replay) {
            if (replay.commandCode !== code) throw new PlcSignalError(409, 'requestId já utilizado por outro comando.');
            return replay;
        }
        const command = await this.repository.commandByCode(this.lineId, code);
        if (!command) throw new PlcSignalError(404, 'Comando ativo não encontrado.');
        return this.executeReplicatedCommand(command, requestId, requestedBy);
    }
    async preflightByCode(code: string) {
        if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(code)) throw new PlcSignalError(400, 'Código de comando inválido.');
        await this.loadConfiguration();
        const command = await this.repository.commandByCode(this.lineId, code);
        if (!command) throw new PlcSignalError(404, 'Comando START geral não encontrado.');
        const failures = this.commandFailures(command);
        if (failures.length) throw new PlcSignalError(409, failures.join(' '));
        const plcIds = [...new Set([command.plcId, ...(command.replicaPlcIds ?? [])].filter((item): item is string => !!item))];
        if (!plcIds.length) throw new PlcSignalError(409, 'Nenhuma CLP foi vinculada ao comando START geral.');
        const probes = await Promise.allSettled(plcIds.map(async plcId => {
            const target = this.targetForSignal({ plcId });
            if (!target) throw new Error(`CLP ${plcId} não está ativa ou configurada.`);
            if (this.executingTargets.has(target.id)) throw new Error(`${this.devices.find(item => item.plcId === plcId)?.name ?? plcId} está executando outro comando.`);
            const session = this.session(target), observed = await this.readCommandAddress(session, { ...command, plcId });
            session.confirmReconciled();
            if (command.mode === 'pulse') {
                const baseline = command.commandType === 'coil' ? Boolean(command.resetValue ?? 0) : command.resetValue ?? 0;
                if (observed !== baseline) throw new Error(`${command.plcAddress} já está ativo em ${this.devices.find(item => item.plcId === plcId)?.name ?? plcId}.`);
            }
            return this.devices.find(item => item.plcId === plcId)?.name ?? plcId;
        }));
        const rejected = probes.flatMap((item, index) => item.status === 'rejected'
            ? [item.reason instanceof Error ? item.reason.message : `CLP ${plcIds[index]} indisponível.`] : []);
        if (rejected.length) throw new PlcSignalError(503, `START bloqueado: ${rejected.join(' ')}`);
        return { commandCode: command.code ?? command.commandId, label: command.label,
            targets: probes.flatMap(item => item.status === 'fulfilled' ? [item.value] : []) };
    }
    private async executeReplicatedCommand(command: PlcCommand, requestId: string, requestedBy?: string): Promise<PlcCommandExecution> {
        const plcIds = [...new Set([command.plcId, ...(command.replicaPlcIds ?? [])].filter((item): item is string => !!item))];
        if (!plcIds.length) return this.executeCommand(command, requestId, requestedBy);
        const attempts = await Promise.allSettled(plcIds.map((plcId, index) => {
            const device = this.devices.find(item => item.plcId === plcId);
            const targetCommand: PlcCommand = { ...command, plcId, replicaPlcIds: undefined,
                label: plcIds.length > 1 ? `${command.label} · ${device?.name ?? plcId}` : command.label,
                ...(index === 0 ? {} : { ackSignalId: undefined, businessAction: 'plc_only' as const }) };
            const targetRequestId = index === 0 ? requestId : `${requestId.slice(0, 96)}_${index}`;
            return this.executeCommand(targetCommand, targetRequestId, requestedBy);
        }));
        const dispatches = attempts.map((attempt, index) => ({ plcId: plcIds[index]!,
            plcName: this.devices.find(item => item.plcId === plcIds[index])?.name,
            status: attempt.status === 'fulfilled' ? attempt.value.status : 'failed' as const,
            ...(attempt.status === 'rejected' ? { error: attempt.reason instanceof Error ? attempt.reason.message : 'Falha não identificada.' } : {}) }));
        const completed = attempts.flatMap(attempt => attempt.status === 'fulfilled' ? [attempt.value] : []);
        if (!completed.length) throw attempts.find(attempt => attempt.status === 'rejected')?.reason
            ?? new PlcSignalError(503, 'Nenhuma CLP recebeu o comando.');
        const failed = dispatches.filter(item => item.status !== 'completed');
        const result = completed[0]!; result.dispatches = dispatches;
        if (failed.length) result.warning = `Comando enviado para ${completed.length} de ${plcIds.length} CLPs. Sem confirmação: ${failed.map(item => item.plcName ?? item.plcId).join(', ')}.`;
        return result;
    }
    private interlockFailures(command: PlcCommand): string[] {
        return (command.interlocks ?? []).flatMap(interlock => {
            const configured = this.signals.find(signal => signal.signalId === interlock.signalId && signal.enabled);
            if (!configured) return [`${interlock.message} Sinal não está mais ativo na configuração.`];
            const state = this.state.get(interlock.signalId);
            if (!state) return [`${interlock.message} Sinal ainda não foi lido.`];
            if (state.error) return [`${interlock.message} Erro de comunicação: ${state.error}`];
            if (Date.now() - state.readAt.getTime() > Math.max(1_000, configured.pollingMs * 3)) {
                return [`${interlock.message} Leitura do sinal está desatualizada.`];
            }
            if (interlock.blockedValues?.length) {
                const value = typeof state.value === 'boolean' ? Number(state.value) : state.value;
                return interlock.blockedValues.includes(value) ? [interlock.message] : [];
            }
            return state.active === interlock.requiredActive ? [] : [interlock.message];
        });
    }
    private commandFailures(command: PlcCommand): string[] {
        const failures = this.interlockFailures(command);
        if (command.ackSignalId && !this.signals.some(signal => signal.signalId === command.ackSignalId && signal.enabled)) {
            failures.push('Sinal de confirmação da CLP não está ativo.');
        }
        if (command.scope === 'machine' && (!command.targetMachineId
            || !this.line?.machines.some(machine => machine.machineId === command.targetMachineId))) {
            failures.push('Máquina de destino não está mais cadastrada na linha.');
        }
        return failures;
    }
    private async persist(execution: PlcCommandExecution, status: PlcCommandExecutionStatus, step: string,
        stepStatus: 'completed' | 'failed' = 'completed', message?: string) {
        const now = new Date(); execution.status = status; execution.updatedAt = now;
        execution.steps.push({ name: step, status: stepStatus, at: now, ...(message ? { message } : {}) });
        if (status === 'completed' || status === 'failed' || status === 'uncertain') execution.completedAt = now;
        if (message && stepStatus === 'failed') execution.error = message;
        await this.repository.saveExecution(execution);
        if (status === 'completed' || status === 'failed' || status === 'uncertain') {
            this.recordOperational({ category: 'plc', action: status === 'completed' ? 'PLC_COMMAND_COMPLETED' : 'PLC_COMMAND_FAILED',
                description: status === 'completed' ? `Comando ${execution.label} concluído.`
                    : `Comando ${execution.label} terminou como ${status === 'uncertain' ? 'incerto' : 'falha'}.`,
                outcome: status === 'completed' ? 'success' : 'failure', resource: execution.commandCode,
                actorLabel: execution.requestedBy ?? 'Sistema', details: { executionId: execution.executionId,
                    commandCode: execution.commandCode, status, ...(message ? { error: message.slice(0, 300) } : {}) } });
        }
    }
    private auditCommand(event: PlcCommandTextLogEvent, execution: PlcCommandExecution, command: PlcCommand,
        details: PlcCommandTextLogDetails = {}) {
        this.commandTextLog?.add(event, execution, command, details);
    }
    private recordOperational(value: Parameters<OperationalLogService['recordSystem']>[0]) {
        void this.operationalLog?.recordSystem(value).catch(error => console.error('[OPERATIONAL_LOG]',
            error instanceof Error ? error.message : error));
    }
    private async write(session: MachineModbusSession, command: PlcCommand, value: number) {
        if (command.commandType === 'coil') await session.writeCoil(command.address, Boolean(value));
        else await session.writeRegisters(command.address, [value]);
    }
    private async readCommandAddress(session: MachineModbusSession, command: PlcCommand): Promise<number | boolean> {
        if (command.commandType === 'coil') return (await session.readCoils(command.address))[0];
        return (await session.readHoldingRegisters(command.address, 1))[0];
    }
    private async probeCommandTarget(session: MachineModbusSession, command: PlcCommand, deadline: number,
        execution: PlcCommandExecution, details: PlcCommandTextLogDetails): Promise<number | boolean> {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
            if (Date.now() >= deadline) break;
            try {
                const observedValue = await this.readCommandAddress(session, command);
                if (Date.now() >= deadline) {
                    throw new PlcSignalError(503, 'A comunicação demorou demais. O comando não foi enviado.');
                }
                this.auditCommand('PREFLIGHT_COMPLETED', execution, command,
                    { ...details, attempt, observedValue, durationMs: Date.now() - (execution.requestedAt?.getTime() ?? Date.now()) });
                return observedValue;
            } catch (error) {
                lastError = error;
                if (error instanceof PlcSignalError) break;
            }
        }
        const suffix = lastError instanceof Error ? ` ${lastError.message}` : '';
        throw new PlcSignalError(503, `Comunicação com a CLP indisponível. O comando não foi enviado.${suffix}`);
    }
    private async executeCommand(command: PlcCommand, requestId: string, requestedBy?: string): Promise<PlcCommandExecution> {
        if (!command || !command.enabled) throw new PlcSignalError(404, 'Comando ativo não encontrado.');
        const now = new Date(), execution: PlcCommandExecution = {
            executionId: randomUUID(), requestId, lineId: this.lineId, commandId: command.commandId,
            commandCode: command.code ?? command.commandId, label: command.label, status: 'requested',
            ...(requestedBy ? { requestedBy } : {}), requestedAt: now, updatedAt: now, steps: []
        };
        try { await this.repository.createExecution(execution); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) {
                const replay = await this.repository.executionByRequest(this.lineId, requestId);
                if (replay && replay.commandCode === execution.commandCode) return replay;
            }
            throw error;
        }
        const executionStartedAt = Date.now();
        this.auditCommand('REQUESTED', execution, command);
        const target = this.targetForSignal(command);
        if (!target) {
            const message = 'CLP ativa do comando não encontrada.';
            await this.persist(execution, 'failed', 'target_validation_failed', 'failed', message);
            this.auditCommand('REJECTED', execution, command, { reason: message, totalDurationMs: Date.now() - executionStartedAt });
            throw new PlcSignalError(404, message);
        }
        if (this.executingTargets.has(target.id)) {
            const message = 'A CLP está executando outro comando.';
            await this.persist(execution, 'failed', 'concurrency_validation_failed', 'failed', message);
            this.auditCommand('REJECTED', execution, command, { targetId: target.id, logId: target.logId,
                reason: message, totalDurationMs: Date.now() - executionStartedAt });
            throw new PlcSignalError(409, message);
        }
        this.executingTargets.add(target.id);
        let written = false, session: MachineModbusSession | undefined;
        let writeStage: { key: 'active_value' | 'pulse_reset'; label: string; value: number } | undefined;
        try {
            await this.persist(execution, 'validating', 'request_registered');
            const targetDetails = { targetId: target.id, logId: target.logId, host: target.host, port: target.port,
                unitId: target.unitId, connectionTimeoutMs: target.timeoutMs };
            const preflightStartedAt = Date.now();
            this.auditCommand('PREFLIGHT_STARTED', execution, command, targetDetails);
            session = this.session(target);
            // A leitura e inofensiva e serve para detectar/reabrir uma conexao TCP obsoleta.
            // Mesmo que a rede retorne depois, nunca escrevemos apos o prazo do preflight.
            const preflightDeadline = preflightStartedAt
                + Math.min(5_000, Math.max(1_500, (target.timeoutMs ?? 3_000) + 500));
            const observedValue = await this.probeCommandTarget(session, command, preflightDeadline,
                execution, targetDetails);
            if (command.mode === 'pulse') {
                const expectedBaseline = command.commandType === 'coil' ? Boolean(command.resetValue ?? 0) : command.resetValue ?? 0;
                if (observedValue !== expectedBaseline) {
                    throw new PlcSignalError(409,
                        `O endereço ${command.plcAddress} já está ativo. O comando não foi reenviado.`);
                }
            }
            // Uma leitura valida do valor de repouso reconcilia eventual socket rompido sem repetir escrita.
            session.confirmReconciled();
            const failures = this.commandFailures(command);
            if (failures.length) throw new PlcSignalError(409, failures.join(' '));
            const action = this.businessActions[command.businessAction ?? 'plc_only'];
            await action?.before?.({ command, execution });
            if (Date.now() >= preflightDeadline) {
                throw new PlcSignalError(503, 'A validação demorou demais. O comando não foi enviado.');
            }
            await this.persist(execution, 'sending', 'interlocks_validated');
            const effectivePulseMs = command.mode === 'pulse' ? enforcedPlcPulseMs(command.pulseMs) : undefined;
            // Configurações legadas podem ter timeout menor que o novo pulso mínimo.
            const deadline = Date.now() + Math.max(command.ackTimeoutMs,
                effectivePulseMs === undefined ? 0 : effectivePulseMs + 100);
            writeStage = { key: 'active_value', label: 'valor ativo', value: command.value };
            const writeStartedAt = Date.now();
            this.auditCommand('WRITE_STARTED', execution, command,
                { ...targetDetails, step: writeStage.key, attemptedValue: writeStage.value });
            await this.write(session, command, command.value); written = true; writeStage = undefined;
            this.auditCommand('WRITE_COMPLETED', execution, command,
                { ...targetDetails, step: 'active_value', attemptedValue: command.value, durationMs: Date.now() - writeStartedAt });
            communicationLog.add(target.logId, 'NODE_TO_PLC', 'PLC_COMMAND_SENT',
                `${command.label}: comando ${command.code ?? command.commandId} enviado.`, {
                    executionId: execution.executionId, commandId: command.commandId, plcAddress: command.plcAddress,
                    modbusAddress: command.address, commandType: command.commandType,
                    functionCode: command.commandType === 'coil' ? 'FC05' : 'FC16',
                    step: 'active_value', value: command.value, mode: command.mode ?? 'maintained',
                    ...(effectivePulseMs === undefined ? {} : { pulseMs: effectivePulseMs })
                });
            const waitsForAck = !!command.ackSignalId;
            await this.persist(execution, waitsForAck ? 'waiting_ack' : 'sending', 'plc_write_completed');
            let acknowledged = false;
            if (command.mode === 'pulse') {
                const resetAt = Date.now() + effectivePulseMs!;
                while (Date.now() < resetAt) {
                    if (waitsForAck) {
                        acknowledged ||= this.state.get(command.ackSignalId!)?.active === true;
                    }
                    await sleep(Math.min(100, Math.max(1, resetAt - Date.now())));
                }
                const resetValue = command.resetValue ?? 0;
                writeStage = { key: 'pulse_reset', label: 'retorno do pulso', value: resetValue };
                const resetStartedAt = Date.now();
                this.auditCommand('PULSE_RESET_STARTED', execution, command,
                    { ...targetDetails, step: writeStage.key, attemptedValue: writeStage.value });
                await this.write(session, command, resetValue); writeStage = undefined;
                this.auditCommand('PULSE_RESET_COMPLETED', execution, command,
                    { ...targetDetails, step: 'pulse_reset', attemptedValue: resetValue, durationMs: Date.now() - resetStartedAt });
                communicationLog.add(target.logId, 'NODE_TO_PLC', 'PLC_COMMAND_PULSE_RESET',
                    `${command.label}: retorno do pulso escrito com valor ${resetValue}.`, {
                        executionId: execution.executionId, commandId: command.commandId, plcAddress: command.plcAddress,
                        modbusAddress: command.address, commandType: command.commandType,
                        functionCode: command.commandType === 'coil' ? 'FC05' : 'FC16',
                        step: 'pulse_reset', value: resetValue, mode: 'pulse', pulseMs: effectivePulseMs
                    });
                await this.persist(execution, waitsForAck ? 'waiting_ack' : 'sending', 'pulse_reset_completed');
            }
            if (!waitsForAck) {
                session.confirmReconciled();
                await this.persist(execution, 'completing', 'business_action_started');
                await action?.after?.({ command, execution });
                await this.persist(execution, 'completed', 'business_action_completed');
                this.auditCommand('COMPLETED', execution, command,
                    { ...targetDetails, waitsForAck: false, totalDurationMs: Date.now() - executionStartedAt });
                communicationLog.add(target.logId, 'SYSTEM', 'PLC_COMMAND_COMPLETED',
                    `${command.label}: escrita concluída sem confirmação da CLP.`, { executionId: execution.executionId });
                return execution;
            }
            const ackStartedAt = Date.now();
            this.auditCommand('ACK_WAIT_STARTED', execution, command, { ...targetDetails, waitsForAck: true });
            while (Date.now() < deadline) {
                if (!acknowledged) {
                    acknowledged = this.state.get(command.ackSignalId!)?.active === true;
                }
                if (acknowledged) {
                    session.confirmReconciled();
                    await this.persist(execution, 'acknowledged', 'plc_acknowledged');
                    this.auditCommand('ACK_RECEIVED', execution, command,
                        { ...targetDetails, waitsForAck: true, durationMs: Date.now() - ackStartedAt });
                    await this.persist(execution, 'completing', 'business_action_started');
                    await action?.after?.({ command, execution });
                    await this.persist(execution, 'completed', 'business_action_completed');
                    this.auditCommand('COMPLETED', execution, command,
                        { ...targetDetails, waitsForAck: true, totalDurationMs: Date.now() - executionStartedAt });
                    communicationLog.add(target.logId, 'SYSTEM', 'PLC_COMMAND_COMPLETED',
                        `${command.label}: comando confirmado e concluído.`, { executionId: execution.executionId });
                    return execution;
                }
                await sleep(100);
            }
            throw new PlcSignalError(409, 'CLP não confirmou o comando dentro do tempo configurado.');
        } catch (error) {
            const rawMessage = (error as Error).message;
            const writeFailure = error instanceof MachineCommunicationError && error.outcomeUnknown;
            const writeDescription = writeFailure && writeStage
                ? ` Falha na etapa ${writeStage.label}: valor ${writeStage.value}, ${command.commandType === 'coil' ? 'FC05' : 'FC16'}, endereço Modbus ${command.address}.`
                : '';
            const message = `${rawMessage}${writeDescription}`;
            const outcomeUnknown = written || error instanceof MachineCommunicationError && error.outcomeUnknown;
            // Sem um ACK configurado, a confirmação funcional é opcional. Mantemos a tentativa como
            // incerta para auditoria, mas não bloqueamos START/STOP posteriores na mesma CLP.
            if (outcomeUnknown && !command.ackSignalId) session?.confirmReconciled();
            await this.persist(execution, outcomeUnknown ? 'uncertain' : 'failed', 'execution_failed', 'failed', message);
            this.auditCommand('FAILED', execution, command, {
                targetId: target.id, logId: target.logId, host: target.host, port: target.port, unitId: target.unitId,
                connectionTimeoutMs: target.timeoutMs, ...(writeStage ? { step: writeStage.key, attemptedValue: writeStage.value } : {}),
                outcomeUnknown, error: message, totalDurationMs: Date.now() - executionStartedAt
            });
            communicationLog.add(target.logId, 'SYSTEM', 'PLC_COMMAND_FAILED', `${command.label}: ${message}`,
                { executionId: execution.executionId, commandId: command.commandId, plcAddress: command.plcAddress,
                    modbusAddress: command.address, commandType: command.commandType,
                    functionCode: command.commandType === 'coil' ? 'FC05' : 'FC16',
                    ...(writeStage ? { failedStep: writeStage.key, attemptedValue: writeStage.value } : {}),
                    mode: command.mode ?? 'maintained' }, 'error');
            throw error;
        } finally { this.executingTargets.delete(target.id); }
    }
}
