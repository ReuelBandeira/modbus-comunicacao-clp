const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MachineModbusSession } = require('../dist/modules/modbus/sessions/machineModbusSession');

test('sessão: porta 502, conexão reutilizada e requisições serializadas por máquina', async () => {
    const calls = [];
    let active = 0;
    const session = new MachineModbusSession({ host: '192.168.1.25' }, () => ({
        setID: value => assert.equal(value, 1), setTimeout: value => assert.equal(value, 3000),
        connectTCP: async (host, options) => { assert.equal(host, '192.168.1.25'); assert.equal(options.port, 502); calls.push('connect'); },
        readHoldingRegisters: async () => {
            assert.equal(++active, 1);
            await new Promise(resolve => setTimeout(resolve, 5)); active--;
            calls.push('read'); return { data: [12] };
        },
        writeRegisters: async () => { assert.equal(active, 0); calls.push('write'); },
        destroy: callback => callback()
    }));
    await Promise.all([session.readHoldingRegisters(0, 1), session.writeRegisters(10, [1]), session.readHoldingRegisters(0, 1)]);
    assert.deepEqual(calls, ['connect', 'read', 'write', 'read']);
    session.dispose();
    await assert.rejects(session.readHoldingRegisters(0, 1), /encerrada/);
});

test('sessão: escrita incerta não é reenviada e exige reconciliação', async () => {
    let writes = 0, connects = 0;
    const session = new MachineModbusSession({ host: '192.168.1.25' }, () => ({
        setID() {}, setTimeout() {}, connectTCP: async () => { connects++; },
        readHoldingRegisters: async () => ({ data: [1] }),
        writeRegisters: async () => { writes++; throw new Error('timeout'); },
        destroy: callback => callback()
    }));
    await assert.rejects(session.writeRegisters(0, [1]), { outcomeUnknown: true });
    await assert.rejects(session.writeRegisters(0, [1]), { outcomeUnknown: true });
    assert.equal(writes, 1);
    assert.deepEqual(await session.readHoldingRegisters(0, 1), [1]);
    assert.equal(connects, 2);
    session.confirmReconciled();
    await assert.rejects(session.writeRegisters(0, [1]), { outcomeUnknown: true });
    assert.equal(writes, 2);
    session.dispose();
});

test('sessão: valida faixas antes de acessar o equipamento', () => {
    const session = new MachineModbusSession({ host: '192.168.1.25' }, () => assert.fail('Não deve conectar'));
    assert.throws(() => session.readHoldingRegisters(65535, 2));
    assert.throws(() => session.writeRegisters(0, [65536]));
    assert.throws(() => session.writeRegisters(0, []));
    session.dispose();
});

test('sessão: lê FC01 e escreve ACK com FC05', async () => {
    const calls = [];
    const session = new MachineModbusSession({ host: '192.168.1.25' }, () => ({
        setID() {}, setTimeout() {}, connectTCP: async () => {},
        readCoils: async (address, count) => { calls.push(['readCoils', address, count]); return { data: [false, true, true, true] }; },
        writeCoil: async (address, value) => { calls.push(['writeCoil', address, value]); },
        readHoldingRegisters: async () => ({ data: [0] }), writeRegisters: async () => {},
        destroy: callback => callback()
    }));
    assert.deepEqual(await session.readCoils(10, 2), [false, true]);
    await session.writeCoil(12, true);
    assert.deepEqual(calls, [['readCoils', 10, 2], ['writeCoil', 12, true]]);
    session.dispose();
});
