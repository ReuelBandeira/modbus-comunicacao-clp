(() => {
    type Method = 'GET' | 'POST';
    interface LogEvent { eventId: string; category: string; action: string; description: string; outcome: 'success' | 'failure';
        actor: { type: string; id: string; label: string }; resource?: string; method?: string; path?: string; httpStatus?: number;
        durationMs?: number; requestId?: string; details?: Record<string, string | number | boolean>; occurredAt: string }
    interface LogResult { events: LogEvent[]; retentionDays: number; generatedAt: string }
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const categoryLabels: Record<string, string> = { authentication: 'Autenticação', production: 'Produção', operators: 'Operadores',
        shifts: 'Turnos', oee: 'OEE e paradas', plc: 'CLP', configuration: 'Configuração', integration: 'Integrações', system: 'Sistema' };
    let token = '', events: LogEvent[] = [], busy = false;

    async function request<T>(method: Method, path: string, body?: unknown, authenticated = true): Promise<T> {
        const authorization = authenticated && token ? `Bearer ${token}` : undefined;
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request(method, path, body, authorization);
        else {
            const result = await fetch(path, { method, headers: { 'Content-Type': 'application/json',
                ...(authorization ? { Authorization: authorization } : {}) }, body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(10_000) });
            response = { ...await result.json(), httpStatus: result.status };
        }
        if (response.httpStatus >= 400 || response.status !== 'OK') {
            if (response.httpStatus === 401 && authenticated) logout();
            throw new Error(response.msg || 'Operação não confirmada.');
        }
        return response.data as T;
    }
    function setBusy(value: boolean) {
        busy = value;
        document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')
            .forEach(item => item.disabled = value);
    }
    function message(value: string, error = false) {
        const output = get('log-message'); output.hidden = !value; output.textContent = value;
        output.className = `notice${error ? ' error' : ''}`;
    }
    function localInput(date: Date) {
        const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
        return shifted.toISOString().slice(0, 16);
    }
    function setDefaultPeriod() {
        const now = new Date(), from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        get<HTMLInputElement>('filter-from').value = localInput(from); get<HTMLInputElement>('filter-to').value = localInput(now);
    }
    function detailList(event: LogEvent) {
        const details = document.createElement('details'); details.className = 'log-details';
        const summary = document.createElement('summary'); summary.textContent = 'Ver'; details.append(summary);
        const list = document.createElement('dl');
        const values: Array<[string, unknown]> = [['Recurso', event.resource], ['Caminho', event.path], ['HTTP', event.httpStatus],
            ['Duração', event.durationMs === undefined ? undefined : `${event.durationMs} ms`], ['Requisição', event.requestId],
            ...Object.entries(event.details ?? {})];
        for (const [label, value] of values.filter(([, value]) => value !== undefined && value !== '')) {
            const term = document.createElement('dt'), description = document.createElement('dd');
            term.textContent = label; description.textContent = String(value); list.append(term, description);
        }
        details.append(list); return details;
    }
    function cell(content: Node | string, className = '') {
        const value = document.createElement('td'); value.className = className;
        typeof content === 'string' ? value.textContent = content : value.append(content); return value;
    }
    function render() {
        const body = get<HTMLTableSectionElement>('log-list'); body.replaceChildren();
        for (const event of events) {
            const row = document.createElement('tr');
            const category = document.createElement('span'); category.className = 'category-badge';
            category.textContent = categoryLabels[event.category] ?? event.category;
            const action = document.createElement('div'); action.className = 'log-action';
            const description = document.createElement('strong'); description.textContent = event.description;
            const code = document.createElement('code'); code.textContent = event.action; action.append(description, code);
            const outcome = document.createElement('span'); outcome.className = `outcome-badge ${event.outcome}`;
            outcome.textContent = event.outcome === 'success' ? 'SUCESSO' : 'FALHA';
            row.append(cell(new Date(event.occurredAt).toLocaleString('pt-BR')), cell(category), cell(action, 'log-description'),
                cell(event.actor.label), cell(outcome), cell(detailList(event))); body.append(row);
        }
        if (!events.length) {
            const row = document.createElement('tr'), empty = cell('Nenhum registro encontrado para os filtros informados.', 'table-empty');
            empty.colSpan = 6; row.append(empty); body.append(row);
        }
        get('summary-total').textContent = String(events.length);
        get('summary-success').textContent = String(events.filter(item => item.outcome === 'success').length);
        get('summary-failure').textContent = String(events.filter(item => item.outcome === 'failure').length);
        get('summary-last').textContent = events[0] ? new Date(events[0].occurredAt).toLocaleString('pt-BR') : '—';
    }
    function query() {
        const params = new URLSearchParams({ from: new Date(get<HTMLInputElement>('filter-from').value).toISOString(),
            to: new Date(get<HTMLInputElement>('filter-to').value).toISOString(), limit: '1000' });
        for (const [id, key] of [['filter-category', 'category'], ['filter-outcome', 'outcome'], ['filter-actor', 'actor'],
            ['filter-search', 'search']] as const) {
            const value = get<HTMLInputElement | HTMLSelectElement>(id).value.trim(); if (value) params.set(key, value);
        }
        return params.toString();
    }
    async function load() {
        if (busy) return; setBusy(true); message('');
        try {
            const result = await request<LogResult>('GET', `/api/operational-logs?${query()}`);
            events = result.events; render(); get('retention-status').textContent = `Retenção automática: ${result.retentionDays} dias.`;
            get('sync-status').textContent = `Atualizado às ${new Date(result.generatedAt).toLocaleTimeString('pt-BR')}`;
            get('connection-dot').className = 'dot green';
        } catch (error) { message(error instanceof Error ? error.message : 'Consulta não confirmada.', true); }
        finally { setBusy(false); }
    }
    function csvValue(value: unknown) { return `"${String(value ?? '').replace(/"/g, '""')}"`; }
    function exportCsv() {
        if (!events.length) { message('Não há registros para exportar.', true); return; }
        const rows = [['Data e hora', 'Categoria', 'Ação', 'Descrição', 'Responsável', 'Resultado', 'Recurso', 'HTTP', 'Duração ms', 'Request ID'],
            ...events.map(event => [new Date(event.occurredAt).toLocaleString('pt-BR'), categoryLabels[event.category] ?? event.category,
                event.action, event.description, event.actor.label, event.outcome === 'success' ? 'Sucesso' : 'Falha',
                event.resource ?? '', event.httpStatus ?? '', event.durationMs ?? '', event.requestId ?? ''])];
        const csv = `\uFEFF${rows.map(row => row.map(csvValue).join(';')).join('\r\n')}`;
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const link = document.createElement('a'); link.href = url;
        link.download = `registro-operacional-${new Date().toISOString().slice(0, 10)}.csv`; link.click(); URL.revokeObjectURL(url);
        message(`${events.length} registro(s) exportado(s).`);
    }
    function logout() {
        token = ''; events = []; get('logs-panel').hidden = true; get('login-panel').hidden = false;
        get<HTMLInputElement>('admin-password').value = ''; get('connection-dot').className = 'dot';
        get('sync-status').textContent = 'Acesso ADMIN necessário';
    }

    get<HTMLFormElement>('login-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true); get('login-message').hidden = true;
        try {
            const session = await request<{ token: string }>('POST', '/api/admin/sessions',
                { password: get<HTMLInputElement>('admin-password').value }, false);
            token = session.token; get<HTMLInputElement>('admin-password').value = '';
            get('login-panel').hidden = true; get('logs-panel').hidden = false; setDefaultPeriod();
        } catch (error) {
            const output = get('login-message'); output.hidden = false;
            output.textContent = error instanceof Error ? error.message : 'Autenticação não confirmada.';
        } finally { setBusy(false); }
        if (token) await load();
    })(); };
    get<HTMLFormElement>('filter-form').onsubmit = event => { event.preventDefault(); void load(); };
    get('export-csv').onclick = exportCsv; get('logout').onclick = logout;
})();
