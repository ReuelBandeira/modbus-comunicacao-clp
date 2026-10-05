(() => {
    type Json<T> = import('../../../modules/pcm/workflow/dtos/lineDashboardDto').Json<T>;
    type Session = Json<import('../../../modules/operatorSessions/models/operatorSessionModel').OperatorStationSession>;
    type Shift = Json<import('../../../modules/shifts/models/shiftModel').Shift>;
    interface Context {
        station: { stationId: string; name: string };
        currentShift: Shift | null;
        activeOperators: Session[];
        staffing: { active: number; minimum: number; satisfied: boolean };
        capturedAt: string;
    }
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    let context: Context | undefined, busy = false, stopped = false, pollTimer: number | undefined, messageTimer: number | undefined;
    let lastSuccess = '';

    async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request(method, path, body);
        else {
            const result = await fetch(path, { method, headers: { 'Content-Type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
            response = { ...await result.json(), httpStatus: result.status };
        }
        if (response.httpStatus >= 400 || response.status !== 'OK') throw new Error(response.msg || 'Operação não confirmada.');
        return response.data as T;
    }
    function setLineState(text: string, tone: 'waiting' | 'running' | 'offline' | 'stale') {
        const state = document.getElementById('line-state');
        if (!state) return;
        state.className = `line-state ${tone}`; state.textContent = text;
    }
    function showMessage(text: string, tone: 'success' | 'error' | 'info', duration = 5000) {
        window.clearTimeout(messageTimer);
        const message = get('operation-message'); message.textContent = text; message.dataset.tone = tone; message.dataset.visible = 'true';
        messageTimer = window.setTimeout(() => { message.dataset.visible = 'false'; message.textContent = ''; }, duration);
    }
    function setBusy(value: boolean) {
        busy = value; get<HTMLInputElement>('operator-registration').disabled = value;
        get<HTMLButtonElement>('operator-submit').disabled = value;
    }
    function focusRegistration() {
        if (!document.hidden && !busy) get<HTMLInputElement>('operator-registration').focus({ preventScroll: true });
    }
    function render() {
        get('shift-name').textContent = context?.currentShift?.name || 'Sem turno vigente';
        get('shift-time').textContent = context?.currentShift
            ? `${context.currentShift.startTime}–${context.currentShift.endTime}` : 'Verifique o cadastro e o horário dos turnos';
        const active = context?.staffing.active ?? context?.activeOperators.length ?? 0;
        const minimum = context?.staffing.minimum ?? 3;
        const satisfied = context?.staffing.satisfied ?? false;
        get('active-count').textContent = `${active} / ${minimum}`;
        get('staffing-status').textContent = satisfied ? 'Equipe mínima atendida' : `Faltam ${Math.max(0, minimum - active)} operador(es)`;
        get('staffing-status').className = satisfied ? 'staffing-ok' : 'staffing-pending';
        document.querySelector('.count-summary')?.classList.toggle('insufficient', !satisfied);
        const list = get('active-operators'); list.replaceChildren();
        for (const session of context?.activeOperators || []) {
            const card = document.createElement('article'); card.className = 'operator-presence';
            const name = document.createElement('strong'); name.textContent = session.operator.name;
            const registration = document.createElement('code'); registration.textContent = session.operator.registration;
            const time = document.createElement('span'); time.textContent = `Entrada: ${new Date(session.startedAt).toLocaleString('pt-BR')}`;
            card.append(name, registration, time); list.append(card);
        }
        if (!list.children.length) {
            const empty = document.createElement('div'); empty.className = 'empty';
            const strong = document.createElement('strong'); strong.textContent = 'Nenhum operador ativo nesta estação'; empty.append(strong); list.append(empty);
        }
    }
    async function refresh() {
        try {
            context = await request<Context>('GET', '/api/operator-station/context');
            lastSuccess = new Date().toLocaleTimeString('pt-BR');
            get('connection-dot').className = 'dot green'; get('sync-status').textContent = `Atualizado às ${lastSuccess}`;
            const ready = !!context.currentShift && context.staffing.satisfied;
            setLineState(ready ? 'EQUIPE LIBERADA' : context.currentShift ? 'EQUIPE INCOMPLETA' : 'SEM TURNO VIGENTE',
                ready ? 'running' : 'waiting');
            render();
        } catch (error) {
            get('connection-dot').className = 'dot red';
            get('sync-status').textContent = lastSuccess ? `Sem atualização · última às ${lastSuccess}` : 'Banco / API indisponível';
            setLineState(lastSuccess ? 'DADOS DESATUALIZADOS' : 'COMUNICAÇÃO PERDIDA', lastSuccess ? 'stale' : 'offline');
            if (!lastSuccess) showMessage(error instanceof Error ? error.message : 'Não foi possível consultar a estação.', 'error');
        }
    }
    async function identify(registration: string) {
        if (busy) return;
        setBusy(true);
        try {
            const active = context?.activeOperators.find(session => session.operator.registration === registration);
            if (active) {
                if (!window.confirm(`Finalizar a operação de ${active.operator.name} nesta estação?`)) return;
                await request('POST', `/api/operator-station/sessions/${encodeURIComponent(active.sessionId)}/exit`,
                    { requestId: crypto.randomUUID() });
                showMessage(`Saída registrada para ${active.operator.name}.`, 'success');
            } else {
                if (!context?.currentShift) {
                    showMessage('Entrada bloqueada: não há turno ativo para este horário.', 'error');
                    return;
                }
                const session = await request<Session>('POST', '/api/operator-station/entries',
                    { registration, requestId: crypto.randomUUID() });
                showMessage(`Entrada registrada para ${session.operator.name}.`, 'success');
            }
            get<HTMLInputElement>('operator-registration').value = ''; await refresh();
        } catch (error) {
            showMessage(error instanceof Error ? error.message : 'Não foi possível registrar a operação.', 'error');
            await refresh();
        } finally { setBusy(false); focusRegistration(); }
    }

    get<HTMLFormElement>('operator-scan-form').onsubmit = event => {
        event.preventDefault();
        const registration = get<HTMLInputElement>('operator-registration').value.trim();
        if (registration) void identify(registration);
    };
    window.addEventListener('focus', focusRegistration); document.addEventListener('visibilitychange', focusRegistration);
    async function poll() { if (stopped) return; if (!busy && !document.hidden) await refresh(); if (!stopped) pollTimer = window.setTimeout(poll, 5000); }
    window.addEventListener('pagehide', () => { stopped = true; window.clearTimeout(pollTimer); window.clearTimeout(messageTimer); }, { once: true });
    void refresh().then(() => { focusRegistration(); return poll(); });
})();
