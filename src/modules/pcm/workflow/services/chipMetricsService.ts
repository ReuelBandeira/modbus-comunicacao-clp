import type { PCM } from '../../models/pcmModel';
import type { ChipHourlyMetric, ChipMetricPeriod, ChipMetricsReport, ChipMetricSummary } from '../dtos/chipMetricsDto';

const HOUR_MS = 60 * 60 * 1000;

interface MetricAccumulator {
    produced: number;
    approved: number;
    rejected: number;
    indeterminate: number;
    cycleTotalMs: number;
    cycleSamples: number;
    traysWithoutPositions: number;
}

export interface ChipMetricsWindow {
    periodFrom: Date;
    periodTo: Date;
    currentHourFrom: Date;
    currentHourTo: Date;
    trendFrom: Date;
    trendTo: Date;
    timezoneOffsetMinutes: number;
}

const empty = (): MetricAccumulator => ({ produced: 0, approved: 0, rejected: 0, indeterminate: 0,
    cycleTotalMs: 0, cycleSamples: 0, traysWithoutPositions: 0 });

function summary(value: MetricAccumulator): ChipMetricSummary {
    return {
        produced: value.produced, approved: value.approved, rejected: value.rejected,
        indeterminate: value.indeterminate,
        approvalRate: value.produced ? Math.round(value.approved / value.produced * 10000) / 100 : null,
        averageCycleTimeMs: value.cycleSamples ? Math.round(value.cycleTotalMs / value.cycleSamples) : null,
        traysWithoutPositions: value.traysWithoutPositions
    };
}

export function workflowCompletedAt(pcm: PCM): Date | undefined {
    if (pcm.workflow?.completedAt instanceof Date) return pcm.workflow.completedAt;
    const timestamps = (pcm.workflow?.stages ?? []).flatMap(stage => stage.passedAt instanceof Date ? [stage.passedAt.getTime()] : []);
    return timestamps.length ? new Date(Math.max(...timestamps)) : undefined;
}

function chipResults(pcm: PCM): { approved: number; rejected: number; indeterminate: number } | undefined {
    const testedStages = (pcm.workflow?.stages ?? []).slice(1);
    if (!testedStages.length) return undefined;
    const arrays = testedStages.map(stage => {
        const positions = stage.data?.positions;
        return Array.isArray(positions) && positions.every(value => typeof value === 'boolean') ? positions as boolean[] : undefined;
    });
    const positionCount = Math.max(0, ...arrays.map(positions => positions?.length ?? 0));
    if (!positionCount) return undefined;
    let approved = 0, rejected = 0, indeterminate = 0;
    for (let position = 0; position < positionCount; position++) {
        const values = arrays.map(positions => positions?.[position]);
        if (values.includes(false)) rejected++;
        else if (values.every(value => value === true)) approved++;
        else indeterminate++;
    }
    return { approved, rejected, indeterminate };
}

function add(target: MetricAccumulator, pcm: PCM) {
    const chips = chipResults(pcm);
    if (!chips) { target.traysWithoutPositions++; return; }
    const produced = chips.approved + chips.rejected + chips.indeterminate;
    target.produced += produced; target.approved += chips.approved;
    target.rejected += chips.rejected; target.indeterminate += chips.indeterminate;
    const completedAt = workflowCompletedAt(pcm);
    const duration = completedAt ? completedAt.getTime() - pcm.enteredAt.getTime() : -1;
    if (Number.isFinite(duration) && duration >= 0) {
        target.cycleTotalMs += duration * produced;
        target.cycleSamples += produced;
    }
}

function hourFloor(value: Date, timezoneOffsetMinutes: number): Date {
    const offset = timezoneOffsetMinutes * 60_000;
    return new Date(Math.floor((value.getTime() - offset) / HOUR_MS) * HOUR_MS + offset);
}

export function chipMetricsWindow(periodFrom: Date, periodTo: Date, timezoneOffsetMinutes: number,
    now = new Date()): ChipMetricsWindow {
    const currentHourFrom = hourFloor(now, timezoneOffsetMinutes);
    const currentHourTo = new Date(currentHourFrom.getTime() + HOUR_MS);
    const trendFrom = new Date(currentHourFrom.getTime() - 23 * HOUR_MS);
    return { periodFrom, periodTo, currentHourFrom, currentHourTo, trendFrom,
        trendTo: currentHourTo, timezoneOffsetMinutes };
}

function hourly(from: Date, to: Date, timezoneOffsetMinutes: number) {
    const result = new Map<number, MetricAccumulator>();
    for (let at = hourFloor(from, timezoneOffsetMinutes).getTime(); at < to.getTime(); at += HOUR_MS) result.set(at, empty());
    return result;
}

function period(from: Date, to: Date, value: MetricAccumulator): ChipMetricPeriod {
    return { from, to, summary: summary(value) };
}

function hourlyResult(values: Map<number, MetricAccumulator>): ChipHourlyMetric[] {
    return [...values].map(([hourStart, value]) => ({ hourStart: new Date(hourStart), ...summary(value) }));
}

export function buildChipMetrics(pcms: PCM[], window: ChipMetricsWindow, generatedAt = new Date()): ChipMetricsReport {
    const current = empty(), selected = empty();
    const selectedHours = hourly(window.periodFrom, window.periodTo, window.timezoneOffsetMinutes);
    const trendHours = hourly(window.trendFrom, window.trendTo, window.timezoneOffsetMinutes);
    for (const pcm of pcms) {
        const completedAt = workflowCompletedAt(pcm);
        if (!completedAt || pcm.workflow?.status !== 'completed') continue;
        const time = completedAt.getTime();
        if (time >= window.currentHourFrom.getTime() && time < window.currentHourTo.getTime()) add(current, pcm);
        if (time >= window.periodFrom.getTime() && time < window.periodTo.getTime()) {
            add(selected, pcm); add(selectedHours.get(hourFloor(completedAt, window.timezoneOffsetMinutes).getTime())!, pcm);
        }
        if (time >= window.trendFrom.getTime() && time < window.trendTo.getTime()) {
            add(trendHours.get(hourFloor(completedAt, window.timezoneOffsetMinutes).getTime())!, pcm);
        }
    }
    return {
        unit: 'chips', currentHour: period(window.currentHourFrom, window.currentHourTo, current),
        period: period(window.periodFrom, window.periodTo, selected), periodHourly: hourlyResult(selectedHours),
        last24Hours: hourlyResult(trendHours), generatedAt
    };
}
