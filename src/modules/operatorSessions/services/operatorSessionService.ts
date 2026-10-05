import { randomUUID } from 'node:crypto';
import type { OperatorStationSession } from '../models/operatorSessionModel';
import { OperatorSessionRepository } from '../repositories/operatorSessionRepository';
import { OperatorRepository } from '../../operators/repositories/operatorRepository';
import { ShiftService } from '../../shifts/services/shiftService';

export class OperatorSessionError extends Error {
    constructor(public readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGISTRATION = /^[A-Za-z0-9_-]{1,80}$/;
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OperatorSessionError(400, 'Informe um objeto JSON.');
    return value as Record<string, unknown>;
}
function requestId(value: unknown): string {
    if (typeof value !== 'string' || !UUID.test(value)) throw new OperatorSessionError(400, 'Identificador da requisicao invalido.');
    return value;
}
function registration(value: unknown): string {
    if (typeof value !== 'string' || !REGISTRATION.test(value.trim())) throw new OperatorSessionError(400, 'Matricula invalida.');
    return value.trim();
}
function sessionId(value: string): string {
    if (!UUID.test(value)) throw new OperatorSessionError(400, 'Identificador da sessao invalido.');
    return value;
}

export class OperatorSessionService {
    constructor(private readonly sessions: OperatorSessionRepository, private readonly operators: OperatorRepository,
        private readonly shifts: ShiftService, private readonly stationId: string, private readonly stationName = 'Principal',
        private readonly minimumOperators: () => Promise<number> = async () => 3) {}

    async context(at = new Date()) {
        const [currentShift, minimumOperators] = await Promise.all([this.shifts.current(at), this.minimumOperators()]);
        await this.sessions.endOutsideShift(this.stationId, currentShift?.shiftId ?? null, at);
        const activeOperators = currentShift
            ? await this.sessions.activeForShift(this.stationId, currentShift.shiftId) : [];
        return { station: { stationId: this.stationId, name: this.stationName }, currentShift, activeOperators,
            staffing: { active: activeOperators.length, minimum: minimumOperators,
                satisfied: activeOperators.length >= minimumOperators }, capturedAt: at };
    }

    async hasActiveForOperator(operatorRegistration: string): Promise<boolean> {
        return (await this.context()).activeOperators.some(session =>
            session.operator.registration === operatorRegistration);
    }

    async enter(value: unknown): Promise<OperatorStationSession> {
        const input = record(value);
        if (Object.keys(input).some(key => !['registration', 'requestId'].includes(key))) {
            throw new OperatorSessionError(400, 'Informe somente matricula e identificador da requisicao.');
        }
        const key = requestId(input.requestId), operatorRegistration = registration(input.registration);
        const replay = await this.sessions.byEntryRequest(key);
        if (replay) return replay;
        const [operator, currentShift] = await Promise.all([
            this.operators.get(operatorRegistration), this.shifts.current()
        ]);
        if (!operator) throw new OperatorSessionError(404, 'Operador nao encontrado.');
        if (!currentShift) throw new OperatorSessionError(409, 'Nenhum turno ativo para este horario.');
        const now = new Date();
        await this.sessions.endOutsideShift(this.stationId, currentShift.shiftId, now);
        const active = await this.sessions.activeByOperator(this.stationId, operatorRegistration);
        if (active) throw new OperatorSessionError(409, `${operator.name} ja esta ativo nesta estacao.`);
        const session: OperatorStationSession = { sessionId: randomUUID(), stationId: this.stationId, operator,
            shift: { shiftId: currentShift.shiftId, name: currentShift.name, startTime: currentShift.startTime,
                endTime: currentShift.endTime },
            status: 'active', startedAt: now, entryRequestId: key, createdAt: now, updatedAt: now };
        try { await this.sessions.create(session); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) {
                const duplicate = await this.sessions.byEntryRequest(key);
                if (duplicate) return duplicate;
                throw new OperatorSessionError(409, `${operator.name} ja esta ativo nesta estacao.`);
            }
            throw error;
        }
        return session;
    }

    async exit(id: string, value: unknown): Promise<OperatorStationSession> {
        const input = record(value);
        if (Object.keys(input).some(key => key !== 'requestId')) {
            throw new OperatorSessionError(400, 'Informe somente o identificador da requisicao.');
        }
        const validSessionId = sessionId(id), key = requestId(input.requestId);
        const replay = await this.sessions.byExitRequest(key);
        if (replay) return replay;
        const endedAt = new Date();
        const session = await this.sessions.exit(validSessionId, this.stationId, key, endedAt);
        if (!session) {
            const duplicate = await this.sessions.byExitRequest(key);
            if (duplicate) return duplicate;
            throw new OperatorSessionError(409, 'A sessao ja foi finalizada ou nao pertence a esta estacao.');
        }
        return session;
    }
}
