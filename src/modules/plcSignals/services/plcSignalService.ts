import { randomUUID } from 'node:crypto';
import { MINIMUM_PLC_PULSE_MS } from '../../modbus/services/pulseTiming';
import { isIPv4 } from 'node:net';
import type { LineRepositoryContract } from '../../machines/repositories/lineRepository';
import { identifier, object } from '../../machines/validators/lineValidation';
import type { PlcAggregateStatusMapping, PlcAlarmDefinition, PlcAlarmSeverity, PlcBehavior, PlcCommand, PlcCommandInterlock, PlcCommandType, PlcDevice, PlcLineStatusColor,
    PlcLineStatusMapping, PlcReadType, PlcSeverity, PlcSignal, PlcSignalAction } from '../models/plcSignalModel';
import { PlcSignalRepository } from '../repositories/plcSignalRepository';

export class PlcSignalError extends Error { constructor(public readonly status: 400 | 404 | 409 | 503, message: string) { super(message); } }
const types = ['coil', 'discrete_input', 'holding_register', 'input_register'] as const;
const behaviors = ['warn', 'pause_entry', 'block_line', 'record_stop'] as const;
const severities = ['info', 'warning', 'critical'] as const;
const signalActions = ['none', 'line_started', 'line_stopped',
    'ifts_start', 'ifts_passage', 'ifts_finish', 'ifts_retry', 'ifts_reset'] as const;
const commandTypes = ['coil', 'holding_register'] as const;
const commandModes = ['maintained', 'pulse'] as const;
const commandScopes = ['line', 'machine'] as const;
const buttonStyles = ['primary', 'success', 'warning', 'danger'] as const;
const businessActions = ['plc_only'] as const;
const lineStatusColors = ['gray', 'green', 'yellow', 'red', 'blue'] as const;
const productionStates = ['stopped', 'running', 'warning', 'emergency'] as const;
const alarmSeverities = ['info', 'warning', 'critical', 'emergency'] as const;
const bool = (value: unknown, label: string) => { if (typeof value !== 'boolean') throw new PlcSignalError(400, `${label} deve ser booleano.`); return value; };
const integer = (value: unknown, min: number, max: number, label: string) => { if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new PlcSignalError(400, `${label} deve estar entre ${min} e ${max}.`); return value as number; };
const text = (value: unknown, label: string, max: number) => { if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new PlcSignalError(400, `${label} inválido.`); return value.trim(); };
const pick = <T extends string>(value: unknown, values: readonly T[], label: string) => { if (typeof value !== 'string' || !values.includes(value as T)) throw new PlcSignalError(400, `${label} inválido.`); return value as T; };
const logicalCode = (value: unknown, fallback: string) => {
    const code = value === undefined || value === '' ? fallback : String(value).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(code)) throw new PlcSignalError(400, 'Código deve usar letras, números e underscore.');
    return code;
};

