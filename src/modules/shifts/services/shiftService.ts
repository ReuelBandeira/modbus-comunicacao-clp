import { randomUUID } from 'node:crypto';
import type { Shift } from '../models/shiftModel';
import { ShiftRepository } from '../repositories/shiftRepository';

export class ShiftError extends Error {
    constructor(public readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}

export interface ShiftUsageGuard {
    hasActiveForShift(shiftId: string): Promise<boolean>;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ShiftError(400, 'Informe um objeto JSON.');
    return value as Record<string, unknown>;
}
function name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
        throw new ShiftError(400, 'Nome deve ter de 1 a 100 caracteres.');
    }
    return value.trim();
}
function time(value: unknown, label: string): string {
    if (typeof value !== 'string' || !TIME.test(value)) throw new ShiftError(400, `${label} deve usar o formato HH:mm.`);
    return value;
}
function active(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new ShiftError(400, 'Status ativo deve ser booleano.');
    return value;
}
function minute(value: string): number {
    const [hour, minutes] = value.split(':').map(Number);
    return hour * 60 + minutes;
}
function segments(startTime: string, endTime: string): Array<[number, number]> {
    const start = minute(startTime), end = minute(endTime);
    return end > start ? [[start, end]] : [[start, 1440], [0, end]];
}

export function shiftsOverlap(first: Pick<Shift, 'startTime' | 'endTime'>,
    second: Pick<Shift, 'startTime' | 'endTime'>): boolean {
    return segments(first.startTime, first.endTime).some(([firstStart, firstEnd]) =>
        segments(second.startTime, second.endTime).some(([secondStart, secondEnd]) =>
            firstStart < secondEnd && secondStart < firstEnd));
}

export function resolveCurrentShift(shifts: Shift[], at = new Date()): Shift | null {
    const now = at.getHours() * 60 + at.getMinutes();
    return shifts.find(shift => {
        if (!shift.active) return false;
        const start = minute(shift.startTime), end = minute(shift.endTime);
        return end > start ? now >= start && now < end : now >= start || now < end;
    }) ?? null;
}

function parse(value: unknown) {
    const input = record(value);
    if (Object.keys(input).some(key => !['name', 'startTime', 'endTime', 'active'].includes(key))) {
        throw new ShiftError(400, 'Informe somente nome, hora inicial, hora final e status.');
    }
    const parsed = { name: name(input.name), startTime: time(input.startTime, 'Hora inicial'),
        endTime: time(input.endTime, 'Hora final'), active: active(input.active) };
    if (parsed.startTime === parsed.endTime) throw new ShiftError(400, 'Hora inicial e hora final devem ser diferentes.');
    return parsed;
}

export class ShiftService {
    private mutation: Promise<void> = Promise.resolve();
    constructor(private readonly repository: ShiftRepository, private readonly usage?: ShiftUsageGuard) {}
    list() { return this.repository.list(); }
    async current(at = new Date()): Promise<Shift | null> { return resolveCurrentShift(await this.repository.list(), at); }
    async create(value: unknown): Promise<Shift> {
        const parsed = parse(value);
        return await this.serialize(async () => {
            await this.validateOverlap(parsed);
            const now = new Date();
            const shift: Shift = { shiftId: randomUUID(), ...parsed, createdAt: now, updatedAt: now };
            await this.repository.create(shift);
            return shift;
        });
    }
    async update(shiftId: string, value: unknown): Promise<Shift> {
        this.validateId(shiftId);
        const parsed = parse(value);
        return await this.serialize(async () => {
            const existing = await this.repository.get(shiftId);
            if (!existing) throw new ShiftError(404, 'Turno nao encontrado.');
            await this.ensureMutable(existing);
            await this.validateOverlap(parsed, shiftId);
            const updated = await this.repository.update(shiftId, { ...parsed, updatedAt: new Date() });
            if (!updated) throw new ShiftError(404, 'Turno nao encontrado.');
            return updated;
        });
    }
    async remove(shiftId: string): Promise<void> {
        this.validateId(shiftId);
        await this.serialize(async () => {
            const existing = await this.repository.get(shiftId);
            if (!existing) throw new ShiftError(404, 'Turno nao encontrado.');
            await this.ensureMutable(existing);
            if (!await this.repository.remove(shiftId)) throw new ShiftError(404, 'Turno nao encontrado.');
        });
    }
    private validateId(shiftId: string) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(shiftId)) {
            throw new ShiftError(400, 'Identificador de turno invalido.');
        }
    }
    private serialize<T>(action: () => Promise<T>): Promise<T> {
        const result = this.mutation.then(action);
        this.mutation = result.then(() => undefined, () => undefined);
        return result;
    }
    private async ensureMutable(shift: Shift, at = new Date()): Promise<void> {
        if (resolveCurrentShift([shift], at)) {
            throw new ShiftError(409, `O turno ${shift.name} esta vigente e nao pode ser alterado ou removido.`);
        }
        if (await this.usage?.hasActiveForShift(shift.shiftId)) {
            throw new ShiftError(409, `O turno ${shift.name} possui operadores ativos e nao pode ser alterado ou removido.`);
        }
    }
    private async validateOverlap(candidate: Pick<Shift, 'name' | 'startTime' | 'endTime' | 'active'>, ignoredId?: string) {
        if (!candidate.active) return;
        const conflict = (await this.repository.list()).find(shift => shift.active && shift.shiftId !== ignoredId
            && shiftsOverlap(candidate, shift));
        if (conflict) throw new ShiftError(409,
            `O horario informado se sobrepoe ao turno ${conflict.name} (${conflict.startTime} - ${conflict.endTime}).`);
    }
}
