/** Todos os pulsos enviados pelo PCM à CLP devem permanecer ativos por mais de 500 ms. */
export const MINIMUM_PLC_PULSE_MS = 600;

/** Também protege configurações antigas já persistidas com pulsos menores. */
export function enforcedPlcPulseMs(value?: number): number {
    return Math.max(MINIMUM_PLC_PULSE_MS, value ?? MINIMUM_PLC_PULSE_MS);
}
