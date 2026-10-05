const test = require('node:test');
const assert = require('node:assert/strict');
const { IhmMachineService, IhmMachineError } = require('../dist/modules/ihmMachines/services/ihmMachineService');

function fixture() {
    const records = [];
    const repository = {
        list: async (_lineId, enabledOnly) => records.filter(item => !enabledOnly || item.enabled),
        get: async (lineId, id) => records.find(item => item.lineId === lineId && item.ihmMachineId === id) || null,
        create: async value => { records.push(value); },
        update: async value => {
            const index = records.findIndex(item => item.lineId === value.lineId && item.ihmMachineId === value.ihmMachineId);
            if (index < 0) return false; records[index] = value; return true;
        },
        remove: async (lineId, id) => {
            const index = records.findIndex(item => item.lineId === lineId && item.ihmMachineId === id);
            if (index < 0) return false; records.splice(index, 1); return true;
        }
    };
    const commands = new Set(['cmd-start', 'cmd-stop', 'cmd-reset']);
    const signals = { command: async (_lineId, id) => commands.has(id) ? { commandId: id } : null };
    return { service: new IhmMachineService(repository, signals, 'linha-01'), records };
}

test('máquinas IHM possuem cadastro independente e vinculam comandos existentes', async () => {
    const { service, records } = fixture();
    const created = await service.create({
        ihmMachineId: 'prensa-01', name: 'Prensa 01', order: 2, enabled: true,
        commandIds: { start: 'cmd-start', stop: 'cmd-stop', reset: 'cmd-reset' }
    });
    assert.equal(created.lineId, 'linha-01');
    assert.deepEqual(created.commandIds, { start: 'cmd-start', stop: 'cmd-stop', reset: 'cmd-reset' });
    assert.equal((await service.list(true)).length, 1);
    assert.equal(records[0].name, 'Prensa 01');

    const updated = await service.update('prensa-01', {
        name: 'Prensa principal', order: 1, enabled: false, commandIds: { start: 'cmd-start' }
    });
    assert.equal(updated.name, 'Prensa principal');
    assert.equal((await service.list(true)).length, 0);
    assert.equal((await service.list(false)).length, 1);
});

test('máquinas IHM rejeitam comando inexistente ou repetido', async () => {
    const { service } = fixture();
    await assert.rejects(() => service.create({ ihmMachineId: 'm1', name: 'M1', commandIds: { start: 'inexistente' } }),
        error => error instanceof IhmMachineError && error.status === 400);
    await assert.rejects(() => service.create({
        ihmMachineId: 'm1', name: 'M1', commandIds: { start: 'cmd-start', stop: 'cmd-start' }
    }), error => error instanceof IhmMachineError && error.status === 400);
});
