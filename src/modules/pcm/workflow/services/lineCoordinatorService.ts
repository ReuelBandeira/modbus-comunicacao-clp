import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LineRepositoryContract } from '../../../machines/repositories/lineRepository';
import { identifier, object, parseLine } from '../../../machines/validators/lineValidation';
import type { PcmWorkflowRepositoryContract } from '../../repositories/pcmWorkflowRepository';
import type { PCM } from '../../models/pcmModel';
import type { MachineAssignment, PcmStage, PcmWorkflow, ProcessResult, TrayInterventionAction } from '../models/workflowModel';
import { WorkflowError } from '../errors/workflowError';
import type { LineDashboard } from '../dtos/lineDashboardDto';
import { buildChipMetrics, chipMetricsWindow } from './chipMetricsService';
import { communicationLog } from '../../../modbus/services/communicationLog';

export interface EntryWorkflow {
    admit(pcm: PCM, persist: () => Promise<void>): Promise<void>;
}

export interface RuntimeInterventionControl {
    pause(): Promise<void>;
    resume(): void;
}
export interface LineOperationalControl { blocksEntry(): boolean; }

export class LineCoordinatorService implements EntryWorkflow {
    private readonly configurationTasks = new Map<string, Promise<unknown>>();
    private readonly stationTasks = new Map<string, Promise<unknown>>();
    private runtimeInterventionControl?: RuntimeInterventionControl;
    private operationalControl?: LineOperationalControl;
    constructor(private readonly lines: LineRepositoryContract,
        private readonly pcms: PcmWorkflowRepositoryContract, private readonly entryLineId: string,
        private readonly bypassEnabled = false) {
        identifier(entryLineId, 'PCM_LINE_ID');
    }

    setRuntimeInterventionControl(control: RuntimeInterventionControl): void {
        this.runtimeInterventionControl = control;
    }
    setOperationalControl(control: LineOperationalControl): void { this.operationalControl = control; }

