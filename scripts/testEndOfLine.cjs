const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = {};
vm.runInNewContext(readFileSync(path.join(__dirname, '../dist/renderer/modules/end-of-line/endOfLineModel.js'), 'utf8'), context);
const model = context.EndOfLine;
const machines = [
    { machineId: 'm1', name: 'Máquina 1' }, { machineId: 'm2', name: 'Máquina 2' },
    { machineId: 'm3', name: 'Máquina 3' }, { machineId: 'm4', name: 'Máquina 4' }
];
function tray(sequence, quality, arrays) {
    return { serialNumber: `QR-${sequence}`, enteredAt: '2026-09-18T10:00:00.000Z', workflow: {
        entrySequence: sequence, status: 'completed', quality, completedAt: `2026-09-18T10:00:${sequence}.000Z`,
        stages: [
            { machineId: 'm1', state: 'completed', result: 'OK' },
            ...arrays.map((positions, index) => ({ machineId: `m${index + 2}`, state: 'completed',
                result: positions.includes(false) ? 'NAO' : 'OK', data: { positions } }))
        ]
    } };
}

test('final de linha mostra somente bandejas concluídas e ordena pela última saída', () => {
    const pending = tray(3, 'pending', [[true], [true], [true]]); pending.workflow.status = 'in_progress';
    assert.deepEqual(model.completedTrays([tray(1, 'approved', [[true], [true], [true]]), pending,
        tray(2, 'approved', [[true], [true], [true]])]).map(item => item.workflow.entrySequence), [2, 1]);
});

test('posição reprovada em duas máquinas conta uma vez e identifica ambas', () => {
    const m2 = Array(20).fill(true), m3 = Array(20).fill(true), m4 = Array(20).fill(true);
    m2[1] = false; m3[1] = false;
    const result = model.summarize(tray(4, 'rejected', [
        m2, m3, m4
    ]), machines);
    assert.equal(result.status, 'rejected');
    assert.equal(result.positions.length, 20);
    assert.deepEqual([...result.positions].slice(0, 3).map(position => position.status), ['approved', 'rejected', 'approved']);
    assert.equal(result.rejected, 1);
    assert.deepEqual([...result.positions[1].failedMachineNames], ['Máquina 2', 'Máquina 3']);
    assert.deepEqual([...result.failedMachineNames], ['Máquina 2', 'Máquina 3']);
});

test('aprovação total exige true em todas as máquinas e marca ausência como incompleta', () => {
    const allApproved = () => Array(20).fill(true);
    const approved = model.summarize(tray(5, 'approved', [allApproved(), allApproved(), allApproved()]), machines);
    assert.equal(approved.status, 'approved'); assert.equal(approved.approved, 20);
    const incomplete = tray(6, 'approved', [allApproved(), allApproved()]);
    incomplete.workflow.stages.push({ machineId: 'm4', state: 'completed', result: 'OK', data: {} });
    const result = model.summarize(incomplete, machines);
    assert.equal(result.status, 'indeterminate'); assert.equal(result.indeterminate, 20);
});
