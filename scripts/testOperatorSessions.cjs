const test = require('node:test');
const assert = require('node:assert/strict');
const { OperatorSessionService } = require('../dist/modules/operatorSessions/services/operatorSessionService');
const { resolveCurrentShift } = require('../dist/modules/shifts/services/shiftService');

const requestA = '11111111-1111-4111-8111-111111111111';
const requestB = '22222222-2222-4222-8222-222222222222';
const requestC = '33333333-3333-4333-8333-333333333333';

function sessionRepository() {
    const values = [];
    return {
        values,
        active: async stationId => structuredClone(values.filter(item => item.stationId === stationId && item.status === 'active')),
        activeForShift: async (stationId, shiftId) => structuredClone(values.filter(item => item.stationId === stationId
            && item.status === 'active' && item.shift?.shiftId === shiftId)),
        activeByOperator: async (stationId, registration) => structuredClone(values.find(item => item.stationId === stationId
            && item.operator.registration === registration && item.status === 'active') || null),
        hasActiveForShift: async shiftId => values.some(item => item.status === 'active'
            && (!item.shift || item.shift.shiftId === shiftId)),
        endOutsideShift: async (stationId, shiftId, endedAt) => {
            const expired = values.filter(item => item.stationId === stationId && item.status === 'active'
                && (!shiftId || item.shift?.shiftId !== shiftId));
            for (const item of expired) {
                item.status = 'ended'; item.endedAt = endedAt; item.updatedAt = endedAt; item.endReason = 'shift_change';
            }
            return expired.length;
        },
        byEntryRequest: async requestId => structuredClone(values.find(item => item.entryRequestId === requestId) || null),
        byExitRequest: async requestId => structuredClone(values.find(item => item.exitRequestId === requestId) || null),
        create: async value => {
            if (values.some(item => item.stationId === value.stationId
                && item.operator.registration === value.operator.registration && item.status === 'active')) {
                throw Object.assign(new Error('duplicate'), { code: 11000 });
            }
            values.push(structuredClone(value));
        },
        exit: async (sessionId, stationId, requestId, endedAt) => {
            const item = values.find(value => value.sessionId === sessionId && value.stationId === stationId && value.status === 'active'
                && !value.exitRequestId);
            if (!item) return null;
            item.status = 'ended'; item.endedAt = endedAt; item.updatedAt = endedAt;
            item.endReason = 'operator_exit'; item.exitRequestId = requestId;
            return structuredClone(item);
        }
    };
}

function service(repository = sessionRepository(), shifts = {
    current: async () => ({ shiftId: 'turno-1', name: 'Turno 1', startTime: '06:00', endTime: '14:00', active: true })
}) {
    const operators = { get: async registration => ({
        'MAT-001': { name: 'João', registration: 'MAT-001' },
        'MAT-002': { name: 'Maria', registration: 'MAT-002' }
    })[registration] || null };
    return { repository, value: new OperatorSessionService(repository, operators, shifts, 'linha-01', 'Principal') };
}

test('sessao de operador: permite varias pessoas e impede duplicidade na mesma estacao', async () => {
    const { value } = service();
    const joao = await value.enter({ registration: 'MAT-001', requestId: requestA });
    await value.enter({ registration: 'MAT-002', requestId: requestB });
    await assert.rejects(value.enter({ registration: 'MAT-001', requestId: requestC }), /ja esta ativo/);
    const context = await value.context();
    assert.equal(context.activeOperators.length, 2);
    assert.equal(context.activeOperators[0].stationId, 'linha-01');
    assert.equal(joao.shift.shiftId, 'turno-1');
    assert.equal(joao.operator.name, 'João');
});

test('sessao de operador: entrada e saida sao idempotentes e persistem no repositorio', async () => {
    const shared = sessionRepository(), first = service(shared).value;
    const entered = await first.enter({ registration: 'MAT-001', requestId: requestA });
    assert.equal((await first.enter({ registration: 'MAT-001', requestId: requestA })).sessionId, entered.sessionId);
    const restarted = service(shared).value;
    const exited = await restarted.exit(entered.sessionId, { requestId: requestB });
    assert.ok(exited.endedAt);
    assert.equal((await restarted.exit(entered.sessionId, { requestId: requestB })).endedAt.getTime(), exited.endedAt.getTime());
    assert.equal((await restarted.context()).activeOperators.length, 0);
});

test('sessao de operador: duas confirmacoes simultaneas de saida produzem o mesmo resultado', async () => {
    const { value } = service();
    const entered = await value.enter({ registration: 'MAT-001', requestId: requestA });
    const [first, second] = await Promise.all([
        value.exit(entered.sessionId, { requestId: requestB }),
        value.exit(entered.sessionId, { requestId: requestB })
    ]);
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(first.endedAt.getTime(), second.endedAt.getTime());
});

test('sessao de operador: rejeita operador inexistente e estacao enviada pelo cliente', async () => {
    const { value } = service();
    await assert.rejects(value.enter({ registration: 'DESCONHECIDO', requestId: requestA }), /nao encontrado/);
    await assert.rejects(value.enter({ registration: 'MAT-001', stationId: 'outra', requestId: requestA }), /somente matricula/);
});

test('sessao de operador: bloqueia nova entrada sem turno e ainda permite saida de sessao existente', async () => {
    const repository = sessionRepository();
    let currentShift = { shiftId: 'turno-1', name: 'Turno 1', startTime: '06:00', endTime: '14:00', active: true };
    const { value } = service(repository, { current: async () => currentShift });
    const entered = await value.enter({ registration: 'MAT-001', requestId: requestA });
    currentShift = null;
    await assert.rejects(value.enter({ registration: 'MAT-002', requestId: requestB }), /Nenhum turno ativo/);
    const exited = await value.exit(entered.sessionId, { requestId: requestC });
    assert.equal(exited.status, 'ended');
});

test('sessao de operador: troca de turno encerra presencas anteriores e permite nova entrada', async () => {
    const repository = sessionRepository();
    let currentShift = { shiftId: 'turno-1', name: 'Turno 1', startTime: '06:00', endTime: '14:00', active: true };
    const { value } = service(repository, { current: async () => currentShift });
    const previous = await value.enter({ registration: 'MAT-001', requestId: requestA });
    currentShift = { shiftId: 'turno-2', name: 'Turno 2', startTime: '14:00', endTime: '22:00', active: true };
    const context = await value.context();
    assert.equal(context.activeOperators.length, 0);
    assert.equal(repository.values.find(item => item.sessionId === previous.sessionId).endReason, 'shift_change');
    const current = await value.enter({ registration: 'MAT-001', requestId: requestB });
    assert.equal(current.shift.shiftId, 'turno-2');
});

test('turno atual: respeita limites e turno que atravessa meia-noite', () => {
    const shifts = [
        { name: 'Turno 1', startTime: '06:00', endTime: '14:00', active: true },
        { name: 'Turno 2', startTime: '14:00', endTime: '22:00', active: true },
        { name: 'Turno 3', startTime: '22:00', endTime: '06:00', active: true }
    ];
    const local = (hour, minute) => new Date(2026, 8, 20, hour, minute);
    assert.equal(resolveCurrentShift(shifts, local(13, 59)).name, 'Turno 1');
    assert.equal(resolveCurrentShift(shifts, local(14, 0)).name, 'Turno 2');
    assert.equal(resolveCurrentShift(shifts, local(23, 30)).name, 'Turno 3');
    assert.equal(resolveCurrentShift(shifts, local(5, 59)).name, 'Turno 3');
    assert.equal(resolveCurrentShift(shifts, local(6, 0)).name, 'Turno 1');
});
