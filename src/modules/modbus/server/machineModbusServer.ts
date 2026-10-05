import { ServerTCP } from 'modbus-serial';
import type { MachineModbusMemory } from './machineModbusMemory';

export interface MachineModbusServerEndpoint {
    host: string;
    port: number;
    unitId: number;
}

export interface MachineMemoryServer {
    start(): Promise<void>;
    stop(): Promise<void>;
}

export class MachineModbusServer implements MachineMemoryServer {
    private server?: ServerTCP;
    constructor(private readonly endpoint: MachineModbusServerEndpoint, private readonly memory: MachineModbusMemory) {}
    start(): Promise<void> {
        if (this.server) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const server = this.server = new ServerTCP({
                getCoil: (address: number) => this.memory.getCoil(address),
                setCoil: (address: number, value: boolean) => this.memory.setCoil(address, value),
                getHoldingRegister: (address: number) => this.memory.getHoldingRegister(address),
                getMultipleHoldingRegisters: (address: number, length: number) => this.memory.getHoldingRegisters(address, length)
            }, { host: this.endpoint.host, port: this.endpoint.port, unitID: this.endpoint.unitId, debug: false });
            const failed = (error: Error | null) => {
                server.removeListener('initialized', initialized);
                this.server = undefined;
                reject(error ?? new Error('Falha ao iniciar o servidor Modbus.'));
            };
            const initialized = () => {
                server.removeListener('serverError', failed);
                server.on('serverError', error => console.error('[MODBUS][SERVER]', error?.message));
                server.on('socketError', error => console.warn('[MODBUS][SERVER][SOCKET]', error?.message));
                resolve();
            };
            server.once('serverError', failed);
            server.once('initialized', initialized);
        });
    }
    stop(): Promise<void> {
        const server = this.server; this.server = undefined;
        if (!server) return Promise.resolve();
        return new Promise(resolve => server.close(() => resolve()));
    }
}