export class PlcSignalService {
    constructor(private readonly repository: PlcSignalRepository, private readonly lines: LineRepositoryContract, private readonly lineId: string) {}
    async view() {
        const line = await this.line();
        const [devices, signals, commands, alarms] = await Promise.all([
            this.repository.devicesFor(this.lineId), this.repository.signalsFor(this.lineId), this.repository.commandsFor(this.lineId),
            this.repository.alarmDefinitionsFor(this.lineId)
        ]);
        return { devices, signals, commands, alarms, machines: line.machines.map(machine => ({ machineId: machine.machineId, name: machine.name })) };
    }
    async saveDevice(plcId: string | undefined, value: unknown) {
        await this.line();
        const input = object(value), now = new Date();
        const current = plcId ? await this.repository.device(this.lineId, identifier(plcId, 'plcId')) : undefined;
        if (plcId && !current) throw new PlcSignalError(404, 'CLP não encontrada.');
        const host = text(input.host, 'IP', 45);
        if (!isIPv4(host)) throw new PlcSignalError(400, 'Informe um endereço IPv4 válido para a CLP.');
        const device: PlcDevice = {
            plcId: current?.plcId ?? randomUUID(), lineId: this.lineId, name: text(input.name, 'Nome da CLP', 100), host,
            port: integer(input.port, 1, 65535, 'Porta'), unitId: integer(input.unitId, 1, 247, 'Unit ID'),
            timeoutMs: integer(input.timeoutMs, 100, 10000, 'Timeout'), enabled: bool(input.enabled, 'Status ativo'),
            createdAt: current?.createdAt ?? now, updatedAt: now
        };
        try { await this.repository.saveDevice(device); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) throw new PlcSignalError(409, 'Já existe uma CLP com o mesmo IP, porta e Unit ID.');
            throw error;
        }
        return device;
    }
    async removeDevice(plcId: string) {
        const id = identifier(plcId, 'plcId');
        if (await this.repository.deviceInUse(this.lineId, id)) throw new PlcSignalError(409, 'A CLP possui sinais ou comandos vinculados. Remova-os primeiro.');
        if (!await this.repository.removeDevice(this.lineId, id)) throw new PlcSignalError(404, 'CLP não encontrada.');
    }
    async saveSignal(signalId: string | undefined, value: unknown) {
        const input = object(value), plcId = identifier(input.plcId, 'plcId'); await this.device(plcId);
        const now = new Date(), current = signalId ? await this.repository.signal(this.lineId, identifier(signalId, 'signalId')) : undefined;
        if (signalId && !current) throw new PlcSignalError(404, 'Sinal não encontrado.');
        const readType = pick(input.readType, types, 'Tipo de leitura'), behavior = pick(input.behavior, behaviors, 'Comportamento');
        const onActivateAction = pick<PlcSignalAction>(input.onActivateAction ?? current?.onActivateAction ?? 'none', signalActions, 'Ação ao ativar');
        const onDeactivateAction = pick<PlcSignalAction>(input.onDeactivateAction ?? current?.onDeactivateAction ?? 'none', signalActions, 'Ação ao desativar');
        const downtimeReasonId = input.downtimeReasonId === undefined || input.downtimeReasonId === '' ? undefined
            : identifier(input.downtimeReasonId, 'downtimeReasonId');
        if ((behavior === 'record_stop' || onActivateAction === 'line_stopped' || onDeactivateAction === 'line_stopped') && !downtimeReasonId) {
            throw new PlcSignalError(400, 'Selecione o motivo de parada usado pela integração com o OEE.');
        }
        const bit = input.bit === undefined || input.bit === null || input.bit === '' ? undefined : integer(input.bit, 0, 15, 'Bit');
        if ((readType === 'coil' || readType === 'discrete_input') && bit !== undefined) throw new PlcSignalError(400, 'Coils e entradas discretas não usam bit.');
        const triggerValue = input.triggerValue === undefined || input.triggerValue === '' ? undefined
            : integer(input.triggerValue, 0, 65535, 'Valor que ativa');
        const booleanSignal = readType === 'coil' || readType === 'discrete_input' || bit !== undefined;
        const rawAggregateMappings = input.aggregateStatusMappings ?? [];
        if (!Array.isArray(rawAggregateMappings) || rawAggregateMappings.length > 16) {
            throw new PlcSignalError(400, 'Mapeamento do status agregado inválido.');
        }
        const aggregateStatusMappings: PlcAggregateStatusMapping[] = rawAggregateMappings.map((raw, index) => {
            const mapping = object(raw);
            return { value: integer(mapping.value, 0, 65535, `Valor agregado ${index + 1}`),
                label: text(mapping.label, `Nome do estado agregado ${index + 1}`, 40),
                color: pick<PlcLineStatusColor>(mapping.color, lineStatusColors, `Cor do estado agregado ${index + 1}`),
                blocksEntry: mapping.blocksEntry === undefined ? false : bool(mapping.blocksEntry, `Bloqueio do estado agregado ${index + 1}`),
                ...(mapping.productionState === undefined || mapping.productionState === '' ? {}
                    : { productionState: pick(mapping.productionState, productionStates, `Estado produtivo agregado ${index + 1}`) }) };
        });
        if (new Set(aggregateStatusMappings.map(item => item.value)).size !== aggregateStatusMappings.length) {
            throw new PlcSignalError(400, 'Cada estado agregado deve possuir um valor diferente.');
        }
        if (booleanSignal && aggregateStatusMappings.some(item => item.value !== 0 && item.value !== 1)) {
            throw new PlcSignalError(400, 'O status agregado de um sinal booleano aceita somente os valores 0 e 1.');
        }
        let machineStatus: PlcSignal['machineStatus'];
        if (input.machineStatus !== undefined && input.machineStatus !== null) {
            const rawMachineStatus = object(input.machineStatus);
            const rawMappings = rawMachineStatus.mappings;
            if (!Array.isArray(rawMappings) || !rawMappings.length || rawMappings.length > 16) {
                throw new PlcSignalError(400, 'Mapeamento do status da máquina inválido.');
            }
            const mappings: PlcLineStatusMapping[] = rawMappings.map((raw, index) => {
                const mapping = object(raw);
                return { value: integer(mapping.value, 0, 65535, `Valor da máquina ${index + 1}`),
                    label: text(mapping.label, `Nome do estado da máquina ${index + 1}`, 40),
                    color: pick<PlcLineStatusColor>(mapping.color, lineStatusColors, `Cor do estado da máquina ${index + 1}`) };
            });
            if (new Set(mappings.map(item => item.value)).size !== mappings.length) {
                throw new PlcSignalError(400, 'Cada estado da máquina deve possuir um valor diferente.');
            }
            if (booleanSignal && mappings.some(item => item.value !== 0 && item.value !== 1)) {
                throw new PlcSignalError(400, 'O status de máquina de um sinal booleano aceita somente os valores 0 e 1.');
            }
            const ihmMachineId = identifier(rawMachineStatus.ihmMachineId, 'Máquina IHM');
            const duplicate = (await this.repository.signalsFor(this.lineId)).find(item => item.signalId !== current?.signalId
                && item.enabled && item.machineStatus?.ihmMachineId === ihmMachineId);
            if (duplicate) throw new PlcSignalError(409, `O sinal ${duplicate.label} já controla o status dessa máquina IHM.`);
            machineStatus = { ihmMachineId, mappings };
        }
        const signal: PlcSignal = {
            signalId: current?.signalId ?? randomUUID(), lineId: this.lineId, plcId,
            label: text(input.label, 'Nome', 100), plcAddress: text(input.plcAddress, 'Endereço PLC', 40), readType,
            address: integer(input.address, 0, 65535, 'Endereço Modbus'), ...(bit === undefined ? {} : { bit }),
            ...(triggerValue === undefined || bit !== undefined || readType === 'coil' || readType === 'discrete_input' ? {} : { triggerValue }),
            activeValue: bool(input.activeValue, 'Valor ativo'), pollingMs: integer(input.pollingMs, 50, 60000, 'Polling'),
            severity: pick(input.severity, severities, 'Gravidade'), behavior, ...(downtimeReasonId ? { downtimeReasonId } : {}),
            onActivateAction, onDeactivateAction,
            ...(aggregateStatusMappings.length ? { aggregateStatusMappings } : {}),
            ...(machineStatus ? { machineStatus } : {}),
            requiresAcknowledgment: bool(input.requiresAcknowledgment, 'Reconhecimento'), enabled: bool(input.enabled, 'Status ativo'),
            createdAt: current?.createdAt ?? now, updatedAt: now
        };
        await this.repository.saveSignal(signal); return signal;
    }
    async removeSignal(signalId: string) {
        const id = identifier(signalId, 'signalId');
        if (await this.repository.signalInUse(this.lineId, id)) {
            throw new PlcSignalError(409, 'O sinal confirma ou intertrava um comando. Remova o vínculo antes de excluir.');
        }
        if (!await this.repository.removeSignal(this.lineId, id)) throw new PlcSignalError(404, 'Sinal não encontrado.');
    }
    async saveAlarm(alarmId: string | undefined, value: unknown) {
        const input = object(value), now = new Date();
        const current = alarmId ? await this.repository.alarmDefinition(this.lineId, identifier(alarmId, 'alarmId')) : undefined;
        if (alarmId && !current) throw new PlcSignalError(404, 'Alarme não encontrado.');
        const signalId = identifier(input.signalId, 'signalId');
        const signal = await this.repository.signal(this.lineId, signalId), alarmEnabled = bool(input.enabled, 'Status ativo');
        if (!signal || (alarmEnabled && !signal.enabled)) throw new PlcSignalError(400, 'Sinal monitorado ativo não encontrado.');
        if (!Array.isArray(input.activeValues) || !input.activeValues.length || input.activeValues.length > 64) {
            throw new PlcSignalError(400, 'Informe de 1 a 64 valores de ativação.');
        }
        const activeValues = input.activeValues.map((item, index) => integer(item, 0, 65535, `Valor ativo ${index + 1}`));
        if (new Set(activeValues).size !== activeValues.length) throw new PlcSignalError(400, 'Os valores de ativação não podem se repetir.');
        if ((signal.readType === 'coil' || signal.readType === 'discrete_input' || signal.bit !== undefined)
            && activeValues.some(item => item !== 0 && item !== 1)) {
            throw new PlcSignalError(400, 'Sinais booleanos aceitam somente os valores ativos 0 e 1.');
        }
        const optionalText = (raw: unknown, label: string, max: number) => raw === undefined || raw === null || raw === ''
            ? undefined : text(raw, label, max);
        const rawCode = text(input.code, 'Código', 80).toUpperCase();
        if (!/^[A-Z][A-Z0-9_]{2,79}$/.test(rawCode)) throw new PlcSignalError(400, 'Código do alarme deve usar letras, números e underscore.');
        const alarm: PlcAlarmDefinition = {
            alarmId: current?.alarmId ?? randomUUID(), lineId: this.lineId, code: rawCode, signalId,
            ...(optionalText(input.ihmMachineId, 'Máquina IHM', 100) ? { ihmMachineId: identifier(input.ihmMachineId, 'ihmMachineId') } : {}),
            title: text(input.title, 'Título', 100),
            ...(optionalText(input.description, 'Descrição', 300) ? { description: optionalText(input.description, 'Descrição', 300) } : {}),
            ...(optionalText(input.instruction, 'Orientação', 300) ? { instruction: optionalText(input.instruction, 'Orientação', 300) } : {}),
            severity: pick<PlcAlarmSeverity>(input.severity, alarmSeverities, 'Gravidade'), activeValues,
            requiresAcknowledgment: bool(input.requiresAcknowledgment, 'Reconhecimento'),
            blocksEntry: bool(input.blocksEntry, 'Bloqueio de entradas'),
            activationDelayMs: integer(input.activationDelayMs, 0, 60000, 'Atraso de ativação'),
            clearDelayMs: integer(input.clearDelayMs, 0, 60000, 'Atraso de normalização'),
            enabled: alarmEnabled, createdAt: current?.createdAt ?? now, updatedAt: now
        };
        try { await this.repository.saveAlarmDefinition(alarm); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) throw new PlcSignalError(409, 'Já existe um alarme com esse código.');
            throw error;
        }
        return alarm;
    }
    async removeAlarm(alarmId: string) {
        if (!await this.repository.removeAlarmDefinition(this.lineId, identifier(alarmId, 'alarmId'))) {
            throw new PlcSignalError(404, 'Alarme não encontrado.');
        }
    }
    async saveCommand(commandId: string | undefined, value: unknown) {
        const input = object(value), plcId = identifier(input.plcId, 'plcId'); await this.device(plcId);
        const now = new Date(), current = commandId ? await this.repository.command(this.lineId, identifier(commandId, 'commandId')) : undefined;
        if (commandId && !current) throw new PlcSignalError(404, 'Comando não encontrado.');
        const rawAckSignalId = input.ackSignalId ?? current?.ackSignalId;
        const ackSignalId = rawAckSignalId === undefined || rawAckSignalId === null || rawAckSignalId === ''
            ? undefined : identifier(rawAckSignalId, 'Sinal de confirmação');
        const ack = ackSignalId ? await this.repository.signal(this.lineId, ackSignalId) : undefined;
        if (ackSignalId && (!ack || !ack.enabled)) throw new PlcSignalError(404, 'Sinal ativo de confirmação não encontrado.');
        if (ack?.plcId && ack.plcId !== plcId) throw new PlcSignalError(400, 'O sinal de confirmação deve pertencer à mesma CLP.');
        const rawReplicaPlcIds = input.replicaPlcIds ?? current?.replicaPlcIds ?? [];
        if (!Array.isArray(rawReplicaPlcIds) || rawReplicaPlcIds.length > 20) {
            throw new PlcSignalError(400, 'Selecione no máximo 20 CLPs adicionais.');
        }
        const replicaPlcIds: string[] = [];
        for (const rawReplicaPlcId of rawReplicaPlcIds) {
            const replicaPlcId = identifier(rawReplicaPlcId, 'CLP adicional');
            if (replicaPlcId === plcId) throw new PlcSignalError(400, 'A CLP principal não pode ser repetida.');
            await this.device(replicaPlcId); replicaPlcIds.push(replicaPlcId);
        }
        if (new Set(replicaPlcIds).size !== replicaPlcIds.length) throw new PlcSignalError(400, 'Uma CLP adicional foi selecionada mais de uma vez.');
        const resolvedCommandId = current?.commandId ?? randomUUID();
        const scope = pick(input.scope ?? current?.scope ?? 'line', commandScopes, 'Destino');
        const targetMachineId = scope === 'machine' ? identifier(input.targetMachineId, 'Máquina de destino') : undefined;
        if (targetMachineId && !(await this.line()).machines.some(machine => machine.machineId === targetMachineId)) {
            throw new PlcSignalError(404, 'Máquina de destino não encontrada.');
        }
        const mode = pick(input.mode ?? current?.mode ?? 'maintained', commandModes, 'Modo do comando');
        const commandType = pick(input.commandType, commandTypes, 'Tipo de comando');
        const commandValue = integer(input.value, 0, 65535, 'Valor');
        if (commandType === 'coil' && commandValue !== 0 && commandValue !== 1) {
            throw new PlcSignalError(400, 'Comandos coil aceitam somente os valores 0 e 1.');
        }
        const ackTimeoutMs = integer(input.ackTimeoutMs, 100, 60000, 'Timeout de confirmação');
        const pulseMs = mode === 'pulse' ? integer(input.pulseMs ?? MINIMUM_PLC_PULSE_MS,
            MINIMUM_PLC_PULSE_MS, 10000, 'Duração do pulso') : undefined;
        const resetValue = mode === 'pulse' ? integer(input.resetValue ?? 0, 0, 65535, 'Valor de retorno') : undefined;
        if (commandType === 'coil' && resetValue !== undefined && resetValue !== 0 && resetValue !== 1) {
            throw new PlcSignalError(400, 'O retorno de um comando coil deve ser 0 ou 1.');
        }
        if (ackSignalId && pulseMs !== undefined && pulseMs >= ackTimeoutMs) {
            throw new PlcSignalError(400, 'O timeout de confirmação deve ser maior que a duração do pulso.');
        }
        const rawInterlocks = input.interlocks ?? current?.interlocks ?? [];
        if (!Array.isArray(rawInterlocks) || rawInterlocks.length > 20) throw new PlcSignalError(400, 'Intertravamentos inválidos.');
        const interlocks: PlcCommandInterlock[] = [];
        for (const raw of rawInterlocks) {
            const item = object(raw), signalId = identifier(item.signalId, 'Sinal do intertravamento');
            const signal = await this.repository.signal(this.lineId, signalId);
            if (!signal || !signal.enabled) throw new PlcSignalError(404, 'Sinal ativo do intertravamento não encontrado.');
            const rawBlockedValues = item.blockedValues;
            if (rawBlockedValues !== undefined) {
                if (!Array.isArray(rawBlockedValues) || rawBlockedValues.length < 1 || rawBlockedValues.length > 32) {
                    throw new PlcSignalError(400, 'Informe de 1 a 32 valores que bloqueiam o comando.');
                }
                const blockedValues = rawBlockedValues.map((entry, index) =>
                    integer(entry, 0, 65535, `Valor bloqueado ${index + 1}`));
                if (new Set(blockedValues).size !== blockedValues.length) {
                    throw new PlcSignalError(400, 'Os valores bloqueados do intertravamento não podem se repetir.');
                }
                if ((signal.readType === 'coil' || signal.readType === 'discrete_input' || signal.bit !== undefined)
                    && blockedValues.some(entry => entry !== 0 && entry !== 1)) {
                    throw new PlcSignalError(400, `O intertravamento do sinal ${signal.label} aceita somente os valores 0 e 1.`);
                }
                interlocks.push({ signalId, blockedValues,
                    message: text(item.message, 'Mensagem do intertravamento', 200) });
            } else {
                interlocks.push({ signalId, requiredActive: bool(item.requiredActive, 'Estado exigido'),
                    message: text(item.message, 'Mensagem do intertravamento', 200) });
            }
        }
        if (new Set(interlocks.map(item => item.signalId)).size !== interlocks.length) {
            throw new PlcSignalError(400, 'O mesmo sinal não pode ser repetido nos intertravamentos.');
        }
        const command: PlcCommand = {
            commandId: resolvedCommandId, lineId: this.lineId, plcId, ...(replicaPlcIds.length ? { replicaPlcIds } : {}),
            code: logicalCode(input.code, current?.code ?? `CMD_${resolvedCommandId.replaceAll('-', '').slice(0, 12).toUpperCase()}`),
            label: text(input.label, 'Nome', 100), plcAddress: text(input.plcAddress, 'Endereço PLC', 40),
            commandType, address: integer(input.address, 0, 65535, 'Endereço Modbus'),
            value: commandValue, ...(ackSignalId ? { ackSignalId } : {}), scope,
            ...(targetMachineId ? { targetMachineId } : {}), mode,
            ...(mode === 'pulse' ? { pulseMs, resetValue } : {}),
            visible: input.visible === undefined ? true : bool(input.visible, 'Visibilidade'),
            requiresConfirmation: input.requiresConfirmation === undefined ? current?.requiresConfirmation ?? true
                : bool(input.requiresConfirmation, 'Confirmação do operador'),
            buttonStyle: pick(input.buttonStyle ?? current?.buttonStyle ?? 'primary', buttonStyles, 'Estilo do botão'),
            order: integer(input.order ?? 0, 0, 9999, 'Ordem'),
            businessAction: pick(input.businessAction ?? 'plc_only', businessActions, 'Regra de negócio'), interlocks,
            ackTimeoutMs, enabled: bool(input.enabled, 'Status ativo'),
            createdAt: current?.createdAt ?? now, updatedAt: now
        };
        try { await this.repository.saveCommand(command); }
        catch (error) {
            if ((error as { code?: number }).code === 11000) throw new PlcSignalError(409, 'Já existe um comando com esse código.');
            throw error;
        }
        return command;
    }
    async removeCommand(commandId: string) { if (!await this.repository.removeCommand(this.lineId, identifier(commandId, 'commandId'))) throw new PlcSignalError(404, 'Comando não encontrado.'); }
    private async line() { const line = await this.lines.get(this.lineId); if (!line) throw new PlcSignalError(404, 'Linha não cadastrada.'); return line; }
    private async device(plcId: string) {
        const device = await this.repository.device(this.lineId, plcId);
        if (!device || !device.enabled) throw new PlcSignalError(404, 'CLP ativa não encontrada.');
        return device;
    }
}
