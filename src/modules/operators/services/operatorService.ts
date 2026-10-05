import type { Operator } from '../models/operatorModel';
import { OperatorRepository } from '../repositories/operatorRepository';

export interface OperatorUsageGuard {
    hasActiveForOperator(registration: string): Promise<boolean>;
}

export class OperatorError extends Error {
    constructor(public readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}

const REGISTRATION = /^[A-Za-z0-9_-]{1,80}$/;
function body(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OperatorError(400, 'Informe um objeto JSON.');
    return value as Record<string, unknown>;
}
function name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
        throw new OperatorError(400, 'Nome deve ter de 1 a 100 caracteres.');
    }
    return value.trim();
}
function registration(value: unknown): string {
    if (typeof value !== 'string' || !REGISTRATION.test(value.trim())) {
        throw new OperatorError(400, 'Matricula deve usar somente letras, numeros, hifen ou sublinhado.');
    }
    return value.trim();
}

export class OperatorService {
    constructor(private readonly repository: OperatorRepository, private readonly usage?: OperatorUsageGuard) {}
    list() { return this.repository.list(); }
    async create(value: unknown): Promise<Operator> {
        const input = body(value);
        if (Object.keys(input).some(key => !['name', 'registration'].includes(key))) {
            throw new OperatorError(400, 'Informe somente nome e matricula.');
        }
        const operator = { name: name(input.name), registration: registration(input.registration) };
        try { await this.repository.create(operator); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) throw new OperatorError(409, 'Matricula ja cadastrada.');
            throw error;
        }
        return operator;
    }
    async update(currentRegistration: string, value: unknown): Promise<Operator> {
        const input = body(value);
        if (Object.keys(input).some(key => !['name', 'registration'].includes(key))) {
            throw new OperatorError(400, 'Informe somente nome e matricula.');
        }
        const current = registration(currentRegistration);
        if (await this.usage?.hasActiveForOperator(current)) {
            throw new OperatorError(409, 'Operador ativo na linha. Registre a saida antes de editar o cadastro.');
        }
        let updated: Operator | null;
        try {
            updated = await this.repository.update(current,
                { name: name(input.name), registration: registration(input.registration) });
        } catch (error) {
            if ((error as { code?: number }).code === 11000) throw new OperatorError(409, 'Matricula ja cadastrada.');
            throw error;
        }
        if (!updated) throw new OperatorError(404, 'Operador nao encontrado.');
        return updated;
    }
    async remove(registrationValue: string): Promise<void> {
        const current = registration(registrationValue);
        if (await this.usage?.hasActiveForOperator(current)) {
            throw new OperatorError(409, 'Operador ativo na linha. Registre a saida antes de remover o cadastro.');
        }
        if (!await this.repository.remove(current)) {
            throw new OperatorError(404, 'Operador nao encontrado.');
        }
    }
}