    async createLine(body: unknown) {
        const config = parseLine(body);
        await this.lines.create(config);
        return config;
    }
    // Compartilha a exclusão entre edição e admissão até o insert terminar.
    // O deployment segue com um único coordenador por linha.
    private exclusive<T>(lineId: string, action: () => Promise<T>): Promise<T> {
        const operation = (this.configurationTasks.get(lineId) ?? Promise.resolve()).then(action);
        const tail = operation.catch(() => {});
        this.configurationTasks.set(lineId, tail);
        void tail.then(() => {
            if (this.configurationTasks.get(lineId) === tail) this.configurationTasks.delete(lineId);
        });
        return operation;
    }
    private stationExclusive<T>(lineId: string, machineId: string, action: () => Promise<T>): Promise<T> {
        const key = `${lineId}:${machineId}`;
        const operation = (this.stationTasks.get(key) ?? Promise.resolve()).then(action);
        const tail = operation.catch(() => {});
        this.stationTasks.set(key, tail);
        void tail.then(() => { if (this.stationTasks.get(key) === tail) this.stationTasks.delete(key); });
        return operation;
    }
    async updateLine(lineId: string, body: unknown) {
        identifier(lineId, 'lineId');
        const input = object(body);
        if (input.lineId !== undefined && input.lineId !== lineId) throw new WorkflowError(400, 'lineId diverge da URL.');
        if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) {
            throw new WorkflowError(400, 'Informe a revision obtida na consulta da linha.');
        }
        const parsed = parseLine({ ...input, lineId });
        return this.exclusive(lineId, async () => {
            const current = await this.getLine(lineId);
            if (input.revision !== current.revision) throw new WorkflowError(409, 'Configuração foi alterada. Consulte a linha novamente.');
            if (await this.pcms.hasInProgress(lineId)) {
                throw new WorkflowError(409, 'Finalize as bandejas da linha antes de alterar máquinas ou sequência.');
            }
            const updated = { ...parsed, createdAt: current.createdAt, revision: current.revision + 1, updatedAt: new Date() };
            if (!await this.lines.update(updated, current.revision)) throw new WorkflowError(409, 'Configuração foi alterada. Consulte a linha novamente.');
            return updated;
        });
    }
    async updateMinimumOperators(lineId: string, body: unknown) {
        identifier(lineId, 'lineId');
        const input = object(body);
        if (Object.keys(input).some(key => !['minimumOperators', 'revision'].includes(key))) {
            throw new WorkflowError(400, 'Informe somente minimumOperators e revision.');
        }
        if (!Number.isInteger(input.minimumOperators) || (input.minimumOperators as number) < 1
            || (input.minimumOperators as number) > 99) {
            throw new WorkflowError(400, 'Operadores mínimos: informe um inteiro de 1 a 99.');
        }
        if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) {
            throw new WorkflowError(400, 'Informe a revision obtida na consulta da linha.');
        }
        return this.exclusive(lineId, async () => {
            const current = await this.getLine(lineId);
            if (input.revision !== current.revision) throw new WorkflowError(409, 'Configuração foi alterada. Consulte a linha novamente.');
            const updatedAt = new Date();
            if (!await this.lines.updateMinimumOperators(lineId, input.minimumOperators as number, current.revision, updatedAt)) {
                throw new WorkflowError(409, 'Configuração foi alterada. Consulte a linha novamente.');
            }
            return { ...current, minimumOperators: input.minimumOperators as number,
                revision: current.revision + 1, updatedAt };
        });
    }
    async getLine(lineId: string) {
        identifier(lineId, 'lineId');
        const line = await this.lines.get(lineId);
        if (!line) throw new WorkflowError(404, 'Linha não cadastrada.');
        return line;
    }
    context() { return { entryLineId: this.entryLineId }; }
    async dashboard(lineId: string): Promise<LineDashboard> {
        const line = await this.getLine(lineId);
        const machineIds = new Set(line.machines.map(machine => machine.machineId));
        return { line, snapshot: await this.pcms.snapshot(lineId),
            communication: communicationLog.health().filter(health => machineIds.has(health.machineId)), capturedAt: new Date() };
    }
    async admit(pcm: PCM, persist: () => Promise<void>): Promise<void> {
        await this.exclusive(this.entryLineId, async () => {
            if (this.operationalControl?.blocksEntry()) throw new WorkflowError(409, 'Entrada bloqueada por sinal operacional da CLP.');
            const line = await this.getLine(this.entryLineId);
            const first = line.machines[0];
            const capacity = first.protocol === 'm1-qr-handshake-v1' && first.modbus?.enabled
                ? first.modbus.map.serialRegisterCount * 2 : undefined;
            const qrBytes = Buffer.byteLength(pcm.serialNumber, 'utf8');
            if (capacity !== undefined && qrBytes > capacity) {
                throw new WorkflowError(400,
                    `QR possui ${qrBytes} bytes, mas a Máquina 1 aceita no máximo ${capacity} bytes.`);
            }
            pcm.workflow = await this.prepare(line);
            await persist();
        });
    }
    private async prepare(line: Awaited<ReturnType<LineCoordinatorService['getLine']>>): Promise<PcmWorkflow> {
        return {
            lineId: line.lineId, lineRevision: line.revision, entrySequence: await this.lines.nextSequence(line.lineId),
            version: 0, status: 'in_progress', quality: 'pending', nextMachineId: line.machines[0].machineId,
            stages: line.machines.map(machine => ({ machineId: machine.machineId, state: 'waiting' }))
        };
    }
    async machine(lineId: string, machineId: string) {
        identifier(machineId, 'machineId');
        const line = await this.getLine(lineId);
        const machine = line.machines.find(item => item.machineId === machineId);
        if (!machine) throw new WorkflowError(404, 'Máquina não pertence à linha.');
        return machine;
    }
    private assignment(pcm: PCM, stage: PcmStage): MachineAssignment {
        return { serialNumber: pcm.serialNumber, entrySequence: pcm.workflow!.entrySequence,
            machineId: stage.machineId, cycleId: stage.cycleId!,
            operationId: stage.operationId!, action: stage.action!, state: stage.state,
            blockedByMachine: pcm.workflow!.blockedByMachine,
            startedAt: stage.startedAt,
            communicationState: stage.communicationState,
            identificationAcknowledgedAt: stage.identificationAcknowledgedAt };
    }

    async activeAssignment(lineId: string, machineId: string): Promise<MachineAssignment | null> {
        await this.machine(lineId, machineId);
        const pcm = await this.pcms.active(lineId, machineId);
        if (!pcm) return null;
        const stage = pcm.workflow!.stages.find(item => item.machineId === machineId);
        return stage?.operationId ? this.assignment(pcm, stage) : null;
    }

    async activeAssignments(lineId: string, machineId: string): Promise<MachineAssignment[]> {
        await this.machine(lineId, machineId);
        return (await this.pcms.activeMany(lineId, machineId)).flatMap(pcm => {
            const stage = pcm.workflow?.stages.find(item => item.machineId === machineId);
            return stage?.operationId ? [this.assignment(pcm, stage)] : [];
        });
    }

    async assignmentBySerial(lineId: string, machineId: string, serialNumber: string): Promise<MachineAssignment | null> {
        await this.machine(lineId, machineId);
        const pcm = await this.pcms.get(serialNumber);
        if (!pcm?.workflow || pcm.workflow.lineId !== lineId) return null;
        const stage = pcm.workflow.stages.find(item => item.machineId === machineId);
        return stage?.operationId ? this.assignment(pcm, stage) : null;
    }

    async assignmentByCycleId(lineId: string, machineId: string, cycleId: string): Promise<MachineAssignment | null> {
        await this.machine(lineId, machineId);
        identifier(cycleId, 'cycleId');
        const pcm = await this.pcms.byStageCycleId(lineId, machineId, cycleId);
        if (!pcm) return null;
        const stage = pcm.workflow?.stages.find(item => item.machineId === machineId && item.cycleId === cycleId);
        return stage?.operationId ? this.assignment(pcm, stage) : null;
    }

    async arriveNext(lineId: string, machineId: string): Promise<MachineAssignment> {
        if (this.operationalControl?.blocksEntry()) throw new WorkflowError(409, 'Fluxo bloqueado por sinal operacional da CLP.');
        return this.stationExclusive(lineId, machineId, async () => {
            const machine = await this.machine(lineId, machineId);
            const active = await this.pcms.activeMany(lineId, machineId);
            const capacity = machine.protocol === 'm1-qr-handshake-v1' ? machine.modbus?.inFlightCapacity ?? 1 : 1;
            if (active.length >= capacity) throw new WorkflowError(409,
                `Célula ocupada: ${active.length} de ${capacity} bandejas em processamento.`);
            const next = await this.pcms.firstWaiting(lineId, machineId);
            if (!next) throw new WorkflowError(409, 'Nenhuma bandeja aguardando esta estação.');
            return this.reserve(lineId, machineId, `entry-${next.workflow!.entrySequence}`, capacity);
        });
    }
    async chipMetrics(lineId: string, fromValue: unknown, toValue: unknown, timezoneOffsetValue: unknown) {
        await this.getLine(lineId);
        const now = new Date();
        const from = typeof fromValue === 'string' ? new Date(fromValue) : new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const to = typeof toValue === 'string' ? new Date(toValue) : now;
        const timezoneOffsetMinutes = timezoneOffsetValue === undefined ? now.getTimezoneOffset() : Number(timezoneOffsetValue);
        if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
            throw new WorkflowError(400, 'Informe um período válido para o relatório.');
        }
        if (to.getTime() - from.getTime() > 93 * 24 * 60 * 60 * 1000) {
            throw new WorkflowError(400, 'O relatório por hora permite períodos de até 93 dias.');
        }
        if (!Number.isInteger(timezoneOffsetMinutes) || timezoneOffsetMinutes < -840 || timezoneOffsetMinutes > 840) {
            throw new WorkflowError(400, 'Fuso horário inválido.');
        }
        const window = chipMetricsWindow(from, to, timezoneOffsetMinutes, now);
        const queryFrom = new Date(Math.min(window.periodFrom.getTime(), window.trendFrom.getTime()));
        const queryTo = new Date(Math.max(window.periodTo.getTime(), window.trendTo.getTime()));
        return buildChipMetrics(await this.pcms.completedBetween(lineId, queryFrom, queryTo), window, now);
    }

    /** Resolve a unidade do mailbox sem ultrapassar a ordem fisica da fila. */
    async mailboxAssignment(lineId: string, machineId: string, entrySequence = 0): Promise<MachineAssignment> {
        await this.machine(lineId, machineId);
        const active = await this.pcms.active(lineId, machineId);
        if (active) return this.assignment(active, active.workflow!.stages.find(item => item.machineId === machineId)!);
        // Recuperacao apos reinicio: se o banco ja concluiu este mailbox, devolve a
        // mesma operacao para o runtime apenas confirmar a limpeza na CLP.
        if (Number.isSafeInteger(entrySequence) && entrySequence > 0) {
            const previous = await this.pcms.bySequence(lineId, entrySequence);
            const stage = previous?.workflow?.stages.find(item => item.machineId === machineId);
            if (previous && stage?.operationId && ['completed', 'skipped'].includes(stage.state)) {
                return this.assignment(previous, stage);
            }
        }
        return this.arriveNext(lineId, machineId);
    }

    /** Persiste identificacao, resultado e passagem numa unica troca de versao. */
    async completeMailboxStage(lineId: string, machineId: string, entrySequence: number,
        result: ProcessResult, data: Record<string, unknown> = {}): Promise<MachineAssignment> {
        await this.machine(lineId, machineId);
        if (!['OK', 'NAO'].includes(result)) throw new WorkflowError(400, 'Resultado deve ser OK ou NAO.');
        object(data);
        if (Buffer.byteLength(JSON.stringify(data)) > 3000) throw new WorkflowError(400, 'Dados adicionais excedem 3000 bytes.');
        if (!Number.isSafeInteger(entrySequence) || entrySequence < 1) throw new WorkflowError(400, 'entrySequence invalida.');
        for (let attempt = 0; attempt < 5; attempt++) {
            const pcm = await this.pcms.bySequence(lineId, entrySequence);
            const workflow = pcm?.workflow;
            const stage = workflow?.stages.find(item => item.machineId === machineId);
            if (!pcm || !workflow || !stage?.operationId) throw new WorkflowError(404, 'Operacao do mailbox nao encontrada.');
            if (stage.state === 'completed' || stage.state === 'skipped') return this.assignment(pcm, stage);
            if (workflow.activeMachineId !== machineId || stage.state !== 'processing') {
                throw new WorkflowError(409, 'Unidade nao esta em processamento nesta estacao.');
            }
            const now = new Date();
            delete stage.communicationState;
            delete stage.communicationErrorAt;
            delete stage.communicationData;
            stage.identificationAcknowledgedAt ??= now;
            stage.data = data;
            if (stage.action === 'EXECUTE') {
                stage.result = result; stage.resultAt = now; stage.state = 'completed';
                if (result === 'NAO') { workflow.quality = 'rejected'; workflow.blockedByMachine ??= machineId; }
            } else {
                stage.state = 'skipped';
            }
            stage.passedAt = now;
            delete workflow.activeMachineId;
            const next = workflow.stages[workflow.stages.indexOf(stage) + 1];
            if (next) workflow.nextMachineId = next.machineId;
            else {
                delete workflow.nextMachineId; workflow.status = 'completed'; workflow.completedAt = now;
                if (workflow.quality !== 'rejected') workflow.quality = 'approved';
            }
            if (await this.pcms.save(workflow.lineId, workflow.entrySequence, workflow.version, workflow)) return this.assignment(pcm, stage);
        }
        throw new WorkflowError(409, 'Atualizacao concorrente do mailbox. Repita a leitura.');
    }

    /** Registra uma falha de comunicação sem transformar erro de protocolo em reprovação de produto. */
    async recordCommunicationFault(lineId: string, machineId: string, entrySequence: number,
        data: Record<string, unknown>): Promise<MachineAssignment> {
        await this.machine(lineId, machineId);
        object(data);
        if (Buffer.byteLength(JSON.stringify(data)) > 3000) throw new WorkflowError(400, 'Dados adicionais excedem 3000 bytes.');
        if (!Number.isSafeInteger(entrySequence) || entrySequence < 1) throw new WorkflowError(400, 'entrySequence invalida.');
        for (let attempt = 0; attempt < 5; attempt++) {
            const pcm = await this.pcms.bySequence(lineId, entrySequence);
            const workflow = pcm?.workflow;
            const stage = workflow?.stages.find(item => item.machineId === machineId);
            if (!pcm || !workflow || !stage?.operationId) throw new WorkflowError(404, 'Operacao do mailbox nao encontrada.');
            if (workflow.activeMachineId !== machineId || !['processing', 'result_recorded'].includes(stage.state)) {
                throw new WorkflowError(409, 'Unidade nao esta em processamento nesta estacao.');
            }
            const communicationState = data.communicationState;
            if (!['correlation_error', 'protocol_error', 'timeout', 'connection_error'].includes(String(communicationState))) {
                throw new WorkflowError(400, 'Estado de falha de comunicação inválido.');
            }
            if (stage.communicationState === communicationState && isDeepStrictEqual(stage.communicationData, data)) {
                return this.assignment(pcm, stage);
            }
            stage.communicationState = communicationState as NonNullable<PcmStage['communicationState']>;
            stage.communicationErrorAt = new Date();
            stage.communicationData = data;
            if (await this.pcms.save(workflow.lineId, workflow.entrySequence, workflow.version, workflow)) {
                return this.assignment(pcm, stage);
            }
        }
        throw new WorkflowError(409, 'Atualização concorrente da comunicação. Repita a leitura.');
    }

    async recordCorrelationFault(lineId: string, machineId: string, entrySequence: number,
        data: Record<string, unknown>): Promise<MachineAssignment> {
        return this.recordCommunicationFault(lineId, machineId, entrySequence, data);
    }

    async clearCommunicationFault(lineId: string, machineId: string, entrySequence: number): Promise<MachineAssignment> {
        await this.machine(lineId, machineId);
        if (!Number.isSafeInteger(entrySequence) || entrySequence < 1) throw new WorkflowError(400, 'entrySequence inválida.');
        for (let attempt = 0; attempt < 5; attempt++) {
            const pcm = await this.pcms.bySequence(lineId, entrySequence);
            const workflow = pcm?.workflow;
            const stage = workflow?.stages.find(item => item.machineId === machineId);
            if (!pcm || !workflow || !stage?.operationId) throw new WorkflowError(404, 'Operação do mailbox não encontrada.');
            if (workflow.activeMachineId !== machineId || !['processing', 'result_recorded'].includes(stage.state)) {
                throw new WorkflowError(409, 'Unidade não está em processamento nesta estação.');
            }
            if (!stage.communicationState) return this.assignment(pcm, stage);
            delete stage.communicationState;
            delete stage.communicationErrorAt;
            delete stage.communicationData;
            if (await this.pcms.save(workflow.lineId, workflow.entrySequence, workflow.version, workflow)) {
                return this.assignment(pcm, stage);
            }
        }
        throw new WorkflowError(409, 'Atualização concorrente da comunicação. Repita a leitura.');
    }

    async acknowledgeIdentification(lineId: string, machineId: string, entrySequence: number): Promise<MachineAssignment> {
        await this.machine(lineId, machineId);
        if (!Number.isSafeInteger(entrySequence) || entrySequence < 1) throw new WorkflowError(400, 'entrySequence inválida.');
        for (let attempt = 0; attempt < 5; attempt++) {
            const pcm = await this.pcms.bySequence(lineId, entrySequence);
            if (!pcm) throw new WorkflowError(404, 'Unidade não encontrada para o ACK de identificação.');
            const workflow = pcm.workflow!;
            const stage = workflow.stages.find(item => item.machineId === machineId);
            if (!stage?.operationId) throw new WorkflowError(409, 'Unidade não foi reservada para esta máquina.');
            if (stage.identificationAcknowledgedAt) return this.assignment(pcm, stage);
            if (workflow.activeMachineId !== machineId || !['processing', 'result_recorded'].includes(stage.state)) {
                throw new WorkflowError(409, 'Unidade não aguarda confirmação de identificação nesta máquina.');
            }
            stage.identificationAcknowledgedAt = new Date();
            if (await this.pcms.save(workflow.lineId, workflow.entrySequence, workflow.version, workflow)) return this.assignment(pcm, stage);
        }
        throw new WorkflowError(409, 'ACK concorrente. Repita a confirmação da mesma unidade.');
    }

    private async operationBySequence(lineId: string, machineId: string, entrySequence: number): Promise<string> {
        if (!Number.isSafeInteger(entrySequence) || entrySequence < 1) throw new WorkflowError(400, 'entrySequence inválida.');
        const pcm = await this.pcms.bySequence(lineId, entrySequence);
        const stage = pcm?.workflow?.stages.find(item => item.machineId === machineId);
        if (!pcm || !stage?.operationId) throw new WorkflowError(404, 'Operação não encontrada para a sequência informada.');
        return stage.operationId;
    }

    async resultBySequence(lineId: string, machineId: string, entrySequence: number, result: ProcessResult,
        data: Record<string, unknown> = {}): Promise<MachineAssignment> {
        return this.result(lineId, machineId, await this.operationBySequence(lineId, machineId, entrySequence), result, data);
    }

    async passageBySequence(lineId: string, machineId: string, entrySequence: number): Promise<MachineAssignment> {
        return this.passage(lineId, machineId, await this.operationBySequence(lineId, machineId, entrySequence));
    }

    async arrive(lineId: string, machineId: string, cycleId: string): Promise<MachineAssignment> {
        const machine = await this.machine(lineId, machineId);
        identifier(cycleId, 'cycleId');
        const capacity = machine.protocol === 'm1-qr-handshake-v1' ? machine.modbus?.inFlightCapacity ?? 1 : 1;
        return this.stationExclusive(lineId, machineId, () => this.reserve(lineId, machineId, cycleId, capacity));
    }

    private async reserve(lineId: string, machineId: string, cycleId: string, capacity: number): Promise<MachineAssignment> {
        const key = JSON.stringify([lineId, machineId, cycleId]);
        for (let attempt = 0; attempt < 5; attempt++) {
            const previous = await this.pcms.byRequest(key);
            if (previous) return this.assignment(previous, previous.workflow!.stages.find(s => s.machineId === machineId && s.cycleId === cycleId)!);
            const active = await this.pcms.activeMany(lineId, machineId);
            const sameCycle = active.find(item => item.workflow!.stages.some(stage =>
                stage.machineId === machineId && stage.cycleId === cycleId));
            if (sameCycle) return this.assignment(sameCycle,
                sameCycle.workflow!.stages.find(stage => stage.machineId === machineId)!);
            if (active.length >= capacity) throw new WorkflowError(409,
                capacity === 1 ? 'Máquina possui uma passagem pendente. Reconcilie o ciclo anterior.'
                    : `Célula ocupada: ${active.length} de ${capacity} bandejas em processamento.`);
            const pcm = await this.pcms.firstWaiting(lineId, machineId);
            if (!pcm) throw new WorkflowError(409, 'Nenhuma bandeja aguardando esta estação.');
            const workflow = pcm.workflow!;
            if (workflow.nextMachineId !== machineId || workflow.activeMachineId) {
                throw new WorkflowError(409, 'A primeira bandeja ainda não confirmou a passagem na estação anterior.');
            }
            const stage = workflow.stages.find(item => item.machineId === machineId)!;
            stage.operationId = randomUUID();
            stage.cycleId = cycleId;
            stage.action = this.bypassEnabled && workflow.quality === 'rejected' ? 'BYPASS' : 'EXECUTE';
            stage.state = 'processing';
            stage.startedAt = new Date();
            workflow.activeMachineId = machineId;
            (workflow.requestKeys ??= []).push(key);
            if (await this.pcms.save(workflow.lineId, workflow.entrySequence, workflow.version, workflow)) return this.assignment(pcm, stage);
        }
        throw new WorkflowError(409, 'Reserva concorrente. Repita a mesma solicitação com o mesmo cycleId.');
    }

    async result(lineId: string, machineId: string, operationId: string, result: ProcessResult,
        data: Record<string, unknown> = {}): Promise<MachineAssignment> {
        if (!['OK', 'NAO'].includes(result)) throw new WorkflowError(400, 'Resultado deve ser OK ou NAO.');
        object(data);
        // Limita também eventos que venham de adaptadores, fora do parser HTTP.
        if (Buffer.byteLength(JSON.stringify(data)) > 3000) throw new WorkflowError(400, 'Dados adicionais excedem 3000 bytes.');
        return this.change(lineId, machineId, operationId, (workflow, stage) => {
            if (stage.action !== 'EXECUTE') throw new WorkflowError(409, 'Bandeja em bypass não pode receber resultado de processo.');
            if (stage.result) {
                if (stage.result !== result || !isDeepStrictEqual(stage.data, data)) throw new WorkflowError(409, 'Resultado diverge do já registrado.');
                return false;
            }
            if (stage.state !== 'processing') throw new WorkflowError(409, 'Operação não está em processamento.');
            delete stage.communicationState;
            delete stage.communicationErrorAt;
            delete stage.communicationData;
            stage.result = result; stage.data = data; stage.resultAt = new Date(); stage.state = 'result_recorded';
            if (result === 'NAO') { workflow.quality = 'rejected'; workflow.blockedByMachine ??= machineId; }
            return true;
        });
    }

    async passage(lineId: string, machineId: string, operationId: string): Promise<MachineAssignment> {
        return this.stationExclusive(lineId, machineId, async () => {
            const machine = await this.machine(lineId, machineId);
            const capacity = machine.protocol === 'm1-qr-handshake-v1' ? machine.modbus?.inFlightCapacity ?? 1 : 1;
            if (capacity > 1) {
                const current = await this.pcms.byOperation(lineId, machineId, operationId);
                if (!current?.workflow) throw new WorkflowError(404, 'Operação não encontrada nesta máquina.');
                const older = (await this.pcms.activeMany(lineId, machineId)).find(item =>
                    item.workflow!.entrySequence < current.workflow!.entrySequence);
                if (older) throw new WorkflowError(409,
                    `Saída fora de ordem: aguarde a sequência ${older.workflow!.entrySequence}.`);
            }
            return this.change(lineId, machineId, operationId, (workflow, stage) => {
            if (stage.state === 'completed' || stage.state === 'skipped') return false;
            if (stage.action === 'EXECUTE' && stage.state !== 'result_recorded') {
                throw new WorkflowError(409, 'Registre o resultado antes de confirmar a passagem.');
            }
            stage.state = stage.action === 'BYPASS' ? 'skipped' : 'completed';
            stage.passedAt = new Date();
            delete stage.communicationState;
            delete stage.communicationErrorAt;
            delete stage.communicationData;
            delete workflow.activeMachineId;
            const next = workflow.stages[workflow.stages.indexOf(stage) + 1];
            if (next) workflow.nextMachineId = next.machineId;
            else {
                delete workflow.nextMachineId;
                workflow.status = 'completed'; workflow.completedAt = stage.passedAt;
                if (workflow.quality !== 'rejected') workflow.quality = 'approved';
            }
            return true;
            });
        });
    }

    private async change(lineId: string, machineId: string, operationId: string,
        update: (workflow: PcmWorkflow, stage: PcmStage) => boolean): Promise<MachineAssignment> {
        await this.machine(lineId, machineId);
        identifier(operationId, 'operationId');
        for (let attempt = 0; attempt < 5; attempt++) {
            const pcm = await this.pcms.byOperation(lineId, machineId, operationId);
            if (!pcm) throw new WorkflowError(404, 'Operação não encontrada nesta máquina.');
            const workflow = pcm.workflow!;
            const stage = workflow.stages.find(s => s.machineId === machineId && s.operationId === operationId)!;
            if (!update(workflow, stage)) return this.assignment(pcm, stage);
            if (await this.pcms.save(workflow.lineId, workflow.entrySequence, workflow.version, workflow)) return this.assignment(pcm, stage);
        }
        throw new WorkflowError(409, 'Atualização concorrente. Repita o mesmo evento.');
    }
    async list(lineId: string, limit = 50) {
        await this.getLine(lineId);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new WorkflowError(400, 'Limite deve ser de 1 a 200.');
        return this.pcms.list(lineId, limit);
    }
    async tray(serialNumber: string) {
        const pcm = await this.pcms.get(serialNumber);
        if (!pcm) throw new WorkflowError(404, 'Bandeja não encontrada.');
        return pcm;
    }
    async trayBySequence(lineId: string, entrySequence: number) {
        await this.getLine(lineId);
        if (!Number.isSafeInteger(entrySequence) || entrySequence < 1) throw new WorkflowError(400, 'Sequência de entrada inválida.');
        const pcm = await this.pcms.bySequence(lineId, entrySequence);
        if (!pcm) throw new WorkflowError(404, 'Passagem da bandeja não encontrada.');
        return pcm;
    }

    async intervene(lineId: string, entrySequence: number, body: unknown) {
        await this.getLine(lineId);
        if (!Number.isSafeInteger(entrySequence) || entrySequence < 1) {
            throw new WorkflowError(400, 'Sequencia de entrada invalida.');
        }
        const input = object(body);
        const action = input.action;
        if (!['remove', 'quarantine'].includes(String(action))) {
            throw new WorkflowError(400, 'Acao deve ser remove ou quarantine.');
        }
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
        if (reason.length < 3 || reason.length > 120) {
            throw new WorkflowError(400, 'Informe um motivo entre 3 e 120 caracteres.');
        }
        if (notes.length > 500) throw new WorkflowError(400, 'Observacao excede 500 caracteres.');
        if (input.physicalRemovalConfirmed !== undefined && typeof input.physicalRemovalConfirmed !== 'boolean') {
            throw new WorkflowError(400, 'Confirmacao de retirada fisica invalida.');
        }

        return this.exclusive(lineId, async () => {
            let current = await this.pcms.bySequence(lineId, entrySequence);
            if (!current?.workflow) throw new WorkflowError(404, 'Passagem da bandeja nao encontrada.');
            if (current.workflow.status !== 'in_progress') {
                throw new WorkflowError(409, 'Somente uma bandeja em andamento pode ser retirada ou colocada em quarentena.');
            }
            const activeMachineId = current.workflow.activeMachineId;
            if (activeMachineId && input.physicalRemovalConfirmed !== true) {
                throw new WorkflowError(409,
                    'Confirme que a bandeja foi retirada fisicamente e que o mailbox da estacao foi limpo.');
            }
            if (activeMachineId && !this.runtimeInterventionControl) {
                throw new WorkflowError(503, 'Runtime das maquinas indisponivel para retirar uma bandeja ativa.');
            }

            let paused = false;
            try {
                if (this.runtimeInterventionControl) {
                    await this.runtimeInterventionControl.pause(); paused = true;
                    current = await this.pcms.bySequence(lineId, entrySequence);
                    if (!current?.workflow || current.workflow.status !== 'in_progress') {
                        throw new WorkflowError(409, 'A bandeja mudou de estado durante a confirmacao. Atualize a tela.');
                    }
                }
                for (let attempt = 0; attempt < 5; attempt++) {
                    const workflow = current.workflow!;
                    const now = new Date();
                    const disposition = action as TrayInterventionAction;
                    workflow.status = disposition === 'remove' ? 'removed' : 'quarantined';
                    workflow.endedAt = now;
                    workflow.intervention = {
                        interventionId: randomUUID(), action: disposition, reason, ...(notes ? { notes } : {}),
                        actorRole: 'ADMIN', requestedAt: now, ...(workflow.activeMachineId ? { activeMachineId: workflow.activeMachineId } : {}),
                        physicalRemovalConfirmed: input.physicalRemovalConfirmed === true
                    };
                    for (const stage of workflow.stages) {
                        if (!['completed', 'skipped'].includes(stage.state)) {
                            stage.state = 'cancelled'; stage.cancelledAt = now;
                        }
                    }
                    delete workflow.activeMachineId; delete workflow.nextMachineId;
                    if (await this.pcms.save(lineId, entrySequence, workflow.version, workflow)) {
                        communicationLog.add(activeMachineId || 'LINE', 'SYSTEM',
                            disposition === 'remove' ? 'TRAY_REMOVED' : 'TRAY_QUARANTINED',
                            `Bandeja ${current.serialNumber} encerrada manualmente por ADMIN.`, {
                                lineId, entrySequence, serial: current.serialNumber, reason,
                                physicalRemovalConfirmed: input.physicalRemovalConfirmed === true
                            });
                        return await this.trayBySequence(lineId, entrySequence);
                    }
                    current = await this.pcms.bySequence(lineId, entrySequence);
                    if (!current?.workflow || current.workflow.status !== 'in_progress') {
                        throw new WorkflowError(409, 'A bandeja mudou de estado durante a operacao. Atualize a tela.');
                    }
                }
                throw new WorkflowError(409, 'Atualizacao concorrente da bandeja. Repita a operacao.');
            } finally {
                if (paused) this.runtimeInterventionControl!.resume();
            }
        });
    }
    async advanceTray(lineId: string, entrySequence: number, body: unknown) {
        await this.getLine(lineId);
        if (!Number.isSafeInteger(entrySequence) || entrySequence < 1) {
            throw new WorkflowError(400, 'Sequencia de entrada invalida.');
        }
        const input = object(body);
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        const notes = typeof input.notes === 'string' ? input.notes.trim() : '';
        if (reason.length < 3 || reason.length > 120) throw new WorkflowError(400, 'Informe um motivo entre 3 e 120 caracteres.');
        if (notes.length > 500) throw new WorkflowError(400, 'Observacao excede 500 caracteres.');
        if (input.physicalMovementConfirmed !== true) {
            throw new WorkflowError(409, 'Confirme a movimentacao fisica e a liberacao da estacao atual.');
        }
        if (!this.runtimeInterventionControl) throw new WorkflowError(503, 'Runtime das maquinas indisponivel para o avanco manual.');

        return this.exclusive(lineId, async () => {
            let paused = false;
            try {
                await this.runtimeInterventionControl!.pause(); paused = true;
                for (let attempt = 0; attempt < 5; attempt++) {
                    const current = await this.pcms.bySequence(lineId, entrySequence);
                    const workflow = current?.workflow;
                    if (!current || !workflow) throw new WorkflowError(404, 'Passagem da bandeja nao encontrada.');
                    if (workflow.status !== 'in_progress') throw new WorkflowError(409, 'Somente uma bandeja em andamento pode avancar.');
                    const fromMachineId = workflow.activeMachineId ?? workflow.nextMachineId;
                    if (!fromMachineId) throw new WorkflowError(409, 'A bandeja nao possui uma estacao atual.');
                    const stage = workflow.stages.find(item => item.machineId === fromMachineId);
                    if (!stage || ['completed', 'skipped', 'cancelled'].includes(stage.state)) {
                        throw new WorkflowError(409, 'A etapa atual nao pode ser avancada manualmente.');
                    }
                    const next = workflow.stages[workflow.stages.indexOf(stage) + 1];
                    if (!next) throw new WorkflowError(409, 'A bandeja ja esta na ultima estacao da linha.');
                    const now = new Date();
                    stage.state = stage.result ? 'completed' : 'skipped'; stage.passedAt = now;
                    delete stage.communicationState; delete stage.communicationErrorAt; delete stage.communicationData;
                    delete workflow.activeMachineId; workflow.nextMachineId = next.machineId;
                    (workflow.manualAdvances ??= []).push({ advanceId: randomUUID(), fromMachineId, toMachineId: next.machineId,
                        reason, ...(notes ? { notes } : {}), actorRole: 'ADMIN', requestedAt: now, physicalMovementConfirmed: true });
                    if (await this.pcms.save(lineId, entrySequence, workflow.version, workflow)) {
                        communicationLog.add(fromMachineId, 'SYSTEM', 'TRAY_MANUALLY_ADVANCED',
                            `Bandeja ${current.serialNumber} avancada manualmente por ADMIN para ${next.machineId}.`, {
                                lineId, entrySequence, serial: current.serialNumber, fromMachineId, toMachineId: next.machineId, reason
                            });
                        return await this.trayBySequence(lineId, entrySequence);
                    }
                }
                throw new WorkflowError(409, 'Atualizacao concorrente da bandeja. Repita a operacao.');
            } finally {
                if (paused) this.runtimeInterventionControl!.resume();
            }
        });
    }
}
