const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregatePhysicalLineState } = require('../dist/modules/plcSignals/services/physicalLineState');

const signal = (signalId, productionState, error) => ({ signalId, label: signalId.toUpperCase(), value: 1,
    ...(productionState ? { productionState } : {}), ...(error ? { error } : {}) });

test('estado físico: linha serial produz enquanto alguma CLP produz e para quando todas param', () => {
    assert.equal(aggregatePhysicalLineState([
        signal('m1', 'stopped'), signal('m2', 'running'), signal('m3', 'warning'), signal('m4', 'stopped')
    ], 'serial_any_running').state, 'RUNNING');
    assert.equal(aggregatePhysicalLineState([
        signal('m1', 'stopped'), signal('m2', 'stopped'), signal('m3', 'stopped'), signal('m4', 'stopped')
    ], 'serial_any_running').state, 'STOPPED');
});

test('estado físico: emergência prevalece e comunicação inválida vira desconhecida', () => {
    assert.equal(aggregatePhysicalLineState([
        signal('m1', 'running'), signal('m2', undefined, 'timeout'), signal('m3', 'emergency')
    ], 'serial_any_running').state, 'STOPPED');
    assert.equal(aggregatePhysicalLineState([
        signal('m1', 'running'), signal('m2', undefined, 'timeout')
    ], 'serial_any_running').state, 'UNKNOWN');
});

test('estado físico: estratégias de todas obrigatórias e sinal de referência são determinísticas', () => {
    const values = [signal('m1', 'running'), signal('m2', 'stopped')];
    assert.equal(aggregatePhysicalLineState(values, 'all_required').state, 'STOPPED');
    assert.equal(aggregatePhysicalLineState(values, 'reference_signal', 'm1').state, 'RUNNING');
    assert.equal(aggregatePhysicalLineState(values, 'reference_signal', 'ausente').state, 'UNKNOWN');
});
