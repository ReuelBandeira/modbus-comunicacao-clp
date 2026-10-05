const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EntryService } = require('../dist/modules/pcm/entry/services/entryService');
const { LineCoordinatorService } = require('../dist/modules/pcm/workflow/services/lineCoordinatorService');
const { parseLine } = require('../dist/modules/machines/validators/lineValidation');
const { MachineRuntime } = require('../dist/modules/machines/services/machineRuntime');

const lineInput = { lineId: 'linha-01', name: 'Linha 1', machines: [
    { machineId: 'm1', name: 'Máquina 1', host: '192.168.1.25' },
    { machineId: 'm2', name: 'Máquina 2', host: '192.168.1.35' },
    { machineId: 'm3', name: 'Máquina 3', host: '192.168.1.45' }
] };

async function fixture(bypassEnabled = false, input = lineInput) {
    const documents = new Map();
    let config, sequence = 0;
    const lines = {
        create: async value => { config = structuredClone(value); },
        get: async id => config?.lineId === id ? structuredClone(config) : null,
        update: async (value, expectedRevision) => {
            if (config.revision !== expectedRevision) return false;
            config = structuredClone(value); return true;
        },
        updateMinimumOperators: async (lineId, minimumOperators, expectedRevision, updatedAt) => {
            if (config.lineId !== lineId || config.revision !== expectedRevision) return false;
            config = { ...config, minimumOperators, revision: config.revision + 1, updatedAt }; return true;
        },
        nextSequence: async () => ++sequence
    };
    const values = () => [...documents.values()];
    const find = predicate => structuredClone(values().find(predicate) ?? null);
    const pcms = {
        inProgress: async serial => values().some(p => p.serialNumber === serial && p.workflow?.status === 'in_progress'),
        hasInProgress: async lineId => values().some(p => p.workflow.lineId === lineId && p.workflow.status === 'in_progress'),
        insert: async pcm => { documents.set(`${pcm.workflow.lineId}:${pcm.workflow.entrySequence}`, structuredClone(pcm)); },
        byRequest: async key => find(p => p.workflow.requestKeys?.includes(key)),
        byOperation: async (lineId, machineId, operationId) => find(p => p.workflow.lineId === lineId
            && p.workflow.stages.some(s => s.machineId === machineId && s.operationId === operationId)),
        byStageCycleId: async (lineId, machineId, cycleId) => find(p => p.workflow.lineId === lineId
            && p.workflow.stages.some(s => s.machineId === machineId && s.cycleId === cycleId)),
        bySequence: async (lineId, entrySequence) => find(p => p.workflow.lineId === lineId
            && p.workflow.entrySequence === entrySequence),
        active: async (lineId, machineId) => find(p => p.workflow.lineId === lineId && p.workflow.activeMachineId === machineId),
        activeMany: async (lineId, machineId) => structuredClone(values().filter(p =>
            p.workflow.lineId === lineId && p.workflow.activeMachineId === machineId)
            .sort((a, b) => a.workflow.entrySequence - b.workflow.entrySequence)),
        firstWaiting: async (lineId, machineId) => structuredClone(values().filter(p => p.workflow.lineId === lineId
            && p.workflow.stages.some(s => s.machineId === machineId && s.state === 'waiting'))
            .sort((a, b) => a.workflow.entrySequence - b.workflow.entrySequence)[0] ?? null),
        save: async (lineId, entrySequence, version, workflow) => {
            const key = `${lineId}:${entrySequence}`, current = documents.get(key);
            if (current?.workflow.version !== version) return false;
            const machine = config.machines.find(item => item.machineId === workflow.activeMachineId);
            const capacity = machine?.protocol === 'm1-qr-handshake-v1' ? machine.modbus?.inFlightCapacity ?? 1 : 1;
            if (workflow.activeMachineId && values().filter(p => p.workflow.entrySequence !== entrySequence
                && p.workflow.lineId === workflow.lineId
                && p.workflow.activeMachineId === workflow.activeMachineId).length >= capacity) return false;
            current.workflow = structuredClone({ ...workflow, version: version + 1 });
            return true;
        },
        get: async serial => structuredClone(values().filter(p => p.serialNumber === serial)
            .sort((a, b) => b.workflow.entrySequence - a.workflow.entrySequence)[0] ?? null),
        list: async lineId => values().filter(p => p.workflow.lineId === lineId)
    };
    const service = new LineCoordinatorService(lines, pcms, 'linha-01', bypassEnabled);
    await service.createLine(input);
    const entry = new EntryService(pcms, service);
    return { service, entry, pcms, lines, documents };
}

