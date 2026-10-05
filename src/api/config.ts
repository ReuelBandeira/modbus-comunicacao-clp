export function readHttpConfig(env: NodeJS.ProcessEnv = process.env) {
    const port = Number(env.API_PORT ?? '3000');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('API_PORT inválida.');
    return { host: env.API_HOST || '0.0.0.0', port };
}

export function readBypassEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = (env.PCM_BYPASS_ENABLED ?? 'false').trim().toLowerCase();
    if (['true', '1', 'on'].includes(value)) return true;
    if (['false', '0', 'off'].includes(value)) return false;
    throw new Error('PCM_BYPASS_ENABLED deve ser true/false, 1/0 ou on/off.');
}

export function readOfflineInspectionAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
    const value = (env.ALLOW_OFFLINE_INSPECTION ?? 'false').trim().toLowerCase();
    if (['true', '1', 'on'].includes(value)) return true;
    if (['false', '0', 'off'].includes(value)) return false;
    throw new Error('ALLOW_OFFLINE_INSPECTION deve ser true/false, 1/0 ou on/off.');
}
