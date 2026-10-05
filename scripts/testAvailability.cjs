const test = require('node:test');
const assert = require('node:assert/strict');
const { AvailabilityService } = require('../dist/modules/availability/services/availabilityService');

function availabilityRepository(seed = {}) {
    const reasons = structuredClone(seed.reasons || []), breaks = structuredClone(seed.breaks || []);
    const calendar = structuredClone(seed.calendar || []), events = structuredClone(seed.events || []), periods = structuredClone(seed.periods || []);
    let configuration = structuredClone(seed.configuration || null);
    return {
        configuration: async () => structuredClone(configuration),
        saveConfiguration: async value => { configuration = structuredClone(value); return structuredClone(value); },
        listReasons: async () => structuredClone(reasons), reason: async id => structuredClone(reasons.find(value => value.reasonId === id) || null),
        createReason: async value => reasons.push(structuredClone(value)),
        updateReason: async (id, value) => { const item = reasons.find(reason => reason.reasonId === id); if (!item) return null; Object.assign(item, structuredClone(value)); return structuredClone(item); },
        removeReason: async id => { const index = reasons.findIndex(value => value.reasonId === id); if (index < 0) return false; reasons.splice(index, 1); return true; },
        reasonInUse: async id => events.some(value => value.reason.reasonId === id),
        listBreaks: async () => structuredClone(breaks), breakById: async id => structuredClone(breaks.find(value => value.breakId === id) || null),
        createBreak: async value => breaks.push(structuredClone(value)),
        updateBreak: async (id, value) => { const item = breaks.find(entry => entry.breakId === id); if (!item) return null; Object.assign(item, structuredClone(value)); return structuredClone(item); },
        removeBreak: async id => { const index = breaks.findIndex(value => value.breakId === id); if (index < 0) return false; breaks.splice(index, 1); return true; },
        listCalendar: async (lineId, from, to) => structuredClone(calendar.filter(value => value.lineId === lineId && (!from || value.date >= from && value.date <= to))),
        createCalendar: async value => calendar.push(structuredClone(value)), removeCalendar: async () => false,
        openEvent: async lineId => structuredClone(events.find(value => value.lineId === lineId && value.status === 'open') || null),
        eventByStartRequest: async requestId => structuredClone(events.find(value => value.startRequestId === requestId) || null),
        eventByEndRequest: async requestId => structuredClone(events.find(value => value.endRequestId === requestId) || null),
        createEvent: async value => events.push(structuredClone(value)),
        addPlcSignals: async (lineId, eventId, signals, activeSignalIds, updatedAt) => {
            const item = events.find(value => value.lineId === lineId && value.eventId === eventId && value.status === 'open' && value.source === 'plc');
            if (!item) return null;
            item.sourceSignals ||= []; item.activeSourceSignalIds ||= [];
            for (const signal of signals) if (!item.sourceSignals.some(value => value.signalId === signal.signalId)) item.sourceSignals.push(structuredClone(signal));
            for (const signalId of activeSignalIds) if (!item.activeSourceSignalIds.includes(signalId)) item.activeSourceSignalIds.push(signalId);
            item.updatedAt = updatedAt; return structuredClone(item);
        },
        replacePlcSignals: async (lineId, eventId, signals, activeSignalIds, notes, updatedAt) => {
            const item = events.find(value => value.lineId === lineId && value.eventId === eventId && value.status === 'open' && value.source === 'plc');
            if (!item) return null;
            item.sourceSignals = structuredClone(signals); item.activeSourceSignalIds = structuredClone(activeSignalIds);
            item.notes = notes; item.updatedAt = updatedAt; return structuredClone(item);
        },
        removePlcSignal: async (lineId, eventId, signalId, updatedAt) => {
            const item = events.find(value => value.lineId === lineId && value.eventId === eventId && value.status === 'open' && value.source === 'plc');
            if (!item) return null;
            item.activeSourceSignalIds = (item.activeSourceSignalIds || []).filter(value => value !== signalId);
            item.updatedAt = updatedAt; return structuredClone(item);
        },
        closePlcEventWithoutSignals: async (lineId, eventId, requestId, endedAt) => {
            const item = events.find(value => value.lineId === lineId && value.eventId === eventId && value.status === 'open'
                && value.source === 'plc' && value.activeSourceSignalIds?.length === 0);
            if (!item) return null;
            Object.assign(item, { status: 'closed', endRequestId: requestId, endedAt, updatedAt: endedAt }); return structuredClone(item);
        },
        closeEvent: async (lineId, requestId, endedAt) => { const item = events.find(value => value.lineId === lineId && value.status === 'open'); if (!item) return null; Object.assign(item, { status: 'closed', endRequestId: requestId, endedAt, updatedAt: endedAt }); return structuredClone(item); },
        closeEventById: async (lineId, eventId, requestId, endedAt) => { const item = events.find(value => value.lineId === lineId && value.eventId === eventId && value.status === 'open'); if (!item) return null; Object.assign(item, { status: 'closed', endRequestId: requestId, endedAt, updatedAt: endedAt }); return structuredClone(item); },
        classifyEvent: async (lineId, eventId, eventReason, notes, updatedAt) => {
            const item = events.find(value => value.lineId === lineId && value.eventId === eventId && value.status === 'open' && value.source === 'plc');
            if (!item) return null;
            item.reason = structuredClone(eventReason); item.classificationPending = false;
            if (notes) item.notes = notes; item.updatedAt = updatedAt; return structuredClone(item);
        },
        eventsBetween: async (lineId, from, to) => structuredClone(events.filter(value => value.lineId === lineId && value.startedAt < to && (!value.endedAt || value.endedAt > from))),
        recentEvents: async lineId => structuredClone(events.filter(value => value.lineId === lineId)),
        period: async (lineId, date, shiftId) => structuredClone(periods.find(value => value.lineId === lineId && value.operationalDate === date && value.shiftId === shiftId) || null),
        createPeriod: async value => periods.push(structuredClone(value)),
        periodsBetween: async (lineId, from, to) => structuredClone(periods.filter(value => value.lineId === lineId && value.plannedStartAt < to && value.plannedEndAt > from))
    };
}

