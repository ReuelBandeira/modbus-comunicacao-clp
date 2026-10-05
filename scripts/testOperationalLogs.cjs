const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../dist/api/app');
const { AdminAccessService } = require('../dist/modules/operators/services/adminAccessService');
const { OperationalLogService, describeOperation } = require('../dist/modules/operationalLogs/services/operationalLogService');

test('registro operacional persiste somente metadados seguros e aplica retenção', async () => {
    const inserted = [], queries = [];
    const service = new OperationalLogService({
        insert: async value => inserted.push(structuredClone(value)),
        list: async query => { queries.push(query); return structuredClone(inserted); }
    }, 'linha-01', 30);
    const event = await service.recordHttp({ method: 'POST', path: '/api/admin/sessions', status: 200, durationMs: 12,
        body: { password: 'segredo-que-nao-pode-ser-gravado' } });
    assert.equal(event.actor.label, 'ADMIN'); assert.equal(event.action, 'ADMIN_LOGIN');
    assert.doesNotMatch(JSON.stringify(event), /segredo-que-nao-pode-ser-gravado/);
    assert.equal(Math.round((event.expiresAt - event.occurredAt) / 86_400_000), 30);
    const result = await service.list({ from: new Date(Date.now() - 3_600_000).toISOString(),
        to: new Date(Date.now() + 3_600_000).toISOString(), category: 'authentication', outcome: 'success', limit: '50' });
    assert.equal(result.events.length, 1); assert.equal(queries[0].category, 'authentication'); assert.equal(queries[0].limit, 50);
    await assert.rejects(service.list({ category: 'invalida' }), /Categoria inválida/);
    await assert.rejects(service.list({ limit: '1001' }), /entre 1 e 1000/);
});

test('registro operacional traduz as principais ações para linguagem operacional', () => {
    assert.equal(describeOperation('POST', '/api/line-operation/start').action, 'LINE_STARTED');
    assert.equal(describeOperation('POST', '/api/availability/stops').action, 'DOWNTIME_STARTED');
    assert.equal(describeOperation('POST', '/api/plc-controls/LINE_START/execute').category, 'plc');
    assert.equal(describeOperation('POST', '/api/station-test-reset').action, 'STATION_TEST_RESET');
    assert.equal(describeOperation('PUT', '/api/shifts/turno-1').category, 'shifts');
});

test('API do registro operacional exige ADMIN e audita operações mutáveis', async t => {
    const captured = [];
    const operational = { recordHttp: async value => { captured.push(value); },
        list: async query => ({ events: [], filters: query, retentionDays: 365, generatedAt: new Date() }) };
    const args = Array(17).fill(undefined); args[3] = new AdminAccessService('senha-admin'); args[16] = operational;
    const server = createApp(...args).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/api/operational-logs')).status, 401);
    const login = await fetch(base + '/api/admin/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'senha-admin' }) });
    const token = (await login.json()).data.token;
    const response = await fetch(base + '/api/operational-logs?limit=25', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); assert.equal((await response.json()).data.retentionDays, 365);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(captured.length, 1); assert.equal(captured[0].path, '/api/admin/sessions'); assert.equal(captured[0].status, 200);
    assert.doesNotMatch(JSON.stringify(captured[0]), /senha-admin/);
});
