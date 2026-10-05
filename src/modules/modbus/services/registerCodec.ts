export type ByteOrder = 'be' | 'le';
export type WordOrder = 'high-low' | 'low-high';

export function encodeTextRegisters(text: string, count: number, order: ByteOrder): number[] {
    if (!Number.isInteger(count) || count < 1 || count > 123) throw new Error('Quantidade de registradores inválida.');
    if (typeof text !== 'string' || !text.length) throw new Error('Informe o conteúdo do QR code.');
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.length > count * 2) throw new Error(`Texto ocupa ${bytes.length} bytes; capacidade de ${count * 2}.`);
    const padded = Buffer.alloc(count * 2); bytes.copy(padded);
    return Array.from({ length: count }, (_, index) => order === 'be'
        ? padded.readUInt16BE(index * 2) : padded.readUInt16LE(index * 2));
}

export function decodeTextRegisters(registers: number[], order: ByteOrder): string {
    const bytes = Buffer.alloc(registers.length * 2);
    registers.forEach((value, index) => order === 'be'
        ? bytes.writeUInt16BE(value, index * 2) : bytes.writeUInt16LE(value, index * 2));
    const terminator = bytes.indexOf(0);
    return bytes.subarray(0, terminator === -1 ? bytes.length : terminator).toString('utf8');
}

export function encodeUint32(value: number, order: WordOrder): [number, number] {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw new Error('Valor UINT32 inválido.');
    const high = Math.floor(value / 0x10000), low = value & 0xffff;
    return order === 'high-low' ? [high, low] : [low, high];
}

export function decodeUint32(registers: number[], order: WordOrder): number {
    if (registers.length !== 2 || registers.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff)) {
        throw new Error('São necessários dois registradores UINT16 válidos.');
    }
    const [high, low] = order === 'high-low' ? registers : [registers[1], registers[0]];
    return high * 0x10000 + low;
}

/** Posicoes booleanas, bit 0 primeiro, agrupadas em holding registers UINT16. */
export function encodeBooleanRegisters(values: boolean[], registerCount: number): number[] {
    if (!Number.isInteger(registerCount) || registerCount < 1 || registerCount > 123) {
        throw new Error('Quantidade de registradores de posicoes invalida.');
    }
    if (values.length > registerCount * 16) throw new Error('Quantidade de posicoes excede a capacidade do mailbox.');
    const registers = Array<number>(registerCount).fill(0);
    values.forEach((value, index) => {
        if (value) registers[Math.floor(index / 16)] |= 1 << (index % 16);
    });
    return registers;
}

export function decodeBooleanRegisters(registers: number[], count: number): boolean[] {
    if (!Number.isInteger(count) || count < 0 || count > registers.length * 16) {
        throw new Error('Quantidade de posicoes invalida no mailbox.');
    }
    return Array.from({ length: count }, (_, index) =>
        (registers[Math.floor(index / 16)] & (1 << (index % 16))) !== 0);
}
