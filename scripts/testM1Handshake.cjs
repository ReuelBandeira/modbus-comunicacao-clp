const assert = require('node:assert/strict');
const { test } = require('node:test');
const { RisingEdgeDetector } = require('../dist/modules/modbus/services/risingEdgeDetector');
const { encodeTextRegisters, decodeTextRegisters, encodeUint32, decodeUint32 } = require('../dist/modules/modbus/services/registerCodec');
const { MachineModbusMemory } = require('../dist/modules/modbus/server/machineModbusMemory');
const { M1HandshakeRuntime } = require('../dist/modules/machines/services/m1HandshakeRuntime');
const { ResultHandshakeRuntime } = require('../dist/modules/machines/services/resultHandshakeRuntime');
const { ZeroMailboxRuntime } = require('../dist/modules/machines/services/zeroMailboxRuntime');
const { MachineModbusServer } = require('../dist/modules/modbus/server/machineModbusServer');
const { parseLine } = require('../dist/modules/machines/validators/lineValidation');
const ModbusRTU = require('modbus-serial');
const net = require('node:net');
const { once } = require('node:events');

function configuration() {
    return {
        enabled: true, inFlightCapacity: 1, outputAckMode: 'pulse', outputAckPulseMs: 600,
        pollingMs: 200, reconnectInitialMs: 1000, reconnectMaxMs: 30000,
        acceptInitialRequest: false, completePassageOnResult: true, byteOrder: 'be', wordOrder: 'high-low',
        expectedPositionCount: 20, phaseTimeoutMs: 120000,
        resultOkValue: 1, resultErrorValue: 2,
        map: {
            requestQrCoil: 0, resultReadyCoil: 1, resultAckCoil: 2,
            resultEntrySequenceRegister: 0, resultRegister: 2, errorCodeRegister: 3, cycleTimeRegister: 4,
            qrReadyCoil: 10, qrAckCoil: 11, qrEntrySequenceRegister: 10,
            serialLengthRegister: 12, serialStartRegister: 13, serialRegisterCount: 8, outputSerialStartRegister: 30,
            positionCountRegister: 21, positionStartRegister: 22, positionRegisterCount: 4
        }
    };
}

test('handshake: rising edge e codecs são determinísticos', () => {
    const edge = new RisingEdgeDetector();
    assert.deepEqual([false, false, true, true, false, true].map(value => edge.update(value)),
        [false, false, true, false, false, true]);
    const encoded = encodeTextRegisters('ABC', 2, 'be');
    assert.deepEqual(encoded, [0x4142, 0x4300]);
    assert.equal(decodeTextRegisters(encoded, 'be'), 'ABC');
    assert.equal(decodeTextRegisters([0x4142, 0x0000, 0x4344], 'be'), 'AB');
    assert.equal(decodeTextRegisters([0x4241, 0x0000, 0x4443], 'le'), 'AB');
    assert.deepEqual(encodeUint32(0x12345678, 'high-low'), [0x1234, 0x5678]);
    assert.equal(decodeUint32([0x5678, 0x1234], 'low-high'), 0x12345678);
});

test('handshake: configuração completa da M1 é validada e ativa modo de produção', () => {
    const modbus = configuration();
    const line = parseLine({ lineId: 'linha-01', name: 'Linha 1', ipRange: { min: 1, max: 254 }, machines: [{
        machineId: 'm1', name: 'Máquina 1', host: '127.0.0.1', port: 1502, unitId: 1,
        protocol: 'm1-qr-handshake-v1', modbus
    }] });
    assert.equal(line.mode, 'production'); assert.deepEqual(line.machines[0].modbus, modbus);
    assert.throws(() => parseLine({ ...line, machines: [{ ...line.machines[0], modbus: {
        ...modbus, outputAckPulseMs: 500
    } }] }), /600/);
    assert.throws(() => parseLine({ ...line, machines: [{ ...line.machines[0], modbus: {
        ...modbus, map: { ...modbus.map, serialLengthRegister: 20 }
    } }] }), /Mailbox|mailbox/);
});

test('handshake: as estações usam somente o endpoint Modbus de cada CLP', () => {
    const machine = (machineId, name, host, protocol) => ({
        machineId, name, host, port: 502, unitId: 1, protocol,
        modbus: configuration()
    });
    const input = { lineId: 'linha-01', name: 'Linha 1', ipRange: { min: 1, max: 254 }, machines: [
        machine('m1', 'Máquina 1', '192.168.1.25', 'm1-qr-handshake-v1'),
        machine('m2', 'Máquina 2', '192.168.1.35', 'result-handshake-v1'),
        machine('m3', 'Máquina 3', '192.168.1.45', 'result-handshake-v1')
    ] };
    const line = parseLine(input);
    assert.deepEqual(line.machines.map(item => [item.host, item.port]), [
        ['192.168.1.25', 502], ['192.168.1.35', 502], ['192.168.1.45', 502]
    ]);
    assert.equal(Object.hasOwn(line.machines[0].modbus, 'serverHost'), false);
    assert.equal(Object.hasOwn(line.machines[0].modbus, 'serverPort'), false);
    assert.equal(Object.hasOwn(line.machines[0].modbus, 'serverUnitId'), false);
});

