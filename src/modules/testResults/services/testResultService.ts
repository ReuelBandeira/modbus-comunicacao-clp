import { createHash, timingSafeEqual } from 'node:crypto';
import type { TestOutcome, TestResultCycle, TestResultPosition, TestResultSourceFile } from '../models/testResultModel';
import type { TestResultQuery, TestResultRepositoryContract } from '../repositories/testResultRepository';

export class TestResultError extends Error { constructor(public readonly status: 400 | 401 | 404 | 500 | 503, message: string) { super(message); } }
export interface TestResultReceipt { received: true; duplicate: boolean; cycleId: string; receivedAt?: Date; }
export type TestResultPersistedHandler = (cycle: TestResultCycle) => Promise<void>;
const record = (value: unknown, label: string): Record<string, unknown> => { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TestResultError(400, `${label} deve ser um objeto.`); return value as Record<string, unknown>; };
const text = (value: unknown, label: string, max: number) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new TestResultError(400, `${label} inválido.`); return value.trim(); };
const nullableText = (value: unknown, label: string, max: number) => value === null ? null : text(value, label, max);
const integer = (value: unknown, label: string, max = 10_000_000) => { if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > max) throw new TestResultError(400, `${label} inválido.`); return value as number; };
const instant = (value: unknown, label: string) => { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) throw new TestResultError(400, `${label} deve estar em ISO 8601 UTC.`); const parsed = new Date(value); if (Number.isNaN(parsed.getTime())) throw new TestResultError(400, `${label} inválido.`); return parsed; };
const queryInstant = (value: unknown, label: string) => value === undefined ? undefined : instant(value, label);