function service(seed = {}) {
    const shifts = seed.shifts || [];
    const shiftRepository = { list: async () => structuredClone(shifts), get: async id => structuredClone(shifts.find(value => value.shiftId === id) || null) };
    const pcms = { completedBetween: async () => structuredClone(seed.pcms || []) };
    return new AvailabilityService(availabilityRepository(seed), shiftRepository, pcms, 'linha-01', seed.operationalLog);
}

const shift = { shiftId: '11111111-1111-4111-8111-111111111111', name: 'Turno 1', startTime: '06:00', endTime: '14:00', active: true };
const reason = { reasonId: '22222222-2222-4222-8222-222222222222', code: 'FALHA', name: 'Falha mecânica', classification: 'unplanned', countsAgainstAvailability: true, active: true };

test('disponibilidade: calcula turno, pausa, parada computada e parada excluida', async () => {
    const result = await service({ shifts: [shift], breaks: [{ breakId: 'b', shiftId: shift.shiftId, name: 'Intervalo', startTime: '10:00', endTime: '10:30', excludeFromPlannedTime: true, active: true }], events: [
        { eventId: 'e1', lineId: 'linha-01', status: 'closed', startedAt: new Date(2026, 0, 10, 8), endedAt: new Date(2026, 0, 10, 9), reason, source: 'manual' },
        { eventId: 'e2', lineId: 'linha-01', status: 'closed', startedAt: new Date(2026, 0, 10, 11), endedAt: new Date(2026, 0, 10, 11, 30), reason: { ...reason, reasonId: 'r2', countsAgainstAvailability: false }, source: 'manual' }
    ] }).report(new Date(2026, 0, 10, 0).toISOString(), new Date(2026, 0, 11, 0).toISOString(), new Date().getTimezoneOffset());
    assert.equal(result.scheduledTimeMs, 8 * 60 * 60 * 1000);
    assert.equal(result.excludedBreakTimeMs, 30 * 60 * 1000);
    assert.equal(result.excludedEventTimeMs, 30 * 60 * 1000);
    assert.equal(result.plannedTimeMs, 7 * 60 * 60 * 1000);
    assert.equal(result.downtimeMs, 60 * 60 * 1000);
    assert.equal(result.operatingTimeMs, 6 * 60 * 60 * 1000);
    assert.equal(result.availability, 85.71);
    assert.equal(result.performance, null);
    assert.equal(result.oee, null);
});

test('disponibilidade: calendario cancela uma ocorrencia e turno atravessa meia-noite', async () => {
    const night = { ...shift, startTime: '22:00', endTime: '06:00' };
    const from = new Date(2026, 0, 10, 20), to = new Date(2026, 0, 12, 8);
    const result = await service({ shifts: [night], calendar: [{ lineId: 'linha-01', date: '2026-01-11', shiftId: shift.shiftId, productionEnabled: false }] })
        .report(from.toISOString(), to.toISOString(), new Date().getTimezoneOffset());
    assert.equal(result.scheduledTimeMs, 8 * 60 * 60 * 1000);
    assert.equal(result.plannedTimeMs, 8 * 60 * 60 * 1000);
});

