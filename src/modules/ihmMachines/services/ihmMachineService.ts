import { identifier } from '../../machines/validators/lineValidation';
import type { PlcSignalRepository } from '../../plcSignals/repositories/plcSignalRepository';
import type { IhmMachine, IhmMachineCommandMap } from '../models/ihmMachineModel';
import type { IhmMachineRepositoryContract } from '../repositories/ihmMachineRepository';

export class IhmMachineError extends Error {
    constructor(public readonly status: 400 | 404 | 409 | 503, message: string) { super(message); }
}

const allowedKeys = ['ihmMachineId', 'name', 'enabled', 'order', 'commandIds'] as const;
const actionKeys = ['start', 'stop', 'reset'] as const;

function object(value: unknown, label = 'dados'): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IhmMachineError(400, `Informe ${label} em um objeto JSON.`);
    return value as Record<string, unknown>;
}
function machineName(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) {
        throw new IhmMachineError(400, 'Nome da máquina deve ter de 1 a 100 caracteres.');
    }
    return value.trim();
}
function enabled(value: unknown) {
    if (typeof value !== 'boolean') throw new IhmMachineError(400, 'enabled deve ser booleano.');
    return value;
}
function order(value: unknown) {
    if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 9999) {
        throw new IhmMachineError(400, 'order deve ser um inteiro entre 0 e 9999.');
    }
    return value as number;
}

export class IhmMachineService {
    constructor(private readonly repository: IhmMachineRepositoryContract, private readonly signals: Pick<PlcSignalRepository, 'command'>,
        private readonly lineId: string) {}

    list(operationalOnly = false) { return this.repository.list(this.lineId, operationalOnly); }

    private async commandMap(value: unknown): Promise<IhmMachineCommandMap> {
        const input = object(value, 'commandIds');
        if (Object.keys(input).some(key => !actionKeys.includes(key as typeof actionKeys[number]))) {
            throw new IhmMachineError(400, 'commandIds aceita somente start, stop e reset.');
        }
        const result: IhmMachineCommandMap = {};
        for (const action of actionKeys) {
            const raw = input[action];
            if (raw === undefined || raw === null || raw === '') continue;
            const commandId = identifier(raw, `commandIds.${action}`);
            if (!await this.signals.command(this.lineId, commandId)) {
                throw new IhmMachineError(400, `Comando ${action} não existe na configuração de sinais desta linha.`);
            }
            result[action] = commandId;
        }
        const assigned = Object.values(result);
        if (new Set(assigned).size !== assigned.length) throw new IhmMachineError(400, 'Use um comando diferente para cada ação.');
        return result;
    }

    private async parse(value: unknown, fixedId?: string) {
        const input = object(value);
        if (Object.keys(input).some(key => !allowedKeys.includes(key as typeof allowedKeys[number]))) {
            throw new IhmMachineError(400, `Informe somente ${allowedKeys.join(', ')}.`);
        }
        return {
            ihmMachineId: identifier(fixedId ?? input.ihmMachineId, 'ihmMachineId'),
            name: machineName(input.name),
            enabled: input.enabled === undefined ? true : enabled(input.enabled),
            order: input.order === undefined ? 0 : order(input.order),
            commandIds: await this.commandMap(input.commandIds ?? {})
        };
    }

    async create(value: unknown): Promise<IhmMachine> {
        const input = await this.parse(value), now = new Date();
        const machine: IhmMachine = { lineId: this.lineId, ...input, createdAt: now, updatedAt: now };
        try { await this.repository.create(machine); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) throw new IhmMachineError(409, 'Máquina IHM já cadastrada.');
            throw error;
        }
        return machine;
    }

    async update(ihmMachineId: string, value: unknown): Promise<IhmMachine> {
        const id = identifier(ihmMachineId, 'ihmMachineId');
        const current = await this.repository.get(this.lineId, id);
        if (!current) throw new IhmMachineError(404, 'Máquina IHM não encontrada.');
        const input = await this.parse(value, id);
        const machine: IhmMachine = { lineId: this.lineId, ...input, createdAt: current.createdAt, updatedAt: new Date() };
        if (!await this.repository.update(machine)) throw new IhmMachineError(404, 'Máquina IHM não encontrada.');
        return machine;
    }

    async remove(ihmMachineId: string): Promise<void> {
        if (!await this.repository.remove(this.lineId, identifier(ihmMachineId, 'ihmMachineId'))) {
            throw new IhmMachineError(404, 'Máquina IHM não encontrada.');
        }
    }
}
