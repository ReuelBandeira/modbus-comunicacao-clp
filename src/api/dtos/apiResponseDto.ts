/** Contrato JSON das respostas HTTP da API. */
export type ApiResponseDto =
    | { status: 'OK'; msg?: never }
    | { status: 'ERROR'; msg: string };