test('disponibilidade: periodo materializado preserva historico sem depender do cadastro atual', async () => {
    const result = await service({ shifts: [], periods: [{ periodId: 'p1', lineId: 'linha-01', shiftId: shift.shiftId,
        operationalDate: '2026-01-10', shift: { name: 'Turno antigo', startTime: '06:00', endTime: '14:00' },
        plannedStartAt: new Date(2026, 0, 10, 6), plannedEndAt: new Date(2026, 0, 10, 14), excludedBreaks: [], createdAt: new Date() }] })
        .report(new Date(2026, 0, 10, 0).toISOString(), new Date(2026, 0, 11, 0).toISOString(), new Date().getTimezoneOffset());
    assert.equal(result.plannedTimeMs, 8 * 60 * 60 * 1000);
});

test('disponibilidade: ciclo ideal habilita performance e OEE', async () => {
    const shortShift = { ...shift, endTime: '07:00' };
    const pcm = { serialNumber: 'OEE-001', enteredAt: new Date(2026, 0, 10, 6), workflow: {
        lineId: 'linha-01', entrySequence: 1, version: 1, status: 'completed', completedAt: new Date(2026, 0, 10, 6, 30), quality: 'approved',
        stages: [{ machineId: 'm1', state: 'completed' }, { machineId: 'm2', state: 'completed', data: { positions: [true] } }]
    } };
    const value = service({ shifts: [shortShift], pcms: [pcm] });
    await value.updateConfiguration({ idealCycleTimeSeconds: 3600 });
    const result = await value.report(new Date(2026, 0, 10, 6).toISOString(), new Date(2026, 0, 10, 7).toISOString(), new Date().getTimezoneOffset());
    assert.equal(result.idealCycleTimeSeconds, 3600);
    assert.equal(result.performance, 100);
    assert.equal(result.oee, 100);
});

test('disponibilidade: estado atual informa os limites do periodo produtivo materializado', async () => {
    const wholeDay = { ...shift, startTime: '00:00', endTime: '00:00' };
    const result = await service({ shifts: [wholeDay] }).current();
    assert.equal(result.state, 'RUNNING');
    assert.equal(result.currentPeriod?.shift.name, shift.name);
    assert.ok(result.currentPeriod?.plannedStartAt instanceof Date);
    assert.ok(result.currentPeriod?.plannedEndAt instanceof Date);
});

test('disponibilidade: consolida emergencias simultaneas da CLP em uma unica parada', async () => {
    const value = service({ reasons: [reason] });
    const first = await value.reconcilePlcSignal('status-m1', true, reason.reasonId, 'Emergência M1');
    const second = await value.reconcilePlcSignal('status-m2', true, reason.reasonId, 'Emergência M2');
    assert.equal(first.action, 'opened'); assert.equal(second.action, 'joined');
    assert.equal(second.event.eventId, first.event.eventId);
    assert.deepEqual(second.event.sourceSignals.map(item => item.signalId).sort(), ['status-m1', 'status-m2']);

    const firstCleared = await value.reconcilePlcSignal('status-m1', false, reason.reasonId, 'Emergência M1');
    assert.equal(firstCleared.action, 'updated'); assert.equal(firstCleared.event.status, 'open');
    assert.deepEqual(firstCleared.event.activeSourceSignalIds, ['status-m2']);
    assert.deepEqual(firstCleared.event.sourceSignals.map(item => item.signalId).sort(), ['status-m1', 'status-m2']);
    assert.equal((await value.current()).state, 'STOPPED');

    const lastCleared = await value.reconcilePlcSignal('status-m2', false, reason.reasonId, 'Emergência M2');
    assert.equal(lastCleared.action, 'closed'); assert.equal(lastCleared.event.eventId, first.event.eventId);
    assert.equal(lastCleared.event.status, 'closed');
    assert.deepEqual(lastCleared.event.sourceSignals.map(item => item.signalId).sort(), ['status-m1', 'status-m2']);
});

test('disponibilidade: apontamento manual é idempotente e exige motivo ativo', async () => {
    const value = service({ shifts: [shift], reasons: [reason] });
    const requestA = '33333333-3333-4333-8333-333333333333', requestB = '44444444-4444-4444-8444-444444444444';
    const stopped = await value.stop({ reasonId: reason.reasonId, notes: 'Teste', requestId: requestA });
    assert.equal((await value.current()).state, 'STOPPED');
    assert.equal((await value.stop({ reasonId: reason.reasonId, notes: 'Teste', requestId: requestA })).eventId, stopped.eventId);
    const resumed = await value.resume({ requestId: requestB });
    assert.equal(resumed.status, 'closed');
    assert.equal((await value.current()).state, resolveCurrentState());
});

