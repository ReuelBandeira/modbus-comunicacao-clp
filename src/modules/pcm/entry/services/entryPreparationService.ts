import { randomUUID } from 'node:crypto';
import type { PCM } from '../../models/pcmModel';
import type { PcmRepositoryContract } from '../../repositories/pcmRepositoryContract';
import type { EntryWorkflow } from '../../workflow/services/lineCoordinatorService';
import { WorkflowError } from '../../workflow/errors/workflowError';
import { isSerialNumber, parseEntryInput } from '../validators/entryValidation';
import type { EntryPreparationRepository } from '../repositories/entryPreparationRepository';

const CHIP_COUNT = 20;

export interface EntryStaffingControl {
    assertMinimumOperators(): Promise<void>;
    assertRequiredStation?(): Promise<void>;
    assertOperationRunning?(): Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError(400, 'Corpo da requisição inválido.');
    return value as Record<string, unknown>;
}
function optionalRequestId(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value)) throw new WorkflowError(400, 'requestId inválido.');
    return value;
}
function entryId(value: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new WorkflowError(400, 'entryId inválido.');
    return value;
}

export class EntryPreparationService {
    private admission: Promise<void> = Promise.resolve();
    constructor(private readonly preparations: EntryPreparationRepository,
        private readonly pcms: PcmRepositoryContract, private readonly workflow: EntryWorkflow,
        private readonly lineId: string, private readonly stationId: string, private readonly stationName: string,
        private readonly staffing?: EntryStaffingControl) {}

    current(): Promise<PCM | null> { return this.preparations.current(this.lineId, this.stationId); }

