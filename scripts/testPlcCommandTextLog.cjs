const assert = require('node:assert/strict');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { PlcCommandTextLog } = require('../dist/modules/plcSignals/services/plcCommandTextLog');

test('log texto CLP registra etapas detalhadas em arquivo diario', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pcm-plc-command-log-'));
    try {
        const log = new PlcCommandTextLog(directory);
        const now = new Date();
        const command = {
            commandId: 'cmd-1', lineId: 'linha-01', plcId: 'plc-1', code: 'LINE_START', label: 'Iniciar linha',
            plcAddress: 'M20', commandType: 'coil', address: 20, value: 1, mode: 'pulse', pulseMs: 600,
            resetValue: 0, ackTimeoutMs: 5000, enabled: true, createdAt: now, updatedAt: now
        };
        const execution = {
            executionId: 'execution-1', requestId: 'request-1', lineId: 'linha-01', commandId: 'cmd-1',
            commandCode: 'LINE_START', label: 'Iniciar linha', status: 'sending', requestedBy: 'IHM Principal',
            requestedAt: now, updatedAt: now, steps: []
        };
        log.add('WRITE_STARTED', execution, command, {
            host: '192.0.2.10', port: 502, unitId: 1, step: 'active_value', attemptedValue: 1
        });
        log.add('WRITE_COMPLETED', execution, command, { step: 'active_value', attemptedValue: 1, durationMs: 12 });
        await log.flush();

        const files = await readdir(directory);
        assert.equal(files.length, 1);
        assert.match(files[0], /^plc-commands-\d{4}-\d{2}-\d{2}\.txt$/);
        const records = (await readFile(join(directory, files[0]), 'utf8')).trim().split('\n').map(JSON.parse);
        assert.deepEqual(records.map(record => record.event), ['WRITE_STARTED', 'WRITE_COMPLETED']);
        assert.equal(records[0].commandCode, 'LINE_START');
        assert.equal(records[0].modbusAddress, 20);
        assert.equal(records[0].functionCode, 'FC05');
        assert.equal(records[1].durationMs, 12);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
