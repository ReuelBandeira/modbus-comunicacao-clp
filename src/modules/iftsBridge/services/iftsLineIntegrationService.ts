import type { MachineAssignment, ProcessResult } from '../../pcm/workflow/models/workflowModel';
import type { TestResultCycle } from '../../testResults/models/testResultModel';
import { IftsBridgeError, type IftsBridgeClient } from './iftsBridgeClient';

interface IftsLineCoordinator {
    activeAssignment(lineId: string, machineId: string): Promise<MachineAssignment | null>;
    assignmentByCycleId(lineId: string, machineId: string, cycleId: string): Promise<MachineAssignment | null>;
    result(lineId: string, machineId: string, operationId: string, result: ProcessResult,
        data?: Record<string, unknown>): Promise<MachineAssignment>;
}

export interface IftsLineIntegrationConfig {
    lineId: string;
    machineId: string;
    expectedPositionCount: number;
}

export type IftsAppliedResult = { mode: 'debug'; cycleId: string }
    | { mode: 'production'; cycleId: string; assignment: MachineAssignment; positions: boolean[] };

export class IftsLineIntegrationError extends Error {}

export function readIftsLineIntegrationConfig(lineId: string,
    env: NodeJS.ProcessEnv = process.env): IftsLineIntegrationConfig | undefined {
    const machineId = env.IFTS_MEMORY_MACHINE_ID?.trim();
    if (!machineId) return undefined;
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(machineId)) throw new Error('IFTS_MEMORY_MACHINE_ID inválido.');
    const expectedPositionCount = Number(env.IFTS_EXPECTED_POSITION_COUNT ?? 20);
    if (!Number.isInteger(expectedPositionCount) || expectedPositionCount < 1 || expectedPositionCount > 10_000) {
        throw new Error('IFTS_EXPECTED_POSITION_COUNT deve ser um inteiro entre 1 e 10000.');
    }
    return { lineId, machineId, expectedPositionCount };
}

/** Integra o ciclo automático do IFTS à etapa produtiva da bandeja. Ciclos SIM permanecem isolados para debug. */
export class IftsLineIntegrationService {
    constructor(private readonly config: IftsLineIntegrationConfig,
        private readonly coordinator: IftsLineCoordinator,
        private readonly bridge: IftsBridgeClient) {}

    async assertDebugStart(body: unknown): Promise<void> {
        const cycleId = body && typeof body === 'object' && !Array.isArray(body)
            ? (body as Record<string, unknown>).cycleId : undefined;
        if (typeof cycleId !== 'string' || !cycleId.startsWith('SIM-')) {
            throw new IftsBridgeError(400, 'Ciclos iniciados pela tela de debug devem usar o prefixo SIM-.');
        }
        const active = await this.coordinator.activeAssignment(this.config.lineId, this.config.machineId);
        if (active) {
            throw new IftsBridgeError(409,
                `A estação de memória está ocupada pela bandeja ${active.serialNumber}; o START de debug foi bloqueado.`);
        }
    }

    async start(): Promise<MachineAssignment> {
        let assignment = await this.coordinator.activeAssignment(this.config.lineId, this.config.machineId);
        if (!assignment) {
            throw new IftsLineIntegrationError('A M2 ainda não recebeu os dados de uma bandeja. Solicite o QR antes do START.');
        }
        if (!assignment.identificationAcknowledgedAt) {
            const deadline = Date.now() + 1_500;
            while (!assignment.identificationAcknowledgedAt && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 50));
                assignment = await this.coordinator.activeAssignment(this.config.lineId, this.config.machineId);
                if (!assignment) break;
            }
            if (!assignment?.identificationAcknowledgedAt) {
                throw new IftsLineIntegrationError('A CLP ainda não confirmou a captura do QR da bandeja.');
            }
        }
        if (assignment.action !== 'EXECUTE') {
            throw new IftsLineIntegrationError('A bandeja está em bypass na estação de memória e não pode iniciar o IFTS.');
        }
        if (assignment.state !== 'processing') {
            throw new IftsLineIntegrationError('A estação de memória já recebeu o resultado e aguarda confirmação de passagem.');
        }
        await this.bridge.start({ cycleId: assignment.cycleId });
        return assignment;
    }

    async apply(cycle: TestResultCycle): Promise<IftsAppliedResult> {
        if (cycle.cycleId.startsWith('SIM-')) return { mode: 'debug', cycleId: cycle.cycleId };
        const assignment = await this.coordinator.assignmentByCycleId(
            this.config.lineId, this.config.machineId, cycle.cycleId);
        if (!assignment) {
            throw new IftsLineIntegrationError(
                `O ciclo ${cycle.cycleId} não pertence a uma bandeja da estação ${this.config.machineId}.`);
        }
        const positions = this.positions(cycle);
        const result: ProcessResult = cycle.passed ? 'OK' : 'NAO';
        const updated = await this.coordinator.result(this.config.lineId, this.config.machineId,
            assignment.operationId, result, {
                protocol: 'ifts-bridge', iftsCycleId: cycle.cycleId, model: cycle.model,
                positionCount: cycle.totalPositions, positions,
                passedPositions: cycle.passedPositions, failedPositions: cycle.failedPositions
            });
        return { mode: 'production', cycleId: cycle.cycleId, assignment: updated, positions };
    }

    /** Confirma o retorno do término à CLP sem antecipar a saída física da bandeja. */
    async completeAfterResultWrite(cycleId: string): Promise<MachineAssignment> {
        const assignment = await this.coordinator.assignmentByCycleId(
            this.config.lineId, this.config.machineId, cycleId);
        if (!assignment) {
            throw new IftsLineIntegrationError(
                `O ciclo ${cycleId} não pertence a uma bandeja da estação ${this.config.machineId}.`);
        }
        if (assignment.state === 'completed' || assignment.state === 'skipped') return assignment;
        if (assignment.state !== 'result_recorded') {
            throw new IftsLineIntegrationError('A bandeja ainda não possui resultado IFTS persistido.');
        }
        return assignment;
    }

    private positions(cycle: TestResultCycle): boolean[] {
        const expected = this.config.expectedPositionCount;
        if (cycle.totalPositions !== expected || cycle.positions.length !== expected) {
            throw new IftsLineIntegrationError(
                `Resultado IFTS inválido: esperadas ${expected} posições; recebidas ${cycle.totalPositions}.`);
        }
        const ordered = [...cycle.positions].sort((left, right) => left.position - right.position);
        const invalid = ordered.find((position, index) => position.position !== index + 1);
        if (invalid) {
            throw new IftsLineIntegrationError(`Resultado IFTS inválido: posições devem ser contínuas de 1 a ${expected}.`);
        }
        return ordered.map(position => position.passed);
    }
}