test('linha: rejeita na entrada QR maior que a capacidade configurada da M1', async () => {
    const productionLine = { lineId: 'linha-01', name: 'Linha 1', machines: [{
        machineId: 'm1', name: 'Máquina 1', host: '192.168.1.25', protocol: 'm1-qr-handshake-v1',
        modbus: {
            enabled: true, pollingMs: 200, reconnectInitialMs: 1000, reconnectMaxMs: 30000,
            acceptInitialRequest: false, completePassageOnResult: true,
            expectedPositionCount: 20, phaseTimeoutMs: 120000,
            byteOrder: 'be', wordOrder: 'high-low', resultOkValue: 1, resultErrorValue: 2,
            map: { serialRegisterCount: 8 }
        }
    }] };
    const { entry, pcms } = await fixture(false, productionLine);
    await assert.rejects(entry.register({ 'qr-code': '12345678901234567' }), /máximo 16 bytes/);
    assert.equal((await pcms.list('linha-01')).length, 0);
});

test('linha: reprovação não impede os testes das máquinas seguintes quando bypass está desabilitado', async () => {
    const { service, entry, pcms, lines } = await fixture();
    await Promise.all(['A', 'B', 'C'].map(serial => entry.register({ 'qr-code': serial })));
    assert.deepEqual((await pcms.list('linha-01')).map(p => p.workflow.entrySequence), [1, 2, 3]);
    const a1 = await service.arrive('linha-01', 'm1', 'c1');
    assert.equal(a1.serialNumber, 'A'); assert.equal(a1.action, 'EXECUTE');
    assert.deepEqual(await service.arrive('linha-01', 'm1', 'c1'), a1);
    await assert.rejects(service.arrive('linha-01', 'm1', 'c2'), { status: 409 });
    await assert.rejects(service.passage('linha-01', 'm1', a1.operationId), { status: 409 });
    await service.result('linha-01', 'm1', a1.operationId, 'OK', { measurement: 12 });
    await assert.rejects(service.arrive('linha-01', 'm2', 'c1'), { status: 409 });
    await service.passage('linha-01', 'm1', a1.operationId);
    const [a2, b1] = await Promise.all([service.arrive('linha-01', 'm2', 'c1'), service.arrive('linha-01', 'm1', 'c2')]);
    assert.equal(a2.serialNumber, 'A'); assert.equal(b1.serialNumber, 'B');
    await service.result('linha-01', 'm2', a2.operationId, 'NAO', { reason: 'Solda' });
    await service.passage('linha-01', 'm2', a2.operationId);
    // Outra instância recupera do repositório; não depende do estado em memória do coordenador.
    const resumed = new LineCoordinatorService(lines, pcms, 'linha-01');
    const a3 = await resumed.arrive('linha-01', 'm3', 'c1');
    assert.equal(a3.action, 'EXECUTE'); assert.equal(a3.blockedByMachine, 'm2');
    await resumed.result('linha-01', 'm3', a3.operationId, 'OK', { positions: [true, true] });
    await resumed.passage('linha-01', 'm3', a3.operationId);
    await resumed.passage('linha-01', 'm3', a3.operationId);
    const a = await pcms.get('A');
    assert.equal(a.workflow.status, 'completed'); assert.equal(a.workflow.quality, 'rejected');
    assert.deepEqual(a.workflow.stages.map(s => s.state), ['completed', 'completed', 'completed']);
    assert.equal(a.workflow.stages[2].result, 'OK');
    assert.equal(a.workflow.activeMachineId, undefined);
    assert.equal((await resumed.arrive('linha-01', 'm1', 'c1')).serialNumber, 'A');
    assert.equal((await resumed.arrive('linha-01', 'm1', 'c2')).serialNumber, 'B');
    await assert.rejects(resumed.result('linha-01', 'm2', a2.operationId, 'OK'), { status: 409 });
});

