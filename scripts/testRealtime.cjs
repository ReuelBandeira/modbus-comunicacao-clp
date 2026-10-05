const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createApp } = require('../dist/api/app');

test('canal em tempo real envia o estado inicial da linha via SSE', async t => {
    const dashboard = {
        line: { lineId: 'PCM', name: 'Linha PCM', machines: [], revision: 1 },
        snapshot: { totals: { total: 0, inProgress: 0, completed: 0, rejected: 0 }, active: [], queues: [], waiting: [], recent: [] },
        capturedAt: new Date()
    };
    const coordinator = {
        context: () => ({ entryLineId: 'PCM' }),
        dashboard: async lineId => { assert.equal(lineId, 'PCM'); return dashboard; }
    };
    const server = createApp(undefined, coordinator).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/realtime?lineId=PCM`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const { value } = await response.body.getReader().read();
    const event = new TextDecoder().decode(value);
    controller.abort();
    assert.match(event, /event: line:state/);
    assert.match(event, /"lineId":"PCM"/);
});
