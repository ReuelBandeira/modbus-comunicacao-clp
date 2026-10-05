import type { IndexDescription } from 'mongodb';

export interface MachineConfig {
    machineId: string;
    name: string;
    host: string;
    port: number;
    unitId: number;
    timeoutMs: number;
    // Nenhum mapa de registradores é presumido. O debug definirá o adaptador real.
    protocol: 'unmapped' | 'm1-qr-handshake-v1' | 'ifts-qr-handshake-v1' | 'result-handshake-v1';
    modbus?: MachineHandshakeConfig;
}

export interface MachineHandshakeMap {
    // PLC memory, read/written by Node.
    requestQrCoil: number;
    resultReadyCoil: number;
    resultAckCoil: number;
    resultEntrySequenceRegister: number;
    resultRegister: number;
    errorCodeRegister: number;
    cycleTimeRegister: number;
    // Node memory, read/written by the PLC.
    qrReadyCoil: number;
    qrAckCoil: number;
    qrEntrySequenceRegister: number;
    serialLengthRegister: number;
    serialStartRegister: number;
    serialRegisterCount: number;
    /** Início do QR devolvido pela CLP na saída da célula paralela. */
    outputSerialStartRegister: number;
    positionCountRegister?: number;
    positionStartRegister?: number;
    positionRegisterCount?: number;
}

export interface MachineHandshakeConfig {
    enabled: boolean;
    /** Unidades que podem permanecer simultaneamente dentro da célula. */
    inFlightCapacity: number;
    /** Pulso encerrado pelo PCM ou sinal mantido ate a CLP limpar a Coil de ACK. */
    outputAckMode: 'pulse' | 'plc-reset';
    /** Duração do pulso de confirmação enviado à CLP após persistir a saída. */
    outputAckPulseMs: number;
    pollingMs: number;
    reconnectInitialMs: number;
    reconnectMaxMs: number;
    acceptInitialRequest: boolean;
    completePassageOnResult: boolean;
    /** Quantidade exata de posições que M2..Mn devem publicar. */
    expectedPositionCount: number;
    /** Tempo máximo esperado para uma fase física do handshake. */
    phaseTimeoutMs: number;
    byteOrder: 'be' | 'le';
    wordOrder: 'high-low' | 'low-high';
    resultOkValue: number;
    resultErrorValue: number;
    map: MachineHandshakeMap;
}

export interface LineConfig {
    lineId: string;
    name: string;
    mode: 'simulation' | 'production';
    /** Quantidade mínima de operadores ativos exigida para iniciar uma bipagem. */
    minimumOperators: number;
    ipRange: { min: number; max: number };
    machines: MachineConfig[];
    createdAt: Date;
    revision: number;
    updatedAt?: Date;
}

export const linesCollection = 'pcm_lines';
export const lineIndexes: IndexDescription[] = [
    { key: { lineId: 1 }, name: 'uq_pcm_line', unique: true }
];

export interface LineCounter { _id: string; value: number; }
export const lineCountersCollection = 'pcm_line_counters';
