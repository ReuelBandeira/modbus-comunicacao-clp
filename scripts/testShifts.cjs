const test = require('node:test');
const assert = require('node:assert/strict');
const { ShiftService, shiftsOverlap } = require('../dist/modules/shifts/services/shiftService');

function memoryRepository(seed = []) {
    const values = structuredClone(seed);
    return {
        values,
        list: async () => structuredClone(values).sort((a, b) => a.startTime.localeCompare(b.startTime)),
        get: async id => structuredClone(values.find(item => item.shiftId === id) || null),
        create: async value => { values.push(structuredClone(value)); },
        update: async (id, value) => {
            const index = values.findIndex(item => item.shiftId === id);
            if (index < 0) return null;
            values[index] = { ...values[index], ...structuredClone(value) };
            return structuredClone(values[index]);
        },
        remove: async id => {
            const index = values.findIndex(item => item.shiftId === id);
            if (index < 0) return false;
            values.splice(index, 1); return true;
        }
    };
}

test('turnos: aceita sequencia contigua incluindo virada da meia-noite', async () => {
    const repository = memoryRepository(), service = new ShiftService(repository);
    const first = await service.create({ name: 'Turno 1', startTime: '06:00', endTime: '14:00', active: true });
    await service.create({ name: 'Turno 2', startTime: '14:00', endTime: '22:00', active: true });
    const third = await service.create({ name: 'Turno 3', startTime: '22:00', endTime: '06:00', active: true });
    assert.match(first.shiftId, /^[0-9a-f-]{36}$/);
    assert.equal(third.endTime, '06:00');
    assert.equal(repository.values.length, 3);
});

test('turnos: detecta sobreposicao comum e na meia-noite', async () => {
    const service = new ShiftService(memoryRepository());
    await service.create({ name: 'Dia', startTime: '06:00', endTime: '14:00', active: true });
    await assert.rejects(service.create({ name: 'Conflito', startTime: '13:00', endTime: '22:00', active: true }), /sobrepoe/);
    const nightService = new ShiftService(memoryRepository());
    await nightService.create({ name: 'Noite', startTime: '22:00', endTime: '06:00', active: true });
    await assert.rejects(nightService.create({ name: 'Madrugada', startTime: '05:00', endTime: '07:00', active: true }), /sobrepoe/);
    assert.equal(shiftsOverlap({ startTime: '22:00', endTime: '06:00' }, { startTime: '06:00', endTime: '14:00' }), false);
});

test('turnos: inativo pode sobrepor e ativacao volta a validar', async () => {
    const repository = memoryRepository(), service = new ShiftService(repository);
    await service.create({ name: 'Principal', startTime: '06:00', endTime: '14:00', active: true });
    const inactive = await service.create({ name: 'Reserva', startTime: '07:00', endTime: '10:00', active: false });
    await assert.rejects(service.update(inactive.shiftId,
        { name: inactive.name, startTime: inactive.startTime, endTime: inactive.endTime, active: true }), /sobrepoe/);
});

test('turnos: valida campos obrigatorios e horarios distintos', async () => {
    const service = new ShiftService(memoryRepository());
    await assert.rejects(service.create({ name: '', startTime: '06:00', endTime: '14:00', active: true }), /Nome/);
    await assert.rejects(service.create({ name: 'Turno', startTime: '6:00', endTime: '14:00', active: true }), /HH:mm/);
    await assert.rejects(service.create({ name: 'Turno', startTime: '06:00', endTime: '06:00', active: true }), /diferentes/);
});

test('turnos: remove cadastro existente e informa turno ausente', async () => {
    const repository = memoryRepository(), service = new ShiftService(repository);
    const shift = await service.create({ name: 'Temporario', startTime: '08:00', endTime: '12:00', active: false });
    await service.remove(shift.shiftId);
    assert.equal(repository.values.length, 0);
    await assert.rejects(service.remove(shift.shiftId), /nao encontrado/);
});

test('turnos: serializa cadastros concorrentes para impedir sobreposicao', async () => {
    const repository = memoryRepository(), service = new ShiftService(repository);
    const results = await Promise.allSettled([
        service.create({ name: 'Primeiro', startTime: '06:00', endTime: '14:00', active: true }),
        service.create({ name: 'Segundo', startTime: '13:00', endTime: '22:00', active: true })
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(repository.values.length, 1);
});

test('turnos: impede alterar ou remover o turno vigente', async () => {
    const repository = memoryRepository(), service = new ShiftService(repository);
    const now = new Date();
    const start = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const endDate = new Date(now.getTime() + 60 * 60 * 1000);
    const end = `${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}`;
    const shift = await service.create({ name: 'Vigente', startTime: start, endTime: end, active: true });
    await assert.rejects(service.update(shift.shiftId,
        { name: 'Alterado', startTime: start, endTime: end, active: false }), /esta vigente/);
    await assert.rejects(service.remove(shift.shiftId), /esta vigente/);
});

test('turnos: impede alterar ou remover turno com operador ativo', async () => {
    const repository = memoryRepository();
    const usage = { hasActiveForShift: async () => true };
    const service = new ShiftService(repository, usage);
    const shift = await service.create({ name: 'Com equipe', startTime: '00:01', endTime: '00:02', active: false });
    await assert.rejects(service.update(shift.shiftId,
        { name: shift.name, startTime: shift.startTime, endTime: shift.endTime, active: false }), /operadores ativos/);
    await assert.rejects(service.remove(shift.shiftId), /operadores ativos/);
});
