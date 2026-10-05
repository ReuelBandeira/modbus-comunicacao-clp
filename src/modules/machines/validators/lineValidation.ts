import { isIPv4 } from 'node:net';
import type { LineConfig, MachineHandshakeConfig, MachineHandshakeMap } from '../models/lineModel';
import { WorkflowError } from '../../pcm/workflow/errors/workflowError';
import { MINIMUM_PLC_PULSE_MS } from '../../modbus/services/pulseTiming';

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkflowError(400, 'Informe um objeto JSON.');
    return value as Record<string, unknown>;
}
export function identifier(value: unknown, label: string): string {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) {
        throw new WorkflowError(400, `${label}: use 1 a 80 letras, números, hífen ou sublinhado.`);
    }
    return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        throw new WorkflowError(400, `${label}: informe um inteiro de ${min} a ${max}.`);
    }
    return value;
}
function name(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new WorkflowError(400, 'Nome inválido.');
    return value.trim();
}
function bool(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') throw new WorkflowError(400, `${label}: informe verdadeiro ou falso.`);
    return value;
}
function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) throw new WorkflowError(400, `${label}: valor inválido.`);
    return value as T;
}
function noOverlap(ranges: { start: number; count: number; label: string }[], group: string) {
    for (let left = 0; left < ranges.length; left++) for (let right = left + 1; right < ranges.length; right++) {
        const a = ranges[left], b = ranges[right];
        if (a.start < b.start + b.count && b.start < a.start + a.count) {
            throw new WorkflowError(400, `${group}: ${a.label} e ${b.label} se sobrepõem.`);
        }
    }
}

function parseHandshake(value: unknown): MachineHandshakeConfig {
    const input = object(value), addresses = object(input.map);
    const address = (key: keyof MachineHandshakeMap, fallback = 0) => integer(addresses[key] ?? fallback, 0, 65535, String(key));
    const serialStartRegister = address('serialStartRegister', 3);
    const serialRegisterCount = integer(addresses.serialRegisterCount ?? 32, 1, 117, 'serialRegisterCount');
    const outputSerialStartRegister = address('outputSerialStartRegister',
        address('qrEntrySequenceRegister', 0) + serialRegisterCount);
    const positionCountRegister = address('positionCountRegister', serialStartRegister + serialRegisterCount);
    const positionStartRegister = address('positionStartRegister', positionCountRegister + 1);
    const positionRegisterCount = integer(addresses.positionRegisterCount ?? 4, 1, 117, 'positionRegisterCount');
    const map: MachineHandshakeMap = {
        requestQrCoil: address('requestQrCoil', 0), resultReadyCoil: address('resultReadyCoil', 1),
        resultAckCoil: address('resultAckCoil', 2), resultEntrySequenceRegister: address('resultEntrySequenceRegister', 100),
        resultRegister: address('resultRegister', 102), errorCodeRegister: address('errorCodeRegister', 103),
        cycleTimeRegister: address('cycleTimeRegister', 104), qrReadyCoil: address('qrReadyCoil', 0),
        qrAckCoil: address('qrAckCoil', 1), qrEntrySequenceRegister: address('qrEntrySequenceRegister', 0),
        serialLengthRegister: address('serialLengthRegister', 2), serialStartRegister,
        serialRegisterCount, outputSerialStartRegister, positionCountRegister, positionStartRegister, positionRegisterCount
    };
    const range = (start: number, count: number, label: string) => {
        if (start + count > 65536) throw new WorkflowError(400, `${label}: faixa Modbus inválida.`);
        return { start, count, label };
    };
    noOverlap([
        range(map.qrEntrySequenceRegister, 2, 'qrEntrySequenceRegister'),
        range(map.serialLengthRegister, 1, 'serialLengthRegister'),
        range(map.serialStartRegister, map.serialRegisterCount, 'serialStartRegister'),
        range(positionCountRegister, 1, 'positionCountRegister'),
        range(positionStartRegister, positionRegisterCount, 'positionStartRegister')
    ], 'Mailbox da CLP');
    if (map.serialLengthRegister !== map.qrEntrySequenceRegister + 2
        || map.serialStartRegister !== map.serialLengthRegister + 1
        || positionCountRegister !== map.serialStartRegister + map.serialRegisterCount
        || positionStartRegister !== positionCountRegister + 1) {
        throw new WorkflowError(400, 'O mailbox deve ser continuo: sequencia, tamanho, serial, quantidade e posicoes.');
    }
    const mailboxCount = positionStartRegister + positionRegisterCount - map.qrEntrySequenceRegister;
    if (mailboxCount > 123) throw new WorkflowError(400, 'O mailbox excede 123 registers e nao cabe em uma FC16.');
    const resultOkValue = integer(input.resultOkValue ?? 1, 0, 65535, 'Valor legado de resultado OK');
    const resultErrorValue = integer(input.resultErrorValue ?? 2, 0, 65535, 'Valor legado de resultado ERRO');
    if (resultOkValue === resultErrorValue) throw new WorkflowError(400, 'Os valores OK e ERRO devem ser diferentes.');
    const reconnectInitialMs = integer(input.reconnectInitialMs, 100, 60000, 'Reconexão inicial');
    const reconnectMaxMs = integer(input.reconnectMaxMs, reconnectInitialMs, 300000, 'Reconexão máxima');
    const expectedPositionCount = integer(input.expectedPositionCount ?? 20, 1,
        positionRegisterCount * 16, 'Quantidade esperada de posições');
    const inFlightCapacity = integer(input.inFlightCapacity ?? 1, 1, 32, 'Capacidade simultânea');
    if (outputSerialStartRegister + serialRegisterCount > 65536) {
        throw new WorkflowError(400, 'QR de saída: faixa Modbus inválida.');
    }
    const inputQrStart = map.qrEntrySequenceRegister;
    if (inFlightCapacity > 1 && inputQrStart < outputSerialStartRegister + serialRegisterCount
        && outputSerialStartRegister < inputQrStart + serialRegisterCount) {
        throw new WorkflowError(400, 'Os blocos de QR de entrada e saída não podem se sobrepor.');
    }
    return {
        enabled: bool(input.enabled, 'Integração habilitada'),
        inFlightCapacity,
        outputAckMode: enumValue(input.outputAckMode ?? 'pulse', ['pulse', 'plc-reset'] as const,
            'Modo da confirmacao da saida'),
        outputAckPulseMs: integer(input.outputAckPulseMs ?? MINIMUM_PLC_PULSE_MS,
            MINIMUM_PLC_PULSE_MS, 5000, 'Pulso de confirmação da saída'),
        pollingMs: integer(input.pollingMs, 50, 60000, 'Polling'),
        reconnectInitialMs, reconnectMaxMs, acceptInitialRequest: bool(input.acceptInitialRequest ?? false, 'REQUEST inicial'),
        completePassageOnResult: bool(input.completePassageOnResult ?? true, 'Resultado conclui passagem'),
        expectedPositionCount,
        phaseTimeoutMs: integer(input.phaseTimeoutMs ?? 120000, 1000, 3600000, 'Timeout da fase'),
        byteOrder: enumValue(input.byteOrder, ['be', 'le'] as const, 'Ordem dos bytes'),
        wordOrder: enumValue(input.wordOrder, ['high-low', 'low-high'] as const, 'Ordem das words'),
        resultOkValue, resultErrorValue, map
    };
}

