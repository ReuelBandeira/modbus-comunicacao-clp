(() => {
    type Tray = import('../../../modules/pcm/workflow/dtos/lineDashboardDto').Json<import('../../../modules/pcm/models/pcmModel').PCM>;
    type Workflow = NonNullable<Tray['workflow']>;
    type Method = 'GET' | 'POST';
    interface Context { entryLineId: string }
    interface Dashboard { line: { machines: Array<{ machineId: string; name: string }> }; snapshot: { totals: {
        inProgress: number; removed: number; quarantined: number } } }
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const dialog = get<HTMLDialogElement>('intervention-dialog');
    let lineId = '', trays: Tray[] = [], dashboard: Dashboard | undefined, selected: Tray | undefined;
    let token = '', busy = false, refreshing = false, stopped = false, timer: number | undefined;

    async function request<T>(method: Method, path: string, body?: unknown, authenticated = false): Promise<T> {
        const authorization = authenticated && token ? `Bearer ${token}` : undefined;
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request(method, path, body, authorization);
        else {
            const result = await fetch(path, { method, headers: { 'Content-Type': 'application/json',
                ...(authorization ? { Authorization: authorization } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
            response = { ...await result.json(), httpStatus: result.status };
        }
        if (response.httpStatus >= 400 || response.status !== 'OK') {
            if (response.httpStatus === 401) logout();
            throw new Error(response.msg || 'Operação não confirmada.');
        }
        return response.data as T;
    }
    const date = (value?: string) => value ? new Date(value).toLocaleString('pt-BR') : '—';
    const machineName = (id?: string) => dashboard?.line.machines.find(machine => machine.machineId === id)?.name || id || '—';
    const statusLabel = (status: Workflow['status']) => ({ in_progress: 'EM ANDAMENTO', completed: 'CONCLUÍDA',
        removed: 'RETIRADA', quarantined: 'QUARENTENA' }[status]);
    function location(workflow: Workflow) {
        if (workflow.status === 'removed' || workflow.status === 'quarantined') {
            return workflow.intervention?.activeMachineId ? `Retirada em ${machineName(workflow.intervention.activeMachineId)}` : 'Retirada da fila';
        }
        if (workflow.status === 'completed') return 'Final da linha';
        if (workflow.activeMachineId) return machineName(workflow.activeMachineId);
        return `Fila · ${machineName(workflow.nextMachineId)}`;
    }
    function notice(message: string, error = false) {
        const element = get('tray-message'); element.hidden = !message; element.textContent = message;
        element.className = `notice${error ? ' error' : ''}`;
    }
    function setLineState(text: string, tone: 'running' | 'waiting' | 'offline') {
        const state = document.getElementById('line-state');
        if (!state) return;
        state.textContent = text; state.className = `line-state ${tone}`;
    }
    function logout() {
        token = ''; get('admin-state').textContent = 'LEITURA'; get('admin-detail').textContent = 'ADMIN exigido para intervir';
        get<HTMLButtonElement>('admin-exit').hidden = true; get<HTMLFieldSetElement>('admin-credentials').hidden = false;
        get<HTMLInputElement>('admin-password').value = '';
    }
    function render() {
        const query = get<HTMLInputElement>('tray-search').value.trim().toLocaleLowerCase('pt-BR');
        const status = get<HTMLSelectElement>('tray-status').value;
        const visible = trays.filter(tray => tray.workflow && (status === 'all' || tray.workflow.status === status)
            && (!query || tray.serialNumber.toLocaleLowerCase('pt-BR').includes(query)
                || String(tray.workflow.entrySequence).includes(query)));
        get('count-progress').textContent = String(dashboard?.snapshot.totals.inProgress ?? 0);
        get('count-removed').textContent = String(dashboard?.snapshot.totals.removed ?? 0);
        get('count-quarantined').textContent = String(dashboard?.snapshot.totals.quarantined ?? 0);
        get('result-count').textContent = `${visible.length} resultado${visible.length === 1 ? '' : 's'}`;
        const body = get<HTMLTableSectionElement>('tray-list'); body.replaceChildren();
        for (const tray of visible) {
            const workflow = tray.workflow!; const row = document.createElement('tr');
            const cell = (content = '') => { const td = document.createElement('td'); td.textContent = content; row.append(td); return td; };
            cell(String(workflow.entrySequence)); const serial = document.createElement('code'); serial.textContent = tray.serialNumber; cell().append(serial);
            const badge = document.createElement('span'); badge.className = `tray-status ${workflow.status}`; badge.textContent = statusLabel(workflow.status);
            cell().append(badge); cell(location(workflow));
            const timing = cell(); timing.className = 'tray-time';
            const entered = document.createElement('span'); entered.textContent = `Entrada: ${date(tray.enteredAt)}`; timing.append(entered);
            if (workflow.endedAt || workflow.completedAt) { const ended = document.createElement('span'); ended.textContent = `Fim: ${date(workflow.endedAt || workflow.completedAt)}`; timing.append(ended); }
            const reason = cell(workflow.intervention?.reason || '—'); reason.className = 'tray-reason'; reason.title = workflow.intervention?.notes || '';
            const actions = cell();
            if (workflow.status === 'in_progress') {
                const manage = document.createElement('button'); manage.type = 'button'; manage.className = 'button danger tray-action';
                manage.textContent = 'GERENCIAR'; manage.onclick = () => openIntervention(tray); actions.append(manage);
            } else actions.textContent = 'Histórico preservado';
            body.append(row);
        }
        if (!visible.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 7;
            cell.className = 'table-empty'; cell.textContent = 'Nenhuma bandeja encontrada neste filtro.'; row.append(cell); body.append(row); }
    }
    async function refresh() {
        if (refreshing) return; refreshing = true;
        try {
            if (!lineId) lineId = (await request<Context>('GET', '/api/line-context')).entryLineId;
            [dashboard, trays] = await Promise.all([
                request<Dashboard>('GET', `/api/lines/${encodeURIComponent(lineId)}/status`),
                request<Tray[]>('GET', `/api/lines/${encodeURIComponent(lineId)}/trays?limit=200`)
            ]);
            get('connection-dot').className = 'dot green'; get('sync-status').textContent = `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
            setLineState(dashboard.snapshot.totals.inProgress > 0 ? 'PRODUÇÃO EM ANDAMENTO' : 'AGUARDANDO BANDEJA',
                dashboard.snapshot.totals.inProgress > 0 ? 'running' : 'waiting');
            render();
        } catch (error) {
            get('connection-dot').className = 'dot red'; get('sync-status').textContent = 'Falha na atualização';
            setLineState('SEM CONEXÃO', 'offline');
            notice(error instanceof Error ? error.message : 'Não foi possível consultar as bandejas.', true);
        } finally { refreshing = false; }
    }
    function openIntervention(tray: Tray) {
        selected = tray; const workflow = tray.workflow!; const active = Boolean(workflow.activeMachineId);
        get('selected-serial').textContent = tray.serialNumber; get('selected-sequence').textContent = String(workflow.entrySequence);
        get('selected-location').textContent = location(workflow); get('physical-warning').hidden = !active;
        get<HTMLLabelElement>('physical-confirm-row').hidden = !active; const confirm = get<HTMLInputElement>('physical-confirm');
        confirm.required = active; confirm.checked = false; get<HTMLFormElement>('intervention-form').reset(); confirm.required = active;
        get<HTMLFieldSetElement>('admin-credentials').hidden = Boolean(token); dialog.showModal(); get<HTMLInputElement>('intervention-reason').focus();
    }
    function setBusy(value: boolean) {
        busy = value; dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            'button,input,select,textarea').forEach(control => control.disabled = value);
    }
    get<HTMLFormElement>('intervention-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy || !selected?.workflow) return; setBusy(true);
        try {
            if (!token) {
                const login = await request<{ token: string }>('POST', '/api/admin/sessions',
                    { password: get<HTMLInputElement>('admin-password').value });
                token = login.token; get('admin-state').textContent = 'ADMIN'; get('admin-detail').textContent = 'Sessão administrativa ativa';
                get<HTMLButtonElement>('admin-exit').hidden = false;
            }
            const action = get<HTMLSelectElement>('intervention-action').value;
            await request('POST', `/api/lines/${encodeURIComponent(lineId)}/trays/${selected.workflow.entrySequence}/interventions`, {
                action, reason: get<HTMLInputElement>('intervention-reason').value.trim(),
                notes: get<HTMLTextAreaElement>('intervention-notes').value.trim(),
                physicalRemovalConfirmed: get<HTMLInputElement>('physical-confirm').checked
            }, true);
            dialog.close(); notice(action === 'remove' ? 'Bandeja retirada da linha com histórico preservado.' : 'Bandeja colocada em quarentena.');
            await refresh();
        } catch (error) { notice(error instanceof Error ? error.message : 'Intervenção não confirmada.', true); }
        finally { setBusy(false); }
    })(); };
    get('close-intervention').onclick = () => { if (!busy) dialog.close(); };
    get('admin-exit').onclick = logout;
    get('tray-search').oninput = render; get('tray-status').onchange = render;
    void refresh(); timer = window.setInterval(() => void refresh(), 3_000);
    window.addEventListener('pagehide', () => { stopped = true; window.clearInterval(timer); }, { once: true });
    void stopped;
})();
