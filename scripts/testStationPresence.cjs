const assert = require('node:assert/strict');
const { test } = require('node:test');
const { StationPresenceService } = require('../dist/modules/stations/services/stationPresenceService');

test('final de linha é obrigatória em produção e expira sem heartbeat', async () => {
    const service = new StationPresenceService(async () => true, 5000);
    const start = new Date('2026-01-01T12:00:00.000Z');
    assert.deepEqual(await service.status(start), {
        role: 'end-of-line', connected: false, required: true, satisfied: false, lastSeen: null, timeoutMs: 5000
    });
    await assert.rejects(service.assertAvailable(), { status: 409 });
    const online = await service.heartbeat({ role: 'end-of-line' }, start);
    assert.equal(online.connected, true);
    assert.equal((await service.status(new Date(start.getTime() + 5000))).satisfied, true);
    assert.equal((await service.status(new Date(start.getTime() + 5001))).satisfied, false);
});

test('final de linha não bloqueia simulação', async () => {
    const service = new StationPresenceService(async () => false, 5000);
    const status = await service.status();
    assert.equal(status.connected, false);
    assert.equal(status.required, false);
    assert.equal(status.satisfied, true);
    await service.assertAvailable();
});

test('heartbeat aceita somente o papel final de linha', async () => {
    const service = new StationPresenceService(async () => true, 5000);
    await assert.rejects(service.heartbeat({ role: 'main' }), { status: 400 });
    await assert.rejects(service.heartbeat({ role: 'end-of-line', extra: true }), { status: 400 });
});