test('handshake: servidor do Node expõe QR e recebe QR_ACK da M1', async t => {
    const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const modbus = configuration();
    const memory = new MachineModbusMemory(modbus); memory.prepare(21, 'SERIAL-21');
    const server = new MachineModbusServer({ host: '127.0.0.1', port, unitId: 1 }, memory); await server.start();
    const client = new ModbusRTU();
    t.after(async () => { client.destroy(() => {}); await server.stop(); });
    client.setID(1); client.setTimeout(1000); await client.connectTCP('127.0.0.1', { port, timeout: 1000 });
    assert.equal((await client.readCoils(10, 1)).data[0], true);
    assert.equal(decodeUint32((await client.readHoldingRegisters(10, 2)).data, 'high-low'), 21);
    await client.writeCoil(11, true); assert.equal(memory.acknowledged, true);
});

test('handshake M1: pede a próxima sequência, confirma QR e só envia ACK após resultado persistido', async () => {
    const modbus = configuration();
    const machine = { machineId: 'm1', name: 'Máquina 1', host: '192.168.1.25', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'm1-qr-handshake-v1', modbus };
    const coils = new Map([[0, false], [1, false], [2, false]]);
    const registers = new Map();
    const writes = [];
    const session = {
        readCoils: async address => [coils.get(address) ?? false],
        readHoldingRegisters: async (address, count) => Array.from({ length: count }, (_, index) => registers.get(address + index) ?? 0),
        writeCoil: async (address, value) => { writes.push([address, value]); coils.set(address, value); },
        confirmReconciled() {}, dispose() {}
    };
    const memory = new MachineModbusMemory(modbus);
    const assignment = { serialNumber: '7897254101668', entrySequence: 21, machineId: 'm1', cycleId: 'entry-21',
        operationId: 'op-21', action: 'EXECUTE', state: 'processing' };
    let active = null, qrAcks = 0, results = 0, passages = 0;
    const coordinator = {
        activeAssignment: async () => active,
        arriveNext: async () => (active = { ...assignment }),
        acknowledgeIdentification: async () => {
            qrAcks++; active = { ...active, identificationAcknowledgedAt: new Date() }; return active;
        },
        resultBySequence: async (_line, _machine, sequence, result, data) => {
            assert.equal(sequence, 21); assert.equal(result, 'OK');
            assert.deepEqual(data, { errorCode: 0, cycleTimeMs: 4500, modbusResult: 1 }); results++; return active;
        },
        passageBySequence: async () => { passages++; active = null; return assignment; }
    };
    const server = { start: async () => {}, stop: async () => {} };
    const runtime = new M1HandshakeRuntime('linha-01', machine, coordinator, { session, memory, server });

    await runtime.pollOnce(); // primeira leitura falsa inicializa a borda.
    coils.set(0, true); await runtime.pollOnce();
    assert.equal(memory.ready, true);
    assert.equal(decodeUint32(memory.getHoldingRegisters(10, 2), 'high-low'), 21);
    assert.equal(memory.getHoldingRegister(12), 13);
    assert.equal(decodeTextRegisters(memory.getHoldingRegisters(13, 8), 'be'), '7897254101668');

    memory.setCoil(11, true); await runtime.pollOnce();
    assert.equal(qrAcks, 1); assert.equal(results, 0); assert.equal(passages, 0); assert.equal(memory.ready, false);
    memory.setCoil(11, false); coils.set(0, false); await runtime.pollOnce();

    encodeUint32(21, 'high-low').forEach((value, index) => registers.set(index, value));
    registers.set(2, 1); registers.set(3, 0);
    encodeUint32(4500, 'high-low').forEach((value, index) => registers.set(4 + index, value));
    coils.set(1, true); await runtime.pollOnce();
    assert.equal(results, 1); assert.equal(passages, 1);
    assert.deepEqual(writes.at(-1), [2, true]);
    assert.equal(memory.acknowledged, false);
    assert.equal(memory.getHoldingRegister(12), 0);

    coils.set(1, false); await runtime.pollOnce();
    assert.deepEqual(writes.at(-1), [2, false]);
});