test('disponibilidade: estado físico abre, classifica e encerra uma única parada automática', async () => {
    const classifiedReason = { ...reason, reasonId: '55555555-5555-4555-8555-555555555555', code: 'AJUSTE', name: 'Ajuste' };
    const audit = [];
    const value = service({ reasons: [reason, classifiedReason], operationalLog: {
        recordSystem: async event => { audit.push(event); }
    } });
    await value.updateConfiguration({ physicalMonitoring: { enabled: true, strategy: 'serial_any_running',
        stopConfirmationMs: 5000, resumeConfirmationMs: 2000, defaultReasonId: reason.reasonId,
        referenceSignalId: '', manualContingencyEnabled: true, manualContingencyRequiresAdmin: true } });
    const stoppedAt = new Date();
    const stopped = await value.reconcilePhysicalLineState({ state: 'STOPPED', strategy: 'serial_any_running',
        reason: 'Todas as CLPs estão paradas.', capturedAt: stoppedAt, signals: [
            { signalId: 'm1', label: 'M1', productionState: 'stopped', value: 0 },
            { signalId: 'm2', label: 'M2', productionState: 'stopped', value: 0 }
        ] });
    assert.equal(stopped.action, 'opened'); assert.equal(stopped.event.classificationPending, true);
    await assert.rejects(value.resume({ requestId: '66666666-6666-4666-8666-666666666666' }), /sinais das CLPs/);
    const classified = await value.classify(stopped.event.eventId, { reasonId: classifiedReason.reasonId, notes: 'Troca de ferramenta' });
    assert.equal(classified.reason.code, 'AJUSTE'); assert.equal(classified.classificationPending, false);
    const running = await value.reconcilePhysicalLineState({ state: 'RUNNING', strategy: 'serial_any_running',
        reason: 'Duas CLPs produzindo.', capturedAt: new Date(), signals: [
            { signalId: 'm1', label: 'M1', productionState: 'running', value: 1 },
            { signalId: 'm2', label: 'M2', productionState: 'running', value: 1 }
        ] });
    assert.equal(running.action, 'closed'); assert.equal(running.event.status, 'closed');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(audit.map(item => item.action), ['PHYSICAL_DOWNTIME_STARTED', 'PHYSICAL_DOWNTIME_ENDED']);
});

test('disponibilidade: contingência manual respeita estado físico e autenticação configurada', async () => {
    const value = service({ reasons: [reason] });
    await value.updateConfiguration({ physicalMonitoring: { enabled: true, strategy: 'serial_any_running',
        stopConfirmationMs: 0, resumeConfirmationMs: 0, defaultReasonId: reason.reasonId,
        manualContingencyEnabled: true, manualContingencyRequiresAdmin: true } });
    const body = { reasonId: reason.reasonId, requestId: '77777777-7777-4777-8777-777777777777' };
    await assert.rejects(value.stop(body), /autenticacao ADMIN/);
    const manual = await value.stop(body, true); assert.equal(manual.source, 'manual');
});

test('disponibilidade: desativar consolidação permite encerrar uma parada automática remanescente', async () => {
    const value = service({ reasons: [reason] });
    const enabled = { enabled: true, strategy: 'serial_any_running', stopConfirmationMs: 0, resumeConfirmationMs: 0,
        defaultReasonId: reason.reasonId, manualContingencyEnabled: true, manualContingencyRequiresAdmin: true };
    await value.updateConfiguration({ physicalMonitoring: enabled });
    await assert.rejects(value.updateReason(reason.reasonId, { code: reason.code, name: reason.name,
        classification: reason.classification, countsAgainstAvailability: reason.countsAgainstAvailability, active: false }),
    /desative o monitoramento/);
    await assert.rejects(value.removeReason(reason.reasonId), /desative o monitoramento/);
    await value.reconcilePhysicalLineState({ state: 'STOPPED', strategy: 'serial_any_running', reason: 'CLPs paradas.',
        capturedAt: new Date(), signals: [{ signalId: 'm1', label: 'M1', productionState: 'stopped', value: 0 }] });
    await assert.rejects(value.resume({ requestId: '88888888-8888-4888-8888-888888888888' }), /sinais das CLPs/);
    await value.updateConfiguration({ physicalMonitoring: { ...enabled, enabled: false } });
    const resumed = await value.resume({ requestId: '99999999-9999-4999-8999-999999999999' });
    assert.equal(resumed.status, 'closed');
});

function resolveCurrentState() {
    const now = new Date(), minutes = now.getHours() * 60 + now.getMinutes();
    return minutes >= 360 && minutes < 840 ? 'RUNNING' : 'IDLE';
}

test('disponibilidade: valida pausa dentro do turno e motivo historico nao pode ser removido', async () => {
    const value = service({ shifts: [shift], reasons: [reason], events: [{ lineId: 'linha-01', status: 'closed', reason }] });
    await assert.rejects(value.createBreak({ shiftId: shift.shiftId, name: 'Fora', startTime: '15:00', endTime: '16:00', excludeFromPlannedTime: true, active: true }), /contida/);
    await assert.rejects(value.removeReason(reason.reasonId), /preservar o historico/);
});
