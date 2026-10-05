(() => {
    type Dashboard = import('../../../modules/pcm/workflow/dtos/lineDashboardDto').Json<
        import('../../../modules/pcm/workflow/dtos/lineDashboardDto').LineDashboard>;
    type Tray = Dashboard['snapshot']['recent'][number];
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const statusLabels = { approved: 'APROVADA · 100%', rejected: 'REPROVADA', indeterminate: 'RESULTADO INCOMPLETO' } as const;
    let dashboard: Dashboard | undefined;
    let shownSequence = 0;

    function date(value?: string) { return value ? new Date(value).toLocaleString('pt-BR') : '—'; }
    function completedAt(tray: EndOfLine.TrayLike) {
        return tray.workflow?.completedAt || tray.workflow?.stages.map(stage => stage.passedAt).filter(Boolean).sort().at(-1);
    }
    function setConnection(connected: boolean, text: string) {
        get('connection-dot').className = connected ? 'online' : 'offline';
        get('connection-text').textContent = text;
        document.body.classList.toggle('stale', !connected);
    }
    function renderPosition(position: EndOfLine.PositionResult) {
        const card = document.createElement('article'); card.className = `position ${position.status}`;
        const number = document.createElement('span'); number.className = 'number'; number.textContent = String(position.position).padStart(2, '0');
        const status = document.createElement('strong'); status.textContent = position.status === 'approved' ? 'APROVADA'
            : position.status === 'rejected' ? 'REPROVADA' : 'SEM RESULTADO';
        const detail = document.createElement('small'); detail.textContent = position.failedMachineNames.length
            ? `Falha: ${position.failedMachineNames.join(', ')}`
            : position.status === 'approved' ? 'Aprovada em todas as estações' : 'Dados incompletos';
        card.append(number, status, detail); return card;
    }
    function renderWaitingPosition(position: number) {
        const card = document.createElement('article'); card.className = 'position waiting';
        const number = document.createElement('span'); number.className = 'number'; number.textContent = String(position).padStart(2, '0');
        const status = document.createElement('strong'); status.textContent = 'AGUARDANDO';
        const detail = document.createElement('small'); detail.textContent = 'Sem dados da bandeja';
        card.append(number, status, detail); return card;
    }
    function renderWaitingState() {
        const positions = get('positions'); positions.replaceChildren();
        for (let position = 1; position <= EndOfLine.POSITION_COUNT; position++) positions.append(renderWaitingPosition(position));
    }
    function showTray(tray: EndOfLine.TrayLike) {
        if (!dashboard) return;
        const result = EndOfLine.summarize(tray, dashboard.line.machines);
        shownSequence = result.sequence;
        const banner = get('result-banner'); banner.className = `result-banner ${result.status}`;
        // Reinicia a animação visual sempre que uma nova bandeja sai da linha.
        banner.animate([{ opacity: .35, transform: 'scale(.99)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 450 });
        get('result-title').textContent = statusLabels[result.status];
        const completion = completedAt(tray);
        get('result-context').textContent = 'ÚLTIMA BANDEJA CONCLUÍDA';
        get('completed-at').textContent = date(completion);
        get('serial-number').textContent = tray.serialNumber;
        get('serial-number').title = tray.serialNumber;
        get('entry-sequence').textContent = `Passagem #${String(result.sequence).padStart(3, '0')}`;
        get('position-total').textContent = String(result.positions.length);
        get('position-approved').textContent = String(result.approved);
        get('position-rejected').textContent = String(result.rejected);
        get('position-indeterminate').textContent = String(result.indeterminate);
        const failures = get('failure-panel'); failures.hidden = result.status !== 'rejected';
        get('failed-machines').textContent = result.failedMachineNames.length ? result.failedMachineNames.join(', ') : 'Estação não identificada';
        get('position-note').textContent = `Concluída em ${date(completion)} · aguardando próxima bandeja`;
        const positions = get('positions'); positions.replaceChildren();
        result.positions.forEach(position => positions.append(renderPosition(position)));
    }
    function renderRecent(trays: EndOfLine.TrayLike[]) {
        const recent = get('recent'); recent.replaceChildren();
        for (const tray of EndOfLine.completedTrays(trays).slice(0, 5)) {
            const result = EndOfLine.summarize(tray, dashboard!.line.machines);
            const item = document.createElement('article'); item.className = `recent-item ${result.status}`;
            const serial = document.createElement('strong'); serial.textContent = tray.serialNumber; serial.title = tray.serialNumber;
            const detail = document.createElement('span'); detail.textContent = `#${result.sequence} · ${statusLabels[result.status]}`;
            const time = document.createElement('span'); time.textContent = date(completedAt(tray));
            item.append(serial, detail, time); recent.append(item);
        }
        if (!recent.children.length) {
            const empty = document.createElement('p'); empty.className = 'recent-empty';
            empty.textContent = 'Nenhuma bandeja concluída nesta sessão.'; recent.append(empty);
        }
    }
    function applyState(next: Dashboard) {
        dashboard = next;
        const completed = EndOfLine.completedTrays(next.snapshot.recent as EndOfLine.TrayLike[]);
        renderRecent(completed);
        const latest = completed[0];
        if (latest && (latest.workflow?.entrySequence ?? 0) !== shownSequence) showTray(latest);
    }
    async function initialState() {
        const context = await window.lineApi!.request('GET', '/api/line-context');
        if (context.httpStatus >= 400 || context.status !== 'OK') throw new Error(context.msg || 'Linha indisponível.');
        const lineId = (context.data as { entryLineId: string }).entryLineId;
        const response = await window.lineApi!.request('GET', `/api/lines/${encodeURIComponent(lineId)}/status`);
        if (response.httpStatus >= 400 || response.status !== 'OK') throw new Error(response.msg || 'Estado da linha indisponível.');
        applyState(response.data as Dashboard);
    }
    renderWaitingState();
    const unsubscribe = window.station.onRealtime(event => {
        if (event.type === 'line:state') { applyState(event.data as Dashboard); setConnection(true, 'Online · tempo real'); }
        if (event.type === 'connection') {
            const state = event.data as { connected?: boolean; status?: string };
            setConnection(!!state.connected, state.connected ? 'Online · tempo real'
                : state.status === 'connecting' ? 'Conectando…' : 'Sem conexão · tentando novamente');
        }
        if (event.type === 'error') setConnection(false, 'Sem conexão · tentando novamente');
    });
    void initialState().then(() => setConnection(true, 'Online · sincronizado'))
        .catch(() => setConnection(false, 'Sem conexão · tentando novamente'));
    void window.station.startRealtime();
    window.addEventListener('pagehide', () => {
        unsubscribe(); void window.station.stopRealtime();
    }, { once: true });
})();
