const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { StationTestResetService } = require('../dist/modules/machines/services/stationTestResetService');
const { ZeroMailboxRuntime } = require('../dist/modules/machines/services/zeroMailboxRuntime');
const { communicationLog } = require('../dist/modules/modbus/services/communicationLog');
const { createApp } = require('../dist/api/app');
const { AdminAccessService } = require('../dist/modules/operators/services/adminAccessService');

function machine(machineId = 'm1', protocol = 'm1-qr-handshake-v1') {
    return {
        machineId, name: machineId.toUpperCase(), host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000, protocol,
        modbus: { enabled: true, inFlightCapacity: 3, outputAckPulseMs: 600, pollingMs: 200,
            reconnectInitialMs: 100, reconnectMaxMs: 1000, acceptInitialRequest: false,
            completePassageOnResult: true, expectedPositionCount: 20, phaseTimeoutMs: 120000,
            byteOrder: 'be', wordOrder: 'high-low', resultOkValue: 1, resultErrorValue: 2,
            map: { requestQrCoil: 0, resultReadyCoil: 1, resultAckCoil: 2,
                resultEntrySequenceRegister: 0, resultRegister: 2, errorCodeRegister: 3, cycleTimeRegister: 4,
                qrReadyCoil: 10, qrAckCoil: 11, qrEntrySequenceRegister: 0,
                serialLengthRegister: 2, serialStartRegister: 3, serialRegisterCount: 15,
                outputSerialStartRegister: 21, positionCountRegister: 18, positionStartRegister: 19,
                positionRegisterCount: 4 }
        }
    };
}

function harness({ failCoil = false } = {}) {
    const events = [], coils = new Map([[0, true], [1, true], [2, true]]), registers = new Map();
    const line = { lineId: 'linha-01', revision: 1, machines: [machine()] };
    const preparations = { replaceLineForTest: async (_lineId, tray) => {
        events.push('database'); preparations.tray = tray; return 4;
    } };
    const runtime = { pause: async () => events.push('pause'), resume: initial => events.push(`resume:${initial}`) };
    const signals = { executeByCode: async (code, requestId) => {
        events.push(`command:${code}:${requestId}`); return { status: 'completed' };
    } };
    const session = {
        writeCoil: async (address, value) => { events.push(`write-coil:${address}`); coils.set(address, value); },
        readCoils: async address => [failCoil && address === 1 ? true : coils.get(address)],
        writeRegisters: async (address, values) => { events.push(`write-registers:${address}:${values.length}`); registers.set(address, [...values]); },
        readHoldingRegisters: async (address, count) => registers.get(address) ?? Array(count).fill(9),
        confirmReconciled() {}, dispose() { events.push('dispose'); }
    };
    const service = new StationTestResetService('linha-01', 'principal', 'Principal',
        { get: async () => line }, preparations, runtime, signals, 'BANDEJA-TESTE-01', 'CHIP-TESTE', () => session);
    return { service, events, preparations };
}

test('reset de teste limpa e confere a CLP antes de substituir as bandejas', async () => {
    const { service, events, preparations } = harness();
    const result = await service.execute({ requestId: 'reset-001' });
    assert.equal(result.removedTrays, 4);
    assert.equal(result.tray.serialNumber, 'BANDEJA-TESTE-01');
    assert.equal(preparations.tray.preparation.status, 'ready');
    assert.equal(preparations.tray.preparation.active, true);
    assert.equal(preparations.tray.preparation.chips.length, 20);
    assert.ok(events.indexOf('pause') < events.indexOf('command:REINICIAR_ESTACAO:reset-001'));
    assert.ok(events.indexOf('write-registers:21:15') < events.indexOf('database'));
    assert.equal(events.at(-1), 'resume:true');
});

test('reset de teste preserva o banco quando uma CLP nao confirma a limpeza', async () => {
    const { service, events } = harness({ failCoil: true });
    await assert.rejects(service.execute({ requestId: 'reset-002' }), /M1 permaneceu TRUE/);
    assert.equal(events.includes('database'), false);
    assert.equal(events.at(-1), 'resume:true');
});

test('retomada do reset aceita M0 ja ativo e registra observacao, pedido e escrita conferida', async () => {
    const configured = machine('m-reset');
    let input = Array(15).fill(0), arrivals = 0;
    const session = {
        readCoils: async address => [address === 0],
        readHoldingRegisters: async address => address === 0 ? [...input] : Array(15).fill(0),
        writeRegisters: async (_address, values) => { input = [...values]; },
        writeCoil: async () => {}, confirmReconciled() {}, dispose() {}
    };
    const assignment = { entrySequence: 1, serialNumber: 'BANDEJA-TESTE-01', machineId: 'm-reset',
        cycleId: 'cycle-1', operationId: 'operation-1', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        activeAssignments: async () => [],
        assignmentBySerial: async () => null,
        clearCommunicationFault: async () => assignment,
        arriveNext: async () => { arrivals++; return assignment; },
        acknowledgeIdentification: async () => assignment,
        resultBySequence: async () => assignment,
        passageBySequence: async () => assignment,
        recordCommunicationFault: async () => assignment
    };
    const runtime = new ZeroMailboxRuntime('linha-01', configured, 0, coordinator, session, true);
    await runtime.pollOnce();
    assert.equal(arrivals, 1);
    const events = communicationLog.list().filter(item => item.machineId === 'm-reset').map(item => item.event);
    assert.ok(events.includes('PLC_COIL_OBSERVED'));
    assert.ok(events.includes('REQUEST_QR'));
    assert.ok(events.includes('MAILBOX_WRITTEN'));
});

test('endpoint do reset de teste exige uma sessao ADMIN', async t => {
    const calls = [];
    const args = Array(18).fill(undefined);
    args[3] = new AdminAccessService('senha-admin');
    args[17] = { execute: async body => { calls.push(body); return { removedTrays: 0, tray: {
        entryId: 'id', serialNumber: 'BANDEJA-TESTE-01', chipCount: 20, status: 'ready'
    }, machines: [] }; } };
    const server = createApp(...args).listen(0, '127.0.0.1');
    await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const unauthorized = await fetch(`${base}/api/station-test-reset`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: 'reset-http-1' }) });
    assert.equal(unauthorized.status, 401);
    const login = await fetch(`${base}/api/admin/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'senha-admin' }) });
    const token = (await login.json()).data.token;
    const response = await fetch(`${base}/api/station-test-reset`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ requestId: 'reset-http-2' }) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.tray.status, 'ready');
    assert.deepEqual(calls, [{ requestId: 'reset-http-2' }]);
});