test('handshake das máquinas posteriores também publica o QR completo na memória exclusiva', async () => {
    const modbus = configuration();
    const machine = { machineId: 'm2', name: 'Máquina 2', host: '192.168.1.26', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'result-handshake-v1', modbus };
    const coils = new Map([[0, false], [1, false], [2, false]]);
    const session = {
        readCoils: async address => [coils.get(address) ?? false],
        readHoldingRegisters: async (_address, count) => Array(count).fill(0),
        writeCoil: async (address, value) => coils.set(address, value),
        confirmReconciled() {}, dispose() {}
    };
    const memory = new MachineModbusMemory(modbus);
    const assignment = { serialNumber: 'QR-M2-0001', entrySequence: 31, machineId: 'm2', cycleId: 'entry-31',
        operationId: 'op-31', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        activeAssignment: async () => null,
        arriveNext: async () => assignment,
        acknowledgeIdentification: async () => ({ ...assignment, identificationAcknowledgedAt: new Date() }),
        resultBySequence: async () => assignment,
        passageBySequence: async () => assignment
    };
    const runtime = new M1HandshakeRuntime('linha-01', machine, coordinator,
        { session, memory, server: { start: async () => {}, stop: async () => {} } });
    await runtime.pollOnce();
    coils.set(0, true); await runtime.pollOnce();
    assert.equal(memory.ready, true);
    assert.equal(decodeUint32(memory.getHoldingRegisters(10, 2), 'high-low'), 31);
    assert.equal(decodeTextRegisters(memory.getHoldingRegisters(13, 8), 'be'), 'QR-M2-0001');
});

test('handshake de resultado: máquinas posteriores persistem OK/NÃO sem alterar a M1', async () => {
    const modbus = configuration();
    const machine = { machineId: 'm2', name: 'Máquina 2', host: '192.168.1.26', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'result-handshake-v1', modbus };
    const coils = new Map([[1, true], [2, false]]), registers = new Map(), writes = [];
    encodeUint32(22, 'high-low').forEach((value, index) => registers.set(index, value));
    registers.set(2, 2); registers.set(3, 7);
    encodeUint32(3100, 'high-low').forEach((value, index) => registers.set(4 + index, value));
    const session = {
        readCoils: async address => [coils.get(address) ?? false],
        readHoldingRegisters: async (address, count) => Array.from({ length: count }, (_, index) => registers.get(address + index) ?? 0),
        writeCoil: async (address, value) => { writes.push([address, value]); coils.set(address, value); },
        confirmReconciled() {}, dispose() {}
    };
    let results = 0, passages = 0;
    const assignment = { serialNumber: 'SERIAL-22', entrySequence: 22, machineId: 'm2', cycleId: 'entry-22',
        operationId: 'op-22', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        arrive: async (_line, _machine, cycle) => { assert.equal(cycle, 'entry-22'); return assignment; },
        resultBySequence: async (_line, _machine, sequence, result, data) => {
            assert.equal(sequence, 22); assert.equal(result, 'NAO');
            assert.deepEqual(data, { errorCode: 7, cycleTimeMs: 3100, modbusResult: 2 }); results++; return assignment;
        },
        passageBySequence: async () => { passages++; return assignment; }
    };
    const runtime = new ResultHandshakeRuntime('linha-01', machine, coordinator, session);
    await runtime.pollOnce();
    assert.equal(results, 1); assert.equal(passages, 1); assert.deepEqual(writes.at(-1), [2, true]);
    await runtime.pollOnce(); assert.equal(results, 1);
    coils.set(1, false); await runtime.pollOnce(); assert.deepEqual(writes.at(-1), [2, false]);
});

test('mailbox-zero M1: conclui pela Coil de saída sem assumir a limpeza da CLP', async () => {
    const modbus = configuration();
    const machine = { machineId: 'm1', name: 'Maquina 1', host: '192.168.1.25', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'm1-qr-handshake-v1', modbus };
    let request = false, exit = false; let registers = Array(16).fill(0); let results = 0, passages = 0, writes = 0;
    const session = {
        readCoils: async address => [address === modbus.map.requestQrCoil ? request : exit],
        readHoldingRegisters: async () => [...registers],
        writeRegisters: async (_address, values) => { writes++; registers = [...values]; },
        confirmReconciled() {}, dispose() {}
    };
    const assignment = { serialNumber: 'QR-0001', entrySequence: 41, machineId: 'm1', cycleId: 'entry-41',
        operationId: 'op-41', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        activeAssignment: async () => null, arriveNext: async () => assignment,
        mailboxAssignment: async () => assignment,
        acknowledgeIdentification: async () => ({ ...assignment, identificationAcknowledgedAt: new Date() }),
        resultBySequence: async (_line, _machine, sequence, result, data) => {
            assert.equal(sequence, 41); assert.equal(result, 'OK');
            assert.equal(data.confirmationSource, 'exit-coil-rising-edge');
            assert.equal(data.exitCoil, 1); results++; return { ...assignment, state: 'result_recorded' };
        },
        passageBySequence: async () => { passages++; return { ...assignment, state: 'completed' }; },
        recordCommunicationFault: async () => { throw new Error('não esperado'); }
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 0, coordinator, session);
    await runtime.pollOnce(); request = true; await runtime.pollOnce();
    assert.equal(registers.length, 8);
    assert.equal(decodeTextRegisters(registers, 'be'), 'QR-0001');
    await runtime.pollOnce(); // observa Coil 1 FALSE depois da escrita e arma a borda segura.
    exit = true; await runtime.pollOnce(); assert.equal(results, 1); assert.equal(passages, 0);
    assert.equal(writes, 1); assert.ok(registers.some(value => value !== 0));
    registers.fill(0); await runtime.pollOnce();
    assert.equal(passages, 1);
    assert.equal(writes, 1);
    assert.ok(registers.every(value => value === 0));
});

