import { randomUUID } from 'node:crypto';
import { WorkflowError } from '../../pcm/workflow/errors/workflowError';
import type { LineOperationCheck, LineOperationState } from '../models/lineOperationModel';
import type { LineOperationRepositoryContract } from '../repositories/lineOperationRepository';

export interface LineOperationControls {
    operators(): Promise<Omit<LineOperationCheck, 'key' | 'label'>>;
    endOfLine(): Promise<Omit<LineOperationCheck, 'key' | 'label'>>;
    bridge(startIfOffline: boolean): Promise<Omit<LineOperationCheck, 'key' | 'label'>>;
    plcs(): Promise<Omit<LineOperationCheck, 'key' | 'label'> & { commandCode?: string }>;
}

const definitions = [
    ['operators', 'Equipe mínima'], ['end_of_line', 'Final de Linha'],
    ['bridge', 'Teste de memória'], ['plcs', 'Comunicação das CLPs']
] as const;

function requestId(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) {
        throw new WorkflowError(400, 'requestId inválido para iniciar a operação.');
    }
    return value;
}

export class LineOperationService {
    private startLock: Promise<void> = Promise.resolve();
    constructor(private readonly lineId: string, private readonly repository: LineOperationRepositoryContract,
        private readonly controls: LineOperationControls) {}

    async status(): Promise<LineOperationState> {
        const stored = await this.repository.current(this.lineId);
        if (stored?.status === 'running') return stored;
        const { checks } = await this.checks(false);
        return { lineId: this.lineId, status: stored?.status ?? 'stopped', checks,
            updatedAt: stored?.updatedAt ?? new Date(), ...(stored?.error ? { error: stored.error } : {}) };
    }

    async start(body: unknown): Promise<LineOperationState> {
        const input = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
        const id = requestId(input.requestId); let result: LineOperationState | undefined;
        const task = this.startLock.then(async () => {
            const current = await this.repository.current(this.lineId);
            if (current?.status === 'running') { result = current; return; }
            if (current && ['checking', 'starting'].includes(current.status)) {
                throw new WorkflowError(409, 'Já existe uma inicialização da linha em andamento.');
            }
            const operationId = randomUUID(), checking: LineOperationState = {
                lineId: this.lineId, operationId, startRequestId: id, status: 'checking', checks: [], updatedAt: new Date()
            };
            await this.repository.save(checking);
            let checks: LineOperationCheck[] = [];
            try {
                const evaluated = await this.checks(true);
                checks = evaluated.checks;
                const failures = checks.filter(item => !item.ok);
                if (failures.length) throw new WorkflowError(409,
                    `Operação bloqueada: ${failures.map(item => item.detail).join(' ')}`);
                if (!evaluated.commandCode) throw new WorkflowError(409, 'Comando START geral não configurado.');
                const starting: LineOperationState = { ...checking, status: 'starting', checks, updatedAt: new Date() };
                await this.repository.save(starting);
                result = { ...starting, status: 'running', startedAt: new Date(), updatedAt: new Date() };
                await this.repository.save(result);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Não foi possível iniciar a operação.';
                const failed: LineOperationState = { ...checking, status: 'failed', checks,
                    error: message, updatedAt: new Date() };
                await this.repository.save(failed); throw error;
            }
        });
        this.startLock = task.catch(() => {}); await task; return result!;
    }

    async assertRunning(): Promise<void> {
        if ((await this.repository.current(this.lineId))?.status !== 'running') {
            throw new WorkflowError(409, 'Bipagem bloqueada: inicie a operação da linha na tela de Entrada.');
        }
    }

    async markStopped(): Promise<void> {
        const current = await this.repository.current(this.lineId);
        if (current?.status !== 'running') return;
        const now = new Date();
        await this.repository.save({ ...current, status: 'stopped', stoppedAt: now, updatedAt: now });
    }

    private async checks(startBridge: boolean): Promise<{ checks: LineOperationCheck[]; commandCode?: string }> {
        const actions = [() => this.controls.operators(), () => this.controls.endOfLine(),
            () => this.controls.bridge(startBridge), () => this.controls.plcs()];
        const results = await Promise.allSettled(actions.map(action => action()));
        const checks = results.map((result, index) => {
            const [key, label] = definitions[index]!;
            if (result.status === 'fulfilled') return { key, label, ok: result.value.ok, detail: result.value.detail,
                ...(result.value.actionable === true ? { actionable: true } : {}) };
            return { key, label, ok: false,
                detail: result.reason instanceof Error ? result.reason.message : `${label} indisponível.` };
        });
        const plc = results[3] as PromiseSettledResult<Awaited<ReturnType<LineOperationControls['plcs']>>>;
        return { checks, ...(plc?.status === 'fulfilled' && plc.value.commandCode
            ? { commandCode: plc.value.commandCode } : {}) };
    }
}
