import type { PCM } from '../models/pcmModel';

export interface PcmRepositoryContract {
    inProgress(serialNumber: string): Promise<boolean>;
    insert(pcm: PCM): Promise<void>;
}
