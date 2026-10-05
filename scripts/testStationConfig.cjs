const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { StationConfigStore } = require('../dist/main/stationConfig');

test('configuração local valida senha, perfil e URL sem persistir a senha', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pcm-station-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new StationConfigStore(directory, '123');
    assert.equal(await store.read(), null);
    await assert.rejects(store.save({ role: 'end-of-line', serverUrl: 'http://10.0.0.5:3000', password: 'errada' },
        'http://127.0.0.1:3000'), /Senha/);
    const saved = await store.save({ role: 'end-of-line', serverUrl: 'http://10.0.0.5:3000/', password: '123' },
        'http://127.0.0.1:3000');
    assert.deepEqual(saved, { version: 1, role: 'end-of-line', serverUrl: 'http://10.0.0.5:3000' });
    assert.deepEqual(await store.read(), saved);
    assert.doesNotMatch(await readFile(path.join(directory, 'station.json'), 'utf8'), /123/);
});

test('perfis antigos de inspeção exigem uma nova configuração', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pcm-station-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await require('node:fs/promises').writeFile(path.join(directory, 'station.json'), JSON.stringify({
        version: 1, role: 'inspection-1', serverUrl: 'http://10.0.0.5:3000'
    }));
    assert.equal(await new StationConfigStore(directory).read(), null);
});

test('perfil Principal ignora URL remota e usa a API local', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pcm-station-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new StationConfigStore(directory);
    assert.deepEqual(await store.save({ role: 'main', serverUrl: 'http://externo:9999', password: '123' },
        'http://127.0.0.1:3000'), { version: 1, role: 'main', serverUrl: 'http://127.0.0.1:3000' });
});