test('mailbox-zero M1: célula paralela permite que a CLP limpe o ACK e bloqueia nova saída enquanto M2 está ativo', async () => {
    const modbus = configuration(); modbus.inFlightCapacity = 3; modbus.outputAckMode = 'plc-reset';
    const machine = { machineId: 'm1', name: 'Célula de solda', host: '192.168.1.25', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'm1-qr-handshake-v1', modbus };
    let request = false, outputReady = false, outputAck = false;
    let inputRegisters = Array(8).fill(0), outputRegisters = Array(8).fill(0), next = 0;
    const completed = [], active = [], coilWrites = [], faults = [];
    let clearedFaults = 0;
    const source = ['QR-A', 'QR-B'].map((serialNumber, index) => ({
        serialNumber, entrySequence: index + 1, machineId: 'm1', cycleId: `entry-${index + 1}`,
        operationId: `op-${index + 1}`, action: 'EXECUTE', state: 'processing'
    }));
    const session = {
        readCoils: async address => [address === modbus.map.requestQrCoil ? request
            : address === modbus.map.resultAckCoil ? outputAck : outputReady],
        readHoldingRegisters: async address => [...(address === modbus.map.outputSerialStartRegister ? outputRegisters : inputRegisters)],
        writeRegisters: async (address, values) => { if (address === modbus.map.qrEntrySequenceRegister) inputRegisters = [...values]; },
        writeCoil: async (address, value) => { coilWrites.push([address, value]); outputAck = value; },
        confirmReconciled() {}, dispose() {}
    };
    const coordinator = {
        activeAssignment: async () => active[0] ?? null,
        activeAssignments: async () => active.map(item => ({ ...item })),
        assignmentBySerial: async (_line, _machine, serial) => {
            const item = active.find(value => value.serialNumber === serial); return item ? { ...item } : null;
        },
        arriveNext: async () => { const item = { ...source[next++] }; active.push(item); return item; },
        acknowledgeIdentification: async (_line, _machine, sequence) => {
            const item = active.find(value => value.entrySequence === sequence);
            item.identificationAcknowledgedAt = new Date(); return { ...item };
        },
        resultBySequence: async (_line, _machine, sequence) => {
            const item = active.find(value => value.entrySequence === sequence); item.state = 'result_recorded'; return { ...item };
        },
        passageBySequence: async (_line, _machine, sequence) => {
            const index = active.findIndex(value => value.entrySequence === sequence);
            completed.push(active[index].serialNumber); return active.splice(index, 1)[0];
        },
        recordCommunicationFault: async (_line, _machine, sequence, data) => {
            const item = active.find(value => value.entrySequence === sequence);
            item.communicationState = data.communicationState; faults.push({ sequence, data }); return { ...item };
        },
        clearCommunicationFault: async (_line, _machine, sequence) => {
            const item = active.find(value => value.entrySequence === sequence);
            delete item.communicationState; clearedFaults++; return { ...item };
        }
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 0, coordinator, session);
    await runtime.pollOnce();
    request = true; await runtime.pollOnce(); assert.equal(decodeTextRegisters(inputRegisters, 'be'), 'QR-A');
    request = false; await runtime.pollOnce(); assert.equal(decodeTextRegisters(inputRegisters, 'be'), 'QR-A');
    assert.ok(active[0].identificationAcknowledgedAt);
    request = true; await runtime.pollOnce(); assert.equal(decodeTextRegisters(inputRegisters, 'be'), 'QR-B');
    request = false; await runtime.pollOnce(); assert.equal(decodeTextRegisters(inputRegisters, 'be'), 'QR-B');
    assert.equal(active.length, 2);
    outputRegisters = [0, ...encodeTextRegisters('RESIDUO', 8, 'be').slice(1)]; outputReady = true;
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(completed.length, 0); assert.equal(coilWrites.length, 0); assert.equal(faults.length, 0);
    outputRegisters = encodeTextRegisters('QR-ERRADO', 8, 'be'); outputReady = true;
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(completed.length, 0); assert.equal(coilWrites.length, 0);
    assert.equal(faults.length, 1); assert.equal(faults[0].sequence, 1);
    assert.equal(faults[0].data.expectedSerial, 'QR-A'); assert.equal(faults[0].data.reportedSerial, 'QR-ERRADO');
    outputReady = false; await runtime.pollOnce(); assert.equal(clearedFaults, 1);
    outputRegisters = encodeTextRegisters('QR-A', 8, 'be'); outputReady = true;
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.deepEqual(completed, ['QR-A']); assert.equal(active[0].serialNumber, 'QR-B');
    assert.deepEqual(coilWrites, [[modbus.map.resultAckCoil, true]]);
    await runtime.pollOnce();
    assert.deepEqual(completed, ['QR-A']);
    assert.deepEqual(coilWrites, [[modbus.map.resultAckCoil, true]]);
    outputReady = false; outputRegisters.fill(0); await runtime.pollOnce();
    outputRegisters = encodeTextRegisters('QR-B', 8, 'be'); outputReady = true;
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.deepEqual(completed, ['QR-A']);
    assert.deepEqual(coilWrites, [[modbus.map.resultAckCoil, true]]);
    outputAck = false; await runtime.pollOnce();
    assert.deepEqual(completed, ['QR-A', 'QR-B']);
    assert.deepEqual(coilWrites, [[modbus.map.resultAckCoil, true], [modbus.map.resultAckCoil, true]]);
});

