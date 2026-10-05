(() => {
    type Json<T> = import('../../../modules/pcm/workflow/dtos/lineDashboardDto').Json<T>;
    type Report = Json<import('../../../modules/pcm/workflow/dtos/chipMetricsDto').ChipMetricsReport>;
    type Summary = Report['period']['summary'];
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    let lineId = '', report: Report | undefined, timer: number | undefined, loading = false, lastSuccess = '', stopped = false;

    class ApiError extends Error { constructor(public code: number, message: string) { super(message); } }
    async function request<T>(path: string): Promise<T> {
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request('GET', path);
        else {
            const result = await fetch(path, { signal: AbortSignal.timeout(10000) });
            response = { ...await result.json(), httpStatus: result.status };
        }
        if (response.httpStatus >= 400 || response.status !== 'OK') throw new ApiError(response.httpStatus, response.msg || 'Relatório não confirmado.');
        return response.data as T;
    }
    const localInput = (value: Date) => new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    const inputDate = (id: string) => new Date(get<HTMLInputElement>(id).value);
    const formatDate = (value: string) => new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
    const formatHour = (value: string) => new Date(value).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const number = (value: number) => value.toLocaleString('pt-BR');
    function duration(ms: number | null) {
        if (ms === null) return '—';
        const seconds = Math.round(ms / 1000), hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60), rest = seconds % 60;
        return hours ? `${hours}h ${String(minutes).padStart(2, '0')}min` : minutes ? `${minutes}min ${String(rest).padStart(2, '0')}s` : `${rest}s`;
    }
    function notice(text: string, error = false) {
        get('notice').hidden = !text; get('notice').className = `notice${error ? ' error' : ''}`; get('notice').textContent = text;
    }
    function setLineState(text: string, tone: 'online' | 'stale' | 'offline') {
        const state = document.getElementById('line-state');
        if (!state) return;
        state.className = `line-state ${tone}`; state.textContent = text;
    }
    function setPreset(value: string) {
        if (value === 'custom') return;
        const now = new Date(), from = new Date(now);
        if (value === 'today') from.setHours(0, 0, 0, 0);
        else if (value === '24h') from.setTime(now.getTime() - 24 * 60 * 60 * 1000);
        else { from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (value === '7d' ? 6 : 29)); }
        get<HTMLInputElement>('period-from').value = localInput(from);
        get<HTMLInputElement>('period-to').value = localInput(now);
    }
    function renderSummary(scope: 'current' | 'period', value: Summary) {
        get(`${scope}-produced`).textContent = number(value.produced);
        get(`${scope}-approved`).textContent = number(value.approved);
        get(`${scope}-rejected`).textContent = number(value.rejected);
        get(`${scope}-rate`).textContent = value.approvalRate === null ? '—' : `${value.approvalRate.toLocaleString('pt-BR')}%`;
        get(`${scope}-cycle`).textContent = duration(value.averageCycleTimeMs);
        const issues = [];
        if (value.indeterminate) issues.push(`${number(value.indeterminate)} chip(s) com resultado indeterminado`);
        if (value.traysWithoutPositions) issues.push(`${number(value.traysWithoutPositions)} bandeja(s) sem posições registradas`);
        const note = get(`${scope}-quality-note`); note.hidden = !issues.length; note.textContent = issues.join(' · ');
    }
    function renderTrend(values: Report['last24Hours']) {
        const chart = get('trend-chart'); chart.replaceChildren();
        const maximum = Math.max(1, ...values.map(value => value.produced));
        for (const value of values) {
            const column = document.createElement('article'); column.className = 'hour-column';
            column.title = `${formatHour(value.hourStart)} · ${value.produced} produzidos · ${value.approved} aprovados · ${value.rejected} reprovados`;
            const total = document.createElement('span'); total.className = 'hour-total'; total.textContent = number(value.produced);
            const space = document.createElement('div'); space.className = 'bar-space';
            const stack = document.createElement('div'); stack.className = 'bar-stack';
            stack.style.height = `${Math.max(value.produced ? 4 : 1, value.produced / maximum * 100)}%`;
            for (const [className, amount] of [['bar-approved', value.approved], ['bar-rejected', value.rejected], ['bar-unknown', value.indeterminate]] as const) {
                const segment = document.createElement('span'); segment.className = className;
                segment.style.flex = `${amount} 0 0`; stack.append(segment);
            }
            space.append(stack);
            const label = document.createElement('span'); label.className = 'hour-label';
            label.textContent = new Date(value.hourStart).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
            column.append(total, space, label); chart.append(column);
        }
    }
    function renderHistory(values: Report['periodHourly']) {
        const body = get<HTMLTableSectionElement>('hourly-history'); body.replaceChildren();
        for (const value of [...values].reverse()) {
            const row = document.createElement('tr');
            const cells = [formatHour(value.hourStart), number(value.produced), number(value.approved), number(value.rejected),
                number(value.indeterminate), value.approvalRate === null ? '—' : `${value.approvalRate.toLocaleString('pt-BR')}%`];
            for (const text of cells) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
            body.append(row);
        }
        if (!body.children.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 6; cell.className = 'table-empty'; cell.textContent = 'Nenhuma hora no período selecionado.'; row.append(cell); body.append(row); }
    }
    function render() {
        if (!report) return;
        renderSummary('current', report.currentHour.summary); renderSummary('period', report.period.summary);
        get('current-range').textContent = `${formatDate(report.currentHour.from)} até ${formatDate(report.currentHour.to)}`;
        get('period-range').textContent = `${formatDate(report.period.from)} até ${formatDate(report.period.to)}`;
        renderTrend(report.last24Hours); renderHistory(report.periodHourly);
        get('report-updated').textContent = `Atualização automática a cada 2 segundos · última em ${formatDate(report.generatedAt)} · unidade: chips`;
    }
    async function refresh() {
        if (loading) return;
        const preset = get<HTMLSelectElement>('period-preset').value;
        if (preset !== 'custom') setPreset(preset);
        const from = inputDate('period-from'), to = inputDate('period-to');
        if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) { notice('Informe um período inicial e final válido.', true); return; }
        loading = true; get<HTMLButtonElement>('apply-period').disabled = true;
        try {
            if (!lineId) lineId = (await request<{ entryLineId: string }>('/api/line-context')).entryLineId;
            const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), timezoneOffsetMinutes: String(new Date().getTimezoneOffset()) });
            report = await request<Report>(`/api/lines/${encodeURIComponent(lineId)}/chip-metrics?${query}`);
            lastSuccess = new Date().toLocaleTimeString('pt-BR'); get('sync-status').textContent = `Ao vivo · atualizado às ${lastSuccess}`;
            get('connection-dot').className = 'dot green'; document.body.classList.remove('stale'); notice(''); render();
            setLineState('DADOS AO VIVO', 'online');
        } catch (error) {
            const message = error instanceof ApiError ? error.message : 'Não foi possível consultar as métricas no banco.';
            notice(message, true); get('sync-status').textContent = lastSuccess ? `Sem atualização · última às ${lastSuccess}` : 'Banco / API indisponível';
            get('connection-dot').className = 'dot red'; document.body.classList.add('stale');
            setLineState(lastSuccess ? 'DADOS DESATUALIZADOS' : 'COMUNICAÇÃO PERDIDA', lastSuccess ? 'stale' : 'offline');
        } finally { loading = false; get<HTMLButtonElement>('apply-period').disabled = false; }
    }
    get<HTMLSelectElement>('period-preset').onchange = event => { setPreset((event.target as HTMLSelectElement).value); };
    for (const id of ['period-from', 'period-to']) get<HTMLInputElement>(id).onchange = () => { get<HTMLSelectElement>('period-preset').value = 'custom'; };
    get('apply-period').onclick = () => { void refresh(); };
    async function poll() {
        if (stopped) return;
        if (!document.hidden) await refresh();
        if (!stopped) timer = window.setTimeout(poll, 2_000);
    }
    setPreset('today'); void poll();
    window.addEventListener('pagehide', () => { stopped = true; window.clearTimeout(timer); }, { once: true });
})();