export class TestResultService {
    constructor(private readonly repository: TestResultRepositoryContract, private readonly apiKey?: string,
        private readonly afterPersist?: TestResultPersistedHandler,
        private readonly beforeAcknowledge?: TestResultPersistedHandler) {}
    async receive(payload: unknown, idempotencyKey?: string, suppliedApiKey?: string): Promise<TestResultReceipt> {
        this.authorize(suppliedApiKey); const cycle = this.parse(payload, idempotencyKey);
        console.info(`[IFTS] POST /api/test-results cycleId=${cycle.cycleId} result=${cycle.result} positions=${cycle.totalPositions}`);
        let duplicate = false;
        try { await this.repository.insert(cycle); console.info(`[IFTS] Resultado persistido cycleId=${cycle.cycleId}.`); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) { duplicate = true; console.info(`[IFTS] Resultado duplicado cycleId=${cycle.cycleId}.`); }
            else { console.error(`[IFTS] Erro ao persistir cycleId=${cycle.cycleId}: ${error instanceof Error ? error.message : 'erro desconhecido'}`); throw new TestResultError(500, 'Não foi possível persistir o resultado do teste.'); }
        }
        try { await this.beforeAcknowledge?.(cycle); }
        catch (error) {
            console.error(`[IFTS] Resultado salvo, mas não integrado à linha cycleId=${cycle.cycleId}: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
            throw new TestResultError(500, 'Resultado salvo, mas ainda não foi integrado à bandeja da linha. O Bridge deve repetir a entrega.');
        }
        try { await this.afterPersist?.(cycle); }
        catch (error) {
            console.error(`[IFTS] Resultado salvo; bypass de debug confirmou o recebimento apesar da falha no retorno para a CLP cycleId=${cycle.cycleId}: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
        }
        return { received: true, duplicate, cycleId: cycle.cycleId, ...(duplicate ? {} : { receivedAt: cycle.receivedAt }) };
    }
    async byCycleId(value: unknown) { const cycleId = text(value, 'cycleId', 200), result = await this.repository.byCycleId(cycleId); if (!result) throw new TestResultError(404, 'Ciclo de teste não encontrado.'); return result; }
    list(values: Record<string, unknown>) { const limit = values.limit === undefined ? 50 : Number(values.limit); if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new TestResultError(400, 'limit deve estar entre 1 e 500.'); const from = queryInstant(values.from, 'from'), to = queryInstant(values.to, 'to'); if (from && to && from > to) throw new TestResultError(400, 'O período informado é inválido.'); return this.repository.list({ limit, ...(values.model === undefined ? {} : { model: text(values.model, 'model', 120) }), ...(from ? { from } : {}), ...(to ? { to } : {}) } as TestResultQuery); }
    private authorize(supplied?: string) { if (!this.apiKey) return; if (typeof supplied !== 'string') throw new TestResultError(401, 'X-API-Key inválida.'); const expected = createHash('sha256').update(this.apiKey).digest(), actual = createHash('sha256').update(supplied).digest(); if (!timingSafeEqual(expected, actual)) throw new TestResultError(401, 'X-API-Key inválida.'); }
    private parse(payload: unknown, idempotencyKey?: string): TestResultCycle {
        const input = record(payload, 'Payload'); if (input.schemaVersion !== 2) throw new TestResultError(400, 'schemaVersion deve ser 2.');
        const cycleId = text(input.cycleId, 'cycleId', 200), headerKey = idempotencyKey?.trim(); if (headerKey && headerKey !== cycleId) throw new TestResultError(400, 'Idempotency-Key deve ser igual ao cycleId.');
        const model = text(input.model, 'model', 120), startedAt = instant(input.startedAt, 'startedAt'), finishedAt = instant(input.finishedAt, 'finishedAt'); if (finishedAt < startedAt) throw new TestResultError(400, 'finishedAt não pode ser anterior a startedAt.');
        const result = this.outcome(input.result, 'result'), passed = input.passed; if (typeof passed !== 'boolean' || passed !== (result === 'PASS')) throw new TestResultError(400, 'passed deve corresponder a result.');
        if (!Array.isArray(input.positions) || input.positions.length > 10_000) throw new TestResultError(400, 'positions inválido.'); const positions = input.positions.map((value, index) => this.position(value, index)); if (new Set(positions.map(position => position.position)).size !== positions.length) throw new TestResultError(400, 'positions não pode conter posições duplicadas.');
        const totalPositions = integer(input.totalPositions, 'totalPositions'), passedPositions = integer(input.passedPositions, 'passedPositions'), failedPositions = integer(input.failedPositions, 'failedPositions'), actualPassed = positions.filter(position => position.passed).length;
        if (totalPositions !== positions.length || passedPositions !== actualPassed || failedPositions !== positions.length - actualPassed) throw new TestResultError(400, 'Contadores de posições diferem dos detalhes recebidos.'); if (passed !== (failedPositions === 0)) throw new TestResultError(400, 'Resultado do ciclo difere das posições recebidas.');
        if (!Array.isArray(input.sourceFiles) || input.sourceFiles.length < 1 || input.sourceFiles.length > 100) throw new TestResultError(400, 'sourceFiles deve conter entre 1 e 100 arquivos.'); const sourceFiles = input.sourceFiles.map((value, index) => this.sourceFile(value, index)); if (sourceFiles.reduce((sum, file) => sum + file.positionCount, 0) !== totalPositions) throw new TestResultError(400, 'sourceFiles difere do total de posições.');
        return { schemaVersion: 2, cycleId, model, startedAt, finishedAt, result, passed, totalPositions, passedPositions, failedPositions, positions, sourceFiles, receivedAt: new Date() };
    }
    private outcome(value: unknown, label: string): TestOutcome { if (value !== 'PASS' && value !== 'FAIL') throw new TestResultError(400, `${label} deve ser PASS ou FAIL.`); return value; }
    private position(value: unknown, index: number): TestResultPosition { const input = record(value, `positions[${index}]`), result = this.outcome(input.result, `positions[${index}].result`); if (!Number.isInteger(input.position) || (input.position as number) < 1) throw new TestResultError(400, `positions[${index}].position inválido.`); if (typeof input.passed !== 'boolean' || input.passed !== (result === 'PASS')) throw new TestResultError(400, `positions[${index}].passed deve corresponder a result.`); return { position: input.position as number, passed: input.passed, result, judgment: nullableText(input.judgment, `positions[${index}].judgment`, 120), ngStep: nullableText(input.ngStep, `positions[${index}].ngStep`, 120), message: nullableText(input.message, `positions[${index}].message`, 1000) }; }
    private sourceFile(value: unknown, index: number): TestResultSourceFile { const input = record(value, `sourceFiles[${index}]`); return { name: text(input.name, `sourceFiles[${index}].name`, 255), positionCount: integer(input.positionCount, `sourceFiles[${index}].positionCount`) }; }
}
