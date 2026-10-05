const test = require('node:test');
const assert = require('node:assert/strict');
const { PlcSignalService, PlcSignalError } = require('../dist/modules/plcSignals/services/plcSignalService');
const { PlcSignalRuntime } = require('../dist/modules/plcSignals/services/plcSignalRuntime');
const { MachineModbusSession } = require('../dist/modules/modbus/sessions/machineModbusSession');

function fixture() {
    const devices = [], signals = [], commands = [], alarms = [], alarmOccurrences = [];
    const repository = {
        devicesFor: async () => [...devices], signalsFor: async () => [...signals], commandsFor: async () => [...commands],
        device: async (_lineId, id) => devices.find(item => item.plcId === id) || null,
        signal: async (_lineId, id) => signals.find(item => item.signalId === id) || null,
        command: async (_lineId, id) => commands.find(item => item.commandId === id) || null,
        alarmDefinitionsFor: async () => [...alarms], alarmDefinition: async (_lineId, id) => alarms.find(item => item.alarmId === id) || null,
        saveDevice: async value => { const index = devices.findIndex(item => item.plcId === value.plcId); if (index < 0) devices.push(value); else devices[index] = value; },
        saveSignal: async value => { signals.push(value); }, saveCommand: async value => { commands.push(value); },
        saveAlarmDefinition: async value => { const index = alarms.findIndex(item => item.alarmId === value.alarmId);
            if (index < 0) alarms.push(value); else alarms[index] = value; },
        deviceInUse: async (_lineId, id) => signals.some(item => item.plcId === id) || commands.some(item => item.plcId === id),
        signalInUse: async (_lineId, id) => commands.some(item => item.ackSignalId === id
            || (item.interlocks || []).some(interlock => interlock.signalId === id)) || alarms.some(item => item.signalId === id),
        removeDevice: async (_lineId, id) => { const index = devices.findIndex(item => item.plcId === id); if (index < 0) return false; devices.splice(index, 1); return true; },
        removeSignal: async () => true, removeCommand: async () => true,
        removeAlarmDefinition: async (_lineId, id) => { const index = alarms.findIndex(item => item.alarmId === id);
            if (index < 0) return false; alarms.splice(index, 1); return true; },
        activeAlarmOccurrences: async () => alarmOccurrences.filter(item => !item.clearedAt),
        activeAlarmOccurrence: async (_lineId, alarmId) => alarmOccurrences.find(item => item.alarmId === alarmId && !item.clearedAt) || null,
        alarmHistory: async () => [...alarmOccurrences],
        alarmOccurrence: async (_lineId, id) => alarmOccurrences.find(item => item.occurrenceId === id) || null,
        saveAlarmOccurrence: async value => { const index = alarmOccurrences.findIndex(item => item.occurrenceId === value.occurrenceId);
            if (index < 0) alarmOccurrences.push({ ...value }); else alarmOccurrences[index] = { ...value }; }
    };
    const lines = { get: async () => ({ lineId: 'linha-01', machines: [{ machineId: 'M2' }] }) };
    return { service: new PlcSignalService(repository, lines, 'linha-01'), devices, signals, commands, alarms, alarmOccurrences };
}

