import type { Collection } from 'mongodb';
import type { PcmRepositoryContract } from './pcmRepositoryContract';
import { DuplicateSerialError } from '../errors/duplicateSerialError';
import type { PCM } from '../models/pcmModel';

export class PcmRepository implements PcmRepositoryContract {
    constructor(private readonly collection: Pick<Collection<PCM>, 'insertOne' | 'findOne'>) {}

    async inProgress(serialNumber: string): Promise<boolean> {
        return await this.collection.findOne({ serialNumber, 'workflow.status': 'in_progress' },
            { projection: { _id: 1 } }) !== null;
    }

    async insert(pcm: PCM): Promise<void> {
        try {
            // O índice parcial protege somente o serial que ainda está percorrendo a linha.
            await this.collection.insertOne(pcm);
        } catch (error) {
            const duplicate = error as { code?: number; keyPattern?: Record<string, unknown> };
            if (duplicate.code === 11000 && duplicate.keyPattern?.serialNumber) {
                throw new DuplicateSerialError('Este serial já está em uso na linha.');
            }
            throw error;
        }
    }
}
