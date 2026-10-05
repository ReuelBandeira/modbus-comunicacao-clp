export interface ChipMetricSummary {
    produced: number;
    approved: number;
    rejected: number;
    indeterminate: number;
    approvalRate: number | null;
    averageCycleTimeMs: number | null;
    traysWithoutPositions: number;
}

export interface ChipHourlyMetric extends ChipMetricSummary {
    hourStart: Date;
}

export interface ChipMetricPeriod {
    from: Date;
    to: Date;
    summary: ChipMetricSummary;
}

export interface ChipMetricsReport {
    unit: 'chips';
    currentHour: ChipMetricPeriod;
    period: ChipMetricPeriod;
    periodHourly: ChipHourlyMetric[];
    last24Hours: ChipHourlyMetric[];
    generatedAt: Date;
}
