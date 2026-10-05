import type { IndexDescription } from 'mongodb';

export type TestOutcome = 'PASS' | 'FAIL';

export interface TestResultPosition {
    position: number;
    passed: boolean;
    result: TestOutcome;
    judgment: string | null;
    ngStep: string | null;
    message: string | null;
}

export interface TestResultSourceFile { name: string; positionCount: number; }

/** Resultado normalizado enviado pelo IFTS CSV Bridge (contrato schemaVersion 2). */
export interface TestResultCycle {
    schemaVersion: 2;
    cycleId: string;
    model: string;
    startedAt: Date;
    finishedAt: Date;
    result: TestOutcome;
    passed: boolean;
    totalPositions: number;
    passedPositions: number;
    failedPositions: number;
    positions: TestResultPosition[];
    sourceFiles: TestResultSourceFile[];
    receivedAt: Date;
}

export type TestResultSummary = Omit<TestResultCycle, 'positions' | 'sourceFiles'>;
export const testResultsCollection = 'ifts_test_results';
export const testResultIndexes: IndexDescription[] = [
    { key: { cycleId: 1 }, name: 'uq_ifts_test_result_cycle', unique: true },
    { key: { receivedAt: -1 }, name: 'ix_ifts_test_result_received' },
    { key: { model: 1, finishedAt: -1 }, name: 'ix_ifts_test_result_model_finished' },
    { key: { finishedAt: -1 }, name: 'ix_ifts_test_result_finished' }
];