test('mailbox-zero M1: confirma a entrada por M0 mesmo quando a CLP consome o QR imediatamente', async () => {
    const modbus = configuration(); modbus.inFlightCapacity = 3;
    const machine = { machineId: 'm1', name: 'Célula de solda', host: '192.168.1.25', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'm1-qr-handshake-v1', modbus };
    const assignment = { serialNumber: 'QR-CONSUMIDO', entrySequence: 80, machineId: 'm1', cycleId: 'entry-80',
        operationId: 'op-80', action: 'EXECUTE', state: 'processing' };
    let request = false, inputRegisters = Array(8).fill(0), acknowledgements = 0, writes = 0;
    const session = {
        readCoils: async address => [address === modbus.map.requestQrCoil ? request : false],
        readHoldingRegisters: async address => address === modbus.map.outputSerialStartRegister
            ? Array(8).fill(0) : [...inputRegisters],
        writeRegisters: async (_address, values) => {
            writes++; inputRegisters = [...values]; inputRegisters[0] = 0;
        },
        writeCoil: async () => {}, confirmReconciled() {}, dispose() {}
    };
    const coordinator = {
        activeAssignments: async () => acknowledgements ? [{ ...assignment, identificationAcknowledgedAt: new Date() }] : [],
        arriveNext: async () => ({ ...assignment }),
        acknowledgeIdentification: async () => { acknowledgements++; return { ...assignment, identificationAcknowledgedAt: new Date() }; },
        clearCommunicationFault: async () => ({ ...assignment })
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 0, coordinator, session);
    await runtime.pollOnce();
    request = true; await runtime.pollOnce();
    assert.equal(writes, 1); assert.equal(acknowledgements, 0);
    request = false; await runtime.pollOnce();
    assert.equal(acknowledgements, 1);
});

