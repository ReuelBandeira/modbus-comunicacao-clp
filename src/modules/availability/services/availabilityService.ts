import { randomUUID } from 'node:crypto';
import type { PCM } from '../../pcm/models/pcmModel';
import type { PcmWorkflowRepositoryContract } from '../../pcm/repositories/pcmWorkflowRepository';
import { buildChipMetrics, chipMetricsWindow } from '../../pcm/workflow/services/chipMetricsService';
import type { Shift } from '../../shifts/models/shiftModel';
import type { ShiftRepository } from '../../shifts/repositories/shiftRepository';
import { shiftsOverlap } from '../../shifts/services/shiftService';
import type { DowntimeEvent, DowntimeReason, OeeConfiguration, PhysicalLineStateSnapshot, PhysicalMonitoringConfiguration,
    ProductionCalendarException, ProductionPeriod, ShiftBreak } from '../models/availabilityModel';
import type { AvailabilityRepository } from '../repositories/availabilityRepository';
import type { OperationalLogService } from '../../operationalLogs/services/operationalLogService';

export class AvailabilityError extends Error {
    constructor(public readonly status: 400 | 401 | 404 | 409 | 503, message: string) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[A-Za-z0-9_-]{1,40}$/;
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const DEFAULT_PHYSICAL_MONITORING: PhysicalMonitoringConfiguration = {
    enabled: false, strategy: 'serial_any_running', stopConfirmationMs: 5000, resumeConfirmationMs: 2000,
    manualContingencyEnabled: true, manualContingencyRequiresAdmin: true
};
type Interval = { start: Date; end: Date };

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AvailabilityError(400, 'Informe um objeto JSON.');
    return value as Record<string, unknown>;
}
function only(input: Record<string, unknown>, keys: string[]) {
    if (Object.keys(input).some(key => !keys.includes(key))) throw new AvailabilityError(400, 'A requisicao possui campos nao permitidos.');
}
function text(value: unknown, label: string, maximum: number, required = true): string | undefined {
    if (value === undefined && !required) return undefined;
    if (typeof value !== 'string' || (required && !value.trim()) || value.trim().length > maximum) {
        throw new AvailabilityError(400, `${label} invalido.`);
    }
    return value.trim() || undefined;
}
function boolean(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw new AvailabilityError(400, `${label} deve ser booleano.`);
    return value;
}
function id(value: unknown, label: string): string {
    if (typeof value !== 'string' || !UUID.test(value)) throw new AvailabilityError(400, `${label} invalido.`);
    return value;
}
function time(value: unknown, label: string): string {
    if (typeof value !== 'string' || !TIME.test(value)) throw new AvailabilityError(400, `${label} deve usar HH:mm.`);
    return value;
}
function minute(value: string) { const [hour, minutes] = value.split(':').map(Number); return hour * 60 + minutes; }
function segments(start: string, end: string): Array<[number, number]> {
    const a = minute(start), b = minute(end);
    return b > a ? [[a, b]] : [[a, 1440], [0, b]];
}
function withinShift(item: Pick<ShiftBreak, 'startTime' | 'endTime'>, shift: Shift) {
    return segments(item.startTime, item.endTime).every(([start, end]) =>
        segments(shift.startTime, shift.endTime).some(([shiftStart, shiftEnd]) => start >= shiftStart && end <= shiftEnd));
}
function localDate(value: Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}
function dateParts(value: string) { return value.split('-').map(Number) as [number, number, number]; }
function localAt(date: string, value: string, nextDay = false) {
    const [year, month, day] = dateParts(date), [hour, minutes] = value.split(':').map(Number);
    return new Date(year, month - 1, day + (nextDay ? 1 : 0), hour, minutes, 0, 0);
}
function operationalWindow(date: string, shift: Pick<Shift, 'startTime' | 'endTime'>): Interval {
    return { start: localAt(date, shift.startTime), end: localAt(date, shift.endTime, minute(shift.endTime) <= minute(shift.startTime)) };
}
function breakWindow(date: string, shift: Shift, item: ShiftBreak): Interval {
    const overnight = minute(shift.endTime) <= minute(shift.startTime);
    const startsNextDay = overnight && minute(item.startTime) < minute(shift.startTime);
    const start = localAt(date, item.startTime, startsNextDay);
    const end = localAt(date, item.endTime, startsNextDay || minute(item.endTime) <= minute(item.startTime));
    return { start, end };
}
function clip(interval: Interval, from: Date, to: Date): Interval | undefined {
    const start = new Date(Math.max(interval.start.getTime(), from.getTime()));
    const end = new Date(Math.min(interval.end.getTime(), to.getTime()));
    return start < end ? { start, end } : undefined;
}
function merge(values: Interval[]): Interval[] {
    const sorted = values.filter(value => value.start < value.end).sort((a, b) => a.start.getTime() - b.start.getTime());
    const result: Interval[] = [];
    for (const value of sorted) {
        const last = result.at(-1);
        if (!last || value.start > last.end) result.push({ start: value.start, end: value.end });
        else if (value.end > last.end) last.end = value.end;
    }
    return result;
}
function subtract(base: Interval[], exclusions: Interval[]): Interval[] {
    let result = merge(base);
    for (const exclusion of merge(exclusions)) {
        result = result.flatMap(value => {
            if (exclusion.end <= value.start || exclusion.start >= value.end) return [value];
            const parts: Interval[] = [];
            if (exclusion.start > value.start) parts.push({ start: value.start, end: exclusion.start });
            if (exclusion.end < value.end) parts.push({ start: exclusion.end, end: value.end });
            return parts;
        });
    }
    return result;
}
function duration(values: Interval[]) { return values.reduce((total, value) => total + value.end.getTime() - value.start.getTime(), 0); }
function intersections(first: Interval[], second: Interval[]) {
    return merge(first.flatMap(a => second.flatMap(b => {
        const value = clip(a, b.start, b.end); return value ? [value] : [];
    })));
}
function percentage(value: number, total: number) { return total > 0 ? Math.round(value / total * 10000) / 100 : null; }
function scheduledOccurrence(shifts: Shift[], exceptions: ProductionCalendarException[], at = new Date()) {
    const previous = new Date(at); previous.setDate(previous.getDate() - 1);
    for (const date of [localDate(previous), localDate(at)]) {
        for (const shift of shifts) {
            const exception = exceptions.find(item => item.date === date && item.shiftId === shift.shiftId);
            const window = operationalWindow(date, shift);
            if (at < window.start || at >= window.end) continue;
            if (shift.active && exception?.productionEnabled === false) return { shift, date, productionEnabled: false };
            if (shift.active || exception?.productionEnabled === true) return { shift, date, productionEnabled: true };
        }
    }
    return null;
}

