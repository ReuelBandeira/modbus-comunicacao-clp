const assert = require('node:assert/strict');
const { test } = require('node:test');
const { CommunicationLog } = require('../dist/modules/modbus/services/communicationLog');

test('console Modbus mantém somente os registros mais recentes em ordem', () => {
    const log = new CommunicationLog(2);
    log.add('m1', 'PLC_TO_NODE', 'REQUEST_QR', 'solicitou');
    log.add('m1', 'NODE_TO_PLC', 'MAILBOX_WRITTEN', 'gravou', { registers: [1, 2] });
    log.add('m2', 'PLC_TO_NODE', 'MAILBOX_RECEIVED', 'recebeu');
    const records = log.list();
    assert.deepEqual(records.map(record => record.id), [2, 3]);
    assert.equal(records[0].data.registers[1], 2);
    assert.ok(records.every(record => record.timestamp instanceof Date));
});

test('saúde Modbus sinaliza perda e recuperação por máquina', () => {
    const log = new CommunicationLog();
    log.markSuccess('m2');
    assert.equal(log.health()[0].status, 'online');
    log.markFailure('m2', 'connect ECONNREFUSED');
    assert.equal(log.health()[0].status, 'offline');
    assert.equal(log.health()[0].error, 'connect ECONNREFUSED');
    log.markSuccess('m2');
    assert.equal(log.health()[0].status, 'online');
    assert.equal(log.list().at(-1).event, 'COMMUNICATION_RESTORED');
});