test('mailbox-zero M2 IFTS: identifica antes do START e só libera a saída depois do resultado', async () => {
    const modbus = configuration(); modbus.inFlightCapacity = 1; modbus.outputAckPulseMs = 600;
    const machine = { machineId: 'm2', name: 'Teste de memória', host: '192.168.1.35', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'ifts-qr-handshake-v1', modbus };
    let request = false, outputReady = false, inputRegisters = Array(8).fill(0), outputRegisters = Array(8).fill(0);
    let active, passages = 0; const coilWrites = [];
    const assignment = { serialNumber: 'QR-IFTS-01', entrySequence: 81, machineId: 'm2', cycleId: 'entry-81',
        operationId: 'op-81', action: 'EXECUTE', state: 'processing' };
    const session = {
        readCoils: async address => [address === modbus.map.requestQrCoil ? request : outputReady],
        readHoldingRegisters: async address => [...(address === modbus.map.outputSerialStartRegister ? outputRegisters : inputRegisters)],
        writeRegisters: async (address, values) => { if (address === modbus.map.qrEntrySequenceRegister) inputRegisters = [...values]; },
        writeCoil: async (address, value) => { coilWrites.push([address, value]); },
        confirmReconciled() {}, dispose() {}
    };
    const coordinator = {
        activeAssignment: async () => active ? { ...active } : null,
        activeAssignments: async () => active ? [{ ...active }] : [],
        assignmentBySerial: async (_line, _machine, serial) => active?.serialNumber === serial ? { ...active } : null,
        arriveNext: async () => { active = { ...assignment }; return { ...active }; },
        acknowledgeIdentification: async () => {
            active.identificationAcknowledgedAt = new Date(); return { ...active };
        },
        resultBySequence: async () => { throw new Error('O QR de saída não pode criar o resultado IFTS.'); },
        passageBySequence: async () => { passages++; active.state = 'completed'; return { ...active }; },
        recordCommunicationFault: async () => { throw new Error('não esperado'); },
        clearCommunicationFault: async () => ({ ...active })
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 1, coordinator, session);
    await runtime.pollOnce(); request = true; await runtime.pollOnce();
    assert.equal(decodeTextRegisters(inputRegisters, 'be'), 'QR-IFTS-01');
    request = false; await runtime.pollOnce(); assert.ok(active.identificationAcknowledgedAt);
    assert.equal(decodeTextRegisters(inputRegisters, 'be'), 'QR-IFTS-01');
    outputRegisters = encodeTextRegisters('QR-IFTS-01', 8, 'be'); outputReady = true;
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(passages, 0); assert.deepEqual(coilWrites, []);
    active.state = 'result_recorded'; await runtime.pollOnce();
    assert.equal(passages, 1);
    assert.deepEqual(coilWrites, [[modbus.map.resultAckCoil, true], [modbus.map.resultAckCoil, false]]);
});

test('mailbox-zero: recuperação da entrada confirma somente por M0 inativo', async () => {
    const modbus = configuration(); modbus.inFlightCapacity = 1;
    const machine = { machineId: 'm2', name: 'Teste de memória', host: '192.168.1.35', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'ifts-qr-handshake-v1', modbus };
    const assignment = { serialNumber: 'QR-RECOVERY', entrySequence: 82, machineId: 'm2', cycleId: 'entry-82',
        operationId: 'op-82', action: 'EXECUTE', state: 'processing' };
    const staleInput = encodeTextRegisters('CONTEUDO-ANTIGO', 8, 'be');
    let acknowledgements = 0, writes = 0;
    const session = {
        readCoils: async () => [false],
        readHoldingRegisters: async address => address === modbus.map.outputSerialStartRegister
            ? Array(8).fill(0) : [...staleInput],
        writeRegisters: async () => { writes++; }, writeCoil: async () => {},
        confirmReconciled() {}, dispose() {}
    };
    const coordinator = {
        activeAssignments: async () => [assignment],
        clearCommunicationFault: async () => assignment,
        acknowledgeIdentification: async (_line, _machine, sequence) => {
            assert.equal(sequence, assignment.entrySequence); acknowledgements++; return assignment;
        }
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 1, coordinator, session);
    await runtime.pollOnce();
    assert.equal(acknowledgements, 1);
    assert.equal(writes, 0);
});

test('mailbox-zero M3: compara QR e sequencia, grava posicoes e limpa o bloco', async () => {
    const modbus = configuration();
    modbus.expectedPositionCount = 3;
    const machine = { machineId: 'm3', name: 'Maquina 3', host: '192.168.1.45', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'result-handshake-v1', modbus };
    let registers = Array(16).fill(0); let captured, state = 'processing', passages = 0;
    encodeUint32(51, 'high-low').forEach((value, index) => { registers[index] = value; });
    registers[2] = 7;
    encodeTextRegisters('QR-0051', 8, 'be').forEach((value, index) => { registers[3 + index] = value; });
    registers[11] = 3; registers[12] = 0b101;
    const session = {
        readCoils: async () => [false], readHoldingRegisters: async () => [...registers],
        writeRegisters: async (_address, values) => { registers = [...values]; },
        confirmReconciled() {}, dispose() {}
    };
    const assignment = { serialNumber: 'QR-0051', entrySequence: 51, machineId: 'm3', cycleId: 'entry-51',
        operationId: 'op-51', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        activeAssignment: async () => state === 'result_recorded' ? { ...assignment, state } : null,
        arriveNext: async () => assignment, mailboxAssignment: async () => ({ ...assignment, state }),
        resultBySequence: async (_line, _machine, sequence, result, data) => {
            captured = { sequence, result, data }; state = 'result_recorded'; return { ...assignment, state };
        },
        passageBySequence: async () => { passages++; state = 'completed'; return { ...assignment, state }; },
        recordCommunicationFault: async () => { throw new Error('not expected'); }
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 2, coordinator, session);
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(captured.sequence, 51); assert.equal(captured.result, 'NAO');
    assert.deepEqual(captured.data.positions, [true, false, true]);
    assert.ok(registers.every(value => value === 0));
    assert.equal(passages, 0); await runtime.pollOnce(); assert.equal(passages, 1);
});

