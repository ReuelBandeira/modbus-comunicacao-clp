const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { MongoClient } = require('mongodb');
const { buildMongoUri } = require('../dist/database/mongo');
const { pcmIndexes } = require('../dist/modules/pcm/models/pcmModel');
const { lineIndexes } = require('../dist/modules/machines/models/lineModel');
const { LineRepository } = require('../dist/modules/machines/repositories/lineRepository');
const { PcmRepository } = require('../dist/modules/pcm/repositories/pcmRepository');
const { PcmWorkflowRepository } = require('../dist/modules/pcm/repositories/pcmWorkflowRepository');
const { LineCoordinatorService } = require('../dist/modules/pcm/workflow/services/lineCoordinatorService');
const { createApp } = require('../dist/api/app');

test('Mongo real: API, índices, concorrência, reprovação sem bypass e recuperação em collections isoladas', {
    skip: process.env.PCM_TEST_MONGO !== 'true'
}, async t => {
    const client = new MongoClient(buildMongoUri(), { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db = client.db(process.env.MONGO_DATABASE);
    const prefix = `test_line_${randomUUID().replaceAll('-', '')}`;
    const created = [];
    t.after(async () => {
        try { for (const name of created) await db.collection(name).drop(); }
        finally { await client.close(); }
    });
    async function collection(suffix) {
        const name = `${prefix}_${suffix}`;
        await db.createCollection(name); created.push(name);
        return db.collection(name);
    }
    const pcms = await collection('pcms');
    const lines = await collection('lines');
    const counters = await collection('counters');
    await pcms.createIndexes(pcmIndexes); await lines.createIndexes(lineIndexes);
    // Documentos antigos continuam válidos e não são atribuídos automaticamente à produção.
    await pcms.insertMany([{ serialNumber: 'LEGACY-A', enteredAt: new Date() }, { serialNumber: 'LEGACY-B', enteredAt: new Date() }]);
    const lineRepo = new LineRepository(lines, counters);
    const workflowRepo = new PcmWorkflowRepository(pcms);
    const service = new LineCoordinatorService(lineRepo, workflowRepo, 'linha-01');
    const server = createApp(new PcmRepository(pcms), service).listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const post = async (path, body, status = 200, method = 'POST') => {
        const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const result = await response.json();
        assert.equal(response.status, status, JSON.stringify(result));
        return result.data;
    };
    await post('/serial-numbers', { 'qr-code': 'NOT-ADMITTED' }, 404);
    assert.equal(await pcms.countDocuments({ serialNumber: 'NOT-ADMITTED' }), 0);
    const line = { lineId: 'linha-01', name: 'Linha teste', machines: [
        { machineId: 'm1', name: 'Primeira', host: '192.168.1.25' },
        { machineId: 'm2', name: 'Segunda', host: '192.168.1.35' },
        { machineId: 'm3', name: 'Terceira', host: '192.168.1.45' }
    ] };
    await post('/lines', line); await post('/lines', line, 409);
    await Promise.all(['A', 'B', 'C'].map(serial => post('/serial-numbers', { 'qr-code': serial })));
    const ordered = await pcms.find({ workflow: { $exists: true } }).sort({ 'workflow.entrySequence': 1 }).toArray();
    await post('/lines/linha-01', { ...line, revision: 1, machines: [...line.machines].reverse() }, 409, 'PUT');
    const firstSerial = ordered[0].serialNumber;
    const machine = id => `/lines/linha-01/machines/${id}`;
    const arrivals = await Promise.all(Array.from({ length: 10 }, () => post(machine('m1') + '/arrival', { cycleId: 'c1' })));
    assert.equal(new Set(arrivals.map(a => a.operationId)).size, 1);
    const a1 = arrivals[0]; assert.equal(a1.serialNumber, firstSerial);
    await post(machine('m1') + '/arrival', { cycleId: 'c2' }, 409);
    await post(machine('m2') + '/arrival', { cycleId: 'c1' }, 409);
    // A capacidade paralela permite mais de uma reserva; ciclos continuam globalmente idempotentes.
    const first = await pcms.findOne({ serialNumber: firstSerial });
    await pcms.insertOne({ serialNumber: 'COLLISION', enteredAt: new Date(),
        workflow: { ...first.workflow, entrySequence: 100, requestKeys: ['another-key'] } });
    await pcms.deleteOne({ serialNumber: 'COLLISION' });
    await post(machine('m1') + '/result', { operationId: a1.operationId, result: 'NAO', data: { reason: 'Falha' } });
    await post(machine('m1') + '/passage', { operationId: a1.operationId });
    await assert.rejects(pcms.insertOne({ serialNumber: 'REUSED-CYCLE', enteredAt: new Date(),
        workflow: { ...first.workflow, activeMachineId: 'other-machine', entrySequence: 101 } }), { code: 11000 });
    const resumed = new LineCoordinatorService(lineRepo, new PcmWorkflowRepository(pcms), 'linha-01');
    for (const id of ['m2', 'm3']) {
        const next = await resumed.arrive('linha-01', id, 'c1');
        assert.equal(next.action, 'EXECUTE'); assert.equal(next.serialNumber, firstSerial);
        await resumed.result('linha-01', id, next.operationId, 'OK', { positions: [true, true] });
        await resumed.passage('linha-01', id, next.operationId);
    }
    const completed = await pcms.findOne({ serialNumber: firstSerial });
    assert.equal(completed.workflow.quality, 'rejected');
    assert.equal(completed.workflow.status, 'completed');
    assert.ok(completed.workflow.completedAt instanceof Date);
    assert.equal(completed.workflow.activeMachineId, undefined);
    assert.deepEqual(completed.workflow.stages.map(s => s.state), ['completed', 'completed', 'completed']);
    await post('/serial-numbers', { 'qr-code': firstSerial });
    await post('/serial-numbers', { 'qr-code': firstSerial }, 409);
    assert.equal(await pcms.countDocuments({ serialNumber: firstSerial }), 2);
    const second = await resumed.arrive('linha-01', 'm1', 'c2');
    assert.equal(second.serialNumber, ordered[1].serialNumber);
    assert.equal(second.action, 'EXECUTE');
    const response = await fetch(base + `/trays/${firstSerial}`);
    assert.equal((await response.json()).data.workflow.status, 'in_progress');
    const firstPassage = await fetch(base + `/lines/linha-01/trays/${completed.workflow.entrySequence}`);
    assert.equal((await firstPassage.json()).data.workflow.status, 'completed');
    // Finaliza as demais bandejas antes de editar a configuração física.
    for (let i = 1; i < ordered.length; i++) {
        for (const machineId of ['m1', 'm2', 'm3']) {
            const op = await resumed.arrive('linha-01', machineId, `c${i + 1}`);
            await resumed.result('linha-01', machineId, op.operationId, 'OK');
            await resumed.passage('linha-01', machineId, op.operationId);
        }
    }
    for (const machineId of ['m1', 'm2', 'm3']) {
        const op = await resumed.arrive('linha-01', machineId, `reuse-${machineId}`);
        assert.equal(op.serialNumber, firstSerial);
        await resumed.result('linha-01', machineId, op.operationId, 'OK');
        await resumed.passage('linha-01', machineId, op.operationId);
    }
    const metricQuery = new URLSearchParams({
        from: new Date(Date.now() - 86400000).toISOString(), to: new Date(Date.now() + 86400000).toISOString(),
        timezoneOffsetMinutes: '180'
    });
    const metricsResponse = await fetch(base + `/lines/linha-01/chip-metrics?${metricQuery}`);
    assert.equal(metricsResponse.status, 200);
    const metrics = (await metricsResponse.json()).data;
    assert.equal(metrics.unit, 'chips');
    assert.equal(metrics.period.summary.produced, 2);
    assert.equal(metrics.period.summary.approved, 2);
    assert.equal(metrics.period.summary.rejected, 0);
    assert.equal(metrics.last24Hours.length, 24);
    const edited = await post('/lines/linha-01', {
        ...line, revision: 1, machines: [...line.machines].reverse().map(m => ({ ...m, port: 1502 }))
    }, 200, 'PUT');
    assert.equal(edited.revision, 2);
    assert.deepEqual(edited.machines.map(m => m.machineId), ['m3', 'm2', 'm1']);
    await post('/lines/linha-01', { ...line, revision: 1 }, 409, 'PUT');
    await post('/serial-numbers', { 'qr-code': 'NEW-ROUTE' });
    const newRoute = await pcms.findOne({ serialNumber: 'NEW-ROUTE' });
    assert.equal(newRoute.workflow.lineRevision, 2);
    assert.equal(newRoute.workflow.nextMachineId, 'm3');
    assert.equal((await resumed.arrive('linha-01', 'm3', 'new-route')).serialNumber, 'NEW-ROUTE');
    assert.equal((await pcms.findOne({ serialNumber: firstSerial })).workflow.stages[0].machineId, 'm1');
    // Atualiza também cadastros anteriores à introdução do campo revision.
    await lines.insertOne({ ...line, lineId: 'legacy-config', createdAt: new Date(), mode: 'simulation' });
    const legacy = await resumed.getLine('legacy-config');
    assert.equal(legacy.revision, 1);
    assert.equal((await resumed.updateLine('legacy-config', legacy)).revision, 2);
    // O painel não pode perder uma bandeja ativa só porque ela saiu das últimas 50 entradas.
    await pcms.insertMany(Array.from({ length: 205 }, (_, index) => ({
        serialNumber: `HISTORY-${index}`, enteredAt: new Date(), workflow: {
            lineId: 'linha-01', entrySequence: 1000 + index, version: 0, status: 'completed', quality: 'approved',
            stages: edited.machines.map(machine => ({ machineId: machine.machineId, state: 'completed', result: 'OK' }))
        }
    })));
    const context = await (await fetch(base + '/line-context')).json();
    assert.equal(context.data.entryLineId, 'linha-01');
    const status = await (await fetch(base + '/lines/linha-01/status')).json();
    assert.equal(status.data.snapshot.totals.total, 210);
    assert.equal(status.data.snapshot.totals.inProgress, 1);
    assert.equal(status.data.snapshot.totals.completed, 209);
    assert.equal(status.data.snapshot.totals.rejected, 1);
    assert.equal(status.data.snapshot.recent.length, 50);
    assert.ok(!status.data.snapshot.recent.some(p => p.serialNumber === 'NEW-ROUTE'));
    assert.equal(status.data.snapshot.active[0].serialNumber, 'NEW-ROUTE');
});
