const assert = require('node:assert/strict');
const { test } = require('node:test');
const { LineOperationService } = require('../dist/modules/lineOperations/services/lineOperationService');

function fixture(overrides = {}) {
    let stored = null;
    const repository = { current: async () => stored ? structuredClone(stored) : null,
        save: async value => { stored = structuredClone(value); } };
    const ok = detail => async () => ({ ok: true, detail });
    const controls = {
        operators: ok('3 de 3 operadores ativos.'), endOfLine: ok('Estação conectada.'),
        bridge: ok('Bridge online.'), plcs: async () => ({ ok: true, detail: '2 CLPs prontas.', commandCode: 'LINE_START' }),
        ...overrides
    };
    return { service: new LineOperationService('linha-01', repository, controls), state: () => stored };
}

test('operação libera a bipagem depois dos checks sem acionar o START das CLPs', async () => {
    const { service, state } = fixture();
    await assert.rejects(service.assertRunning(), /inicie a operação/);
    const result = await service.start({ requestId: 'start-1' });
    assert.equal(result.status, 'running'); assert.ok(result.startedAt);
    await service.assertRunning();
    const replay = await service.start({ requestId: 'start-1' });
    assert.equal(replay.operationId, result.operationId); assert.equal(state().status, 'running');
    const secondRequest = await service.start({ requestId: 'start-2' });
    assert.equal(secondRequest.operationId, result.operationId);
});

test('operação permanece bloqueada quando qualquer pré-condição falha', async () => {
    const { service, state } = fixture({ bridge: async () => ({ ok: false, detail: 'Bridge offline.' }) });
    await assert.rejects(service.start({ requestId: 'start-fail' }), /Bridge offline/);
    assert.equal(state().status, 'failed');
});

test('confirmação de linha parada volta a bloquear a bipagem', async () => {
    const { service, state } = fixture();
    await service.start({ requestId: 'start-stop' });
    await service.markStopped();
    assert.equal(state().status, 'stopped');
    assert.ok(state().stoppedAt);
    await assert.rejects(service.assertRunning(), /inicie a operação/);
});
