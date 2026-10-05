const assert = require('node:assert/strict');
const { test } = require('node:test');
const { IftsBridgeClient, IftsBridgeError, readIftsBridgeConfig } = require('../dist/modules/iftsBridge/services/iftsBridgeClient');

function reply(status, value) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function client(handler) { return new IftsBridgeClient({ baseUrl: 'http://192.168.137.1:8787/',
    apiKey: 'segredo', timeoutMs: 60000, startupTimeoutMs: 5000 }, handler); }

test('IFTS Bridge: lê configuração sem fixar endereço no código', () => {
    assert.deepEqual(readIftsBridgeConfig({ IFTS_BRIDGE_BASE_URL: 'http://10.0.0.2:8787', IFTS_BRIDGE_API_KEY: 'abc', IFTS_BRIDGE_TIMEOUT_MS: '60000' }),
        { baseUrl: 'http://10.0.0.2:8787/', apiKey: 'abc', timeoutMs: 60000, startupTimeoutMs: 60000 });
    assert.throws(() => readIftsBridgeConfig({ IFTS_BRIDGE_BASE_URL: 'http://10.0.0.2:8787' }), /configuradas juntas/);
    assert.throws(() => readIftsBridgeConfig({ IFTS_BRIDGE_BASE_URL: 'http://10.0.0.2:8787', IFTS_BRIDGE_API_KEY: 'x', IFTS_BRIDGE_TIMEOUT_MS: '1000' }), /60000/);
});

test('IFTS Bridge: readiness exige o servidor online e orienta aguardar a tarefa de inicialização', async () => {
    const ready = await client(async url => url.pathname === '/health'
        ? reply(200, { stationReady: true, state: { status: 'idle' }, ifts: { stationOk: true, reason: 'ready' } })
        : reply(200, { model: 'A15', cycleStatus: 'idle' })).readiness();
    assert.equal(ready.ready, true); assert.equal(ready.startAttempted, false);
    const offline = await client(async () => { throw new Error('offline'); }).readiness(true);
    assert.equal(offline.ready, false); assert.equal(offline.startAttempted, false);
    assert.match(offline.detail, /tarefa de inicialização/);
});

test('IFTS Bridge: prepara o IFTS quando o servidor está online mas stationReady é falso', async () => {
    let stationReady = false; const calls = [];
    const api = client(async (url, init) => {
        calls.push(`${init.method}:${url.pathname}`);
        if (url.pathname === '/health') return reply(200, { stationReady,
            state: { status: 'idle' }, ifts: { stationOk: stationReady, reason: stationReady ? 'ready' : 'not_running' } });
        if (url.pathname === '/model') return reply(200, { model: 'A15', cycleStatus: 'idle', cycleId: null });
        if (url.pathname === '/ifts/start-auto-save-set') { stationReady = true; return reply(200, { ok: true }); }
        return reply(404, { error: 'not_found' });
    });
    const before = await api.readiness(false);
    assert.equal(before.ready, false); assert.match(before.detail, /não está aberto/);
    const after = await api.readiness(true);
    assert.equal(after.ready, true); assert.equal(after.startAttempted, true);
    assert.ok(calls.includes('POST:/ifts/start-auto-save-set'));
});

test('IFTS Bridge: START envia API key e cycleId', async () => {
    const calls = [], api = client(async (url, init) => {
        calls.push({ path: url.pathname, method: init.method, key: init.headers['X-API-Key'], body: init.body });
        if (url.pathname === '/health') return reply(200, { state: 'idle' });
        if (url.pathname === '/model') return reply(200, { model: 'A15' });
        return reply(200, { state: 'started' });
    });
    const result = await api.start({ cycleId: 'SIM-001' });
    assert.equal(result.cycleId, 'SIM-001');
    const start = calls.find(call => call.path === '/cycle/start');
    assert.equal(start.method, 'POST'); assert.equal(start.key, 'segredo'); assert.deepEqual(JSON.parse(start.body), { cycleId: 'SIM-001' });
});

test('IFTS Bridge: FINISH e RETRY reutilizam o cycleId', async () => {
    const calls = [], api = client(async (url, init) => { calls.push({ path: url.pathname, body: init.body }); return reply(200, { state: 'completed' }); });
    await api.finish({ cycleId: 'SIM-002' }); await api.retry({ cycleId: 'SIM-002' });
    assert.deepEqual(calls.map(call => [call.path, JSON.parse(call.body).cycleId]), [['/cycle/finish', 'SIM-002'], ['/cycle/retry', 'SIM-002']]);
});

test('IFTS Bridge: RESET DEBUG chama endpoint autenticado sem cycleId', async () => {
    const calls = [], api = client(async (url, init) => { calls.push({ path: url.pathname, method: init.method,
        key: init.headers['X-API-Key'], body: init.body }); return reply(200, { status: 'idle' }); });
    await api.resetDebug();
    assert.deepEqual(calls, [{ path: '/debug/reset', method: 'POST', key: 'segredo', body: undefined }]);
});

test('IFTS Bridge: bloqueia START quando outro ciclo está ativo', async () => {
    const api = client(async url => url.pathname === '/health'
        ? reply(200, { stationReady: true, state: { status: 'started', cycleId: 'CICLO-ATIVO' } })
        : reply(200, { model: 'A15', cycleStatus: 'started', cycleId: 'CICLO-ATIVO' }));
    await assert.rejects(api.start({ cycleId: 'NOVO-CICLO' }), error => error instanceof IftsBridgeError && error.status === 409);
});

test('IFTS Bridge: preserva conflito HTTP 409 e trata falha de rede', async () => {
    await assert.rejects(client(async () => reply(409, { message: 'CSV ainda não apareceu' })).finish({ cycleId: 'SIM-003' }),
        error => error instanceof IftsBridgeError && error.status === 409 && /CSV/.test(error.message));
    const status = await client(async () => { throw new Error('ECONNREFUSED'); }).status();
    assert.equal(status.online, false); assert.equal(status.status, 'offline'); assert.match(status.detail, /conectar/);
});

test('IFTS Bridge: status combina health e model e alteração exige ocioso', async () => {
    let active = true;
    const api = client(async (url, init) => {
        if (url.pathname === '/health') return reply(200, { stationReady: true,
            state: active ? { status: 'started', cycleId: 'ORDEM-01' } : { status: 'idle' },
            ifts: { stationOk: true, reason: 'ready' } });
        if (url.pathname === '/model' && init.method === 'GET') return reply(200,
            active ? { model: 'SAMSUNG_A15', cycleStatus: 'started', cycleId: 'ORDEM-01' }
                : { model: 'SAMSUNG_A15', cycleStatus: 'idle', cycleId: null });
        return reply(200, { model: 'SAMSUNG_A16' });
    });
    assert.deepEqual(await api.status(), { configured: true, online: true, status: 'started', cycleId: 'ORDEM-01',
        model: 'SAMSUNG_A15', stationReady: true, stationReason: 'ready' });
    await assert.rejects(api.changeModel({ model: 'SAMSUNG_A16' }), /sem ciclo ativo/);
    active = false;
    const changed = await api.changeModel({ model: 'SAMSUNG_A16' });
    assert.equal(changed.model, 'SAMSUNG_A16'); assert.match(changed.warning, /reiniciado/);
});

test('IFTS Bridge: preserva a mensagem de erro usada pelo projeto real', async () => {
    await assert.rejects(client(async () => reply(409, { error: 'ciclo já está ativo' })).finish({ cycleId: 'SIM-004' }),
        error => error instanceof IftsBridgeError && /ciclo já está ativo/.test(error.message));
});
