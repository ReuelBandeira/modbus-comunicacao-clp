/** Entrada validada: exatamente um identificador, preservando o conteúdo original. */
export type EntryRequestDto =
    | { 'serial-number': string; 'qr-code'?: never }
    | { 'qr-code': string; 'serial-number'?: never };
