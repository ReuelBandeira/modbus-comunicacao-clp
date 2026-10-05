import type { MachineHandshakeConfig } from '../../machines/models/lineModel';
import { encodeTextRegisters, encodeUint32 } from '../services/registerCodec';

function illegalAddress(): never {
    throw Object.assign(new Error('Endereço fora do mapa Modbus da máquina.'), { modbusErrorCode: 2 });
}

/** Memória exposta pelo Node. Somente QR_ACK pode ser escrito pela CLP. */
export class MachineModbusMemory {
    private readonly coils = new Map<number, boolean>();
    private readonly registers = new Map<number, number>();
    constructor(private readonly config: MachineHandshakeConfig) {
        this.coils.set(config.map.qrReadyCoil, false);
        this.coils.set(config.map.qrAckCoil, false);
        this.clearRegisters();
    }
    prepare(entrySequence: number, serialNumber: string): void {
        const { map, byteOrder, wordOrder } = this.config;
        const serial = encodeTextRegisters(serialNumber, map.serialRegisterCount, byteOrder);
        this.writeRegisters(map.qrEntrySequenceRegister, encodeUint32(entrySequence, wordOrder));
        const length = Buffer.byteLength(serialNumber, 'utf8');
        if (length > 0xffff) throw new Error('Serial excede o tamanho suportado.');
        this.registers.set(map.serialLengthRegister, length);
        this.writeRegisters(map.serialStartRegister, serial);
        this.coils.set(map.qrReadyCoil, true);
    }
    setReady(value: boolean): void { this.coils.set(this.config.map.qrReadyCoil, value); }
    get ready(): boolean { return this.coils.get(this.config.map.qrReadyCoil) ?? false; }
    get acknowledged(): boolean { return this.coils.get(this.config.map.qrAckCoil) ?? false; }
    reset(): void {
        this.coils.set(this.config.map.qrReadyCoil, false);
        this.coils.set(this.config.map.qrAckCoil, false);
        this.clearRegisters();
    }
    getCoil(address: number): boolean {
        if (!this.coils.has(address)) return illegalAddress();
        return this.coils.get(address)!;
    }
    setCoil(address: number, value: boolean): void {
        if (address !== this.config.map.qrAckCoil) return illegalAddress();
        this.coils.set(address, value);
    }
    getHoldingRegister(address: number): number {
        if (!this.registers.has(address)) return illegalAddress();
        return this.registers.get(address)!;
    }
    getHoldingRegisters(address: number, count: number): number[] {
        return Array.from({ length: count }, (_, index) => this.getHoldingRegister(address + index));
    }
    private writeRegisters(address: number, values: number[]) {
        values.forEach((value, index) => this.registers.set(address + index, value));
    }
    private clearRegisters() {
        const { map } = this.config;
        this.writeRegisters(map.qrEntrySequenceRegister, [0, 0]);
        this.registers.set(map.serialLengthRegister, 0);
        this.writeRegisters(map.serialStartRegister, Array(map.serialRegisterCount).fill(0));
    }
}
