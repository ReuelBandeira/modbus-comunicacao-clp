import type { LineApiContract } from '../modules/pcm/workflow/contracts/lineApiContract';

/** A página local usa a mesma API da aplicação, sem liberar URLs arbitrárias pelo IPC. */
export function createLineApiBridge(baseUrl: string): LineApiContract {
    const line = '[a-zA-Z0-9_-]{1,80}';
    const paths = {
        GET: new RegExp(`^/api/(health|line-status|line-context|line-operation|entry-preparation/current|communication-logs|operators|shifts|ihm-machines(/configuration)?|plc-signals(/states)?|plc-controls/operational|plc-alarms/operational|ifts-bridge/status|test-results(/[^/?#]+|\\?[^#]+)?|operator-station/context|stations/end-of-line/status|availability/(current|report\\?from=[^&#]+&to=[^&#]+&timezoneOffsetMinutes=-?[0-9]+|reasons|configuration|breaks|calendar(\\?from=\\d{4}-\\d{2}-\\d{2}&to=\\d{4}-\\d{2}-\\d{2})?)|lines/${line}(/status|/trays(/[0-9]+|\\?limit=[0-9]+)?|/chip-metrics\\?from=[^&#]+&to=[^&#]+&timezoneOffsetMinutes=-?[0-9]+)?|trays/[^/?#]+)$`),
        POST: new RegExp(`^/api/(admin/sessions|station-test-reset|operators|shifts|ihm-machines|plc-(devices|signals|alarms)|plc-alarms/occurrences/${line}/acknowledge|plc-commands(/${line}/execute)?|plc-controls/${line}/execute|ifts-bridge/(start|finish|retry|debug/reset)|line-operation/start|operator-station/(entries|sessions/${line}/exit)|availability/(stops(/${line}/classify)?|resume|reasons|breaks|calendar)|lines|serial-numbers|entry-preparation/(tray|[0-9a-f-]{36}/(chips|release))|lines/${line}/(machines/${line}/(arrival|result|passage|connection-test)|trays/[0-9]+/(interventions|advance)))$`, 'i'),
        PUT: new RegExp(`^/api/(ifts-bridge/model|ihm-machines/${line}|lines/${line}(/minimum-operators)?|operators/${line}|shifts/${line}|plc-(devices|signals|commands|alarms)/${line}|availability/(configuration|(reasons|breaks)/${line}))$`),
        DELETE: new RegExp(`^/api/(operators|shifts|ihm-machines|plc-devices|plc-signals|plc-commands|plc-alarms)/${line}$|^/api/availability/(reasons|breaks|calendar)/${line}$|^/api/entry-preparation/[0-9a-f-]{36}(/chips/last)?$`, 'i')
    };
    return { async request(method, pathname, body, authorization) {
        const operationalLogs = method === 'GET' && typeof pathname === 'string'
            && /^\/api\/operational-logs(?:\?[^#]+)?$/.test(pathname);
        if (!operationalLogs && (!Object.hasOwn(paths, method) || typeof pathname !== 'string' || !paths[method].test(pathname))) {
            throw new Error('Operação da linha inválida.');
        }
        const content = body === undefined ? undefined : JSON.stringify(body);
        if (content && Buffer.byteLength(content) > 32768) throw new Error('Conteúdo excede 32 KB.');
        if (authorization !== undefined && (typeof authorization !== 'string' || authorization.length > 200)) {
            throw new Error('Autorização inválida.');
        }
        // Comandos CLP possuem prazo interno para preflight, escrita, retorno do pulso e ACK.
        // O IPC deve aguardar esse resultado, sem permitir escrita tardia: o runtime tem um
        // prazo separado que encerra o preflight antes da primeira escrita.
        const timeoutMs = pathname === '/api/line-operation/start' ? 330_000
            : pathname === '/api/line-operation' ? 15_000
            : pathname.startsWith('/api/ifts-bridge/') ? 65_000
            : pathname === '/api/station-test-reset' ? 45_000
            : /^\/api\/(plc-controls|plc-commands)\/.+\/execute$/i.test(pathname) ? 20_000 : 10_000;
        const endpoint = new URL(pathname, baseUrl);
        let response: Response;
        try {
            response = await fetch(endpoint, {
                method, headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
                body: content, signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            console.error(`[LINE_API] ${method} ${endpoint.href} falhou: ${cause.name}: ${cause.message}`, cause.cause ?? '');
            const timeout = cause.name === 'TimeoutError' || cause.name === 'AbortError';
            return { httpStatus: timeout ? 504 : 503, status: 'ERROR', msg: timeout
                ? 'O servidor da linha demorou para responder. Aguarde alguns segundos e tente novamente.'
                : 'Não foi possível comunicar com o servidor da linha. Verifique a rede e se a IHM Principal está ligada.' };
        }
        try { return { ...await response.json(), httpStatus: response.status }; }
        catch (error) {
            const cause = error instanceof Error ? error : new Error(String(error));
            console.error(`[LINE_API] ${method} ${endpoint.href} retornou uma resposta inválida: ${cause.message}`);
            return { httpStatus: 502, status: 'ERROR',
                msg: 'O servidor da linha retornou uma resposta inválida. Tente novamente ou solicite suporte.' };
        }
    } };
}