test('CLP: separa endpoint da máquina e vincula sinal com valor exato', async () => {
    const { service, devices, signals } = fixture();
    const device = await service.saveDevice(undefined, { name: 'CLP principal', host: '192.168.1.10', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    await service.saveSignal(undefined, { plcId: device.plcId, label: 'Parada', plcAddress: 'D10',
        readType: 'holding_register', address: 10, triggerValue: 1, activeValue: true, pollingMs: 200,
        severity: 'critical', behavior: 'warn', requiresAcknowledgment: false, enabled: true });
    assert.equal(devices[0].host, '192.168.1.10');
    assert.equal(signals[0].plcId, device.plcId);
    assert.equal(signals[0].triggerValue, 1);
    await assert.rejects(() => service.removeDevice(device.plcId), error => error instanceof PlcSignalError && error.status === 409);
});

test('CLP: cadastra CLPs adicionais sem repetir a principal', async () => {
    const { service } = fixture();
    const primary = await service.saveDevice(undefined, { name: 'CLP 1', host: '192.168.1.10', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const replica = await service.saveDevice(undefined, { name: 'CLP 2', host: '192.168.1.11', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const base = { plcId: primary.plcId, replicaPlcIds: [replica.plcId], code: 'REINICIAR_ESTACAO', label: 'Reiniciar',
        scope: 'line', plcAddress: 'M20', commandType: 'coil', address: 20, value: 1, mode: 'pulse', pulseMs: 600,
        resetValue: 0, ackTimeoutMs: 5000, visible: true, requiresConfirmation: true, buttonStyle: 'danger', order: 0,
        businessAction: 'plc_only', interlocks: [], enabled: true };
    const command = await service.saveCommand(undefined, base);
    assert.deepEqual(command.replicaPlcIds, [replica.plcId]);
    await assert.rejects(() => service.saveCommand(undefined, { ...base, code: 'OUTRO_COMANDO', replicaPlcIds: [primary.plcId] }),
        error => error instanceof PlcSignalError && error.status === 400);
    await assert.rejects(() => service.saveCommand(undefined, { ...base, code: 'COIL_VALOR_INVALIDO', value: 2 }),
        error => error instanceof PlcSignalError && error.status === 400);
    await assert.rejects(() => service.saveCommand(undefined, { ...base, code: 'COIL_RETORNO_INVALIDO', resetValue: 2 }),
        error => error instanceof PlcSignalError && error.status === 400);
});

test('CLP: falha de uma replica gera aviso sem cancelar as demais', async () => {
    const command = { commandId: 'cmd-multi', code: 'REINICIAR_ESTACAO', lineId: 'linha-01', plcId: 'plc-1',
        replicaPlcIds: ['plc-2', 'plc-3'], label: 'Reiniciar', plcAddress: 'M20', commandType: 'coil', address: 20,
        value: 1, ackTimeoutMs: 5000, scope: 'line', mode: 'pulse', pulseMs: 600, resetValue: 0, enabled: true,
        createdAt: new Date(), updatedAt: new Date() };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        commandByCode: async () => command, executionByRequest: async () => null, signalsFor: async () => [],
        devicesFor: async () => ['plc-1', 'plc-2', 'plc-3'].map((plcId, index) => ({ plcId, lineId: 'linha-01',
            name: `CLP ${index + 1}`, host: `192.168.1.${index + 10}`, port: 502, unitId: 1, timeoutMs: 1000, enabled: true }))
    });
    runtime.executeCommand = async target => {
        if (target.plcId === 'plc-2') throw new Error('offline');
        return { executionId: target.plcId, requestId: target.plcId, lineId: 'linha-01', commandId: target.commandId,
            commandCode: target.code, label: target.label, status: 'completed', requestedAt: new Date(), updatedAt: new Date(), steps: [] };
    };
    const result = await runtime.executeByCode('REINICIAR_ESTACAO', 'multi-1');
    assert.equal(result.status, 'completed');
    assert.match(result.warning, /2 de 3 CLPs/);
    assert.deepEqual(result.dispatches.map(item => item.status), ['completed', 'failed', 'completed']);
});

test('CLP: cadastra interpretações do status agregado no mesmo sinal', async () => {
    const { service } = fixture();
    const device = await service.saveDevice(undefined, { name: 'CLP principal', host: '192.168.1.10', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const base = { plcId: device.plcId, label: 'Seguranca M1', plcAddress: 'D40', readType: 'holding_register',
        address: 40, triggerValue: 1, activeValue: true, pollingMs: 100, severity: 'critical', behavior: 'warn',
        requiresAcknowledgment: false, enabled: true };
    const signal = await service.saveSignal(undefined, { ...base, aggregateStatusMappings: [
        { value: 0, label: 'Linha parada', color: 'gray', blocksEntry: false, productionState: 'stopped' },
        { value: 3, label: 'Linha em emergência', color: 'red', blocksEntry: true, productionState: 'emergency' }
    ] });
    assert.deepEqual(signal.aggregateStatusMappings.map(item => item.value), [0, 3]);
    assert.deepEqual(signal.aggregateStatusMappings.map(item => item.blocksEntry), [false, true]);
    assert.deepEqual(signal.aggregateStatusMappings.map(item => item.productionState), ['stopped', 'emergency']);
    await assert.rejects(() => service.saveSignal(undefined, { ...base, address: 41, aggregateStatusMappings: [
        { value: 0, label: 'Inválido', color: 'gray', blocksEntry: false, productionState: 'idle' }
    ] }), error => error instanceof PlcSignalError && error.status === 400);
});

test('CLP: preflight do START exige comunicação com todas as CLPs antes da escrita', async () => {
    const command = { commandId: 'cmd-start', code: 'LINE_START', lineId: 'linha-01', plcId: 'plc-1',
        replicaPlcIds: ['plc-2'], label: 'Iniciar', plcAddress: 'M20', commandType: 'coil', address: 20,
        value: 1, ackTimeoutMs: 5000, scope: 'line', mode: 'pulse', pulseMs: 600, resetValue: 0, enabled: true,
        createdAt: new Date(), updatedAt: new Date() };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        commandByCode: async () => command, signalsFor: async () => [], devicesFor: async () => [
            { plcId: 'plc-1', lineId: 'linha-01', name: 'CLP M1', host: '127.0.0.1', port: 1501, unitId: 1, timeoutMs: 1000, enabled: true },
            { plcId: 'plc-2', lineId: 'linha-01', name: 'CLP M2', host: '127.0.0.1', port: 1502, unitId: 1, timeoutMs: 1000, enabled: true }
        ]
    });
    runtime.session = target => ({ readCoils: async () => {
        if (target.id === 'plc-2') throw new Error('offline'); return [false];
    }, confirmReconciled() {} });
    await assert.rejects(runtime.preflightByCode('LINE_START'), /CLP M2|offline/);
});

test('CLP: vincula um sinal de status a cada máquina IHM', async () => {
    const { service } = fixture();
    const device = await service.saveDevice(undefined, { name: 'CLP M1', host: '192.168.1.11', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const base = { plcId: device.plcId, plcAddress: 'D20', readType: 'holding_register', address: 20,
        triggerValue: 1, activeValue: true, pollingMs: 100, severity: 'info', behavior: 'warn',
        requiresAcknowledgment: false, enabled: true };
    const signal = await service.saveSignal(undefined, { ...base, label: 'Status M1', machineStatus: {
        ihmMachineId: 'M1', mappings: [
            { value: 0, label: 'Máquina parada', color: 'gray' },
            { value: 1, label: 'Em produção', color: 'green' },
            { value: 3, label: 'Em emergência', color: 'red' }
        ]
    } });
    assert.equal(signal.machineStatus.ihmMachineId, 'M1');
    assert.deepEqual(signal.machineStatus.mappings.map(item => item.value), [0, 1, 3]);
    await assert.rejects(() => service.saveSignal(undefined, { ...base, label: 'Status duplicado', address: 21,
        machineStatus: { ihmMachineId: 'M1', mappings: [{ value: 0, label: 'Parada', color: 'gray' }] } }),
    error => error instanceof PlcSignalError && error.status === 409);
});

test('CLP: cadastra alarme padronizado vinculado ao sinal monitorado', async () => {
    const { service, alarms } = fixture();
    const device = await service.saveDevice(undefined, { name: 'CLP M1', host: '192.168.1.11', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const signal = await service.saveSignal(undefined, { plcId: device.plcId, label: 'Código de falha', plcAddress: 'D21',
        readType: 'holding_register', address: 21, triggerValue: 1, activeValue: true, pollingMs: 100,
        severity: 'critical', behavior: 'warn', requiresAcknowledgment: false, enabled: true });
    const alarm = await service.saveAlarm(undefined, { code: 'M1_ESTOP', title: 'Emergência acionada',
        signalId: signal.signalId, ihmMachineId: 'M1', activeValues: [3, 7], severity: 'emergency',
        description: 'Circuito de emergência aberto.', instruction: 'Verifique e rearme a máquina.',
        blocksEntry: true, requiresAcknowledgment: true, activationDelayMs: 100, clearDelayMs: 200, enabled: true });
    assert.equal(alarm.code, 'M1_ESTOP'); assert.deepEqual(alarm.activeValues, [3, 7]); assert.equal(alarms.length, 1);
    await assert.rejects(() => service.removeSignal(signal.signalId),
        error => error instanceof PlcSignalError && error.status === 409);
});

test('CLP: alarme exige sinal ativo e limita valores de sinais booleanos', async () => {
    const { service } = fixture();
    const device = await service.saveDevice(undefined, { name: 'CLP M1', host: '192.168.1.11', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const baseSignal = { plcId: device.plcId, plcAddress: 'M21', readType: 'coil', address: 21,
        activeValue: true, pollingMs: 100, severity: 'critical', behavior: 'warn', requiresAcknowledgment: false };
    const booleanSignal = await service.saveSignal(undefined, { ...baseSignal, label: 'Emergência', enabled: true });
    const inactiveSignal = await service.saveSignal(undefined, { ...baseSignal, label: 'Reserva', address: 22, enabled: false });
    const baseAlarm = { code: 'M1_BOOLEANO', title: 'Alarme booleano', severity: 'emergency',
        blocksEntry: true, requiresAcknowledgment: true, activationDelayMs: 0, clearDelayMs: 0, enabled: true };
    await assert.rejects(() => service.saveAlarm(undefined, { ...baseAlarm, signalId: booleanSignal.signalId, activeValues: [2] }),
        error => error instanceof PlcSignalError && error.status === 400);
    await assert.rejects(() => service.saveAlarm(undefined, { ...baseAlarm, code: 'M1_INATIVO',
        signalId: inactiveSignal.signalId, activeValues: [1] }),
    error => error instanceof PlcSignalError && error.status === 400);
});

test('CLP: abre, reconhece e encerra uma única ocorrência de alarme', async () => {
    const now = new Date(), occurrences = [];
    const signal = { signalId: 'signal-alarm', lineId: 'linha-01', plcId: 'plc-1', label: 'Status M1', plcAddress: 'D20',
        readType: 'holding_register', address: 20, activeValue: true, pollingMs: 50, severity: 'critical', behavior: 'warn',
        requiresAcknowledgment: false, enabled: true, createdAt: now, updatedAt: now };
    const alarm = { alarmId: 'alarm-1', lineId: 'linha-01', code: 'M1_EMERGENCIA', signalId: signal.signalId,
        ihmMachineId: 'M1', title: 'Emergência M1', severity: 'emergency', activeValues: [3], requiresAcknowledgment: true,
        blocksEntry: true, activationDelayMs: 0, clearDelayMs: 0, enabled: true, createdAt: now, updatedAt: now };
    const repository = {
        signalsFor: async () => [signal], devicesFor: async () => [{ plcId: 'plc-1', lineId: 'linha-01', name: 'CLP M1',
            host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000, enabled: true }],
        alarmDefinitionsFor: async () => [alarm], activeAlarmOccurrences: async () => occurrences.filter(item => !item.clearedAt),
        activeAlarmOccurrence: async (_lineId, alarmId) => occurrences.find(item => item.alarmId === alarmId && !item.clearedAt) || null,
        alarmHistory: async () => [...occurrences], alarmOccurrence: async (_lineId, id) => occurrences.find(item => item.occurrenceId === id) || null,
        saveAlarmOccurrence: async value => { const index = occurrences.findIndex(item => item.occurrenceId === value.occurrenceId);
            if (index < 0) occurrences.push({ ...value }); else occurrences[index] = { ...value }; }
    };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, repository);
    let raw = 3; runtime.read = async () => raw;
    await runtime.poll();
    assert.equal((await runtime.alarms()).active.length, 1); assert.equal(occurrences.length, 1); assert.equal(runtime.blocksEntry(), true);
    const occurrenceId = occurrences[0].occurrenceId;
    const acknowledged = await runtime.acknowledgeAlarm(occurrenceId, 'Operador teste');
    assert.equal(acknowledged.status, 'acknowledged'); assert.equal(acknowledged.acknowledgedBy, 'Operador teste');
    runtime.lastPolledAt.clear(); await runtime.poll();
    assert.equal(occurrences.length, 1);
    raw = 0; runtime.lastPolledAt.clear(); await runtime.poll();
    assert.equal((await runtime.alarms()).active.length, 0); assert.equal(occurrences[0].status, 'cleared');
    assert.equal(runtime.blocksEntry(), false);

    raw = 3; runtime.lastPolledAt.clear(); await runtime.poll();
    const concurrentId = occurrences.at(-1).occurrenceId;
    raw = 0; runtime.lastPolledAt.clear();
    const concurrent = await Promise.allSettled([runtime.acknowledgeAlarm(concurrentId, 'Operador concorrente'), runtime.poll()]);
    assert.ok(concurrent.some(item => item.status === 'fulfilled'));
    assert.equal((await runtime.alarms()).active.length, 0);
    assert.equal(occurrences.find(item => item.occurrenceId === concurrentId).status, 'cleared');
});

test('CLP: duas instâncias não duplicam a ocorrência ativa do mesmo alarme', async () => {
    const now = new Date(), occurrences = [];
    const signal = { signalId: 'signal-shared', lineId: 'linha-01', plcId: 'plc-1', label: 'Emergência', plcAddress: 'D20',
        readType: 'holding_register', address: 20, activeValue: true, pollingMs: 50, severity: 'critical', behavior: 'warn',
        requiresAcknowledgment: false, enabled: true, createdAt: now, updatedAt: now };
    const alarm = { alarmId: 'alarm-shared', lineId: 'linha-01', code: 'SHARED_ESTOP', signalId: signal.signalId,
        title: 'Emergência compartilhada', severity: 'emergency', activeValues: [3], requiresAcknowledgment: false,
        blocksEntry: true, activationDelayMs: 0, clearDelayMs: 0, enabled: true, createdAt: now, updatedAt: now };
    const repository = {
        signalsFor: async () => [signal], devicesFor: async () => [{ plcId: 'plc-1', lineId: 'linha-01', name: 'CLP',
            host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000, enabled: true }],
        alarmDefinitionsFor: async () => [alarm], activeAlarmOccurrences: async () => [],
        activeAlarmOccurrence: async (_lineId, alarmId) => occurrences.find(item => item.alarmId === alarmId && !item.clearedAt) || null,
        saveAlarmOccurrence: async value => {
            const duplicate = occurrences.find(item => item.deduplicationKey === value.deduplicationKey
                && item.occurrenceId !== value.occurrenceId);
            if (duplicate) { const error = new Error('duplicate key'); error.code = 11000; throw error; }
            const index = occurrences.findIndex(item => item.occurrenceId === value.occurrenceId);
            if (index < 0) occurrences.push({ ...value }); else occurrences[index] = { ...value };
        }
    };
    const createRuntime = () => {
        const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, repository);
        runtime.read = async () => 3; return runtime;
    };
    const first = createRuntime(), second = createRuntime(); await Promise.all([first.poll(), second.poll()]);
    assert.equal(occurrences.length, 1);
    assert.equal((await first.alarms()).active[0].occurrenceId, occurrences[0].occurrenceId);
    assert.equal((await second.alarms()).active[0].occurrenceId, occurrences[0].occurrenceId);
});

test('CLP: configura regras internas nas transicoes do sinal', async () => {
    const { service } = fixture();
    const device = await service.saveDevice(undefined, { name: 'CLP principal', host: '192.168.1.10', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const input = { plcId: device.plcId, label: 'Linha ativa', plcAddress: 'D101.0', readType: 'holding_register',
        address: 101, bit: 0, activeValue: true, pollingMs: 200, severity: 'info', behavior: 'warn',
        onActivateAction: 'line_started', onDeactivateAction: 'line_stopped', requiresAcknowledgment: false, enabled: true };
    await assert.rejects(() => service.saveSignal(undefined, input),
        error => error instanceof PlcSignalError && error.status === 400);
    const signal = await service.saveSignal(undefined, { ...input, downtimeReasonId: 'sem-producao' });
    assert.equal(signal.onActivateAction, 'line_started');
    assert.equal(signal.onDeactivateAction, 'line_stopped');
    assert.equal(signal.downtimeReasonId, 'sem-producao');
});

test('CLP: executa regra apenas quando o estado monitorado muda', async () => {
    const executions = [], handled = [], values = [false, false, true, true, false];
    const signal = { signalId: 'signal-running', lineId: 'linha-01', plcId: 'plc-1', label: 'Linha ativa',
        plcAddress: 'D101.0', readType: 'holding_register', address: 101, bit: 0, activeValue: true, pollingMs: 50,
        severity: 'info', behavior: 'warn', onActivateAction: 'line_started', onDeactivateAction: 'line_stopped',
        downtimeReasonId: 'sem-producao', requiresAcknowledgment: false, enabled: true,
        createdAt: new Date(), updatedAt: new Date() };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        signalsFor: async () => [signal], devicesFor: async () => [{ plcId: 'plc-1', lineId: 'linha-01', name: 'CLP',
            host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000, enabled: true }],
        saveSignalActionExecution: async value => { const index = executions.findIndex(item => item.executionId === value.executionId);
            if (index < 0) executions.push({ ...value }); else executions[index] = { ...value }; }
    }, undefined, {}, {
        line_started: async () => { handled.push('line_started'); },
        line_stopped: async () => { handled.push('line_stopped'); }
    });
    runtime.read = async () => values.shift();
    for (let index = 0; index < 5; index++) { runtime.lastPolledAt.clear(); await runtime.poll(); }
    assert.deepEqual(handled, ['line_started', 'line_stopped']);
    assert.equal(executions.length, 2);
    assert.ok(executions.every(item => item.status === 'completed'));
});

test('CLP: configura comando pulsado com código, ACK, destino e intertravamento', async () => {
    const { service, commands } = fixture();
    const device = await service.saveDevice(undefined, { name: 'CLP', host: '10.0.0.10', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const ack = await service.saveSignal(undefined, { plcId: device.plcId, label: 'Linha executando', plcAddress: 'D11',
        readType: 'holding_register', address: 11, triggerValue: 1, activeValue: true, pollingMs: 100,
        severity: 'info', behavior: 'warn', requiresAcknowledgment: false, enabled: true });
    const safe = await service.saveSignal(undefined, { plcId: device.plcId, label: 'Segurança operacional', plcAddress: 'D12',
        readType: 'holding_register', address: 12, triggerValue: 1, activeValue: true, pollingMs: 100,
        severity: 'warning', behavior: 'warn', requiresAcknowledgment: false, enabled: true });
    const command = await service.saveCommand(undefined, { plcId: device.plcId, code: 'LINE_START', label: 'Iniciar linha',
        scope: 'machine', targetMachineId: 'M2', plcAddress: 'D20.0', commandType: 'holding_register', address: 20,
        value: 1, mode: 'pulse', pulseMs: 600, resetValue: 0, ackSignalId: ack.signalId, ackTimeoutMs: 5000,
        visible: true, requiresConfirmation: true, buttonStyle: 'success', order: 1, businessAction: 'plc_only',
        interlocks: [{ signalId: safe.signalId, requiredActive: true, message: 'Segurança operacional não liberada.' }], enabled: true });
    assert.equal(command.code, 'LINE_START'); assert.equal(command.mode, 'pulse'); assert.equal(command.targetMachineId, 'M2');
    assert.equal(commands.length, 1);
    await assert.rejects(() => service.removeSignal(safe.signalId), error => error instanceof PlcSignalError && error.status === 409);
});

test('CLP: rejeita pulso maior que o timeout e intertravamento repetido', async () => {
    const { service } = fixture();
    const device = await service.saveDevice(undefined, { name: 'CLP', host: '10.0.0.10', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const signal = await service.saveSignal(undefined, { plcId: device.plcId, label: 'ACK', plcAddress: 'D11',
        readType: 'holding_register', address: 11, triggerValue: 1, activeValue: true, pollingMs: 100,
        severity: 'info', behavior: 'warn', requiresAcknowledgment: false, enabled: true });
    const base = { plcId: device.plcId, code: 'LINE_RESET', label: 'Reset', scope: 'line', plcAddress: 'D20.1',
        commandType: 'holding_register', address: 20, value: 2, mode: 'pulse', resetValue: 0,
        ackSignalId: signal.signalId, visible: true, requiresConfirmation: true, buttonStyle: 'warning', order: 2,
        businessAction: 'plc_only', enabled: true };
    await assert.rejects(() => service.saveCommand(undefined, { ...base, pulseMs: 500, ackTimeoutMs: 5000, interlocks: [] }),
        error => error instanceof PlcSignalError && error.status === 400 && /600/.test(error.message));
    await assert.rejects(() => service.saveCommand(undefined, { ...base, pulseMs: 1000, ackTimeoutMs: 500, interlocks: [] }),
        error => error instanceof PlcSignalError && error.status === 400);
    await assert.rejects(() => service.saveCommand(undefined, { ...base, pulseMs: 600, ackTimeoutMs: 5000,
        interlocks: [{ signalId: signal.signalId, requiredActive: false, message: 'Bloqueado.' },
            { signalId: signal.signalId, requiredActive: true, message: 'Bloqueado novamente.' }] }),
        error => error instanceof PlcSignalError && error.status === 400);
});

test('CLP: comando sem ACK conclui somente depois de desligar o pulso', async () => {
    const executions = [], writes = [];
    const command = { commandId: 'cmd-pulse', code: 'LINE_START', lineId: 'linha-01', plcId: 'plc-1', label: 'Iniciar',
        plcAddress: 'M20', commandType: 'coil', address: 20, value: 1, ackTimeoutMs: 5000, scope: 'line',
        mode: 'pulse', pulseMs: 1, resetValue: 0, enabled: true, createdAt: new Date(), updatedAt: new Date() };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        commandByCode: async () => command, executionByRequest: async () => null,
        createExecution: async value => { executions.push({ ...value }); },
        saveExecution: async value => { executions.push({ ...value, steps: [...value.steps] }); },
        signalsFor: async () => [], devicesFor: async () => []
    });
    runtime.targetForSignal = () => ({ id: 'plc-1', logId: 'plc:plc-1', host: '127.0.0.1', port: 1506, unitId: 1, timeoutMs: 1000 });
    runtime.session = () => ({ readCoils: async () => [false],
        writeCoil: async (_address, value) => { writes.push(value); }, confirmReconciled() {} });
    runtime.poll = async () => {};
    const startedAt = Date.now();
    const result = await runtime.executeByCode('LINE_START', 'pulse-no-ack');
    assert.deepEqual(writes, [true, false]);
    assert.equal(result.status, 'completed');
    assert.equal(executions.at(-1).status, 'completed');
    assert.equal(executions.some(item => item.status === 'waiting_ack'), false);
    assert.ok(Date.now() - startedAt >= 590, 'configuração legada também deve gerar pulso mínimo de 600 ms');
});

test('CLP: comando sem ACK registra escrita incerta sem bloquear o próximo comando', async () => {
    const executions = [];
    const command = { commandId: 'cmd-no-ack', code: 'LINE_START', lineId: 'linha-01', plcId: 'plc-1', label: 'Iniciar',
        plcAddress: 'M20', commandType: 'coil', address: 20, value: 1, ackTimeoutMs: 5000, scope: 'line',
        mode: 'maintained', enabled: true, createdAt: new Date(), updatedAt: new Date() };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        commandByCode: async () => command, executionByRequest: async () => null,
        createExecution: async value => { executions.push({ ...value }); },
        saveExecution: async value => { executions.push({ ...value, steps: [...value.steps] }); },
        signalsFor: async () => [], devicesFor: async () => []
    });
    let writes = 0;
    const session = new MachineModbusSession({ host: '127.0.0.1' }, () => ({
        setID() {}, setTimeout() {}, connectTCP: async () => {},
        readHoldingRegisters: async () => ({ data: [0] }),
        readCoils: async () => ({ data: [false] }),
        writeCoil: async () => { writes++; throw new Error('timeout'); },
        destroy: callback => callback()
    }));
    runtime.targetForSignal = () => ({ id: 'plc-1', logId: 'plc:plc-1', host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000 });
    runtime.session = () => session;
    runtime.poll = async () => {};

    await assert.rejects(runtime.executeByCode('LINE_START', 'no-ack-1'), /Escrita sem confirmação/);
    await assert.rejects(runtime.executeByCode('LINE_START', 'no-ack-2'), /Escrita sem confirmação/);
    assert.equal(writes, 2);
    assert.equal(executions.at(-1).status, 'uncertain');
    assert.match(executions.at(-1).error, /valor ativo: valor 1, FC05, endereço Modbus 20/);
    session.dispose();
});

test('CLP: leitura previa recupera socket obsoleto antes de uma unica escrita', async () => {
    const command = { commandId: 'cmd-reconnect', code: 'LINE_START', lineId: 'linha-01', plcId: 'plc-1', label: 'Iniciar',
        plcAddress: 'M20', commandType: 'coil', address: 20, value: 1, ackTimeoutMs: 5000, scope: 'line',
        mode: 'pulse', pulseMs: 600, resetValue: 0, enabled: true, createdAt: new Date(), updatedAt: new Date() };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        commandByCode: async () => command, executionByRequest: async () => null,
        createExecution: async () => {}, saveExecution: async () => {}, signalsFor: async () => [], devicesFor: async () => []
    });
    let reads = 0; const writes = [];
    const session = new MachineModbusSession({ host: '127.0.0.1', timeoutMs: 1000 }, () => ({
        setID() {}, setTimeout() {}, connectTCP: async () => {},
        readCoils: async () => { reads++; if (reads === 1) throw new Error('socket encerrado'); return { data: [false] }; },
        writeCoil: async (_address, value) => { writes.push(value); },
        destroy: callback => callback()
    }));
    runtime.targetForSignal = () => ({ id: 'plc-1', logId: 'plc:plc-1', host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000 });
    runtime.session = () => session;

    const result = await runtime.executeByCode('LINE_START', 'reconnect-before-write');
    assert.equal(result.status, 'completed');
    assert.equal(reads, 2);
    assert.deepEqual(writes, [true, false]);
    session.dispose();
});

test('CLP: intertravamento bloqueia comando por valores inteiros do registrador', async () => {
    const { service } = fixture();
    const device = await service.saveDevice(undefined, { name: 'CLP', host: '10.0.0.10', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    const signal = await service.saveSignal(undefined, { plcId: device.plcId, label: 'Status geral', plcAddress: 'D40',
        readType: 'holding_register', address: 40, triggerValue: 1, activeValue: true, pollingMs: 100,
        severity: 'info', behavior: 'warn', requiresAcknowledgment: false, enabled: true });
    const command = await service.saveCommand(undefined, { plcId: device.plcId, code: 'LINE_START', label: 'Iniciar',
        scope: 'line', plcAddress: 'M20', commandType: 'coil', address: 20, value: 1, mode: 'pulse', pulseMs: 600,
        resetValue: 0, ackTimeoutMs: 5000, visible: true, requiresConfirmation: true, buttonStyle: 'success', order: 1,
        businessAction: 'plc_only', interlocks: [{ signalId: signal.signalId, blockedValues: [1, 2, 3],
            message: 'A linha não permite START neste estado.' }], enabled: true });
    assert.deepEqual(command.interlocks[0].blockedValues, [1, 2, 3]);

    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {});
    runtime.signals = [signal];
    runtime.state.set(signal.signalId, { signalId: signal.signalId, plcId: device.plcId, label: signal.label,
        active: true, value: 2, readAt: new Date(), changedAt: new Date(), behavior: 'warn' });
    assert.deepEqual(runtime.interlockFailures(command), ['A linha não permite START neste estado.']);
    runtime.state.get(signal.signalId).value = 0;
    assert.deepEqual(runtime.interlockFailures(command), []);
});

test('CLP: rejeita IP inválido e exige motivo para parada automática no OEE', async () => {
    const { service } = fixture();
    await assert.rejects(() => service.saveDevice(undefined, { name: 'CLP', host: 'clp.local', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true }), error => error instanceof PlcSignalError && error.status === 400);
    const device = await service.saveDevice(undefined, { name: 'CLP', host: '10.0.0.10', port: 502,
        unitId: 1, timeoutMs: 3000, enabled: true });
    await assert.rejects(() => service.saveSignal(undefined, { plcId: device.plcId, label: 'Parada', plcAddress: 'D10',
        readType: 'holding_register', address: 10, triggerValue: 1, activeValue: true, pollingMs: 200,
        severity: 'critical', behavior: 'record_stop', requiresAcknowledgment: false, enabled: true }),
    error => error instanceof PlcSignalError && error.status === 400);
});

test('CLP: painel bloqueia comando cuja confirmação foi desativada', async () => {
    const command = { commandId: 'cmd-1', code: 'LINE_START', lineId: 'linha-01', plcId: 'plc-1', label: 'Iniciar',
        plcAddress: 'D20.0', commandType: 'holding_register', address: 20, value: 1, ackSignalId: 'ack-1',
        ackTimeoutMs: 5000, enabled: true, visible: true, createdAt: new Date(), updatedAt: new Date() };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        signalsFor: async () => [], devicesFor: async () => [{ plcId: 'plc-1', lineId: 'linha-01', name: 'CLP',
            host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000, enabled: true }],
        commandsFor: async () => [command], executionHistory: async () => [], signalActionHistory: async () => []
    });
    const view = await runtime.operational();
    assert.equal(view.commands[0].available, false);
    assert.match(view.commands[0].blockedReasons.join(' '), /confirmação.*não está ativo/i);
});

test('CLP: status agregado funciona com uma única CLP e extrai o bit configurado', async () => {
    const signal = { signalId: 'status-1', lineId: 'linha-01', plcId: 'plc-1', label: 'Estado geral', plcAddress: 'D30',
        readType: 'holding_register', address: 30, bit: 1, activeValue: true, pollingMs: 200, severity: 'info', behavior: 'warn',
        requiresAcknowledgment: false, enabled: true, aggregateStatusMappings: [
            { value: 0, label: 'Parada', color: 'red', blocksEntry: true },
            { value: 1, label: 'Produzindo', color: 'green', blocksEntry: false }
        ], createdAt: new Date(), updatedAt: new Date() };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        signalsFor: async () => [signal], devicesFor: async () => [{ plcId: 'plc-1', lineId: 'linha-01', name: 'CLP',
            host: '127.0.0.1', port: 502, unitId: 1, timeoutMs: 1000, enabled: true }]
    });
    assert.equal((await runtime.lineStatus()).status, 'Falha de comunicação/status');
    runtime.state.set('status-1', { signalId: 'status-1', plcId: 'plc-1', label: 'Estado geral', active: true, value: 2,
        readAt: new Date(), changedAt: new Date(), behavior: 'warn' });
    const status = await runtime.lineStatus();
    assert.equal(status.status, 'Produzindo'); assert.equal(status.color, 'green'); assert.equal(status.value, 1);
});

test('CLP: publica status operacional da máquina sem outra leitura Modbus', async () => {
    const now = new Date();
    const signal = { signalId: 'machine-status-1', lineId: 'linha-01', plcId: 'plc-1', label: 'D20 da M1', plcAddress: 'D20',
        readType: 'holding_register', address: 20, activeValue: true, pollingMs: 200, severity: 'info', behavior: 'warn',
        requiresAcknowledgment: false, enabled: true, machineStatus: { ihmMachineId: 'M1', mappings: [
            { value: 0, label: 'Máquina parada', color: 'gray' }, { value: 1, label: 'Em produção', color: 'green' },
            { value: 2, label: 'Em alerta', color: 'yellow' }, { value: 3, label: 'Em emergência', color: 'red' }
        ] }, createdAt: now, updatedAt: now };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        signalsFor: async () => [signal], devicesFor: async () => [], commandsFor: async () => [], executionHistory: async () => [],
        signalActionHistory: async () => [], alarmDefinitionsFor: async () => [], activeAlarmOccurrences: async () => [],
        alarmHistory: async () => []
    });
    let view = await runtime.operational();
    assert.equal(view.machineStatuses[0].status, 'Aguardando leitura'); assert.equal(view.machineStatuses[0].color, 'gray');

    runtime.state.set(signal.signalId, { signalId: signal.signalId, plcId: signal.plcId, label: signal.label, active: true,
        value: 1, readAt: new Date(), changedAt: new Date(), behavior: 'warn' });
    view = await runtime.operational();
    assert.equal(view.machineStatuses[0].status, 'Em produção'); assert.equal(view.machineStatuses[0].color, 'green');
    assert.equal(view.machineStatuses[0].value, 1);

    runtime.state.get(signal.signalId).error = 'timeout';
    view = await runtime.operational();
    assert.equal(view.machineStatuses[0].status, 'Sem comunicação'); assert.equal(view.machineStatuses[0].color, 'red');
    delete runtime.state.get(signal.signalId).error;
    runtime.state.get(signal.signalId).readAt = new Date(Date.now() - 2_000);
    view = await runtime.operational();
    assert.equal(view.machineStatuses[0].status, 'Leitura desatualizada'); assert.equal(view.machineStatuses[0].color, 'red');
});

test('CLP: agrega os quatro D20 com prioridade segura e bloqueio de emergência', async () => {
    const now = new Date();
    const aggregateMappings = [
        { value: 0, label: 'Linha parada', color: 'gray', blocksEntry: false },
        { value: 1, label: 'Linha em produção', color: 'green', blocksEntry: false },
        { value: 2, label: 'Alerta da linha', color: 'yellow', blocksEntry: false },
        { value: 3, label: 'Linha em emergência', color: 'red', blocksEntry: true }
    ];
    const signals = [1, 2, 3, 4].map(number => ({ signalId: `status-${number}`, lineId: 'linha-01', plcId: `plc-${number}`,
        label: `Status M${number}`, plcAddress: 'D20', readType: 'holding_register', address: 20,
        activeValue: true, pollingMs: 100, severity: 'critical', behavior: 'warn', requiresAcknowledgment: false,
        aggregateStatusMappings: aggregateMappings,
        enabled: true, createdAt: now, updatedAt: now }));
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        signalsFor: async () => signals, devicesFor: async () => []
    });
    const setValues = values => signals.forEach((signal, index) => runtime.state.set(signal.signalId, {
        signalId: signal.signalId, plcId: signal.plcId, label: signal.label, active: values[index] !== 0,
        value: values[index], readAt: new Date(), changedAt: new Date(), behavior: 'warn'
    }));

    assert.equal((await runtime.lineStatus()).status, 'Falha de comunicação/status');
    assert.equal(runtime.blocksEntry(), true);

    setValues([0, 0, 0, 0]);
    const stopped = await runtime.lineStatus();
    assert.equal(stopped.status, 'Linha parada'); assert.equal(stopped.color, 'gray'); assert.equal(runtime.blocksEntry(), false);

    setValues([1, 1, 1, 1]);
    const production = await runtime.lineStatus();
    assert.equal(production.status, 'Linha em produção'); assert.equal(production.color, 'green');

    setValues([1, 2, 1, 0]);
    const warning = await runtime.lineStatus();
    assert.equal(warning.status, 'Alerta da linha'); assert.equal(warning.color, 'yellow');
    assert.equal(runtime.blocksEntry(), false);

    setValues([1, 1, 3, 2]);
    const emergency = await runtime.lineStatus();
    assert.equal(emergency.status, 'Linha em emergência'); assert.equal(emergency.color, 'red');
    assert.equal(emergency.label, 'Status M3'); assert.equal(runtime.blocksEntry(), true);

    setValues([0, 1, 0, 1]);
    const divergent = await runtime.lineStatus();
    assert.equal(divergent.status, 'Transição/divergência'); assert.equal(divergent.color, 'blue');

    runtime.state.get('status-4').error = 'timeout';
    const failed = await runtime.lineStatus();
    assert.equal(failed.status, 'Falha de comunicação/status'); assert.equal(failed.color, 'red');
    assert.equal(runtime.blocksEntry(), true);

    runtime.state.get('status-1').value = 2;
    assert.equal((await runtime.lineStatus()).status, 'Falha de comunicação/status');
    runtime.state.get('status-2').value = 3;
    assert.equal((await runtime.lineStatus()).status, 'Linha em emergência');
});

