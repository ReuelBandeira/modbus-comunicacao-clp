import { randomUUID } from 'node:crypto';
import type { OperationalActorType, OperationalLogCategory, OperationalLogEvent,
    OperationalLogOutcome } from '../models/operationalLogModel';
import type { OperationalLogRepository } from '../repositories/operationalLogRepository';

const categories: OperationalLogCategory[] = ['authentication', 'production', 'operators', 'shifts', 'oee',
    'plc', 'configuration', 'integration', 'system'];
const outcomes: OperationalLogOutcome[] = ['success', 'failure'];
const DAY_MS = 86_400_000;

export interface HttpOperationalRecord {
    method: string;
    path: string;
    status: number;
    durationMs: number;
    authorization?: string;
    body?: unknown;
    requestId?: string;
}

export class OperationalLogService {
    private readonly pending = new Set<Promise<void>>();
    constructor(private readonly repository: OperationalLogRepository, private readonly lineId: string,
        private readonly retentionDays = 365) {}

    async recordHttp(input: HttpOperationalRecord) {
        const mapped = describeOperation(input.method, input.path);
        const outcome: OperationalLogOutcome = input.status >= 200 && input.status < 400 ? 'success' : 'failure';
        const actor = actorFrom(input, outcome);
        const occurredAt = new Date();
        const details = safeDetails(input.body);
        const event: OperationalLogEvent = {
            eventId: randomUUID(), lineId: this.lineId, category: mapped.category, action: mapped.action,
            description: outcome === 'success' ? mapped.success : `${mapped.failure} (HTTP ${input.status})`, outcome, actor,
            resource: mapped.resource, method: input.method, path: input.path, httpStatus: input.status,
            durationMs: Math.max(0, Math.round(input.durationMs)), ...(input.requestId ? { requestId: input.requestId } : {}),
            ...(Object.keys(details).length ? { details } : {}), occurredAt,
            expiresAt: new Date(occurredAt.getTime() + this.retentionDays * DAY_MS)
        };
        await this.persist(event);
        return event;
    }

    async recordSystem(value: { category: OperationalLogCategory; action: string; description: string;
        outcome?: OperationalLogOutcome; resource?: string; actorLabel?: string;
        details?: Record<string, string | number | boolean>; occurredAt?: Date }) {
        const occurredAt = value.occurredAt ?? new Date();
        const event: OperationalLogEvent = { eventId: randomUUID(), lineId: this.lineId, category: value.category,
            action: value.action, description: value.description, outcome: value.outcome ?? 'success',
            actor: { type: 'system', id: 'SYSTEM', label: value.actorLabel ?? 'Sistema' },
            ...(value.resource ? { resource: value.resource } : {}), ...(value.details ? { details: value.details } : {}),
            occurredAt, expiresAt: new Date(occurredAt.getTime() + this.retentionDays * DAY_MS) };
        await this.persist(event);
        return event;
    }

    async flush() { await Promise.allSettled([...this.pending]); }

    private persist(event: OperationalLogEvent) {
        const operation = this.repository.insert(event);
        this.pending.add(operation);
        void operation.then(() => this.pending.delete(operation), () => this.pending.delete(operation));
        return operation;
    }

    async list(raw: Record<string, unknown>) {
        const now = new Date(), defaultFrom = new Date(now.getTime() - 7 * DAY_MS);
        const from = date(raw.from, 'Data inicial', defaultFrom), to = date(raw.to, 'Data final', now);
        if (from > to) throw new OperationalLogError(400, 'A data inicial deve ser anterior à data final.');
        if (to.getTime() - from.getTime() > 366 * DAY_MS) {
            throw new OperationalLogError(400, 'Consulte no máximo 366 dias por vez.');
        }
        const category = optionalPick(raw.category, categories, 'Categoria');
        const outcome = optionalPick(raw.outcome, outcomes, 'Resultado');
        const actor = optionalText(raw.actor, 'Responsável', 100);
        const search = optionalText(raw.search, 'Busca', 100);
        const limit = raw.limit === undefined ? 200 : Number(raw.limit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new OperationalLogError(400, 'Limite deve estar entre 1 e 1000.');
        const events = await this.repository.list({ lineId: this.lineId, from, to, category, outcome, actor, search, limit });
        return { events, filters: { from, to, category, outcome, actor, search, limit }, retentionDays: this.retentionDays,
            generatedAt: new Date() };
    }
}

export class OperationalLogError extends Error {
    constructor(public readonly status: 400 | 401 | 503, message: string) { super(message); }
}

function date(value: unknown, label: string, fallback: Date) {
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' || value.length > 40) throw new OperationalLogError(400, `${label} inválida.`);
    const result = new Date(value);
    if (!Number.isFinite(result.getTime())) throw new OperationalLogError(400, `${label} inválida.`);
    return result;
}
function optionalText(value: unknown, label: string, max: number) {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || !value.trim() || value.length > max) throw new OperationalLogError(400, `${label} inválido.`);
    return value.trim();
}
function optionalPick<T extends string>(value: unknown, allowed: readonly T[], label: string): T | undefined {
    if (value === undefined || value === '') return undefined;
    if (typeof value !== 'string' || !allowed.includes(value as T)) throw new OperationalLogError(400, `${label} inválida.`);
    return value as T;
}

