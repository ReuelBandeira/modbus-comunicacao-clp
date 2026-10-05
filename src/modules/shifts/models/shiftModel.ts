import type { IndexDescription } from 'mongodb';

export interface Shift {
    shiftId: string;
    name: string;
    startTime: string;
    endTime: string;
    active: boolean;
    createdAt: Date;
    updatedAt: Date;
}

export const shiftsCollection = 'pcm_shifts';
export const shiftIndexes: IndexDescription[] = [
    { key: { shiftId: 1 }, name: 'uq_pcm_shift_id', unique: true },
    { key: { active: 1, startTime: 1 }, name: 'ix_pcm_shift_schedule' }
];
