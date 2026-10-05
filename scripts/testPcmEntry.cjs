const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { createApp } = require('../dist/api/app');
const { PcmRepository } = require('../dist/modules/pcm/repositories/pcmRepository');
const { readMongoConfig } = require('../dist/database/mongo');

test('service rejeita serial e QR que ainda estão em uso na linha', async t => {
    const queried = [];
    const post = await serve(t, {
        inProgress: async serial => { queried.push(serial); return true; },
        insert: async () => assert.fail('Não deve gravar duplicidade')
    });
    for (const field of ['serial-number', 'qr-code']) {
        const response = await post({ [field]: 'AbC123' });
        assert.equal(response.status, 409);
        assert.deepEqual(await response.json(), { status: 'ERROR', msg: 'Este serial já está em uso na linha.' });
    }
    assert.deepEqual(queried, ['AbC123', 'AbC123']);
});

test('falha na consulta de duplicidade impede gravação', async t => {
    const post = await serve(t, {
        inProgress: async () => { throw new Error('password=secret'); },
        insert: async () => assert.fail('Não deve gravar')
    });
    const response = await post({ 'serial-number': 'abc' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'ERROR', msg: 'Não foi possível confirmar o registro no MongoDB.' });
});

test('repositório consulta uso ativo pelo serial exato', async () => {
    const repository = new PcmRepository({
        findOne: async (filter, options) => {
            assert.deepEqual(options, { projection: { _id: 1 } });
            assert.equal(filter['workflow.status'], 'in_progress');
            return filter.serialNumber === 'AbC123' ? { _id: 1 } : null;
        },
        insertOne: async () => assert.fail('Consulta não deve gravar')
    });
    assert.equal(await repository.inProgress('AbC123'), true);
    assert.equal(await repository.inProgress('abc123'), false);
});

async function serve(t, repository) {
    const server = createApp(repository).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    return body => fetch(`http://127.0.0.1:${server.address().port}/api/serial-numbers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
}

test('só confirma após persistir e preserva o serial exato', async t => {
    let confirm, notify;
    const entered = new Promise(resolve => { notify = resolve; });
    const post = await serve(t, new PcmRepository({ findOne: async () => null, insertOne: async doc => {
        assert.equal(doc.serialNumber, "AbC'123");
        assert.ok(doc.enteredAt instanceof Date);
        notify(); await new Promise(resolve => { confirm = resolve; });
        return { acknowledged: true, insertedId: 1 };
    } }));
    let complete = false;
    const pending = post({ 'serial-number': "AbC'123" }).then(result => { complete = true; return result; });
    await entered; await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(complete, false); confirm();
    const response = await pending;
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { status: 'OK' });
});

test('permite registrar novamente quando o serial não está mais em andamento', async t => {
    let inserts = 0;
    const post = await serve(t, { inProgress: async () => false, insert: async () => { inserts++; } });
    assert.equal((await post({ 'qr-code': 'BANDEJA-01' })).status, 200);
    assert.equal((await post({ 'qr-code': 'BANDEJA-01' })).status, 200);
    assert.equal(inserts, 2);
});

test('serial duplicado retorna 409', async t => {
    const post = await serve(t, new PcmRepository({ findOne: async () => null, insertOne: async () => {
        throw Object.assign(new Error('internal details'), { code: 11000, keyPattern: { serialNumber: 1 } });
    } }));
    const response = await post({ 'serial-number': 'abc' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { status: 'ERROR', msg: 'Este serial já está em uso na linha.' });
});

test('entrada inválida ou QR sem serial válido não grava no banco', async t => {
    const post = await serve(t, { inProgress: async () => false, insert: async () => assert.fail('Não deve gravar') });
    for (const body of [null, [], {}, { 'serial-number': '' }, { 'serial-number': 42 },
        { 'serial-number': 'a b' }, { 'serial-number': 'a'.repeat(513) },
        { 'qr-code': 'a b' }, { 'serial-number': 'abc', 'qr-code': 'abc' }]) {
        const response = await post(body); assert.equal(response.status, 400);
    }
});

test('falha ou ausência de banco retorna 503 sem detalhes internos', async t => {
    for (const repo of [undefined, { inProgress: async () => false, insert: async () => { throw new Error('password=secret'); } }]) {
        const post = await serve(t, repo);
        const response = await post({ 'serial-number': 'abc' });
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { status: 'ERROR', msg: 'Não foi possível confirmar o registro no MongoDB.' });
    }
});

test('configuração exige conexão explícita e porta válida', () => {
    assert.throws(() => readMongoConfig({}));
    const env = { MONGO_HOST: 'localhost', MONGO_DATABASE: 'pcm', MONGO_USER: 'app', MONGO_PASSWORD: '' };
    assert.equal(readMongoConfig(env).port, 27017);
    assert.throws(() => readMongoConfig({ ...env, MONGO_PORT: '-1' }));
});
