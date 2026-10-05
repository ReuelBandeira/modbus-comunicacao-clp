export interface ModbusOptions {
    host: string; port: number; unitId: number; timeout: number;
    writeAddress: number; registerCount: number; byteOrder: 'be' | 'le'; text: string;
    responseAddress: number; responseCount: number; responseMode: 'number' | 'text'; expected: string;
    responseTimeout: number;
}
export interface ModbusResult { ok: boolean; message: string; registers?: number[]; text?: string; written?: boolean; }
export interface ModbusMonitorOptions {
    host: string; port: number; unitId: number; timeout: number;
    includeRequestQr?: boolean; serialOnly?: boolean;
    byteOrder: 'be' | 'le'; wordOrder: 'high-low' | 'low-high';
    map: {
        requestQrCoil: number; resultReadyCoil: number; qrEntrySequenceRegister: number;
        serialLengthRegister: number; serialStartRegister: number; serialRegisterCount: number;
        positionCountRegister: number; positionStartRegister: number; positionRegisterCount: number;
    };
}
export interface ModbusMonitorResult extends ModbusResult {
    requestQr?: boolean; exitConfirmed?: boolean; mailboxEmpty?: boolean; readAt?: string;
    mailbox?: { entrySequence?: number; serialLength: number; serial: string; positionCount: number; positions: boolean[]; };
}
export type ModbusAction = 'ping' | 'probe' | 'read' | 'send' | 'monitor';
