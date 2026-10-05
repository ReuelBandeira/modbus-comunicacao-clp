const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { createApp, isLanRequestAllowed } = require('../dist/api/app');
const { startApi } = require('../dist/api/server');
const { AdminAccessService } = require('../dist/modules/operators/services/adminAccessService');

test('LAN permite somente consultas e entrada externa de bandeja', () => {
    assert.equal(isLanRequestAllowed('POST', '/api/serial-numbers', '192.168.1.50'), true);
    assert.equal(isLanRequestAllowed('GET', '/api/entry-preparation/current', '192.168.1.50'), true);
    assert.equal(isLanRequestAllowed('POST', '/api/entry-preparation/11111111-1111-4111-8111-111111111111/chips', '192.168.1.50'), true);
    assert.equal(isLanRequestAllowed('POST', '/api/entry-preparation/11111111-1111-4111-8111-111111111111/release', '192.168.1.50'), true);
    assert.equal(isLanRequestAllowed('DELETE', '/api/entry-preparation/11111111-1111-4111-8111-111111111111', '192.168.1.50'), false);
    assert.equal(isLanRequestAllowed('GET', '/api/health', '192.168.1.50'), true);
    assert.equal(isLanRequestAllowed('POST', '/api/stations/end-of-line/heartbeat', '192.168.1.50'), true);
    assert.equal(isLanRequestAllowed('GET', '/api/stations/end-of-line/status', '192.168.1.50'), true);
    assert.equal(isLanRequestAllowed('POST', '/api/lines', '192.168.1.50'), false);
    assert.equal(isLanRequestAllowed('DELETE', '/api/shifts/id', '192.168.1.50'), false);
});

