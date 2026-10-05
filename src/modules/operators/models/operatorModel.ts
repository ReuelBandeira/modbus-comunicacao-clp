import type { IndexDescription } from 'mongodb';

export interface Operator {
    name: string;
    registration: string;
}

export const operatorsCollection = 'pcm_operators';
export const operatorIndexes: IndexDescription[] = [
    { key: { registration: 1 }, name: 'uq_pcm_operator_registration', unique: true },
    { key: { name: 1 }, name: 'ix_pcm_operator_name' }
];