    async start(body: unknown): Promise<PCM> {
        const input = parseEntryInput(body);
        const serialNumber = input['serial-number'] ?? input['qr-code'];
        if (!isSerialNumber(serialNumber)) throw new WorkflowError(400, 'QR da bandeja inválido.');
        const raw = object(body), requestId = optionalRequestId(raw.requestId);
        const previousRequest = requestId ? await this.preparations.byStartRequestId(requestId) : null;
        if (previousRequest) {
            if (previousRequest.serialNumber !== serialNumber) throw new WorkflowError(409, 'requestId já usado para outra bandeja.');
            return previousRequest;
        }
        const current = await this.current();
        if (current) {
            if (current.serialNumber === serialNumber || requestId && current.preparation?.startRequestId === requestId) return current;
            throw new WorkflowError(409, 'Já existe uma bandeja em preparação nesta estação. Finalize ou cancele antes de iniciar outra.');
        }
        await Promise.all([this.assertEntryReady(), this.staffing?.assertOperationRunning?.()]);
        if (await this.pcms.inProgress(serialNumber)) throw new WorkflowError(409, 'Esta bandeja já está em uso na linha.');
        const now = new Date();
        const pcm: PCM = { entryId: randomUUID(), serialNumber, enteredAt: now, preparation: {
            lineId: this.lineId, stationId: this.stationId, stationName: this.stationName,
            status: 'scanning', active: true, version: 0, trayScannedAt: now, updatedAt: now,
            ...(requestId ? { startRequestId: requestId } : {}), chips: []
        } };
        try { await this.preparations.insert(pcm); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) {
                const concurrent = await this.current();
                if (concurrent?.serialNumber === serialNumber) return concurrent;
                throw new WorkflowError(409, 'A bandeja ou a estação já possui uma preparação ativa.');
            }
            throw error;
        }
        return pcm;
    }

    async addChip(id: string, body: unknown): Promise<PCM> {
        entryId(id); const input = object(body);
        const serialNumber = input['serial-number'] ?? input['qr-code'];
        if (!isSerialNumber(serialNumber)) throw new WorkflowError(400, 'QR do chip inválido.');
        await this.assertEntryReady();
        const requestId = optionalRequestId(input.requestId);
        for (let attempt = 0; attempt < 5; attempt++) {
            const pcm = await this.preparations.byEntryId(id), preparation = pcm?.preparation;
            if (!pcm || !preparation) throw new WorkflowError(404, 'Preparação não encontrada.');
            if (pcm.serialNumber === serialNumber) {
                throw new WorkflowError(409, 'O QR da bandeja não pode ser cadastrado como chip.');
            }
            if (requestId) {
                const previous = preparation.chips.find(chip => chip.requestId === requestId);
                if (previous) {
                    if (previous.serialNumber !== serialNumber) throw new WorkflowError(409, 'requestId já usado para outro chip.');
                    return pcm;
                }
            }
            if (!preparation.active || preparation.status !== 'scanning') throw new WorkflowError(409, 'A preparação não aceita novas leituras.');
            if (preparation.chips.some(chip => chip.serialNumber === serialNumber)) throw new WorkflowError(409, 'Este chip já foi lido nesta bandeja.');
            const position = preparation.chips.length + 1;
            if (position > CHIP_COUNT) throw new WorkflowError(409, 'As 20 posições já foram preenchidas.');
            if (input.position !== undefined && (!Number.isInteger(input.position) || input.position !== position)) {
                throw new WorkflowError(409, `A próxima leitura deve ser da posição ${position}.`);
            }
            const now = new Date(), status = position === CHIP_COUNT ? 'ready' : 'scanning';
            if (await this.preparations.appendChip(id, preparation.version,
                { position, serialNumber, scannedAt: now, ...(requestId ? { requestId } : {}) }, status,
                status === 'ready' ? now : undefined)) return (await this.preparations.byEntryId(id))!;
        }
        throw new WorkflowError(409, 'Leitura concorrente. Repita o mesmo chip.');
    }

    async undoLast(id: string): Promise<PCM> {
        entryId(id);
        for (let attempt = 0; attempt < 5; attempt++) {
            const pcm = await this.preparations.byEntryId(id), preparation = pcm?.preparation;
            if (!pcm || !preparation) throw new WorkflowError(404, 'Preparação não encontrada.');
            if (!preparation.active) throw new WorkflowError(409, 'A preparação já foi encerrada.');
            if (!preparation.chips.length) throw new WorkflowError(409, 'Nenhum chip para desfazer.');
            if (await this.preparations.undoLast(id, preparation.version, new Date())) return (await this.preparations.byEntryId(id))!;
        }
        throw new WorkflowError(409, 'Alteração concorrente. Atualize a tela.');
    }

    private async assertEntryReady(): Promise<void> {
        await Promise.all([
            this.staffing?.assertMinimumOperators(),
            this.staffing?.assertRequiredStation?.()
        ]);
    }

    async cancel(id: string): Promise<PCM> {
        entryId(id);
        for (let attempt = 0; attempt < 5; attempt++) {
            const pcm = await this.preparations.byEntryId(id), preparation = pcm?.preparation;
            if (!pcm || !preparation) throw new WorkflowError(404, 'Preparação não encontrada.');
            if (!preparation.active) return pcm;
            if (await this.preparations.cancel(id, preparation.version, new Date())) return (await this.preparations.byEntryId(id))!;
        }
        throw new WorkflowError(409, 'Alteração concorrente. Atualize a tela.');
    }

    async release(id: string, body: unknown): Promise<PCM> {
        entryId(id); const input = body === undefined ? {} : object(body), requestId = optionalRequestId(input.requestId);
        let result: PCM | undefined;
        const admitted = this.admission.then(async () => {
            const pcm = await this.preparations.byEntryId(id), preparation = pcm?.preparation;
            if (!pcm || !preparation) throw new WorkflowError(404, 'Preparação não encontrada.');
            if (preparation.status === 'released' && pcm.workflow) { result = pcm; return; }
            await this.assertEntryReady();
            if (!preparation.active || preparation.status !== 'ready' || preparation.chips.length !== CHIP_COUNT) {
                throw new WorkflowError(409, 'A bandeja só pode ser liberada após as 20 posições.');
            }
            if (await this.pcms.inProgress(pcm.serialNumber)) throw new WorkflowError(409, 'Esta bandeja já está em uso na linha.');
            await this.workflow.admit(pcm, async () => {
                if (!pcm.workflow || !await this.preparations.release(id, preparation.version, pcm.workflow, new Date(), requestId)) {
                    throw new WorkflowError(409, 'A preparação mudou durante a liberação. Atualize a tela.');
                }
            });
            result = (await this.preparations.byEntryId(id))!;
        });
        this.admission = admitted.catch(() => {}); await admitted;
        return result!;
    }
}
