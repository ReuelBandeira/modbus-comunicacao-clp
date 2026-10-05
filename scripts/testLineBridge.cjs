const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { createLineApiBridge } = require('../dist/main/lineApiBridge');

test('ponte Electron acessa somente rotas da linha na API configurada', async t => {
    const calls = [];
    const server = createServer((req, res) => {
        calls.push(req.url); res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ status: 'OK', data: { entryLineId: 'linha-01' } }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const api = createLineApiBridge(`http://127.0.0.1:${server.address().port}`);
    assert.deepEqual(await api.request('GET', '/api/line-context'), { httpStatus: 200, status: 'OK', data: { entryLineId: 'linha-01' } });
    await api.request('GET', '/api/communication-logs');
    await api.request('GET', '/api/lines/linha-01/trays/42');
    await api.request('GET', '/api/lines/linha-01/trays?limit=200');
    await api.request('POST', '/api/lines/linha-01/trays/42/interventions',
        { action: 'remove', reason: 'Bandeja danificada' }, 'Bearer token-administrativo-valido');
    await api.request('POST', '/api/lines/linha-01/trays/42/advance',
        { reason: 'Teste IFTS', physicalMovementConfirmed: true }, 'Bearer token-administrativo-valido');
    await api.request('GET', '/api/lines/linha-01/chip-metrics?from=2026-09-18T00%3A00%3A00.000Z&to=2026-09-19T00%3A00%3A00.000Z&timezoneOffsetMinutes=180');
    await api.request('POST', '/api/lines/linha-01/machines/m1/connection-test', {
        host: '192.168.1.25', port: 502, unitId: 1, timeoutMs: 1000, requestQrCoil: 0
    });
    await api.request('DELETE', '/api/operators/MAT-001', undefined, 'Bearer token-administrativo-valido');
    await api.request('DELETE', '/api/shifts/11111111-1111-4111-8111-111111111111', undefined, 'Bearer token-administrativo-valido');
    await api.request('GET', '/api/operator-station/context');
    await api.request('POST', '/api/operator-station/entries', { registration: 'MAT-001', requestId: '11111111-1111-4111-8111-111111111111' });
    await api.request('POST', '/api/operator-station/sessions/22222222-2222-4222-8222-222222222222/exit',
        { requestId: '33333333-3333-4333-8333-333333333333' });
    await api.request('GET', '/api/availability/current');
    await api.request('GET', '/api/operational-logs?from=2026-09-18T00%3A00%3A00.000Z&to=2026-09-19T00%3A00%3A00.000Z&limit=100',
        undefined, 'Bearer token-administrativo-valido');
    await api.request('GET', '/api/availability/configuration', undefined, 'Bearer token-administrativo-valido');
    await api.request('GET', '/api/availability/report?from=2026-09-18T00%3A00%3A00.000Z&to=2026-09-19T00%3A00%3A00.000Z&timezoneOffsetMinutes=180');
    await api.request('POST', '/api/availability/stops', { reasonId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222' });
    await api.request('POST', '/api/availability/stops/33333333-3333-4333-8333-333333333333/classify',
        { reasonId: '11111111-1111-4111-8111-111111111111' });
    await api.request('PUT', '/api/availability/configuration', { idealCycleTimeSeconds: 12 }, 'Bearer token-administrativo-valido');
    await api.request('DELETE', '/api/availability/reasons/11111111-1111-4111-8111-111111111111', undefined, 'Bearer token-administrativo-valido');
    await api.request('GET', '/api/plc-controls/operational');
    await api.request('GET', '/api/line-status');
    await api.request('GET', '/api/plc-alarms/operational');
    await api.request('POST', '/api/plc-alarms', { code: 'M1_ALARME' }, 'Bearer token-administrativo-valido');
    await api.request('PUT', '/api/plc-alarms/alarme-1', { code: 'M1_ALARME' }, 'Bearer token-administrativo-valido');
    await api.request('POST', '/api/plc-alarms/occurrences/ocorrencia-1/acknowledge', { acknowledgedBy: 'IHM Principal' });
    await api.request('DELETE', '/api/plc-alarms/alarme-1', undefined, 'Bearer token-administrativo-valido');
    await api.request('POST', '/api/plc-controls/LINE_START/execute', { requestId: 'execucao-001' });
    await api.request('POST', '/api/station-test-reset', { requestId: 'reset-001' }, 'Bearer token-administrativo-valido');
    await api.request('GET', '/api/ihm-machines');
    await api.request('GET', '/api/ihm-machines/configuration', undefined, 'Bearer token-administrativo-valido');
    await api.request('POST', '/api/ihm-machines', { ihmMachineId: 'prensa-01', name: 'Prensa 01', commandIds: {} },
        'Bearer token-administrativo-valido');
    await api.request('PUT', '/api/ihm-machines/prensa-01', { name: 'Prensa', commandIds: {} },
        'Bearer token-administrativo-valido');
    await api.request('DELETE', '/api/ihm-machines/prensa-01', undefined, 'Bearer token-administrativo-valido');
    for (const [method, path] of [['GET', 'https://example.com/'], ['DELETE', '/api/lines/linha-01'], ['GET', '/api-docs/'], ['POST', '/api/lines/linha-01/status']]) {
        await assert.rejects(api.request(method, path), /inválida/);
    }
    await assert.rejects(api.request('POST', '/api/lines', { text: 'a'.repeat(40000) }), /32 KB/);
    assert.deepEqual(calls, ['/api/line-context', '/api/communication-logs', '/api/lines/linha-01/trays/42',
        '/api/lines/linha-01/trays?limit=200', '/api/lines/linha-01/trays/42/interventions', '/api/lines/linha-01/trays/42/advance',
        '/api/lines/linha-01/chip-metrics?from=2026-09-18T00%3A00%3A00.000Z&to=2026-09-19T00%3A00%3A00.000Z&timezoneOffsetMinutes=180',
        '/api/lines/linha-01/machines/m1/connection-test', '/api/operators/MAT-001',
        '/api/shifts/11111111-1111-4111-8111-111111111111', '/api/operator-station/context',
        '/api/operator-station/entries', '/api/operator-station/sessions/22222222-2222-4222-8222-222222222222/exit',
        '/api/availability/current',
        '/api/operational-logs?from=2026-09-18T00%3A00%3A00.000Z&to=2026-09-19T00%3A00%3A00.000Z&limit=100',
        '/api/availability/configuration',
        '/api/availability/report?from=2026-09-18T00%3A00%3A00.000Z&to=2026-09-19T00%3A00%3A00.000Z&timezoneOffsetMinutes=180',
        '/api/availability/stops', '/api/availability/stops/33333333-3333-4333-8333-333333333333/classify',
        '/api/availability/configuration', '/api/availability/reasons/11111111-1111-4111-8111-111111111111',
        '/api/plc-controls/operational', '/api/line-status', '/api/plc-alarms/operational', '/api/plc-alarms',
        '/api/plc-alarms/alarme-1', '/api/plc-alarms/occurrences/ocorrencia-1/acknowledge', '/api/plc-alarms/alarme-1',
        '/api/plc-controls/LINE_START/execute', '/api/station-test-reset', '/api/ihm-machines',
        '/api/ihm-machines/configuration', '/api/ihm-machines', '/api/ihm-machines/prensa-01', '/api/ihm-machines/prensa-01']);
});

test('ponte Electron converte falha de rede em mensagem adequada ao operador', async () => {
    const server = createServer().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const api = createLineApiBridge(`http://127.0.0.1:${port}`);
    const originalError = console.error;
    const diagnostics = [];
    console.error = (...values) => diagnostics.push(values.join(' '));
    try {
        const result = await api.request('GET', '/api/health');
        assert.equal(result.httpStatus, 503);
        assert.equal(result.status, 'ERROR');
        assert.match(result.msg, /servidor da linha/);
        assert.doesNotMatch(result.msg, /fetch|remote method|TypeError/i);
        assert.match(diagnostics.join(' '), /LINE_API.*fetch failed/i);
    } finally { console.error = originalError; }
});