function actorFrom(input: HttpOperationalRecord, outcome: OperationalLogOutcome): OperationalLogEvent['actor'] {
    const body = input.body && typeof input.body === 'object' && !Array.isArray(input.body)
        ? input.body as Record<string, unknown> : {};
    if (input.path === '/api/admin/sessions') return outcome === 'success'
        ? { type: 'admin', id: 'ADMIN', label: 'ADMIN' }
        : { type: 'unknown', id: 'UNKNOWN', label: 'Não identificado' };
    if (input.authorization && outcome === 'success') return { type: 'admin', id: 'ADMIN', label: 'ADMIN' };
    if (typeof body.registration === 'string' && body.registration.trim()) {
        return { type: 'operator', id: body.registration.trim(), label: body.registration.trim() };
    }
    if (typeof body.acknowledgedBy === 'string' && body.acknowledgedBy.trim()) {
        return { type: 'station', id: 'IHM', label: body.acknowledgedBy.trim().slice(0, 100) };
    }
    return { type: 'station', id: 'IHM', label: 'IHM' };
}

function safeDetails(value: unknown): Record<string, string | number | boolean> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const input = value as Record<string, unknown>, result: Record<string, string | number | boolean> = {};
    for (const key of ['requestId', 'reasonId', 'registration', 'shiftId', 'cycleId', 'action', 'code', 'lineId',
        'physicalMovementConfirmed']) {
        const item = input[key];
        if (typeof item === 'string' && item.length <= 120 || typeof item === 'number' || typeof item === 'boolean') result[key] = item;
    }
    return result;
}

export function describeOperation(method: string, path: string): { category: OperationalLogCategory; action: string;
    success: string; failure: string; resource: string } {
    const match = (pattern: RegExp, category: OperationalLogCategory, action: string, success: string, failure = `Falha: ${success.toLowerCase()}`) =>
        pattern.test(path) ? { category, action, success, failure, resource: path } : undefined;
    return match(/^\/api\/admin\/sessions$/, 'authentication', 'ADMIN_LOGIN', 'Acesso ADMIN autenticado', 'Tentativa de acesso ADMIN rejeitada')
        ?? match(/^\/api\/operator-station\/entries$/, 'operators', 'OPERATOR_ENTRY', 'Entrada de operador registrada')
        ?? match(/^\/api\/operator-station\/sessions\/.+\/exit$/, 'operators', 'OPERATOR_EXIT', 'Saída de operador registrada')
        ?? match(/^\/api\/operators(?:\/.*)?$/, 'operators', `OPERATOR_${method}`, 'Cadastro de operadores alterado')
        ?? match(/^\/api\/shifts(?:\/.*)?$/, 'shifts', `SHIFT_${method}`, 'Cadastro de turnos alterado')
        ?? match(/^\/api\/availability\/stops\/.+\/classify$/, 'oee', 'DOWNTIME_CLASSIFIED', 'Parada classificada')
        ?? match(/^\/api\/availability\/stops$/, 'oee', 'DOWNTIME_STARTED', 'Parada manual registrada')
        ?? match(/^\/api\/availability\/resume$/, 'oee', 'DOWNTIME_ENDED', 'Retomada manual registrada')
        ?? match(/^\/api\/availability\//, 'oee', `OEE_${method}`, 'Configuração do OEE alterada')
        ?? match(/^\/api\/line-operation\/start$/, 'production', 'LINE_STARTED', 'Operação da linha iniciada')
        ?? match(/^\/api\/entry-preparation\//, 'production', `ENTRY_${method}`, 'Preparação de entrada atualizada')
        ?? match(/^\/api\/serial-numbers$/, 'production', 'SERIAL_REGISTERED', 'Entrada de serial registrada')
        ?? match(/^\/api\/lines\/.+\/trays\/.+\/(interventions|advance)$/, 'production', 'TRAY_INTERVENTION', 'Intervenção manual na bandeja registrada')
        ?? match(/^\/api\/station-test-reset$/, 'plc', 'STATION_TEST_RESET', 'Reset de teste da estação concluído')
        ?? match(/^\/api\/plc-(controls|commands)\//, 'plc', 'PLC_COMMAND', 'Comando CLP solicitado')
        ?? match(/^\/api\/plc-alarms\/occurrences\//, 'plc', 'PLC_ALARM_ACK', 'Alarme CLP reconhecido')
        ?? match(/^\/api\/plc-/, 'configuration', `PLC_CONFIGURATION_${method}`, 'Configuração CLP alterada')
        ?? match(/^\/api\/ihm-machines/, 'configuration', `IHM_CONFIGURATION_${method}`, 'Configuração das máquinas da IHM alterada')
        ?? match(/^\/api\/ifts-bridge\//, 'integration', `IFTS_${method}`, 'Operação da integração IFTS executada')
        ?? match(/^\/api\/test-results$/, 'integration', 'TEST_RESULT_RECEIVED', 'Resultado de teste recebido')
        ?? { category: 'system', action: `API_${method}`, success: 'Operação do sistema concluída',
            failure: 'Operação do sistema não concluída', resource: path };
}