test('linha: chegadas concorrentes não consomem duas bandejas na mesma máquina', async () => {
    const { service, entry } = await fixture();
    await entry.register({ 'qr-code': 'A' }); await entry.register({ 'qr-code': 'B' });
    const same = await Promise.all(Array.from({ length: 8 }, () => service.arrive('linha-01', 'm1', 'c1')));
    assert.equal(new Set(same.map(item => item.operationId)).size, 1);
    assert.ok(same.every(item => item.serialNumber === 'A'));
    await assert.rejects(service.arrive('linha-01', 'm1', 'c2'), { status: 409 });
});

test('linha: célula paralela reserva três bandejas e preserva a ordem de saída', async () => {
    const cell = { lineId: 'linha-01', name: 'Célula de solda', machines: [{
        machineId: 'm1', name: 'Célula 1', host: '192.168.1.25', protocol: 'm1-qr-handshake-v1',
        modbus: {
            enabled: true, inFlightCapacity: 3, pollingMs: 200, reconnectInitialMs: 1000, reconnectMaxMs: 30000,
            acceptInitialRequest: false, completePassageOnResult: true,
            expectedPositionCount: 20, phaseTimeoutMs: 120000,
            byteOrder: 'be', wordOrder: 'high-low', resultOkValue: 1, resultErrorValue: 2,
            map: { serialRegisterCount: 8 }
        }
    }] };
    const { service, entry } = await fixture(false, cell);
    await Promise.all(['A', 'B', 'C', 'D'].map(serial => entry.register({ 'qr-code': serial })));
    const assignments = await Promise.all([1, 2, 3].map(() => service.arriveNext('linha-01', 'm1')));
    assert.deepEqual(assignments.map(item => item.serialNumber), ['A', 'B', 'C']);
    await assert.rejects(service.arriveNext('linha-01', 'm1'), /3 de 3/);
    await Promise.all(assignments.map(item => service.result('linha-01', 'm1', item.operationId, 'OK')));
    await assert.rejects(service.passage('linha-01', 'm1', assignments[1].operationId), /fora de ordem/);
    await service.passage('linha-01', 'm1', assignments[0].operationId);
    const fourth = await service.arriveNext('linha-01', 'm1');
    assert.equal(fourth.serialNumber, 'D');
});

test('linha: QR_ACK confirma somente a identificação e RESULT_READY libera a próxima máquina', async () => {
    const { service, entry } = await fixture();
    await entry.register({ 'qr-code': 'ACK-001' });
    const assignment = await service.arriveNext('linha-01', 'm1');
    const acknowledged = await service.acknowledgeIdentification('linha-01', 'm1', assignment.entrySequence);
    assert.equal(acknowledged.state, 'processing');
    let tray = await service.tray('ACK-001');
    assert.equal(tray.workflow.activeMachineId, 'm1');
    assert.equal(tray.workflow.stages[0].state, 'processing');
    assert.ok(tray.workflow.stages[0].identificationAcknowledgedAt instanceof Date);
    await service.resultBySequence('linha-01', 'm1', assignment.entrySequence, 'OK', { confirmationSource: 'RESULT_READY' });
    await service.passageBySequence('linha-01', 'm1', assignment.entrySequence);
    tray = await service.tray('ACK-001');
    assert.equal(tray.workflow.activeMachineId, undefined);
    assert.equal(tray.workflow.nextMachineId, 'm2');
    assert.equal(tray.workflow.stages[0].state, 'completed');
    assert.equal(tray.workflow.stages[0].result, 'OK');
    assert.deepEqual(tray.workflow.stages[0].data, { confirmationSource: 'RESULT_READY' });
    assert.ok(tray.workflow.stages[0].passedAt instanceof Date);
});