test('Swagger e especificação ficam disponíveis sem acessar o banco', async t => {
    const server = createApp({ inProgress: async () => false, insert: async () => assert.fail('Não deve gravar') }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(base + '/api-docs/openapi.json');
    assert.equal(response.status, 200);
    const spec = await response.json();
    assert.equal(spec.openapi, '3.0.3');
    assert.equal(spec.servers[0].url, '/');
    const endpoint = spec.paths['/api/serial-numbers'].post;
    for (const status of ['200', '400', '409', '413', '415', '500', '503']) assert.ok(endpoint.responses[status]);
    assert.equal(spec.info.title, 'API PCM');
    assert.ok(spec.paths['/api/lines/{lineId}/chip-metrics']);
    assert.ok(spec.paths['/api/availability/report']);
    assert.ok(spec.paths['/api/stations/end-of-line/heartbeat']);
    assert.ok(spec.paths['/api/plc-controls/operational']);
    assert.ok(spec.paths['/api/plc-controls/{code}/execute']);
    assert.ok(spec.paths['/api/plc-alarms/operational']);
    assert.ok(spec.paths['/api/plc-alarms/occurrences/{occurrenceId}/acknowledge']);
    assert.ok(spec.paths['/api/test-results']);
    assert.ok(spec.paths['/api/test-results/{cycleId}']);
    assert.ok(spec.paths['/api/operational-logs']);
    assert.equal(spec.components.schemas.EntryRequestDto.oneOf.length, 2);
    assert.equal(spec.components.schemas.ApiResponseDto.oneOf.length, 2);
    assert.equal(endpoint.requestBody.content['application/json'].schema.$ref, '#/components/schemas/EntryRequestDto');
    const page = await fetch(base + '/api-docs/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /swagger-ui/);
    for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-init.js']) {
        const result = await fetch(base + '/api-docs/' + asset);
        assert.equal(result.status, 200);
        assert.ok((await result.text()).length > 0);
    }
});

async function serve(t, repository) {
    const server = createApp(repository).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    return (body, headers = { 'Content-Type': 'application/json' }, path = '/api/serial-numbers') =>
        fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST', headers, body });
}

test('servidor HTTP libera a porta ao encerrar e rejeita porta ocupada', async t => {
    const api = await startApi({ host: '127.0.0.1', port: 0 });
    t.after(() => api.stop());
    const port = api.address.port;
    await assert.rejects(startApi({ host: '127.0.0.1', port }), { code: 'EADDRINUSE' });
    await Promise.all([api.stop(), api.stop()]);
    const restarted = await startApi({ host: '127.0.0.1', port });
    await restarted.stop();
});

test('QR com serial utiliza o mesmo fluxo de persistência', async t => {
    const saved = [];
    const post = await serve(t, { inProgress: async () => false, insert: async pcm => { assert.ok(pcm.enteredAt instanceof Date); saved.push(pcm.serialNumber); } });
    const response = await post(JSON.stringify({ 'qr-code': 'AbC123', ignored: true }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'OK' });
    assert.deepEqual(saved, ['AbC123']);
});

test('interface da linha e seus assets são servidos pela API sem depender do MongoDB', async t => {
    const server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(base + '/line/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="machines-panel"/);
    const entryPage = await fetch(base + '/line/bipagem.html');
    assert.equal(entryPage.status, 200);
    const entryHtml = await entryPage.text();
    assert.match(entryHtml, /id="positions"/);
    assert.match(entryHtml, /id="progress-count"/);
    assert.match(entryHtml, /id="release"/);
    assert.match(entryHtml, /BIPAR CHIPS NAS POSIÇÕES/);
    const reportPage = await fetch(base + '/line/relatorios.html');
    assert.equal(reportPage.status, 200);
    assert.match(await reportPage.text(), /id="trend-chart"/);
    const operatorsPage = await fetch(base + '/line/operadores.html');
    assert.equal(operatorsPage.status, 200);
    const operatorsHtml = await operatorsPage.text();
    assert.match(operatorsHtml, /id="admin-login-form"/);
    const registrationPattern = operatorsHtml.match(/id="operator-registration"[^>]+pattern="([^"]+)"/)?.[1];
    assert.ok(registrationPattern);
    const registrationRegex = new RegExp(`^(?:${registrationPattern})$`, 'v');
    assert.equal(registrationRegex.test('MAT-001_TEST'), true);
    assert.equal(registrationRegex.test('MAT 001'), false);
    const shiftsPage = await fetch(base + '/line/turnos.html');
    assert.equal(shiftsPage.status, 200);
    assert.match(await shiftsPage.text(), /id="shift-form"/);
    const oeePage = await fetch(base + '/line/oee.html');
    assert.equal(oeePage.status, 200);
    const oeeHtml = await oeePage.text();
    assert.match(oeeHtml, /<dialog id="stop-dialog"/);
    assert.match(oeeHtml, /id="stop-form"/);
    assert.match(oeeHtml, /id="production-state"/);
    assert.match(oeeHtml, /id="period-preset"/);
    assert.match(oeeHtml, /value="current-shift" selected/);
    assert.match(oeeHtml, /id="live-update"/);
    assert.match(oeeHtml, /id="availability-waterfall"/);
    assert.match(oeeHtml, /id="waterfall-equation"/);
    assert.match(oeeHtml, /id="physical-state-detail"/);
    const oeeConfigPage = await fetch(base + '/line/oee-config.html');
    assert.equal(oeeConfigPage.status, 200);
    assert.match(await oeeConfigPage.text(), /id="physical-state-form"/);
    assert.equal((await fetch(base + '/line/plc-controls.html')).status, 404);
    const iftsPage = await fetch(base + '/line/ifts-teste.html');
    assert.equal(iftsPage.status, 200);
    const iftsHtml = await iftsPage.text();
    assert.match(iftsHtml, /id="start-cycle"/);
    assert.match(iftsHtml, /id="finish-cycle"/);
    assert.match(iftsHtml, /id="check-result"/);
    const oeeConfigHtml = await (await fetch(base + '/line/oee-config.html')).text();
    const reasonPattern = oeeConfigHtml.match(/id="reason-code"[^>]+pattern="([^"]+)"/)?.[1];
    assert.ok(reasonPattern); assert.doesNotThrow(() => new RegExp(reasonPattern, 'v'));
    const principalPage = await fetch(base + '/line/principal.html');
    assert.equal(principalPage.status, 200);
    assert.match(await principalPage.text(), /id="operator-scan-form"/);
    const traysPage = await fetch(base + '/line/bandejas.html');
    assert.equal(traysPage.status, 200);
    assert.match(await traysPage.text(), /id="intervention-dialog"/);
    assert.match(await (await fetch(base + '/line/line.html')).text(), /id="advance-dialog"/);
    const operationalLogPage = await fetch(base + '/line/logs-operacionais.html');
    assert.equal(operationalLogPage.status, 200);
    assert.match(await operationalLogPage.text(), /id="filter-form"/);
    for (const asset of ['/line/line.js', '/line/line.css', '/line/bipagem.js', '/line/bipagem.css', '/line/bandejas.js', '/line/bandejas.css', '/line/relatorios.js', '/line/relatorios.css', '/line/operadores.js', '/line/operadores.css', '/line/turnos.js', '/line/turnos.css', '/line/principal.js', '/line/principal.css', '/line/oee.js', '/line/oee.css', '/line/oee-config.js', '/line/oee-config.css', '/line/ifts-teste.js', '/line/ifts-teste.css', '/line/logs-operacionais.js', '/line/logs-operacionais.css', '/css/ihm.css', '/css/navigation.css', '/js/navigation.js', '/vendor/bootstrap/bootstrap.min.css']) {
        const response = await fetch(base + asset);
        assert.equal(response.status, 200);
        await response.arrayBuffer();
    }
    const communication = await fetch(base + '/api/communication-logs');
    assert.equal(communication.status, 200);
    assert.ok(Array.isArray((await communication.json()).data));
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
    const temperature = (await health.json()).data.temperature;
    assert.ok(['normal', 'warning', 'critical', 'unavailable'].includes(temperature.status));
    assert.equal(typeof temperature.warningAt, 'number');
    assert.equal(typeof temperature.criticalAt, 'number');
    const response = await fetch(base + '/api/line-context');
    assert.equal(response.status, 503);
});

