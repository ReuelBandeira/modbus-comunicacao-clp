const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MachineConnectionProbe } = require('../dist/modules/modbus/services/machineConnectionProbe');

test('teste de comunicação faz somente leitura FC01 com a configuração informada', async () => {
    const calls = [];
    const probe = new MachineConnectionProbe(connection => ({
        readCoils: async (address, count) => { calls.push(['read', connection, address, count]); return [true]; },
        dispose: () => calls.push(['dispose'])
    }));
    const result = await probe.execute({ host: '192.168.1.25', port: 502, unitId: 3, timeoutMs: 1200, requestQrCoil: 7 });
    assert.equal(result.ok, true);
    assert.equal(result.requestQr, true);
    assert.deepEqual(calls, [
        ['read', { host: '192.168.1.25', port: 502, unitId: 3, timeoutMs: 1200 }, 7, 1],
        ['dispose']
    ]);
});

test('teste de comunicação diferencia indisponibilidade de configuração inválida', async () => {
    let disposed = false;
    const probe = new MachineConnectionProbe(() => ({
        readCoils: async () => { throw new Error('offline'); }, dispose: () => { disposed = true; }
    }));
    const result = await probe.execute({ host: '192.168.1.25', port: 502, unitId: 1, timeoutMs: 3000, requestQrCoil: 0 });
    assert.equal(result.ok, false);
    assert.equal(disposed, true);
    await assert.rejects(probe.execute({ host: 'inválido', port: 502, unitId: 1, timeoutMs: 3000 }), /IP válido/);
});
