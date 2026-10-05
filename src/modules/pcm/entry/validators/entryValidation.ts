import type { EntryRequestDto } from '../dtos/entryRequestDto';
import { InvalidEntryError } from '../errors/invalidEntryError';

// O hash é opaco: não recalcular, alterar capitalização ou remover caracteres.
export function isSerialNumber(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0
        && value.length <= 512 && !/\s|[\x00-\x1f\x7f]/u.test(value);
}

// O corpo HTTP continua unknown até passar pela validação em tempo de execução.
export function parseEntryInput(body: unknown): EntryRequestDto {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new InvalidEntryError('Informe serial-number ou qr-code.');
    }
    const input = body as Record<string, unknown>;
    const hasSerial = Object.hasOwn(input, 'serial-number');
    const hasQr = Object.hasOwn(input, 'qr-code');
    if (hasSerial === hasQr) throw new InvalidEntryError('Informe apenas um campo: serial-number ou qr-code.');
    if (hasSerial) {
        if (!isSerialNumber(input['serial-number'])) {
            throw new InvalidEntryError('serial-number deve ser um texto de 1 a 512 caracteres, sem espaços ou caracteres de controle.');
        }
        return { 'serial-number': input['serial-number'] };
    }
    const qrCode = input['qr-code'];
    if (typeof qrCode !== 'string' || !qrCode.trim() || qrCode.length > 2048) {
        throw new InvalidEntryError('qr-code deve conter o texto lido pelo scanner, de 1 a 2048 caracteres.');
    }
    return { 'qr-code': qrCode };
}