test('rotas de operadores exigem autenticacao ADMIN', async t => {
    const operators = { list: async () => [{ name: 'Maria', registration: 'MAT-001' }] };
    const server = createApp(undefined, undefined, operators, new AdminAccessService('senha-admin')).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/api/operators')).status, 401);
    const login = await fetch(base + '/api/admin/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'senha-admin' }) });
    assert.equal(login.status, 200);
    const token = (await login.json()).data.token;
    const response = await fetch(base + '/api/operators', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, [{ name: 'Maria', registration: 'MAT-001' }]);
});

test('intervencao de bandeja exige ADMIN e encaminha a operacao auditada', async t => {
    let received;
    const coordinator = { intervene: async (lineId, sequence, body) => {
        received = { lineId, sequence, body }; return { serialNumber: 'TRAY-1', workflow: { status: 'removed' } };
    } };
    const server = createApp(undefined, coordinator, undefined, new AdminAccessService('senha-admin')).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const path = '/api/lines/linha-01/trays/7/interventions';
    const options = { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', reason: 'Bandeja danificada' }) };
    assert.equal((await fetch(base + path, options)).status, 401);
    const login = await fetch(base + '/api/admin/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'senha-admin' }) });
    const token = (await login.json()).data.token;
    const response = await fetch(base + path, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(received, { lineId: 'linha-01', sequence: 7,
        body: { action: 'remove', reason: 'Bandeja danificada' } });
});

test('avanco manual de bandeja exige ADMIN', async t => {
    let received;
    const coordinator = { advanceTray: async (lineId, sequence, body) => {
        received = { lineId, sequence, body }; return { serialNumber: 'TRAY-1', workflow: { nextMachineId: 'm2' } };
    } };
    const server = createApp(undefined, coordinator, undefined, new AdminAccessService('senha-admin')).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`, path = '/api/lines/linha-01/trays/7/advance';
    const body = { reason: 'Teste IFTS', physicalMovementConfirmed: true };
    assert.equal((await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 401);
    const login = await fetch(base + '/api/admin/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'senha-admin' }) });
    const token = (await login.json()).data.token;
    assert.equal((await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body) })).status, 200);
    assert.deepEqual(received, { lineId: 'linha-01', sequence: 7, body });
});

test('rotas de turnos exigem autenticacao ADMIN', async t => {
    let removed = '';
    const shifts = {
        list: async () => [{ shiftId: '11111111-1111-4111-8111-111111111111', name: 'Turno 1', startTime: '06:00', endTime: '14:00', active: true }],
        remove: async shiftId => { removed = shiftId; }
    };
    const server = createApp(undefined, undefined, undefined, new AdminAccessService('senha-admin'), shifts).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/api/shifts')).status, 401);
    const login = await fetch(base + '/api/admin/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'senha-admin' }) });
    const token = (await login.json()).data.token;
    const response = await fetch(base + '/api/shifts', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data[0].name, 'Turno 1');
    const removal = await fetch(base + '/api/shifts/11111111-1111-4111-8111-111111111111',
        { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    assert.equal(removal.status, 200);
    assert.equal(removed, '11111111-1111-4111-8111-111111111111');
});

test('rotas operacionais usam a estacao configurada pelo backend', async t => {
    let entered, exited;
    const service = {
        context: async () => ({ station: { stationId: 'linha-01', name: 'Principal' }, currentShift: null, activeOperators: [] }),
        enter: async body => entered = body,
        exit: async (sessionId, body) => exited = { sessionId, body }
    };
    const server = createApp(undefined, undefined, undefined, undefined, undefined, service).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/api/operator-station/context')).status, 200);
    await fetch(base + '/api/operator-station/entries', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registration: 'MAT-001', requestId: '11111111-1111-4111-8111-111111111111' }) });
    await fetch(base + '/api/operator-station/sessions/22222222-2222-4222-8222-222222222222/exit',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: '33333333-3333-4333-8333-333333333333' }) });
    assert.equal(entered.registration, 'MAT-001');
    assert.equal(exited.sessionId, '22222222-2222-4222-8222-222222222222');
});

test('rotas OEE separam apontamento operacional de configuracao ADMIN', async t => {
    let stopped, classified;
    const availability = {
        current: async () => ({ lineId: 'linha-01', state: 'RUNNING' }),
        listReasons: async () => [{ reasonId: 'r1', name: 'Falha', active: true }],
        listBreaks: async () => [], stop: async body => stopped = body,
        classify: async (eventId, body) => classified = { eventId, ...body },
        configuration: async () => ({ lineId: 'linha-01', idealCycleTimeSeconds: null }),
        updateConfiguration: async body => ({ lineId: 'linha-01', ...body })
    };
    const admin = new AdminAccessService('senha-admin');
    const server = createApp(undefined, undefined, undefined, admin, undefined, undefined, availability).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/api/availability/current')).status, 200);
    assert.equal((await fetch(base + '/api/availability/reasons')).status, 200);
    assert.equal((await fetch(base + '/api/availability/breaks')).status, 401);
    assert.equal((await fetch(base + '/api/availability/configuration')).status, 401);
    const login = await fetch(base + '/api/admin/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'senha-admin' }) });
    const token = (await login.json()).data.token;
    const configuration = await fetch(base + '/api/availability/configuration', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(configuration.status, 200);
    const saveConfiguration = await fetch(base + '/api/availability/configuration', { method: 'PUT', headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ idealCycleTimeSeconds: 12 }) });
    assert.equal(saveConfiguration.status, 200);
    const stop = await fetch(base + '/api/availability/stops', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reasonId: 'r1', requestId: 'req' }) });
    assert.equal(stop.status, 200); assert.equal(stopped.reasonId, 'r1');
    const classify = await fetch(base + '/api/availability/stops/evento-1/classify', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reasonId: 'r1' }) });
    assert.equal(classify.status, 200); assert.deepEqual(classified, { eventId: 'evento-1', reasonId: 'r1' });
});

test('retorna erros para JSON inválido, tipo de conteúdo, tamanho e rota removida', async t => {
    const post = await serve(t, { inProgress: async () => false, insert: async () => assert.fail('Não deve gravar') });
    for (const [body, headers, path, status] of [
        ['{', undefined, undefined, 400],
        [JSON.stringify({ 'serial-number': 'x'.repeat(40000) }), undefined, undefined, 413],
        ['abc', { 'Content-Type': 'text/plain' }, undefined, 415],
        ['{}', undefined, '/api/pcm/entries', 404]
    ]) {
        const response = await post(body, headers, path);
        assert.equal(response.status, status);
        const result = await response.json();
        assert.equal(result.status, 'ERROR');
        assert.ok(result.msg);
    }
});
