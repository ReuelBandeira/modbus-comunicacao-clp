export interface IftsBridgeConfig {
    baseUrl: string;
    apiKey: string;
    timeoutMs: number;
    startupTimeoutMs: number;
}

export interface IftsBridgeStatus {
    configured: boolean;
    online: boolean;
    status: string;
    cycleId?: string;
    model?: string;
    stationReady?: boolean;
    stationReason?: string;
    detail?: string;
}

export interface IftsBridgeReadiness extends IftsBridgeStatus {
    ready: boolean;
    startAttempted: boolean;
}

export class IftsBridgeError extends Error {
    constructor(public readonly status: 400 | 409 | 502 | 503, message: string) { super(message); }
}

type Fetcher = typeof fetch;
const cyclePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function object(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function field(value: unknown, name: string): unknown {
    const root = object(value), data = object(root.data);
    return root[name] ?? data[name];
}
function text(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function readIftsBridgeConfig(env: NodeJS.ProcessEnv = process.env): IftsBridgeConfig | undefined {
    const baseUrl = env.IFTS_BRIDGE_BASE_URL?.trim(), apiKey = env.IFTS_BRIDGE_API_KEY?.trim();
    if (!baseUrl && !apiKey) return undefined;
    if (!baseUrl || !apiKey) throw new Error('IFTS_BRIDGE_BASE_URL e IFTS_BRIDGE_API_KEY devem ser configuradas juntas.');
    let url: URL;
    try { url = new URL(baseUrl); } catch { throw new Error('IFTS_BRIDGE_BASE_URL inválida.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('IFTS_BRIDGE_BASE_URL deve ser uma URL HTTP(S) sem credenciais, query ou fragmento.');
    }
    const timeoutMs = Number(env.IFTS_BRIDGE_TIMEOUT_MS ?? 60_000);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 60_000 || timeoutMs > 300_000) {
        throw new Error('IFTS_BRIDGE_TIMEOUT_MS deve estar entre 60000 e 300000.');
    }
    const startupTimeoutMs = Number(env.IFTS_BRIDGE_STARTUP_TIMEOUT_MS ?? 60_000);
    if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 5_000 || startupTimeoutMs > 300_000) {
        throw new Error('IFTS_BRIDGE_STARTUP_TIMEOUT_MS deve estar entre 5000 e 300000.');
    }
    return { baseUrl: url.toString(), apiKey, timeoutMs, startupTimeoutMs };
}

export class IftsBridgeClient {
    constructor(private readonly config?: IftsBridgeConfig, private readonly fetcher: Fetcher = fetch) {}

    async status(timeoutMs?: number): Promise<IftsBridgeStatus> {
        if (!this.config) return { configured: false, online: false, status: 'unconfigured', detail: 'Configure o IFTS Bridge no .env.' };
        try {
            const [health, model] = await Promise.all([
                this.request('/health', 'GET', undefined, timeoutMs), this.request('/model', 'GET', undefined, timeoutMs)
            ]);
            const state = object(field(health, 'state')), ifts = object(field(health, 'ifts'));
            const rawStationReady = field(health, 'stationReady') ?? field(ifts, 'stationOk') ?? field(ifts, 'ready');
            const stationReady = typeof rawStationReady === 'boolean' ? rawStationReady : true;
            const stationReason = text(field(ifts, 'reason'));
            const cycleId = text(field(state, 'cycleId')) ?? text(field(model, 'cycleId'));
            const detail = stationReady ? text(field(health, 'message')) : this.stationDetail(stationReason, text(field(ifts, 'error')));
            return { configured: true, online: true,
                status: text(field(state, 'status')) ?? text(field(model, 'cycleStatus'))
                    ?? text(field(health, 'cycleStatus')) ?? text(field(health, 'status')) ?? 'idle',
                ...(cycleId ? { cycleId } : {}),
                ...(text(field(model, 'model')) ? { model: text(field(model, 'model')) } : {}),
                stationReady, ...(stationReason ? { stationReason } : {}), ...(detail ? { detail } : {}) };
        } catch (error) {
            return { configured: true, online: false, status: 'offline', detail: error instanceof Error ? error.message : 'Bridge indisponível.' };
        }
    }

    async readiness(startIfOffline = false): Promise<IftsBridgeReadiness> {
        let current = await this.status(12_000);
        let startAttempted = false;
        if (!current.online) {
            return { ...current, ready: false, startAttempted,
                detail: 'Bridge offline. Aguarde a tarefa de inicialização do computador da estação.' };
        }
        if (current.stationReady !== false) return { ...current, ready: true, startAttempted };
        if (!startIfOffline) return { ...current, ready: false, startAttempted };
        await this.startStation(); startAttempted = true;
        current = await this.waitFor(status => status.online && status.stationReady !== false);
        return { ...current, ready: current.online && current.stationReady !== false, startAttempted,
            ...(!current.online || current.stationReady === false
                ? { detail: current.detail ?? 'A estação IFTS não ficou pronta dentro do tempo esperado.' } : {}) };
    }

    async start(body: unknown) {
        const cycleId = this.cycleId(body);
        const current = await this.status();
        if (!current.online) throw new IftsBridgeError(502, current.detail ?? 'IFTS Bridge offline.');
        if (current.stationReady === false) throw new IftsBridgeError(503,
            current.detail ?? 'A estação IFTS não está pronta para receber testes.');
        if (current.cycleId && current.cycleId !== cycleId && current.status !== 'idle' && current.status !== 'completed') {
            throw new IftsBridgeError(409, `O Bridge já possui o ciclo ativo ${current.cycleId}.`);
        }
        return this.command('/cycle/start', cycleId);
    }
    finish(body: unknown) { return this.command('/cycle/finish', this.cycleId(body)); }
    retry(body: unknown) { return this.command('/cycle/retry', this.cycleId(body)); }
    resetDebug() { return this.request('/debug/reset', 'POST'); }

    async changeModel(body: unknown) {
        const model = text(object(body).model);
        if (!model || model.length > 120 || /[\u0000-\u001f]/.test(model)) throw new IftsBridgeError(400, 'Modelo inválido.');
        const status = await this.status();
        if (!status.online) throw new IftsBridgeError(502, status.detail ?? 'IFTS Bridge offline.');
        if (status.cycleId && status.status !== 'idle' && status.status !== 'completed') {
            throw new IftsBridgeError(409, 'O modelo só pode ser alterado sem ciclo ativo.');
        }
        const bridge = await this.request('/model', 'PUT', { model });
        return { model, bridge, warning: 'Modelo alterado. O executável do IFTS pode precisar ser reiniciado.' };
    }

    private async command(path: string, cycleId: string) {
        const bridge = await this.request(path, 'POST', { cycleId });
        return { cycleId, bridge };
    }
    private cycleId(body: unknown) {
        const value = text(object(body).cycleId);
        if (!value || !cyclePattern.test(value)) throw new IftsBridgeError(400, 'cycleId inválido.');
        return value;
    }
    private startStation() {
        const timeoutMs = (this.config?.startupTimeoutMs ?? 60_000) + 20_000;
        return this.request('/ifts/start-auto-save-set', 'POST', undefined, timeoutMs);
    }
    private async waitFor(predicate: (status: IftsBridgeStatus) => boolean): Promise<IftsBridgeStatus> {
        const deadline = Date.now() + (this.config?.startupTimeoutMs ?? 60_000);
        let current = await this.status(Math.min(12_000, Math.max(500, deadline - Date.now())));
        while (!predicate(current) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1_000));
            current = await this.status(Math.min(12_000, Math.max(500, deadline - Date.now())));
        }
        return current;
    }
    private stationDetail(reason?: string, error?: string) {
        if (error) return `Estação IFTS indisponível: ${error}`;
        const reasons: Record<string, string> = {
            not_running: 'O aplicativo IFTS não está aberto.',
            window_not_ready: 'A janela principal do IFTS ainda não está pronta.',
            auto_save_set_not_confirmed: 'O Auto Save Set do IFTS ainda não foi confirmado.',
            process_changed: 'O processo do IFTS mudou e o Auto Save Set precisa ser reaplicado.',
            model_changed: 'O modelo mudou e o Auto Save Set precisa ser reaplicado.',
            executable_not_found: 'O executável do IFTS não foi encontrado pelo Bridge.',
            automation_unavailable: 'O script de automação do IFTS não está disponível.',
            status_check_failed: 'O Bridge não conseguiu verificar o estado do IFTS.'
        };
        return reasons[reason ?? ''] ?? 'A estação IFTS ainda não está pronta para receber testes.';
    }
    private async request(path: string, method: 'GET' | 'POST' | 'PUT', body?: unknown, timeoutMs?: number): Promise<unknown> {
        if (!this.config) throw new IftsBridgeError(503, 'IFTS Bridge não configurado.');
        let response: Response;
        try {
            response = await this.fetcher(new URL(path.replace(/^\//, ''), this.config.baseUrl.endsWith('/') ? this.config.baseUrl : `${this.config.baseUrl}/`), {
                method, headers: { 'Content-Type': 'application/json', 'X-API-Key': this.config.apiKey },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs ?? this.config.timeoutMs)
            });
        } catch (error) {
            throw new IftsBridgeError(502, `Não foi possível conectar ao IFTS Bridge: ${error instanceof Error ? error.message : 'erro de rede'}.`);
        }
        const raw = await response.text(); let parsed: unknown = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { message: raw.slice(0, 300) }; }
        if (response.status === 409) throw new IftsBridgeError(409, text(field(parsed, 'error'))
            ?? text(field(parsed, 'message')) ?? text(field(parsed, 'msg')) ?? 'O Bridge recusou a operação por conflito.');
        if (!response.ok) throw new IftsBridgeError(502, text(field(parsed, 'error'))
            ?? text(field(parsed, 'message')) ?? text(field(parsed, 'msg')) ?? `IFTS Bridge respondeu HTTP ${response.status}.`);
        return parsed;
    }
}
