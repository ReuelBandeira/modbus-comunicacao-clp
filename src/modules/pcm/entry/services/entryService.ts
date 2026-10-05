import type { PCM } from '../../models/pcmModel';
import type { PcmRepositoryContract } from '../../repositories/pcmRepositoryContract';
import { isSerialNumber, parseEntryInput } from '../validators/entryValidation';
import { InvalidEntryError } from '../errors/invalidEntryError';
import { DuplicateSerialError } from '../../errors/duplicateSerialError';
import type { EntryWorkflow } from '../../workflow/services/lineCoordinatorService';
import type { EntryPreparationService } from './entryPreparationService';

export class EntryService {
    // Uma única instância de entrada por coordenador: sequencia a admissão antes de liberar a próxima.
    private admission: Promise<void> = Promise.resolve();
    constructor(private readonly repository: PcmRepositoryContract, private readonly workflow?: EntryWorkflow,
        private readonly preparation?: EntryPreparationService) {}

    async register(body: unknown): Promise<PCM | void> {
        // Compatibilidade: o endpoint histórico agora inicia a preparação, sem liberar a bandeja.
        if (this.preparation) return this.preparation.start(body);
        const input = parseEntryInput(body);
        const serial = input['serial-number'] ?? input['qr-code'];
        if (!isSerialNumber(serial)) {
            throw new InvalidEntryError('Para registrar a entrada, o QR code deve conter apenas o serial, de 1 a 512 caracteres sem espaços ou controles.');
        }
        const admitted = this.admission.then(async () => {
            if (await this.repository.inProgress(serial)) {
                throw new DuplicateSerialError('Este serial já está em uso na linha.');
            }
            const pcm: PCM = { serialNumber: serial, enteredAt: new Date() };
            if (this.workflow) await this.workflow.admit(pcm, () => this.repository.insert(pcm));
            else await this.repository.insert(pcm);
        });
        this.admission = admitted.catch(() => {});
        await admitted;
    }
}