test('mailbox-zero M2: quantidade de posições inválida bloqueia sem reprovar nem limpar', async () => {
    const modbus = configuration();
    const machine = { machineId: 'm2', name: 'Maquina 2', host: '192.168.1.35', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'result-handshake-v1', modbus };
    let registers = Array(16).fill(0); let fault, results = 0;
    encodeUint32(61, 'high-low').forEach((value, index) => { registers[index] = value; });
    registers[2] = 7;
    encodeTextRegisters('QR-0061', 8, 'be').forEach((value, index) => { registers[3 + index] = value; });
    const session = {
        readCoils: async () => [false], readHoldingRegisters: async () => [...registers],
        writeRegisters: async (_address, values) => { registers = [...values]; },
        confirmReconciled() {}, dispose() {}
    };
    const assignment = { serialNumber: 'QR-0061', entrySequence: 61, machineId: 'm2', cycleId: 'entry-61',
        operationId: 'op-61', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        activeAssignment: async () => null, arriveNext: async () => assignment,
        mailboxAssignment: async () => assignment,
        recordCommunicationFault: async (_line, _machine, sequence, data) => {
            fault = { sequence, data }; return assignment;
        },
        resultBySequence: async () => { results++; return assignment; },
        passageBySequence: async () => assignment
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 1, coordinator, session);
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(fault.sequence, 61); assert.equal(fault.data.communicationState, 'protocol_error');
    assert.equal(fault.data.expectedPositionCount, 20); assert.equal(fault.data.reportedPositionCount, 0);
    assert.equal(results, 0); assert.ok(registers.some(value => value !== 0));
});

test('mailbox-zero M4: persiste todas as posições aprovadas e conclui com OK', async () => {
    const modbus = configuration();
    modbus.expectedPositionCount = 4;
    const machine = { machineId: 'm4', name: 'Maquina 4', host: '192.168.1.55', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'result-handshake-v1', modbus };
    let registers = Array(16).fill(0); let captured, state = 'processing';
    encodeUint32(71, 'high-low').forEach((value, index) => { registers[index] = value; });
    registers[2] = 7;
    encodeTextRegisters('QR-0071', 8, 'be').forEach((value, index) => { registers[3 + index] = value; });
    registers[11] = 4; registers[12] = 0b1111;
    const session = {
        readCoils: async () => [false], readHoldingRegisters: async () => [...registers],
        writeRegisters: async (_address, values) => { registers = [...values]; },
        confirmReconciled() {}, dispose() {}
    };
    const assignment = { serialNumber: 'QR-0071', entrySequence: 71, machineId: 'm4', cycleId: 'entry-71',
        operationId: 'op-71', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        activeAssignment: async () => state === 'result_recorded' ? { ...assignment, state } : null,
        arriveNext: async () => assignment, mailboxAssignment: async () => ({ ...assignment, state }),
        resultBySequence: async (_line, _machine, sequence, result, data) => {
            captured = { sequence, result, data }; state = 'result_recorded'; return { ...assignment, state };
        }, passageBySequence: async () => { state = 'completed'; return { ...assignment, state }; },
        recordCommunicationFault: async () => { throw new Error('not expected'); }
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 3, coordinator, session);
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(captured.result, 'OK');
    assert.deepEqual(captured.data.positions, [true, true, true, true]);
    assert.ok(registers.every(value => value === 0));
});

test('mailbox-zero M1: Coil de saída já ativa não confirma uma bandeja nova', async () => {
    const modbus = configuration();
    const machine = { machineId: 'm1', name: 'Maquina 1', host: '192.168.1.25', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'm1-qr-handshake-v1', modbus };
    let request = false, exit = true, registers = Array(8).fill(0), results = 0;
    const session = {
        readCoils: async address => [address === 0 ? request : exit],
        readHoldingRegisters: async () => [...registers],
        writeRegisters: async (_address, values) => { registers = [...values]; },
        confirmReconciled() {}, dispose() {}
    };
    const assignment = { serialNumber: 'QR-COIL', entrySequence: 42, machineId: 'm1', cycleId: 'entry-42',
        operationId: 'op-42', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        activeAssignment: async () => null, arriveNext: async () => assignment,
        mailboxAssignment: async () => assignment,
        acknowledgeIdentification: async () => ({ ...assignment, identificationAcknowledgedAt: new Date() }),
        resultBySequence: async () => { results++; return { ...assignment, state: 'result_recorded' }; },
        passageBySequence: async () => assignment,
        recordCommunicationFault: async () => assignment
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 0, coordinator, session);
    await runtime.pollOnce(); request = true; await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(results, 0);
    exit = false; await runtime.pollOnce(); exit = true; await runtime.pollOnce();
    assert.equal(results, 1);
});