export class AvailabilityService {
    private physicalState?: PhysicalLineStateSnapshot;
    constructor(private readonly repository: AvailabilityRepository, private readonly shifts: ShiftRepository,
        private readonly pcms: PcmWorkflowRepositoryContract, private readonly lineId: string,
        private readonly operationalLog?: OperationalLogService) {}

    listReasons() { return this.repository.listReasons(); }
    async configuration() { return this.configurationView(await this.repository.configuration(this.lineId)); }
    async updateConfiguration(value: unknown) {
        const input = object(value); only(input, ['idealCycleTimeSeconds', 'physicalMonitoring']);
        if (!Object.keys(input).length) throw new AvailabilityError(400, 'Informe ao menos uma configuracao do OEE.');
        const current = await this.repository.configuration(this.lineId);
        let idealCycleTimeMs = current?.idealCycleTimeMs;
        if (input.idealCycleTimeSeconds !== undefined) {
            const seconds = input.idealCycleTimeSeconds;
            if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0.001 || seconds > 3600) {
                throw new AvailabilityError(400, 'Tempo de ciclo ideal deve estar entre 0,001 e 3600 segundos.');
            }
            idealCycleTimeMs = Math.round(seconds * 1000);
        }
        const physicalMonitoring = input.physicalMonitoring === undefined ? current?.physicalMonitoring
            : await this.parsePhysicalMonitoring(input.physicalMonitoring);
        const configuration: OeeConfiguration = { lineId: this.lineId, ...(idealCycleTimeMs ? { idealCycleTimeMs } : {}),
            ...(physicalMonitoring ? { physicalMonitoring } : {}), updatedAt: new Date() };
        await this.repository.saveConfiguration(configuration);
        if (input.physicalMonitoring !== undefined) this.physicalState = undefined;
        return this.configurationView(configuration);
    }
    async createReason(value: unknown) {
        const parsed = this.parseReason(value), now = new Date();
        const reason: DowntimeReason = { reasonId: randomUUID(), ...parsed, createdAt: now, updatedAt: now };
        try { await this.repository.createReason(reason); } catch (error) { this.duplicate(error, 'Ja existe um motivo com esse codigo.'); }
        return reason;
    }
    async updateReason(reasonId: string, value: unknown) {
        id(reasonId, 'Identificador do motivo');
        const parsed = this.parseReason(value), now = new Date();
        if (!parsed.active && await this.isActivePhysicalDefaultReason(reasonId)) {
            throw new AvailabilityError(409, 'Motivo inicial do estado fisico: desative o monitoramento antes de inativar o cadastro.');
        }
        try {
            const updated = await this.repository.updateReason(reasonId, { ...parsed, updatedAt: now });
            if (!updated) throw new AvailabilityError(404, 'Motivo de parada nao encontrado.');
            return updated;
        } catch (error) { this.duplicate(error, 'Ja existe um motivo com esse codigo.'); throw error; }
    }
    async removeReason(reasonId: string) {
        id(reasonId, 'Identificador do motivo');
        if (await this.isActivePhysicalDefaultReason(reasonId)) {
            throw new AvailabilityError(409, 'Motivo inicial do estado fisico: desative o monitoramento antes de remover o cadastro.');
        }
        if (await this.repository.reasonInUse(reasonId)) {
            throw new AvailabilityError(409, 'Motivo ja utilizado em paradas. Desative o cadastro para preservar o historico.');
        }
        if (!await this.repository.removeReason(reasonId)) throw new AvailabilityError(404, 'Motivo de parada nao encontrado.');
    }

    listBreaks() { return this.repository.listBreaks(); }
    async createBreak(value: unknown) {
        const parsed = await this.parseBreak(value), now = new Date();
        const item: ShiftBreak = { breakId: randomUUID(), ...parsed, createdAt: now, updatedAt: now };
        await this.validateBreakOverlap(item); await this.repository.createBreak(item); return item;
    }
    async updateBreak(breakId: string, value: unknown) {
        id(breakId, 'Identificador da pausa');
        const parsed = await this.parseBreak(value), now = new Date();
        await this.validateBreakOverlap({ breakId, ...parsed, createdAt: now, updatedAt: now }, breakId);
        const updated = await this.repository.updateBreak(breakId, { ...parsed, updatedAt: now });
        if (!updated) throw new AvailabilityError(404, 'Pausa nao encontrada.');
        return updated;
    }
    async removeBreak(breakId: string) {
        id(breakId, 'Identificador da pausa');
        if (!await this.repository.removeBreak(breakId)) throw new AvailabilityError(404, 'Pausa nao encontrada.');
    }

    listCalendar(from?: unknown, to?: unknown) {
        const start = from === undefined ? undefined : this.date(from), end = to === undefined ? undefined : this.date(to);
        if (!!start !== !!end) throw new AvailabilityError(400, 'Informe inicio e fim do periodo do calendario.');
        return this.repository.listCalendar(this.lineId, start, end);
    }
    async createCalendar(value: unknown) {
        const input = object(value); only(input, ['shiftId', 'date', 'productionEnabled', 'notes']);
        const shiftId = id(input.shiftId, 'Identificador do turno');
        if (!await this.shifts.get(shiftId)) throw new AvailabilityError(404, 'Turno nao encontrado.');
        const now = new Date();
        const item: ProductionCalendarException = { exceptionId: randomUUID(), lineId: this.lineId, shiftId,
            date: this.date(input.date), productionEnabled: boolean(input.productionEnabled, 'Producao habilitada'),
            notes: text(input.notes, 'Observacao', 300, false), createdAt: now, updatedAt: now };
        try { await this.repository.createCalendar(item); }
        catch (error) { this.duplicate(error, 'Ja existe uma excecao para esse turno e data.'); }
        return item;
    }
    async removeCalendar(exceptionId: string) {
        id(exceptionId, 'Identificador da excecao');
        if (!await this.repository.removeCalendar(exceptionId)) throw new AvailabilityError(404, 'Excecao de calendario nao encontrada.');
    }

    async current() {
        const now = new Date(), previous = new Date(now); previous.setDate(previous.getDate() - 1);
        const [event, recent, shifts, exceptions, breaks, configuration] = await Promise.all([
            this.repository.openEvent(this.lineId), this.repository.recentEvents(this.lineId), this.shifts.list(),
            this.repository.listCalendar(this.lineId, localDate(previous), localDate(now)), this.repository.listBreaks(),
            this.repository.configuration(this.lineId)
        ]);
        const occurrence = scheduledOccurrence(shifts, exceptions, now);
        const currentPeriod = occurrence
            ? await this.ensurePeriod(occurrence.shift, occurrence.date, occurrence.productionEnabled, breaks)
            : null;
        const currentShift = occurrence?.productionEnabled ? occurrence.shift : null;
        const monitoring = configuration?.physicalMonitoring ?? DEFAULT_PHYSICAL_MONITORING;
        const physicalState = monitoring.enabled ? this.physicalState ?? {
            state: 'UNKNOWN' as const, strategy: monitoring.strategy, signals: [],
            reason: 'Aguardando a primeira consolidação dos sinais das CLPs.', capturedAt: now
        } : undefined;
        const state = event ? 'STOPPED' : !currentShift ? 'IDLE'
            : physicalState ? physicalState.state : 'RUNNING';
        const manualAllowed = !monitoring.enabled || physicalState?.state === 'UNKNOWN' && monitoring.manualContingencyEnabled;
        return { lineId: this.lineId, state, openEvent: event, physicalState,
            physicalMonitoring: { enabled: monitoring.enabled, strategy: monitoring.strategy },
            manualStop: { allowed: manualAllowed, requiresAdmin: monitoring.enabled && monitoring.manualContingencyRequiresAdmin,
                reason: manualAllowed ? undefined : physicalState?.state === 'RUNNING'
                    ? 'A linha está fisicamente produzindo.' : 'Aguarde a consolidação automática da parada.' },
            currentShift, currentPeriod, recentEvents: recent, capturedAt: now };
    }
    async stop(value: unknown, adminAuthorized = false) {
        const input = object(value); only(input, ['reasonId', 'notes', 'requestId']);
        const requestId = id(input.requestId, 'Identificador da requisicao');
        const replay = await this.repository.eventByStartRequest(requestId); if (replay) return replay;
        const reasonId = id(input.reasonId, 'Identificador do motivo'), reason = await this.repository.reason(reasonId);
        if (!reason || !reason.active) throw new AvailabilityError(404, 'Motivo de parada ativo nao encontrado.');
        const configuration = await this.repository.configuration(this.lineId), monitoring = configuration?.physicalMonitoring;
        if (monitoring?.enabled) {
            const state = this.physicalState?.state ?? 'UNKNOWN';
            if (state !== 'UNKNOWN') throw new AvailabilityError(409, state === 'RUNNING'
                ? 'A parada manual foi bloqueada porque as CLPs indicam linha em producao.'
                : 'Aguarde o apontamento automatico do estado fisico da linha.');
            if (!monitoring.manualContingencyEnabled) {
                throw new AvailabilityError(409, 'Apontamento manual de contingencia desabilitado.');
            }
            if (monitoring.manualContingencyRequiresAdmin && !adminAuthorized) {
                throw new AvailabilityError(401, 'A contingencia manual exige autenticacao ADMIN.');
            }
        }
        const open = await this.repository.openEvent(this.lineId);
        if (open) throw new AvailabilityError(409, `A linha ja esta parada por ${open.reason.name}.`);
        const now = new Date();
        const event: DowntimeEvent = { eventId: randomUUID(), lineId: this.lineId, status: 'open', startedAt: now,
            reason: { reasonId: reason.reasonId, code: reason.code, name: reason.name,
                classification: reason.classification, countsAgainstAvailability: reason.countsAgainstAvailability },
            source: 'manual', notes: text(input.notes, 'Observacao', 500, false), startRequestId: requestId,
            createdAt: now, updatedAt: now };
        try { await this.repository.createEvent(event); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) {
                const duplicate = await this.repository.eventByStartRequest(requestId); if (duplicate) return duplicate;
                throw new AvailabilityError(409, 'A linha ja possui uma parada aberta.');
            }
            throw error;
        }
        return event;
    }
    async resume(value: unknown) {
        const input = object(value); only(input, ['requestId']);
        const requestId = id(input.requestId, 'Identificador da requisicao');
        const replay = await this.repository.eventByEndRequest(requestId); if (replay) return replay;
        const [open, configuration] = await Promise.all([
            this.repository.openEvent(this.lineId), this.repository.configuration(this.lineId)
        ]);
        if (open?.source === 'plc' && configuration?.physicalMonitoring?.enabled) {
            throw new AvailabilityError(409, 'Parada automatica: a retomada sera confirmada pelos sinais das CLPs.');
        }
        try {
            const event = await this.repository.closeEvent(this.lineId, requestId, new Date());
            if (event) return event;
        } catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
        }
        const duplicate = await this.repository.eventByEndRequest(requestId); if (duplicate) return duplicate;
        throw new AvailabilityError(409, 'A linha nao possui uma parada aberta.');
    }

    async classify(eventIdValue: string, value: unknown) {
        const eventId = id(eventIdValue, 'Identificador da parada');
        const input = object(value); only(input, ['reasonId', 'notes']);
        const reasonId = id(input.reasonId, 'Identificador do motivo'), reason = await this.repository.reason(reasonId);
        if (!reason || !reason.active) throw new AvailabilityError(404, 'Motivo de parada ativo nao encontrado.');
        const event = await this.repository.classifyEvent(this.lineId, eventId, {
            reasonId: reason.reasonId, code: reason.code, name: reason.name,
            classification: reason.classification, countsAgainstAvailability: reason.countsAgainstAvailability
        }, text(input.notes, 'Observacao', 500, false), new Date());
        if (!event) throw new AvailabilityError(409, 'A parada automatica nao esta mais aberta.');
        return event;
    }

    async reconcilePhysicalLineState(snapshot: PhysicalLineStateSnapshot): Promise<{
        action: 'disabled' | 'unchanged' | 'blocked' | 'opened' | 'updated' | 'closed'; event: DowntimeEvent | null;
    }> {
        this.physicalState = snapshot;
        const configuration = await this.repository.configuration(this.lineId), monitoring = configuration?.physicalMonitoring;
        const open = await this.repository.openEvent(this.lineId);
        if (!monitoring?.enabled) return { action: 'disabled', event: open };
        if (snapshot.state === 'RUNNING') {
            if (!open || open.source !== 'plc') return { action: 'unchanged', event: open };
            const closed = await this.repository.closeEventById(this.lineId, open.eventId, randomUUID(), snapshot.capturedAt);
            if (closed) this.recordOperational({ category: 'oee', action: 'PHYSICAL_DOWNTIME_ENDED',
                description: 'Retomada física confirmada pelas CLPs.', resource: closed.eventId,
                details: { eventId: closed.eventId } });
            return closed ? { action: 'closed', event: closed }
                : { action: 'unchanged', event: await this.repository.openEvent(this.lineId) };
        }
        if (snapshot.state !== 'STOPPED') return { action: 'unchanged', event: open };
        const signals = snapshot.signals.map(item => ({ signalId: item.signalId, label: item.label }));
        const activeSignalIds = snapshot.signals.filter(item => ['stopped', 'emergency'].includes(item.productionState || ''))
            .map(item => item.signalId);
        const notes = `Parada física consolidada: ${snapshot.reason}`;
        if (open) {
            if (open.source !== 'plc') return { action: 'blocked', event: open };
            const updated = await this.repository.replacePlcSignals(this.lineId, open.eventId, signals, activeSignalIds,
                open.classificationPending === false && open.notes ? open.notes : notes, snapshot.capturedAt);
            return { action: updated ? 'updated' : 'unchanged', event: updated ?? open };
        }
        if (!monitoring.defaultReasonId) throw new AvailabilityError(409, 'Configure o motivo inicial da parada automatica.');
        const reason = await this.repository.reason(monitoring.defaultReasonId);
        if (!reason?.active) throw new AvailabilityError(409, 'O motivo inicial da parada automatica esta inativo ou nao existe.');
        const event: DowntimeEvent = { eventId: randomUUID(), lineId: this.lineId, status: 'open', startedAt: snapshot.capturedAt,
            reason: { reasonId: reason.reasonId, code: reason.code, name: reason.name,
                classification: reason.classification, countsAgainstAvailability: reason.countsAgainstAvailability },
            source: 'plc', sourceSignals: signals, activeSourceSignalIds: activeSignalIds, classificationPending: true, notes,
            startRequestId: randomUUID(), createdAt: snapshot.capturedAt, updatedAt: snapshot.capturedAt };
        try { await this.repository.createEvent(event); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) {
                const concurrent = await this.repository.openEvent(this.lineId);
                return { action: concurrent ? 'unchanged' : 'blocked', event: concurrent };
            }
            throw error;
        }
        this.recordOperational({ category: 'oee', action: 'PHYSICAL_DOWNTIME_STARTED',
            description: `Parada física confirmada pelas CLPs: ${snapshot.reason}`, resource: event.eventId,
            details: { eventId: event.eventId, signals: signals.map(item => item.label).join(', ').slice(0, 300) } });
        return { action: 'opened', event };
    }

    /** Consolida sinais CLP simultâneos em uma parada e não altera paradas abertas por outra origem. */
    async reconcilePlcSignal(signalId: string, active: boolean, reasonId: string, signalLabel: string) {
        if ((await this.repository.configuration(this.lineId))?.physicalMonitoring?.enabled) {
            return { action: 'unchanged' as const, event: await this.repository.openEvent(this.lineId) };
        }
        return this.reconcilePlcSignalAttempt(signalId, active, reasonId, signalLabel, 0);
    }
    private async reconcilePlcSignalAttempt(signalId: string, active: boolean, reasonId: string, signalLabel: string, attempt: number): Promise<{
        action: 'unchanged' | 'blocked' | 'opened' | 'joined' | 'updated' | 'closed'; event: DowntimeEvent | null;
    }> {
        const open = await this.repository.openEvent(this.lineId);
        if (!active) {
            if (!open || open.source !== 'plc') return { action: 'unchanged', event: open };
            const sources = open.sourceSignals?.length ? open.sourceSignals
                : open.sourceSignalId ? [{ signalId: open.sourceSignalId, label: open.sourceSignalId === signalId ? signalLabel : open.notes || open.sourceSignalId }] : [];
            const activeIds = open.activeSourceSignalIds ?? sources.map(item => item.signalId);
            if (!activeIds.includes(signalId)) return { action: 'unchanged', event: open };
            const now = new Date();
            if (!open.sourceSignals || !open.activeSourceSignalIds) {
                await this.repository.addPlcSignals(this.lineId, open.eventId, sources, activeIds, now);
            }
            const updated = await this.repository.removePlcSignal(this.lineId, open.eventId, signalId, now);
            if (!updated) return { action: 'unchanged', event: await this.repository.openEvent(this.lineId) };
            if (updated.activeSourceSignalIds?.length) return { action: 'updated', event: updated };
            const closed = await this.repository.closePlcEventWithoutSignals(this.lineId, open.eventId, randomUUID(), now);
            return closed ? { action: 'closed', event: closed }
                : { action: 'unchanged', event: await this.repository.openEvent(this.lineId) };
        }
        if (open) {
            if (open.source !== 'plc') return { action: 'blocked', event: open };
            const sources = open.sourceSignals?.length ? open.sourceSignals
                : open.sourceSignalId ? [{ signalId: open.sourceSignalId, label: open.notes || open.sourceSignalId }] : [];
            const activeIds = open.activeSourceSignalIds ?? sources.map(item => item.signalId);
            if (activeIds.includes(signalId)) return { action: 'unchanged', event: open };
            const legacySources = open.sourceSignals ? [] : sources;
            const legacyActiveIds = open.activeSourceSignalIds ? [] : activeIds;
            const updated = await this.repository.addPlcSignals(this.lineId, open.eventId,
                [...legacySources, { signalId, label: signalLabel }], [...legacyActiveIds, signalId], new Date());
            if (updated) return { action: 'joined', event: updated };
            if (attempt < 2) return this.reconcilePlcSignalAttempt(signalId, active, reasonId, signalLabel, attempt + 1);
            return { action: 'blocked', event: await this.repository.openEvent(this.lineId) };
        }
        const reason = await this.repository.reason(reasonId);
        if (!reason || !reason.active) throw new AvailabilityError(404, 'Motivo de parada ativo não encontrado para o sinal da CLP.');
        const now = new Date();
        const event: DowntimeEvent = { eventId: randomUUID(), lineId: this.lineId, status: 'open', startedAt: now,
            reason: { reasonId: reason.reasonId, code: reason.code, name: reason.name,
                classification: reason.classification, countsAgainstAvailability: reason.countsAgainstAvailability },
            source: 'plc', sourceSignalId: signalId, sourceSignals: [{ signalId, label: signalLabel }], activeSourceSignalIds: [signalId],
            notes: `Aberta automaticamente pelo sinal CLP: ${signalLabel}.`,
            startRequestId: randomUUID(), createdAt: now, updatedAt: now };
        try { await this.repository.createEvent(event); }
        catch (error) {
            if ((error as { code?: number }).code === 11000 && attempt < 2) {
                return this.reconcilePlcSignalAttempt(signalId, active, reasonId, signalLabel, attempt + 1);
            }
            throw error;
        }
        return { action: 'opened', event };
    }

    /** Converte um sinal de linha em execução em eventos de disponibilidade sem tocar em paradas de outra origem. */
    reconcilePlcRunningSignal(signalId: string, running: boolean, reasonId: string, signalLabel: string) {
        return this.reconcilePlcSignal(signalId, !running, reasonId, signalLabel);
    }

    async report(fromValue: unknown, toValue: unknown, timezoneOffsetValue: unknown) {
        const from = this.instant(fromValue, 'Inicio'), to = this.instant(toValue, 'Fim');
        if (from >= to || to.getTime() - from.getTime() > 93 * DAY_MS) {
            throw new AvailabilityError(400, 'Informe um periodo valido de ate 93 dias.');
        }
        const timezoneOffsetMinutes = Number(timezoneOffsetValue);
        if (!Number.isInteger(timezoneOffsetMinutes) || Math.abs(timezoneOffsetMinutes) > 840) {
            throw new AvailabilityError(400, 'Fuso horario invalido.');
        }
        await this.synchronizeCurrentPeriod();
        const calendarFrom = new Date(from); calendarFrom.setDate(calendarFrom.getDate() - 1);
        const [shifts, breaks, exceptions, events, pcms, periods, configuration] = await Promise.all([
            this.shifts.list(), this.repository.listBreaks(),
            this.repository.listCalendar(this.lineId, localDate(calendarFrom), localDate(to)),
            this.repository.eventsBetween(this.lineId, from, to), this.pcms.completedBetween(this.lineId, from, to),
            this.repository.periodsBetween(this.lineId, from, to), this.repository.configuration(this.lineId)
        ]);
        const scheduled: Interval[] = [], excludedBreaks: Interval[] = [];
        const exceptionKeys = new Map(exceptions.map(item => [`${item.date}:${item.shiftId}`, item]));
        const periodKeys = new Set(periods.map(item => `${item.operationalDate}:${item.shiftId}`));
        for (const period of periods) {
            if (period.productionEnabled === false) continue;
            const window = clip({ start: period.plannedStartAt, end: period.plannedEndAt }, from, to); if (window) scheduled.push(window);
            for (const item of period.excludedBreaks) {
                const interval = clip({ start: item.startAt, end: item.endAt }, from, to); if (interval) excludedBreaks.push(interval);
            }
        }
        for (let day = new Date(calendarFrom.getFullYear(), calendarFrom.getMonth(), calendarFrom.getDate()); day <= to;
            day.setDate(day.getDate() + 1)) {
            const date = localDate(day);
            for (const shift of shifts) {
                if (periodKeys.has(`${date}:${shift.shiftId}`)) continue;
                const exception = exceptionKeys.get(`${date}:${shift.shiftId}`);
                if (exception?.productionEnabled === false || !shift.active && exception?.productionEnabled !== true) continue;
                const window = clip(operationalWindow(date, shift), from, to); if (!window) continue;
                scheduled.push(window);
                for (const item of breaks.filter(value => value.active && value.excludeFromPlannedTime && value.shiftId === shift.shiftId)) {
                    const breakInterval = clip(breakWindow(date, shift, item), from, to); if (breakInterval) excludedBreaks.push(breakInterval);
                }
            }
        }
        const scheduleAfterBreaks = subtract(scheduled, excludedBreaks);
        const eventIntervals = (items: DowntimeEvent[]) => items.map(event => ({ start: event.startedAt,
            end: new Date(Math.min(event.endedAt?.getTime() ?? to.getTime(), to.getTime())) }));
        const excludedEvents = eventIntervals(events.filter(event => !event.reason.countsAgainstAvailability));
        const plannedIntervals = subtract(scheduleAfterBreaks, excludedEvents);
        const countedEvents = events.filter(event => event.reason.countsAgainstAvailability);
        const downtimeIntervals = intersections(plannedIntervals, eventIntervals(countedEvents));
        const scheduledTimeMs = duration(merge(scheduled));
        const afterBreaksTimeMs = duration(scheduleAfterBreaks);
        const excludedBreakTimeMs = Math.max(0, scheduledTimeMs - afterBreaksTimeMs);
        const plannedTimeMs = duration(plannedIntervals);
        const excludedEventTimeMs = Math.max(0, afterBreaksTimeMs - plannedTimeMs);
        const downtimeMs = duration(downtimeIntervals);
        const operatingTimeMs = Math.max(0, plannedTimeMs - downtimeMs);
        const reasonTotals = new Map<string, { reasonId: string; code: string; name: string; classification: string; durationMs: number; occurrences: number }>();
        for (const event of countedEvents) {
            const durationMs = duration(intersections(plannedIntervals, eventIntervals([event])));
            if (!durationMs) continue;
            const current = reasonTotals.get(event.reason.reasonId) ?? { reasonId: event.reason.reasonId, code: event.reason.code,
                name: event.reason.name, classification: event.reason.classification, durationMs: 0, occurrences: 0 };
            current.durationMs += durationMs; current.occurrences++; reasonTotals.set(event.reason.reasonId, current);
        }
        const quality = this.quality(pcms, from, to, timezoneOffsetMinutes);
        const performance = configuration?.idealCycleTimeMs && operatingTimeMs > 0
            ? Math.min(100, percentage(quality.produced * configuration.idealCycleTimeMs, operatingTimeMs) ?? 0)
            : null;
        const availability = percentage(operatingTimeMs, plannedTimeMs);
        const oee = performance === null || quality.percentage === null || availability === null
            ? null
            : Math.round(availability * performance * quality.percentage / 100) / 100;
        return { lineId: this.lineId, period: { from, to }, scheduledTimeMs, excludedBreakTimeMs,
            excludedEventTimeMs, plannedTimeMs, operatingTimeMs, downtimeMs,
            availability, quality, performance, oee,
            performanceStatus: configuration?.idealCycleTimeMs ? 'available' : 'awaiting_ideal_cycle_time',
            idealCycleTimeSeconds: configuration?.idealCycleTimeMs ? configuration.idealCycleTimeMs / 1000 : null,
            downtimeByReason: [...reasonTotals.values()].sort((a, b) => b.durationMs - a.durationMs),
            events, generatedAt: new Date() };
    }

    private parseReason(value: unknown) {
        const input = object(value); only(input, ['code', 'name', 'classification', 'countsAgainstAvailability', 'active']);
        const code = text(input.code, 'Codigo', 40)!;
        if (!CODE.test(code)) throw new AvailabilityError(400, 'Codigo deve usar letras, numeros, hifen ou sublinhado.');
        if (!['planned', 'unplanned'].includes(String(input.classification))) throw new AvailabilityError(400, 'Classificacao invalida.');
        return { code: code.toUpperCase(), name: text(input.name, 'Nome', 100)!,
            classification: input.classification as 'planned' | 'unplanned',
            countsAgainstAvailability: boolean(input.countsAgainstAvailability, 'Impacto na disponibilidade'),
            active: boolean(input.active, 'Status ativo') };
    }
    private async parsePhysicalMonitoring(value: unknown): Promise<PhysicalMonitoringConfiguration> {
        const input = object(value); only(input, ['enabled', 'strategy', 'stopConfirmationMs', 'resumeConfirmationMs',
            'defaultReasonId', 'referenceSignalId', 'manualContingencyEnabled', 'manualContingencyRequiresAdmin']);
        const enabled = boolean(input.enabled, 'Monitoramento fisico');
        const strategies = ['serial_any_running', 'all_required', 'reference_signal'] as const;
        if (!strategies.includes(input.strategy as typeof strategies[number])) {
            throw new AvailabilityError(400, 'Estrategia de consolidacao fisica invalida.');
        }
        const milliseconds = (raw: unknown, label: string) => {
            if (!Number.isInteger(raw) || (raw as number) < 0 || (raw as number) > 600_000) {
                throw new AvailabilityError(400, `${label} deve estar entre 0 e 600000 ms.`);
            }
            return raw as number;
        };
        const strategy = input.strategy as PhysicalMonitoringConfiguration['strategy'];
        const defaultReasonId = input.defaultReasonId === undefined || input.defaultReasonId === '' ? undefined
            : id(input.defaultReasonId, 'Motivo inicial');
        const referenceSignalId = input.referenceSignalId === undefined || input.referenceSignalId === '' ? undefined
            : id(input.referenceSignalId, 'Sinal de referencia');
        if (enabled) {
            if (!defaultReasonId) throw new AvailabilityError(400, 'Selecione o motivo inicial da parada automatica.');
            const reason = await this.repository.reason(defaultReasonId);
            if (!reason?.active) throw new AvailabilityError(400, 'O motivo inicial precisa estar ativo.');
            if (strategy === 'reference_signal' && !referenceSignalId) {
                throw new AvailabilityError(400, 'Selecione o sinal usado como referencia produtiva.');
            }
        }
        return { enabled, strategy,
            stopConfirmationMs: milliseconds(input.stopConfirmationMs, 'Confirmacao de parada'),
            resumeConfirmationMs: milliseconds(input.resumeConfirmationMs, 'Confirmacao de retomada'),
            ...(defaultReasonId ? { defaultReasonId } : {}), ...(referenceSignalId ? { referenceSignalId } : {}),
            manualContingencyEnabled: boolean(input.manualContingencyEnabled, 'Contingencia manual'),
            manualContingencyRequiresAdmin: boolean(input.manualContingencyRequiresAdmin, 'ADMIN na contingencia') };
    }
    private configurationView(value: OeeConfiguration | null) {
        return { lineId: this.lineId, idealCycleTimeSeconds: value?.idealCycleTimeMs ? value.idealCycleTimeMs / 1000 : null,
            physicalMonitoring: value?.physicalMonitoring ?? DEFAULT_PHYSICAL_MONITORING,
            updatedAt: value?.updatedAt ?? null };
    }
    private async isActivePhysicalDefaultReason(reasonId: string) {
        const monitoring = (await this.repository.configuration(this.lineId))?.physicalMonitoring;
        return !!monitoring?.enabled && monitoring.defaultReasonId === reasonId;
    }
    private recordOperational(value: Parameters<OperationalLogService['recordSystem']>[0]) {
        void this.operationalLog?.recordSystem(value).catch(error => console.error('[OPERATIONAL_LOG]',
            error instanceof Error ? error.message : error));
    }
    async synchronizeCurrentPeriod(at = new Date()): Promise<ProductionPeriod | null> {
        const previous = new Date(at); previous.setDate(previous.getDate() - 1);
        const [shifts, exceptions, breaks] = await Promise.all([this.shifts.list(),
            this.repository.listCalendar(this.lineId, localDate(previous), localDate(at)), this.repository.listBreaks()]);
        const occurrence = scheduledOccurrence(shifts, exceptions, at);
        return occurrence ? this.ensurePeriod(occurrence.shift, occurrence.date, occurrence.productionEnabled, breaks) : null;
    }
    private async ensurePeriod(shift: Shift, date: string, productionEnabled: boolean, breaks: ShiftBreak[]): Promise<ProductionPeriod> {
        const existing = await this.repository.period(this.lineId, date, shift.shiftId); if (existing) return existing;
        const window = operationalWindow(date, shift), now = new Date();
        const value: ProductionPeriod = { periodId: randomUUID(), lineId: this.lineId, shiftId: shift.shiftId,
            operationalDate: date, shift: { name: shift.name, startTime: shift.startTime, endTime: shift.endTime },
            productionEnabled,
            plannedStartAt: window.start, plannedEndAt: window.end,
            excludedBreaks: breaks.filter(item => item.shiftId === shift.shiftId && item.active && item.excludeFromPlannedTime)
                .map(item => { const interval = breakWindow(date, shift, item); return { name: item.name, startAt: interval.start, endAt: interval.end }; }),
            createdAt: now };
        try { await this.repository.createPeriod(value); return value; }
        catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
            const duplicate = await this.repository.period(this.lineId, date, shift.shiftId); if (duplicate) return duplicate;
            throw error;
        }
    }
    private async parseBreak(value: unknown) {
        const input = object(value); only(input, ['shiftId', 'name', 'startTime', 'endTime', 'excludeFromPlannedTime', 'active']);
        const shiftId = id(input.shiftId, 'Identificador do turno'), shift = await this.shifts.get(shiftId);
        if (!shift) throw new AvailabilityError(404, 'Turno nao encontrado.');
        const parsed = { shiftId, name: text(input.name, 'Nome', 100)!, startTime: time(input.startTime, 'Hora inicial'),
            endTime: time(input.endTime, 'Hora final'), excludeFromPlannedTime: boolean(input.excludeFromPlannedTime, 'Exclusao do tempo planejado'),
            active: boolean(input.active, 'Status ativo') };
        if (parsed.startTime === parsed.endTime) throw new AvailabilityError(400, 'Inicio e fim da pausa devem ser diferentes.');
        if (!withinShift(parsed, shift)) throw new AvailabilityError(400, 'A pausa precisa estar contida no horario do turno.');
        return parsed;
    }
    private async validateBreakOverlap(candidate: ShiftBreak, ignoredId?: string) {
        if (!candidate.active) return;
        const conflict = (await this.repository.listBreaks()).find(item => item.active && item.shiftId === candidate.shiftId
            && item.breakId !== ignoredId && shiftsOverlap(candidate, item));
        if (conflict) throw new AvailabilityError(409, `A pausa se sobrepoe a ${conflict.name}.`);
    }
    private date(value: unknown) {
        if (typeof value !== 'string' || !DATE.test(value)) throw new AvailabilityError(400, 'Data deve usar AAAA-MM-DD.');
        const parsed = localAt(value, '12:00');
        if (localDate(parsed) !== value) throw new AvailabilityError(400, 'Data invalida.');
        return value;
    }
    private instant(value: unknown, label: string) {
        if (typeof value !== 'string') throw new AvailabilityError(400, `${label} invalido.`);
        const parsed = new Date(value); if (!Number.isFinite(parsed.getTime())) throw new AvailabilityError(400, `${label} invalido.`);
        return parsed;
    }
    private duplicate(error: unknown, message: string): never {
        if ((error as { code?: number }).code === 11000) throw new AvailabilityError(409, message);
        throw error;
    }
    private quality(pcms: PCM[], from: Date, to: Date, timezoneOffsetMinutes: number) {
        const report = buildChipMetrics(pcms, chipMetricsWindow(from, to, timezoneOffsetMinutes), new Date());
        const value = report.period.summary;
        return { percentage: value.approvalRate, produced: value.produced, approved: value.approved,
            rejected: value.rejected, indeterminate: value.indeterminate };
    }
}
