const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildChipMetrics, chipMetricsWindow } = require('../dist/modules/pcm/workflow/services/chipMetricsService');

function tray(serial, enteredAt, completedAt, positions, legacy = false) {
    const stages = [{ machineId: 'm1', state: 'completed', passedAt: new Date(completedAt) }];
    for (const [index, values] of positions.entries()) stages.push({
        machineId: `m${index + 2}`, state: 'completed', passedAt: new Date(completedAt), data: values === null ? {} : { positions: values }
    });
    return { serialNumber: serial, enteredAt: new Date(enteredAt), workflow: {
        lineId: 'linha-01', entrySequence: Number(serial.replace(/\D/g, '')) || 1, version: 1,
        status: 'completed', quality: 'approved', ...(!legacy && { completedAt: new Date(completedAt) }), stages
    } };
}

test('métricas de chips consolidam M2/M3/M4, falhas, ausências, ciclo e horas vazias', () => {
    const now = new Date('2026-09-18T13:30:00.000Z');
    const window = chipMetricsWindow(new Date('2026-09-18T00:00:00.000Z'), new Date('2026-09-19T00:00:00.000Z'), 180, now);
    const records = [
        tray('T1', '2026-09-18T12:15:00.000Z', '2026-09-18T13:15:00.000Z',
            [[true, true, false], [true, false, true], [true, true, true]]),
        tray('T2', '2026-09-18T11:30:00.000Z', '2026-09-18T12:30:00.000Z',
            [[true, true], [true], [true, true]], true),
        tray('T3', '2026-09-18T10:00:00.000Z', '2026-09-18T11:00:00.000Z', [null, null, null])
    ];
    const report = buildChipMetrics(records, window, now);
    assert.deepEqual(report.currentHour.summary, {
        produced: 3, approved: 1, rejected: 2, indeterminate: 0,
        approvalRate: 33.33, averageCycleTimeMs: 3600000, traysWithoutPositions: 0
    });
    assert.equal(report.period.summary.produced, 5);
    assert.equal(report.period.summary.approved, 2);
    assert.equal(report.period.summary.rejected, 2);
    assert.equal(report.period.summary.indeterminate, 1);
    assert.equal(report.period.summary.traysWithoutPositions, 1);
    assert.equal(report.period.summary.approvalRate, 40);
    assert.equal(report.period.summary.averageCycleTimeMs, 3600000);
    assert.equal(report.last24Hours.length, 24);
    assert.equal(report.last24Hours.reduce((total, hour) => total + hour.produced, 0), 5);
    assert.ok(report.periodHourly.some(hour => hour.produced === 0));
});
