const assert = require('node:assert/strict');
const { test } = require('node:test');
const { IftsLineIntegrationService, readIftsLineIntegrationConfig } = require(
    '../dist/modules/iftsBridge/services/iftsLineIntegrationService');

function cycle(overrides = {}) {
    const positions = Array.from({ length: 20 }, (_, index) => ({
        position: index + 1, passed: index !== 4, result: index === 4 ? 'FAIL' : 'PASS',
        judgment: index === 4 ? 'NG' : 'OK', ngStep: index === 4 ? 'DDR_TEST' : null, message: null
    }));
    return {
        schemaVersion: 2, cycleId: 'entry-42', model: 'A15', startedAt: new Date('2026-09-25T10:00:00Z'),
        finishedAt: new Date('2026-09-25T10:01:00Z'), result: 'FAIL', passed: false,
        totalPositions: 20, passedPositions: 19, failedPositions: 1, positions,
        sourceFiles: [{ name: 'A15.csv', positionCount: 20 }], receivedAt: new Date(), ...overrides
    };
}

function fixture() {
    const assignment = { serialNumber: 'BANDEJA-42', entrySequence: 42, machineId: 'm2', cycleId: 'entry-42',
        operationId: 'operation-42', action: 'EXECUTE', state: 'processing', identificationAcknowledgedAt: new Date() };
    const calls = { bridge: [], results: [], passages: [] };
    let active = assignment, stored = assignment;
    const coordinator = {
        activeAssignment: async () => active,
        arriveNext: async () => assignment,
        assignmentByCycleId: async (_lineId, _machineId, cycleId) => cycleId === assignment.cycleId ? stored : null,
        result: async (...args) => {
            calls.results.push(args); active = stored = { ...assignment, state: 'result_recorded' }; return active;
        },
        passage: async (...args) => {
            calls.passages.push(args); active = null; stored = { ...assignment, state: 'completed' }; return stored;
        }
    };
    const bridge = { start: async body => { calls.bridge.push(body); return { cycleId: body.cycleId }; } };
    return { service: new IftsLineIntegrationService(
        { lineId: 'linha-01', machineId: 'm2', expectedPositionCount: 20 }, coordinator, bridge), calls, coordinator };
}

test('IFTS linha: START usa o ciclo da bandeja reservada', async () => {
    const { service, calls } = fixture();
    const assignment = await service.start();
    assert.equal(assignment.serialNumber, 'BANDEJA-42');
    assert.deepEqual(calls.bridge, [{ cycleId: 'entry-42' }]);
});

test('IFTS linha: START exige bandeja previamente identificada pela CLP', async () => {
    const { service, calls, coordinator } = fixture();
    coordinator.activeAssignment = async () => null;
    await assert.rejects(service.start(), /ainda não recebeu os dados/);
    assert.equal(calls.bridge.length, 0);
});

test('IFTS linha: START tolera a corrida curta entre a baixa de M0 e a confirmação persistida', async () => {
    const { service, calls, coordinator } = fixture();
    let reads = 0;
    coordinator.activeAssignment = async () => ({
        serialNumber: 'BANDEJA-42', entrySequence: 42, machineId: 'm2', cycleId: 'entry-42',
        operationId: 'operation-42', action: 'EXECUTE', state: 'processing',
        ...(reads++ ? { identificationAcknowledgedAt: new Date() } : {})
    });
    await service.start();
    assert.deepEqual(calls.bridge, [{ cycleId: 'entry-42' }]);
});

test('IFTS linha: resultado vira OK/NAO e positions booleanas na etapa', async () => {
    const { service, calls } = fixture();
    const applied = await service.apply(cycle());
    assert.equal(applied.mode, 'production');
    assert.equal(calls.results.length, 1);
    const [lineId, machineId, operationId, result, data] = calls.results[0];
    assert.deepEqual([lineId, machineId, operationId, result], ['linha-01', 'm2', 'operation-42', 'NAO']);
    assert.equal(data.positions.length, 20); assert.equal(data.positions[4], false);
    assert.equal(data.iftsCycleId, 'entry-42'); assert.equal(data.failedPositions, 1);
});

test('IFTS linha: ciclo SIM permanece fora do workflow', async () => {
    const { service, calls } = fixture();
    assert.deepEqual(await service.apply(cycle({ cycleId: 'SIM-001' })), { mode: 'debug', cycleId: 'SIM-001' });
    assert.equal(calls.results.length, 0);
});

test('IFTS linha: debug exige prefixo SIM e estação desocupada', async () => {
    const { service } = fixture();
    await assert.rejects(service.assertDebugStart({ cycleId: 'MANUAL-001' }), /prefixo SIM/);
    await assert.rejects(service.assertDebugStart({ cycleId: 'SIM-001' }), /está ocupada/);
});

test('IFTS linha: rejeita ciclo sem bandeja e mapa de posições incompleto', async () => {
    const { service } = fixture();
    await assert.rejects(service.apply(cycle({ cycleId: 'entry-99' })), /não pertence/);
    const invalid = cycle(); invalid.positions = invalid.positions.slice(0, 19); invalid.totalPositions = 19;
    await assert.rejects(service.apply(invalid), /esperadas 20 posições/);
});

test('IFTS linha: término informado à CLP mantém a bandeja aguardando a saída física', async () => {
    const { service, calls } = fixture();
    await assert.rejects(service.completeAfterResultWrite('entry-42'), /ainda não possui resultado/);
    await service.apply(cycle());
    const pendingExit = await service.completeAfterResultWrite('entry-42');
    assert.equal(pendingExit.state, 'result_recorded');
    assert.deepEqual(calls.passages, []);
});

test('IFTS linha: configuração é opcional e valida quantidade', () => {
    assert.equal(readIftsLineIntegrationConfig('linha-01', {}), undefined);
    assert.deepEqual(readIftsLineIntegrationConfig('linha-01', {
        IFTS_MEMORY_MACHINE_ID: 'm2', IFTS_EXPECTED_POSITION_COUNT: '20'
    }), { lineId: 'linha-01', machineId: 'm2', expectedPositionCount: 20 });
    assert.throws(() => readIftsLineIntegrationConfig('linha-01', {
        IFTS_MEMORY_MACHINE_ID: 'm2', IFTS_EXPECTED_POSITION_COUNT: '0'
    }), /entre 1 e 10000/);
});
