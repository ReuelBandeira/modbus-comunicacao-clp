namespace EndOfLine {
    export const POSITION_COUNT = 20;
    export interface MachineLike { machineId: string; name: string; }
    export interface StageLike {
        machineId: string;
        state: string;
        result?: 'OK' | 'NAO';
        passedAt?: string;
        data?: Record<string, unknown>;
    }
    export interface TrayLike {
        serialNumber: string;
        enteredAt: string;
        workflow?: {
            entrySequence: number;
            status: 'in_progress' | 'completed';
            quality: 'pending' | 'approved' | 'rejected';
            completedAt?: string;
            stages: StageLike[];
        };
    }
    export interface PositionResult {
        position: number;
        status: 'approved' | 'rejected' | 'indeterminate';
        failedMachineIds: string[];
        failedMachineNames: string[];
    }
    export interface TrayResult {
        tray: TrayLike;
        sequence: number;
        completedAt?: string;
        status: 'approved' | 'rejected' | 'indeterminate';
        positions: PositionResult[];
        failedMachineIds: string[];
        failedMachineNames: string[];
        approved: number;
        rejected: number;
        indeterminate: number;
    }

    function timestamp(tray: TrayLike): number {
        const workflow = tray.workflow;
        const completed = workflow?.completedAt ? Date.parse(workflow.completedAt) : NaN;
        if (Number.isFinite(completed)) return completed;
        return Math.max(0, ...(workflow?.stages.map(stage => stage.passedAt ? Date.parse(stage.passedAt) : 0) ?? []));
    }

    export function completedTrays(trays: TrayLike[]): TrayLike[] {
        return trays.filter(tray => tray.workflow?.status === 'completed')
            .sort((left, right) => timestamp(right) - timestamp(left)
                || (right.workflow?.entrySequence ?? 0) - (left.workflow?.entrySequence ?? 0));
    }

    export function summarize(tray: TrayLike, machines: MachineLike[]): TrayResult {
        if (!tray.workflow || tray.workflow.status !== 'completed') throw new Error('A bandeja ainda não saiu da última máquina.');
        const machineNames = new Map(machines.map(machine => [machine.machineId, machine.name]));
        const testedStages = tray.workflow.stages.slice(1);
        const arrays = testedStages.map(stage => {
            const value = stage.data?.positions;
            return Array.isArray(value) && value.every(item => typeof item === 'boolean') ? value as boolean[] : undefined;
        });
        const positions: PositionResult[] = [];
        for (let index = 0; index < POSITION_COUNT; index++) {
            const failed = testedStages.filter((_, stageIndex) => arrays[stageIndex]?.[index] === false)
                .map(stage => stage.machineId);
            const values = arrays.map(items => items?.[index]);
            const status: PositionResult['status'] = failed.length ? 'rejected'
                : values.length > 0 && values.every(value => value === true) ? 'approved' : 'indeterminate';
            positions.push({ position: index + 1, status, failedMachineIds: failed,
                failedMachineNames: failed.map(id => machineNames.get(id) || id) });
        }
        const failedMachineIds = [...new Set([
            ...tray.workflow.stages.filter(stage => stage.result === 'NAO').map(stage => stage.machineId),
            ...positions.flatMap(position => position.failedMachineIds)
        ])];
        const rejected = positions.filter(position => position.status === 'rejected').length;
        const indeterminate = positions.filter(position => position.status === 'indeterminate').length;
        const approved = positions.filter(position => position.status === 'approved').length;
        const status: TrayResult['status'] = tray.workflow.quality === 'rejected' || rejected || failedMachineIds.length
            ? 'rejected' : tray.workflow.quality === 'approved' && positions.length > 0 && !indeterminate
                ? 'approved' : 'indeterminate';
        return { tray, sequence: tray.workflow.entrySequence, completedAt: tray.workflow.completedAt,
            status, positions, failedMachineIds, failedMachineNames: failedMachineIds.map(id => machineNames.get(id) || id),
            approved, rejected, indeterminate };
    }
}