test('mailbox-zero: após reinício conclui resultado persistido quando encontra ACK zerado', async () => {
    const modbus = configuration();
    const machine = { machineId: 'm3', name: 'Maquina 3', host: '192.168.1.45', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'result-handshake-v1', modbus };
    const assignment = { serialNumber: 'QR-RESTART', entrySequence: 52, machineId: 'm3', cycleId: 'entry-52',
        operationId: 'op-52', action: 'EXECUTE', state: 'result_recorded' };
    let passages = 0;
    const coordinator = {
        activeAssignment: async () => assignment,
        passageBySequence: async () => { passages++; return { ...assignment, state: 'completed' }; }
    };
    const session = {
        readCoils: async () => [false], readHoldingRegisters: async (_address, count) => Array(count).fill(0),
        writeRegisters: async () => {}, confirmReconciled() {}, dispose() {}
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 2, coordinator, session);
    await runtime.pollOnce(); assert.equal(passages, 1);
});

test('mailbox-zero: sequência da CLP é somente diagnóstica quando o QR confere', async () => {
    const modbus = configuration();
    modbus.expectedPositionCount = 2;
    const machine = { machineId: 'm2', name: 'Maquina 2', host: '192.168.1.35', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'result-handshake-v1', modbus };
    let registers = Array(16).fill(0); let captured;
    encodeUint32(3, 'high-low').forEach((value, index) => { registers[index] = value; });
    registers[2] = 7;
    encodeTextRegisters('QR-0028', 8, 'be').forEach((value, index) => { registers[3 + index] = value; });
    registers[11] = 2; registers[12] = 0b11;
    const session = {
        readCoils: async () => [false], readHoldingRegisters: async () => [...registers],
        writeRegisters: async (_address, values) => { registers = [...values]; },
        confirmReconciled() {}, dispose() {}
    };
    const assignment = { serialNumber: 'QR-0028', entrySequence: 28, machineId: 'm2', cycleId: 'entry-28',
        operationId: 'op-28', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        activeAssignment: async () => null, arriveNext: async () => assignment,
        mailboxAssignment: async () => assignment, recordCommunicationFault: async () => { throw new Error('não esperado'); },
        resultBySequence: async (_line, _machine, sequence, result, data) => {
            captured = { sequence, result, data }; return assignment;
        }, passageBySequence: async () => assignment
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 1, coordinator, session);
    await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(captured.sequence, 28); assert.equal(captured.result, 'OK');
    assert.equal(captured.data.reportedSequence, 3);
    assert.equal(captured.data.sequenceValidation, 'diagnostic-only');
    assert.ok(registers.every(value => value === 0));
});

test('mailbox-zero: QR divergente bloqueia sem reprovar, limpar ou concluir a step', async () => {
    const modbus = configuration();
    const machine = { machineId: 'm2', name: 'Maquina 2', host: '192.168.1.35', port: 502,
        unitId: 1, timeoutMs: 3000, protocol: 'result-handshake-v1', modbus };
    let registers = Array(16).fill(0), faults = 0, completions = 0, writes = 0;
    encodeUint32(3, 'high-low').forEach((value, index) => { registers[index] = value; });
    registers[2] = 7;
    encodeTextRegisters('QR-ERRO', 8, 'be').forEach((value, index) => { registers[3 + index] = value; });
    registers[11] = 2; registers[12] = 0b11;
    const session = {
        readCoils: async () => [false], readHoldingRegisters: async () => [...registers],
        writeRegisters: async () => { writes++; }, confirmReconciled() {}, dispose() {}
    };
    const assignment = { serialNumber: 'QR-0028', entrySequence: 28, machineId: 'm2', cycleId: 'entry-28',
        operationId: 'op-28', action: 'EXECUTE', state: 'processing' };
    const coordinator = {
        activeAssignment: async () => null, arriveNext: async () => assignment,
        mailboxAssignment: async () => assignment,
        recordCommunicationFault: async (_line, _machine, sequence, data) => {
            assert.equal(sequence, 28); assert.equal(data.expectedSerial, 'QR-0028');
            assert.equal(data.reportedSerial, 'QR-ERRO'); faults++; return assignment;
        },
        resultBySequence: async () => { completions++; return assignment; },
        passageBySequence: async () => { completions++; return assignment; }
    };
    const runtime = new ZeroMailboxRuntime('linha-01', machine, 1, coordinator, session);
    await runtime.pollOnce(); await runtime.pollOnce(); await runtime.pollOnce();
    assert.equal(faults, 1); assert.equal(completions, 0); assert.equal(writes, 0);
    assert.ok(registers.some(value => value !== 0));
});
