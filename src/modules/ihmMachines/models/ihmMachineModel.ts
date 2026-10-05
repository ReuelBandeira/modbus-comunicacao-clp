import type { IndexDescription } from 'mongodb';

export type IhmMachineAction = 'start' | 'stop' | 'reset';

export interface IhmMachineCommandMap {
    start?: string;
    stop?: string;
    reset?: string;
}

/** Máquina exibida na IHM. É independente das estações do fluxo produtivo. */
export interface IhmMachine {
    lineId: string;
    ihmMachineId: string;
    name: string;
    enabled: boolean;
    order: number;
    commandIds: IhmMachineCommandMap;
    createdAt: Date;
    updatedAt: Date;
}

export const ihmMachinesCollection = 'pcm_ihm_machines';
export const ihmMachineIndexes: IndexDescription[] = [
    { key: { lineId: 1, ihmMachineId: 1 }, name: 'uq_pcm_ihm_machine', unique: true },
    { key: { lineId: 1, enabled: 1, order: 1, name: 1 }, name: 'ix_pcm_ihm_machine_operational' }
];
