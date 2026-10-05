const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { TcpService } = require('../dist/modules/tcp/services/tcpService');
const { TcpSession } = require('../dist/modules/tcp/sessions/tcpSession');

test('preserva a sessão entre telas e limpa somente o histórico', () => {
    const session = new TcpSession();
    session.state.options = { host: '127.0.0.1', port: 5000 };
    session.record({ kind: 'status', message: 'Conectado', connected: true, time: new Date().toISOString() });
    for (let i = 0; i < 205; i++) {
        session.record({ kind: 'data', message: 'ok', hex: '6f6b', bytes: 2, connected: true, time: new Date().toISOString() });
    }
    // Uma tela nova recebe uma cópia da sessão pelo IPC.
    const snapshot = structuredClone(session.state);
    assert.equal(snapshot.events.length, 200);
    assert.equal(snapshot.bytes, 410);
    assert.equal(snapshot.busy, true);
    assert.equal(snapshot.status, 'Conectado');
    assert.equal(snapshot.options.port, 5000);
    const cleared = session.clear();
    assert.equal(cleared.events.length, 0);
    assert.equal(cleared.bytes, 0);
    assert.equal(cleared.busy, true);
    assert.ok(cleared.sequence > snapshot.sequence);
    session.record({ kind: 'data', message: 'ok', bytes: 2, connected: true, time: new Date().toISOString() });
    assert.equal(session.state.bytes, 2);
    assert.equal(session.state.events.length, 1);
});

test('recebe bytes sem perder dados e preserva UTF-8 dividido entre blocos', { timeout: 5000 }, async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const events = [];
    let notify;
    const service = new TcpService((event) => { events.push(event); notify?.(); });
    const waitFor = (predicate) => new Promise((resolve) => {
        notify = () => { if (predicate()) resolve(); };
        notify();
    });
    let peer;
    try {
        const accepted = once(server, 'connection');
        service.connect({ host: '127.0.0.1', port: server.address().port });
        [peer] = await accepted;
        peer.write(Buffer.from([0xc3]));
        await waitFor(() => events.some((event) => event.kind === 'data'));
        peer.write(Buffer.from([0xa7, 0x00, 0xff]));
        await waitFor(() => events.filter((event) => event.kind === 'data').reduce((sum, event) => sum + event.bytes, 0) === 4);
        const data = events.filter((event) => event.kind === 'data');
        assert.equal(data.map((event) => event.hex).join(''), 'c3a700ff');
        assert.equal(data.map((event) => event.message).join(''), 'ç\u0000\ufffd');
        peer.end();
        await waitFor(() => events.some((event) => event.message === 'Conexão encerrada.'));
        assert.equal(events.at(-1).connected, false);
    } finally {
        service.disconnect();
        peer?.destroy();
        await new Promise((resolve) => server.close(resolve));
    }
});

test('rejeita porta inválida antes de abrir uma conexão', () => {
    const service = new TcpService(() => {});
    assert.throws(() => service.connect({ host: '127.0.0.1', port: 0 }));
    assert.throws(() => service.connect({ host: '', port: 5000 }));
});

test('informa erro quando a conexão é recusada', { timeout: 5000 }, async () => {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const events = [];
    let finish;
    const closed = new Promise((resolve) => { finish = resolve; });
    const service = new TcpService((event) => {
        events.push(event);
        if (event.message === 'Conexão encerrada.') finish();
    });
    try {
        service.connect({ host: '127.0.0.1', port });
        await closed;
        assert.ok(events.some((event) => event.message.includes('ECONNREFUSED')));
        assert.equal(events.at(-1).connected, false);
    } finally {
        service.disconnect();
    }
});
