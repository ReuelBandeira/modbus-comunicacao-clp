const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { ModbusTestService, encodeRegisters } = require('../dist/modules/modbus/services/modbusTestService');
const { MachineModbusSession } = require('../dist/modules/modbus/sessions/machineModbusSession');

test('sessão de produção: lê e escreve FC03/FC16 pelo TCP simulado', async t => {
    const { options, writes } = await simulator(t);
    const session = new MachineModbusSession({ host: options.host, port: options.port, timeoutMs: 500 });
    t.after(() => session.dispose());
    assert.deepEqual(await session.readHoldingRegisters(100, 1), [0]);
    await session.writeRegisters(0, [0x4142, 0x4300]);
    assert.deepEqual(await session.readHoldingRegisters(100, 1), [1]);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].bytes, Buffer.from([65, 66, 67, 0]));
});

async function simulator(t, initial = 0, approve = true) {
    let response = initial;
    const writes = [];
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        let pending = Buffer.alloc(0);
        socket.on('data', chunk => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 7 && pending.length >= 6 + pending.readUInt16BE(4)) {
                const length = 6 + pending.readUInt16BE(4);
                const request = pending.subarray(0, length);
                pending = pending.subarray(length);
                let pdu;
                if (request[7] === 3) {
                    const count = request.readUInt16BE(10);
                    pdu = Buffer.alloc(2 + count * 2);
                    pdu[0] = 3; pdu[1] = count * 2;
                    pdu.writeUInt16BE(response, 2);
                } else {
                    assert.equal(request[7], 16);
                    writes.push({ address: request.readUInt16BE(8), bytes: Buffer.from(request.subarray(13)) });
                    if (approve) response = 1;
                    pdu = Buffer.from(request.subarray(7, 12));
                }
                const header = Buffer.from(request.subarray(0, 7));
                header.writeUInt16BE(pdu.length + 1, 4);
                socket.write(Buffer.concat([header, pdu]));
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return { writes, options: {
        host: '127.0.0.1', port: server.address().port, unitId: 1, timeout: 500,
        writeAddress: 0, registerCount: 4, byteOrder: 'be', text: 'ABC',
        responseAddress: 100, responseCount: 1, responseMode: 'number', expected: '1', responseTimeout: 150
    } };
}

test('Modbus: codifica texto, ordem dos bytes e preenchimento sem truncar UTF-8', () => {
    assert.deepEqual(encodeRegisters('ABC', 2, 'be'), [0x4142, 0x4300]);
    assert.deepEqual(encodeRegisters('ABC', 2, 'le'), [0x4241, 0x0043]);
    assert.deepEqual(encodeRegisters('é', 1, 'be'), [0xc3a9]);
    assert.throws(() => encodeRegisters('éA', 1, 'be'), /capacidade/);
});

test('Modbus: envia FC16 e confirma OK por FC03', async t => {
    const { options, writes } = await simulator(t);
    const result = await new ModbusTestService().execute('send', options);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.written, true);
    assert.deepEqual(result.registers, [1]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].address, 0);
    assert.deepEqual(writes[0].bytes, Buffer.from([65, 66, 67, 0, 0, 0, 0, 0]));
});

test('Modbus: bloqueia escrita quando OK já estava presente', async t => {
    const { options, writes } = await simulator(t, 1);
    const result = await new ModbusTestService().execute('send', options);
    assert.equal(result.ok, false);
    assert.equal(result.written, false);
    assert.equal(writes.length, 0);
});

test('Modbus: leitura isolada não escreve no equipamento', async t => {
    const { options, writes } = await simulator(t);
    const result = await new ModbusTestService().execute('read', options);
    assert.equal(result.ok, true, result.message);
    assert.deepEqual(result.registers, [0]);
    assert.equal(writes.length, 0);
});

test('Modbus: verificação de disponibilidade abre TCP sem escrever ou confirmar OK da CLP', async t => {
    const { options, writes } = await simulator(t);
    const result = await new ModbusTestService().execute('probe', options);
    assert.equal(result.ok, true, result.message);
    assert.equal(result.written, undefined);
    assert.equal(result.registers, undefined);
    assert.equal(writes.length, 0);
});

test('Modbus: verificação TCP informa indisponibilidade após servidor encerrar', async () => {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    const result = await new ModbusTestService().execute('probe', { host: '127.0.0.1', port, timeout: 200 });
    assert.equal(result.ok, false);
});

test('Modbus: escrita confirmada sem OK termina com erro e não repete envio', async t => {
    const { options, writes } = await simulator(t, 0, false);
    const result = await new ModbusTestService().execute('send', options);
    assert.equal(result.ok, false);
    assert.equal(result.written, true);
    assert.match(result.message, /prazo/);
    assert.equal(writes.length, 1);
});

test('Modbus: rejeita sobreposição entre escrita e resposta', async t => {
    const { options, writes } = await simulator(t);
    const result = await new ModbusTestService().execute('send', { ...options, responseAddress: 1 });
    assert.equal(result.ok, false);
    assert.match(result.message, /sobrepor/);
    assert.equal(writes.length, 0);
});
