import ModbusRTU from 'modbus-serial';
import { isIP } from 'node:net';

export interface MachineConnection {
    host: string;
    port?: number;
    unitId?: number;
    timeoutMs?: number;
}
export interface ModbusClient {
    connectTCP(host: string, options: { port: number; timeout: number }): Promise<unknown>;
    setID(id: number): void;
    setTimeout(ms: number): void;
    readHoldingRegisters(address: number, count: number): Promise<{ data: number[] }>;
    readInputRegisters(address: number, count: number): Promise<{ data: number[] }>;
    readCoils(address: number, count: number): Promise<{ data: boolean[] }>;
    readDiscreteInputs(address: number, count: number): Promise<{ data: boolean[] }>;
    writeCoil(address: number, value: boolean): Promise<unknown>;
    writeRegisters(address: number, values: number[]): Promise<unknown>;
    destroy(callback: () => void): void;
}
export class MachineCommunicationError extends Error {
    constructor(message: string, public readonly outcomeUnknown: boolean) { super(message); }
}

/** Uma sessão por máquina. Sem retry de escrita: um timeout pode ocorrer após a CLP aplicá-la. */
export class MachineModbusSession {
    private client?: ModbusClient;
    private pending: Promise<unknown> = Promise.resolve();
    private disposed = false;
    private uncertainWrite = false;
    private readonly options: Required<MachineConnection>;

    constructor(options: MachineConnection, private readonly createClient: () => ModbusClient = () => new ModbusRTU()) {
        this.options = { host: options.host, port: options.port ?? 502,
            unitId: options.unitId ?? 1, timeoutMs: options.timeoutMs ?? 3000 };
        if (!isIP(this.options.host)) throw new Error('IP Modbus inválido.');
        this.integer(this.options.port, 1, 65535);
        this.integer(this.options.unitId, 1, 247);
        this.integer(this.options.timeoutMs, 100, 10000);
    }
    private integer(value: number, min: number, max: number) {
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Valor fora do intervalo ${min} a ${max}.`);
    }
    private range(address: number, count: number, max: number) {
        this.integer(address, 0, 65535); this.integer(count, 1, max);
        if (address + count > 65536) throw new Error('Faixa de registradores inválida.');
    }
    readHoldingRegisters(address: number, count: number): Promise<number[]> {
        this.range(address, count, 125);
        return this.run(false, async client => (await client.readHoldingRegisters(address, count)).data);
    }
    readCoils(address: number, count = 1): Promise<boolean[]> {
        this.range(address, count, 2000);
        return this.run(false, async client => (await client.readCoils(address, count)).data.slice(0, count));
    }
    readDiscreteInputs(address: number, count = 1): Promise<boolean[]> {
        this.range(address, count, 2000);
        return this.run(false, async client => (await client.readDiscreteInputs(address, count)).data.slice(0, count));
    }
    readInputRegisters(address: number, count: number): Promise<number[]> {
        this.range(address, count, 125);
        return this.run(false, async client => (await client.readInputRegisters(address, count)).data);
    }
    writeCoil(address: number, value: boolean): Promise<void> {
        this.range(address, 1, 1);
        if (typeof value !== 'boolean') throw new Error('Valor de Coil inválido.');
        return this.run(true, async client => { await client.writeCoil(address, value); });
    }
    writeRegisters(address: number, values: number[]): Promise<void> {
        this.range(address, values.length, 123);
        values.forEach(value => this.integer(value, 0, 65535));
        const snapshot = [...values];
        return this.run(true, async client => { await client.writeRegisters(address, snapshot); });
    }
    private run<T>(write: boolean, action: (client: ModbusClient) => Promise<T>): Promise<T> {
        const operation = this.pending.then(async () => {
            if (this.disposed) throw new Error('Sessão Modbus encerrada.');
            if (write && this.uncertainWrite) throw new MachineCommunicationError('Reconcilie a escrita anterior antes de enviar outro comando.', true);
            let attemptedWrite = false;
            try {
                if (!this.client) {
                    const client = this.client = this.createClient();
                    client.setID(this.options.unitId); client.setTimeout(this.options.timeoutMs);
                    await client.connectTCP(this.options.host, { port: this.options.port, timeout: this.options.timeoutMs });
                }
                if (this.disposed) throw new Error('Sessão Modbus encerrada.');
                attemptedWrite = write;
                return await action(this.client);
            } catch {
                if (attemptedWrite) this.uncertainWrite = true;
                this.client?.destroy(() => {}); this.client = undefined;
                throw new MachineCommunicationError(attemptedWrite
                    ? 'Escrita sem confirmação. Consulte a operação na CLP antes de reenviar.'
                    : 'Comunicação Modbus indisponível. A passagem permanece pendente.', attemptedWrite);
            }
        });
        this.pending = operation.catch(() => {});
        return operation;
    }
    /** Somente o adaptador, após conferir o ciclo real da CLP, pode liberar novas escritas. */
    confirmReconciled(): void { this.uncertainWrite = false; }
    dispose(): void { this.disposed = true; this.client?.destroy(() => {}); this.client = undefined; }
}