export function parseLine(body: unknown): LineConfig {
    const input = object(body);
    const range = input.ipRange === undefined ? { min: 25, max: 75 } : object(input.ipRange);
    const min = integer(range.min, 1, 254, 'IP mínimo');
    const max = integer(range.max, min, 254, 'IP máximo');
    if (!Array.isArray(input.machines) || input.machines.length < 1 || input.machines.length > 32) {
        throw new WorkflowError(400, 'Configure de 1 a 32 máquinas na ordem física da linha.');
    }
    const machines = input.machines.map((item, index) => {
        const machine = object(item);
        if (typeof machine.host !== 'string' || !isIPv4(machine.host)) throw new WorkflowError(400, 'IP da máquina inválido.');
        integer(Number(machine.host.split('.')[3]), min, max, 'Último octeto do IP');
        const protocol = enumValue(machine.protocol ?? 'unmapped',
            ['unmapped', 'm1-qr-handshake-v1', 'ifts-qr-handshake-v1', 'result-handshake-v1'] as const, 'Protocolo');
        if (protocol === 'm1-qr-handshake-v1' && index !== 0) {
            throw new WorkflowError(400, 'O protocolo inicial de QR deve ser configurado somente na primeira máquina.');
        }
        if (protocol === 'result-handshake-v1' && index === 0) {
            throw new WorkflowError(400, 'A primeira máquina deve usar o protocolo com entrega de QR.');
        }
        if (protocol === 'ifts-qr-handshake-v1' && index === 0) {
            throw new WorkflowError(400, 'O protocolo IFTS deve ser configurado depois da primeira máquina.');
        }
        const modbus = protocol !== 'unmapped' ? parseHandshake(machine.modbus) : undefined;
        if (protocol === 'ifts-qr-handshake-v1' && modbus) {
            if (modbus.inFlightCapacity !== 1) {
                throw new WorkflowError(400, 'A estação IFTS deve operar com capacidade de uma bandeja.');
            }
            const inputStart = modbus.map.qrEntrySequenceRegister;
            const outputStart = modbus.map.outputSerialStartRegister ?? inputStart + modbus.map.serialRegisterCount;
            if (inputStart < outputStart + modbus.map.serialRegisterCount
                && outputStart < inputStart + modbus.map.serialRegisterCount) {
                throw new WorkflowError(400, 'Os blocos de QR de entrada e saída da estação IFTS não podem se sobrepor.');
            }
        }
        return {
            machineId: identifier(machine.machineId, 'machineId'), name: name(machine.name), host: machine.host,
            port: integer(machine.port ?? 502, 1, 65535, 'Porta'),
            unitId: integer(machine.unitId ?? 1, 1, 247, 'Unit ID'),
            timeoutMs: integer(machine.timeoutMs ?? 3000, 100, 10000, 'Timeout'), protocol, ...(modbus ? { modbus } : {})
        };
    });
    if (new Set(machines.map(m => m.machineId)).size !== machines.length
        || new Set(machines.map(m => `${m.host}:${m.port}:${m.unitId}`)).size !== machines.length) {
        throw new WorkflowError(400, 'Máquinas e endereços Modbus não podem se repetir na linha.');
    }
    const production = machines.some(machine => machine.protocol !== 'unmapped' && machine.modbus?.enabled);
    const mode = production ? 'production' : 'simulation';
    return { lineId: identifier(input.lineId, 'lineId'), name: name(input.name), mode,
        minimumOperators: integer(input.minimumOperators ?? 3, 1, 99, 'Operadores mínimos'),
        ipRange: { min, max }, machines, createdAt: new Date(), revision: 1 };
}