test('linha: admissão lenta não permite que um bip posterior entre primeiro', async () => {
    const { service, pcms } = await fixture();
    let release, entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const repository = { ...pcms, insert: async pcm => {
        if (pcm.serialNumber === 'A') {
            entered(); await new Promise(resolve => { release = resolve; });
        }
        await pcms.insert(pcm);
    } };
    const entry = new EntryService(repository, service);
    const a = entry.register({ 'qr-code': 'A' });
    await waiting;
    const b = entry.register({ 'qr-code': 'B' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await pcms.get('B'), null);
    await assert.rejects(service.arrive('linha-01', 'm1', 'c1'), { status: 409 });
    release(); await Promise.all([a, b]);
    assert.equal((await service.arrive('linha-01', 'm1', 'c1')).serialNumber, 'A');
});

test('linha: resultado repetido não avança, divergente é rejeitado e conclusão aprova apenas no final', async () => {
    const { service, entry, pcms } = await fixture();
    await entry.register({ 'qr-code': 'A' });
    for (const machine of ['m1', 'm2', 'm3']) {
        const op = await service.arrive('linha-01', machine, 'c1');
        await assert.rejects(service.result('linha-01', machine, 'desconhecida', 'OK'), { status: 404 });
        await service.result('linha-01', machine, op.operationId, 'OK');
        await service.result('linha-01', machine, op.operationId, 'OK');
        await assert.rejects(service.result('linha-01', machine, op.operationId, 'NAO'), { status: 409 });
        assert.equal((await pcms.get('A')).workflow.quality, 'pending');
        await service.passage('linha-01', machine, op.operationId);
    }
    assert.equal((await pcms.get('A')).workflow.quality, 'approved');
    await assert.rejects(service.arrive('linha-01', 'm1', 'c2'), { status: 409 });
});

test('linha: configura IPs, porta 502 e rejeita cadastros inválidos', () => {
    const line = parseLine(lineInput);
    assert.equal(line.machines[0].port, 502);
    assert.equal(line.machines[0].protocol, 'unmapped');
    assert.equal(parseLine({ ...lineInput, mode: 'production' }).mode, 'simulation');
    assert.throws(() => parseLine({ ...lineInput, machines: [lineInput.machines[0], lineInput.machines[0]] }));
    assert.throws(() => parseLine({ ...lineInput, ipRange: { min: 40, max: 75 } }));
    assert.equal(parseLine({ ...lineInput, ipRange: { min: 1, max: 254 } }).machines.length, 3);
});

test('linha: protocolo IFTS exige capacidade única e áreas separadas de QR', () => {
    const handshake = {
        enabled: true, inFlightCapacity: 1, outputAckPulseMs: 600,
        pollingMs: 200, reconnectInitialMs: 1000, reconnectMaxMs: 30000,
        acceptInitialRequest: false, completePassageOnResult: true,
        expectedPositionCount: 20, phaseTimeoutMs: 120000,
        byteOrder: 'le', wordOrder: 'high-low', resultOkValue: 1, resultErrorValue: 2,
        map: { requestQrCoil: 0, resultReadyCoil: 1, resultAckCoil: 2,
            qrEntrySequenceRegister: 0, serialLengthRegister: 2, serialStartRegister: 3,
            serialRegisterCount: 15, outputSerialStartRegister: 21,
            positionCountRegister: 18, positionStartRegister: 19, positionRegisterCount: 4 }
    };
    const input = { ...lineInput, machines: [lineInput.machines[0], {
        ...lineInput.machines[1], protocol: 'ifts-qr-handshake-v1', modbus: handshake
    }, lineInput.machines[2]] };
    assert.equal(parseLine(input).machines[1].protocol, 'ifts-qr-handshake-v1');
    assert.throws(() => parseLine({ ...input, machines: [input.machines[0], {
        ...input.machines[1], modbus: { ...handshake, inFlightCapacity: 2 }
    }, input.machines[2]] }), /capacidade de uma bandeja/);
    assert.throws(() => parseLine({ ...input, machines: [input.machines[0], {
        ...input.machines[1], modbus: { ...handshake, map: { ...handshake.map, outputSerialStartRegister: 14 } }
    }, input.machines[2]] }), /não podem se sobrepor/);
});

test('linha: edita conexão e sequência, verifica revisão e usa a nova ordem na próxima bipagem', async () => {
    const { service, entry } = await fixture();
    const current = await service.getLine('linha-01');
    const updated = await service.updateLine('linha-01', {
        ...current, machines: [...current.machines].reverse().map(m => ({ ...m, port: 1502 }))
    });
    assert.equal(updated.revision, 2);
    assert.deepEqual(updated.createdAt, current.createdAt);
    assert.ok(updated.updatedAt instanceof Date);
    assert.deepEqual(updated.machines.map(m => m.machineId), ['m3', 'm2', 'm1']);
    assert.ok(updated.machines.every(m => m.port === 1502));
    await assert.rejects(service.updateLine('linha-01', current), { status: 409 });
    await assert.rejects(service.updateLine('linha-01', { ...updated, revision: undefined }), { status: 400 });
    await assert.rejects(service.updateLine('linha-01', { ...updated, lineId: 'outra-linha' }), { status: 400 });
    await entry.register({ 'qr-code': 'A' });
    const pcm = await service.tray('A');
    assert.equal(pcm.workflow.lineRevision, 2);
    await assert.rejects(service.arrive('linha-01', 'm1', 'c1'), { status: 409 });
    assert.equal((await service.arrive('linha-01', 'm3', 'c1')).serialNumber, 'A');
    await assert.rejects(service.updateLine('linha-01', updated), { status: 409 });
});

test('linha: atualiza somente a equipe mínima com controle de revisão', async () => {
    const { service } = await fixture();
    const current = await service.getLine('linha-01');
    const updated = await service.updateMinimumOperators('linha-01', { minimumOperators: 4, revision: current.revision });
    assert.equal(updated.minimumOperators, 4);
    assert.equal(updated.revision, current.revision + 1);
    assert.deepEqual(updated.machines, current.machines);
    await assert.rejects(service.updateMinimumOperators('linha-01', { minimumOperators: 3, revision: current.revision }), { status: 409 });
    await assert.rejects(service.updateMinimumOperators('linha-01', { minimumOperators: 0, revision: updated.revision }), { status: 400 });
});

test('linha: edição aguarda a admissão pendente e não altera a rota de uma bandeja em entrada', async () => {
    const { service, pcms } = await fixture();
    let release, notify;
    const started = new Promise(resolve => { notify = resolve; });
    const entry = new EntryService({ ...pcms, insert: async pcm => {
        notify(); await new Promise(resolve => { release = resolve; }); await pcms.insert(pcm);
    } }, service);
    const pending = entry.register({ 'qr-code': 'A' });
    await started;
    const config = await service.getLine('linha-01');
    let completed = false;
    const update = service.updateLine('linha-01', { ...config, machines: [...config.machines].reverse() });
    const check = assert.rejects(update, { status: 409 }).then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    release(); await pending; await check;
    assert.equal((await service.getLine('linha-01')).revision, 1);
    assert.equal((await service.tray('A')).workflow.nextMachineId, 'm1');
});

test('runtime: sem adaptador não acessa CLP; confirmação só ocorre depois da persistência', async () => {
    const { service, entry } = await fixture();
    await entry.register({ 'qr-code': 'A' });
    const machine = (await service.getLine('linha-01')).machines[0];
    const session = { dispose() {} };
    await assert.rejects(new MachineRuntime('linha-01', machine, service, undefined, session).pollOnce(), /Mapa Modbus/);
    let calls = 0;
    const runtime = new MachineRuntime('linha-01', machine, service, {
        poll: async () => ({ type: 'arrival', cycleId: 'c1' }),
        respond: async (_session, _event, assignment) => {
            calls++;
            const pcm = await service.tray('A');
            assert.equal(pcm.workflow.stages[0].operationId, assignment.operationId);
            throw new Error('Resposta perdida');
        }
    }, session);
    await assert.rejects(runtime.pollOnce(), /Resposta perdida/);
    await assert.rejects(runtime.pollOnce(), /Resposta perdida/);
    assert.equal(calls, 2);
    assert.equal((await service.tray('A')).workflow.requestKeys.length, 1);
});

test('linha: bypass pode ser reativado explicitamente', async () => {
    const { service, entry, pcms } = await fixture(true);
    await entry.register({ 'qr-code': 'BYPASS-ON' });
    const m1 = await service.arrive('linha-01', 'm1', 'bypass-1');
    await service.result('linha-01', 'm1', m1.operationId, 'NAO');
    await service.passage('linha-01', 'm1', m1.operationId);
    const m2 = await service.arrive('linha-01', 'm2', 'bypass-2');
    assert.equal(m2.action, 'BYPASS');
    await assert.rejects(service.result('linha-01', 'm2', m2.operationId, 'OK'), { status: 409 });
    await service.passage('linha-01', 'm2', m2.operationId);
    assert.equal((await pcms.get('BYPASS-ON')).workflow.stages[1].state, 'skipped');
});

test('linha: permite reutilizar o serial somente após concluir a passagem anterior', async () => {
    const { service, entry, pcms } = await fixture();
    await entry.register({ 'qr-code': 'BANDEJA-REUTILIZAVEL' });
    await assert.rejects(entry.register({ 'qr-code': 'BANDEJA-REUTILIZAVEL' }), /em uso na linha/);
    for (const machineId of ['m1', 'm2', 'm3']) {
        const operation = await service.arrive('linha-01', machineId, `primeira-${machineId}`);
        await service.result('linha-01', machineId, operation.operationId, 'OK');
        await service.passage('linha-01', machineId, operation.operationId);
    }
    await entry.register({ 'qr-code': 'BANDEJA-REUTILIZAVEL' });
    const passages = (await pcms.list('linha-01')).filter(pcm => pcm.serialNumber === 'BANDEJA-REUTILIZAVEL');
    assert.equal(passages.length, 2);
    assert.deepEqual(passages.map(pcm => pcm.workflow.entrySequence), [1, 2]);
    assert.equal(passages[0].workflow.status, 'completed');
    assert.equal(passages[1].workflow.status, 'in_progress');
    assert.equal((await service.tray('BANDEJA-REUTILIZAVEL')).workflow.entrySequence, 2);
    assert.equal((await service.trayBySequence('linha-01', 1)).workflow.status, 'completed');
});

test('linha: confirmacao do mailbox conclui a step atomicamente e libera a proxima estacao', async () => {
    const { service, entry } = await fixture();
    await entry.register({ 'qr-code': 'MAILBOX-1' });
    const assignment = await service.arriveNext('linha-01', 'm1');
    await service.completeMailboxStage('linha-01', 'm1', assignment.entrySequence, 'OK', {
        confirmationSource: 'plc-cleared-mailbox'
    });
    const tray = await service.tray('MAILBOX-1');
    const stage = tray.workflow.stages[0];
    assert.equal(stage.state, 'completed'); assert.equal(stage.result, 'OK');
    assert.ok(stage.identificationAcknowledgedAt instanceof Date);
    assert.ok(stage.resultAt instanceof Date); assert.ok(stage.passedAt instanceof Date);
    assert.equal(tray.workflow.activeMachineId, undefined);
    assert.equal(tray.workflow.nextMachineId, 'm2');
    await service.completeMailboxStage('linha-01', 'm1', assignment.entrySequence, 'OK', {
        confirmationSource: 'ignored-on-idempotent-recovery'
    });
    assert.equal((await service.tray('MAILBOX-1')).workflow.stages[0].state, 'completed');
});

test('linha: falha de correlação mantém a step pendente e não reprova a bandeja', async () => {
    const { service, entry } = await fixture();
    await entry.register({ 'qr-code': 'QR-ESPERADO' });
    const assignment = await service.arriveNext('linha-01', 'm1');
    await service.recordCorrelationFault('linha-01', 'm1', assignment.entrySequence, {
        communicationState: 'correlation_error', expectedSerial: 'QR-ESPERADO', reportedSerial: 'QR-ERRADO'
    });
    let tray = await service.tray('QR-ESPERADO');
    assert.equal(tray.workflow.status, 'in_progress');
    assert.equal(tray.workflow.quality, 'pending');
    assert.equal(tray.workflow.activeMachineId, 'm1');
    assert.equal(tray.workflow.stages[0].state, 'processing');
    assert.equal(tray.workflow.stages[0].communicationState, 'correlation_error');
    await service.clearCommunicationFault('linha-01', 'm1', assignment.entrySequence);
    tray = await service.tray('QR-ESPERADO');
    assert.equal(tray.workflow.stages[0].communicationState, undefined);
    await service.recordCorrelationFault('linha-01', 'm1', assignment.entrySequence, {
        communicationState: 'correlation_error', expectedSerial: 'QR-ESPERADO', reportedSerial: 'QR-ERRADO'
    });
    await service.completeMailboxStage('linha-01', 'm1', assignment.entrySequence, 'OK', { reportedSerial: 'QR-ESPERADO' });
    tray = await service.tray('QR-ESPERADO');
    assert.equal(tray.workflow.stages[0].communicationState, undefined);
    assert.equal(tray.workflow.nextMachineId, 'm2');
});

test('linha: quarentena encerra passagem da fila, preserva auditoria e permite nova entrada do serial', async () => {
    const { service, entry } = await fixture();
    await entry.register({ 'qr-code': 'QUARENTENA-1' });
    const result = await service.intervene('linha-01', 1, {
        action: 'quarantine', reason: 'Bandeja danificada', notes: 'Separada para inspecao'
    });
    assert.equal(result.workflow.status, 'quarantined');
    assert.equal(result.workflow.intervention.action, 'quarantine');
    assert.equal(result.workflow.intervention.actorRole, 'ADMIN');
    assert.equal(result.workflow.intervention.physicalRemovalConfirmed, false);
    assert.ok(result.workflow.endedAt instanceof Date);
    assert.ok(result.workflow.stages.every(stage => stage.state === 'cancelled'));
    await entry.register({ 'qr-code': 'QUARENTENA-1' });
    assert.equal((await service.tray('QUARENTENA-1')).workflow.entrySequence, 2);
});

test('linha: retirada em estacao exige confirmacao fisica e reinicia os runtimes', async () => {
    const { service, entry } = await fixture();
    await entry.register({ 'qr-code': 'RETIRADA-1' });
    const assignment = await service.arrive('linha-01', 'm1', 'retirada-ciclo');
    await assert.rejects(service.intervene('linha-01', assignment.entrySequence,
        { action: 'remove', reason: 'Travamento na estacao' }), { status: 409 });
    const calls = [];
    service.setRuntimeInterventionControl({ pause: async () => { calls.push('pause'); }, resume: () => { calls.push('resume'); } });
    const result = await service.intervene('linha-01', assignment.entrySequence, {
        action: 'remove', reason: 'Travamento na estacao', physicalRemovalConfirmed: true
    });
    assert.deepEqual(calls, ['pause', 'resume']);
    assert.equal(result.workflow.status, 'removed');
    assert.equal(result.workflow.intervention.activeMachineId, 'm1');
    assert.equal(result.workflow.activeMachineId, undefined);
    assert.equal(result.workflow.nextMachineId, undefined);
    assert.equal(result.workflow.stages[0].state, 'cancelled');
    await assert.rejects(service.result('linha-01', 'm1', assignment.operationId, 'OK'), { status: 409 });
});

test('linha: avanco manual pula a etapa atual e preserva auditoria ADMIN', async () => {
    const { service, entry } = await fixture();
    await entry.register({ 'qr-code': 'AVANCO-MANUAL-1' });
    const calls = [];
    service.setRuntimeInterventionControl({ pause: async () => { calls.push('pause'); }, resume: () => { calls.push('resume'); } });
    await assert.rejects(service.advanceTray('linha-01', 1, {
        reason: 'Teste IFTS', physicalMovementConfirmed: false
    }), { status: 409 });
    const result = await service.advanceTray('linha-01', 1, {
        reason: 'Teste da integração IFTS', notes: 'Avanço controlado para a M2', physicalMovementConfirmed: true
    });
    assert.deepEqual(calls, ['pause', 'resume']);
    assert.equal(result.workflow.stages[0].state, 'skipped');
    assert.equal(result.workflow.nextMachineId, 'm2');
    assert.equal(result.workflow.manualAdvances[0].fromMachineId, 'm1');
    assert.equal(result.workflow.manualAdvances[0].toMachineId, 'm2');
    assert.equal(result.workflow.manualAdvances[0].actorRole, 'ADMIN');
    assert.equal(result.workflow.manualAdvances[0].physicalMovementConfirmed, true);
});

test('linha: localiza a etapa produtiva pelo cycleId externo', async () => {
    const { service, entry } = await fixture();
    await entry.register({ 'qr-code': 'IFTS-CYCLE' });
    const assignment = await service.arrive('linha-01', 'm1', 'ifts-cycle-1');
    assert.deepEqual(await service.assignmentByCycleId('linha-01', 'm1', 'ifts-cycle-1'), assignment);
    assert.equal(await service.assignmentByCycleId('linha-01', 'm1', 'inexistente'), null);
});