test('CLP: runtime entrega ao OEE um estado físico consolidado das quatro CLPs', async () => {
    const now = new Date();
    const mappings = [
        { value: 0, label: 'Parada', color: 'gray', blocksEntry: false, productionState: 'stopped' },
        { value: 1, label: 'Produzindo', color: 'green', blocksEntry: false, productionState: 'running' },
        { value: 3, label: 'Emergência', color: 'red', blocksEntry: true, productionState: 'emergency' }
    ];
    const signals = [1, 2, 3, 4].map(number => ({ signalId: `physical-${number}`, lineId: 'linha-01', plcId: `plc-${number}`,
        label: `Status M${number}`, plcAddress: 'D20', readType: 'holding_register', address: 20,
        activeValue: true, pollingMs: 100, severity: 'critical', behavior: 'warn', requiresAcknowledgment: false,
        aggregateStatusMappings: mappings, enabled: true, createdAt: now, updatedAt: now }));
    const snapshots = [];
    const availability = {
        configuration: async () => ({ physicalMonitoring: { enabled: true, strategy: 'serial_any_running',
            stopConfirmationMs: 0, resumeConfirmationMs: 0, manualContingencyEnabled: false,
            manualContingencyRequiresAdmin: true } }),
        reconcilePhysicalLineState: async snapshot => { snapshots.push(snapshot); return { action: 'unchanged', event: null }; }
    };
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => ({ lineId: 'linha-01', machines: [] }) }, {
        signalsFor: async () => signals, devicesFor: async () => [], alarmDefinitionsFor: async () => [],
        activeAlarmOccurrences: async () => []
    }, availability);
    await runtime.loadConfiguration();
    const setValues = values => signals.forEach((signal, index) => runtime.state.set(signal.signalId, {
        signalId: signal.signalId, plcId: signal.plcId, label: signal.label, active: values[index] !== 0,
        value: values[index], readAt: new Date(), changedAt: new Date(), behavior: 'warn'
    }));
    setValues([1, 0, 0, 0]); await runtime.synchronizePhysicalState();
    setValues([0, 0, 0, 0]); await runtime.synchronizePhysicalState();
    setValues([1, 1, 3, 1]); await runtime.synchronizePhysicalState();
    assert.deepEqual(snapshots.map(item => item.state), ['RUNNING', 'STOPPED', 'STOPPED']);
    assert.equal(snapshots[2].signals.find(item => item.signalId === 'physical-3').productionState, 'emergency');
});

test('CLP: resultado terminal de comando alimenta o registro operacional', async () => {
    const logs = [];
    const runtime = new PlcSignalRuntime('linha-01', { get: async () => null }, { saveExecution: async () => {} },
        undefined, {}, {}, undefined, { recordSystem: async event => { logs.push(event); } });
    const now = new Date(), execution = { executionId: 'exec-1', requestId: 'req-1', lineId: 'linha-01',
        commandId: 'cmd-1', commandCode: 'LINE_START', label: 'Iniciar linha', status: 'completing',
        requestedBy: 'IHM Principal', requestedAt: now, updatedAt: now, steps: [] };
    await runtime.persist(execution, 'completed', 'business_action_completed');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(logs[0].action, 'PLC_COMMAND_COMPLETED'); assert.equal(logs[0].outcome, 'success');
    assert.equal(logs[0].actorLabel, 'IHM Principal');
});
