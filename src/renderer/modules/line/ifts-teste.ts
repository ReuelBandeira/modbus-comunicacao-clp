(() => {
    type Method = 'GET' | 'POST' | 'PUT';
    interface BridgeStatus { configured: boolean; online: boolean; status: string; cycleId?: string; model?: string; detail?: string }
    interface TestCycle { cycleId: string; model: string; result: 'PASS'|'FAIL'; totalPositions: number; passedPositions: number; failedPositions: number; receivedAt: string; positions: Array<{ position: number; passed: boolean; result: 'PASS'|'FAIL'; judgment: string|null; ngStep: string|null; message: string|null }> }
    interface PlcSignalState { label: string; active: boolean; value: number|boolean; readAt: string; changedAt: string; error?: string }
    interface PlcExecution { executionId: string; commandCode: string; status: string; requestedAt: string; completedAt?: string; error?: string }
    interface PlcSignalAction { action: string; status: string; occurredAt: string; error?: string }
    interface PlcOperational { states: PlcSignalState[]; history: PlcExecution[]; signalActionHistory: PlcSignalAction[] }
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    let token = '', busy = false, timer: number | undefined, ioTimer: number | undefined, stopped = false;
    let ioRefreshing = false, lastM4ExecutionId = '', lastStatus: BridgeStatus | undefined;

    async function request<T>(method: Method, path: string, body?: unknown, auth = true): Promise<T> {
        const authorization = auth && token ? `Bearer ${token}` : undefined;
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request(method, path, body, authorization);
        else {
            const result = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(65_000) });
            response = { ...await result.json(), httpStatus: result.status };
        }
        if (response.httpStatus >= 400 || response.status !== 'OK') throw new Error(response.msg || 'Operação não confirmada.');
        return response.data as T;
    }
    function message(value: string, error = false) { const target = get('message'); target.hidden = !value; target.textContent = value; target.className = `notice${error ? ' error' : ''}`; }
    function cycleId() { return get<HTMLInputElement>('cycle-id').value.trim(); }
    function generateCycle() { const now = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); get<HTMLInputElement>('cycle-id').value = `SIM-${now}-${crypto.randomUUID().slice(0, 8)}`; resetSteps(); }
    function resetSteps() { document.querySelectorAll('.flow-steps article').forEach(step => step.className = ''); get('step-start').className = 'active'; get('operation-detail').textContent = 'Envie START para abrir o ciclo no Bridge.'; }
    function setBusy(value: boolean) { busy = value; document.querySelectorAll<HTMLButtonElement>('.cycle-actions button,#model-button,#new-cycle').forEach(button => button.disabled = value); }
    const stateLabel = (value: string) => ({ idle: 'Ocioso', started: 'Teste em execução', delivery_failed: 'Falha na entrega', delivered_cleanup_pending: 'Resultado salvo; limpeza pendente', completed: 'Concluído', offline: 'Offline', unconfigured: 'Não configurado' } as Record<string,string>)[value] || value;
    function renderStatus(value: BridgeStatus) {
        lastStatus = value; const badge = get('bridge-badge'); badge.textContent = value.online ? 'ONLINE' : value.configured ? 'OFFLINE' : 'NÃO CONFIGURADO'; badge.className = `state-badge ${value.online ? 'online' : 'offline'}`;
        get('bridge-online').textContent = value.online ? 'Disponível' : 'Indisponível'; get('bridge-status').textContent = stateLabel(value.status);
        get('bridge-model').textContent = value.model || '—'; get('bridge-cycle').textContent = value.cycleId || '—';
        if (value.model && !get<HTMLInputElement>('model-input').value) get<HTMLInputElement>('model-input').value = value.model;
        const canChange = value.online && (!value.cycleId || ['idle','completed'].includes(value.status));
        get<HTMLInputElement>('model-input').disabled = !canChange; get<HTMLButtonElement>('model-button').disabled = busy || !canChange;
        get('connection-dot').className = `dot ${value.online ? 'green' : 'red'}`; get('connection-status').textContent = value.online ? `Bridge ${stateLabel(value.status)}` : value.detail || 'Bridge indisponível';
        if (value.cycleId && (!cycleId() || !['idle', 'completed'].includes(value.status) && value.cycleId !== cycleId())) {
            const changed = value.cycleId !== cycleId();
            get<HTMLInputElement>('cycle-id').value = value.cycleId;
            if (changed) {
                resetSteps(); get('step-start').className = 'done'; get('step-test').className = 'active';
                get('operation-detail').textContent = `Ciclo ${value.cycleId} iniciado pela integração CLP.`;
            }
        }
    }
    const time = (value?: string) => value ? new Date(value).toLocaleTimeString('pt-BR') : '—';
    function renderPlcIo(value: PlcOperational) {
        const m23 = value.states.find(item => item.label === 'IFTS_START_REQUEST');
        const start = value.signalActionHistory.find(item => item.action === 'ifts_start');
        const m23Card = get('m23-card');
        m23Card.className = `plc-io-card ${m23?.error ? 'error' : m23?.active ? 'on' : 'idle'}`;
        get('m23-state').textContent = m23?.error ? 'FALHA NA LEITURA' : m23?.active ? 'M23 ATIVO' : m23 ? 'M23 INATIVO' : 'SINAL NÃO CONFIGURADO';
        get('m23-detail').textContent = m23?.error || (start
            ? `Último START: ${time(start.occurredAt)} · ${start.status === 'completed' ? 'executado' : start.status === 'failed' ? 'falhou' : 'processando'}`
            : m23 ? `Última mudança: ${time(m23.changedAt)}` : 'Cadastre IFTS_START_REQUEST em M23');

        const result = value.history.find(item => ['IFTS_RESULT_PASS', 'IFTS_RESULT_FAIL'].includes(item.commandCode));
        const m4Card = get('m4-card');
        if (!result) {
            m4Card.className = 'plc-io-card idle'; get('m4-state').textContent = 'AGUARDANDO RESULTADO';
            get('m4-detail').textContent = 'Nenhum pulso enviado'; return;
        }
        const completed = result.status === 'completed', failed = ['failed', 'uncertain'].includes(result.status);
        m4Card.className = `plc-io-card ${completed ? 'ok' : failed ? 'error' : 'pending'}`;
        get('m4-state').textContent = failed ? 'M24 NÃO CONFIRMADO' : completed ? 'TESTE FINALIZADO · M24 ENVIADO' : 'ENVIANDO M24';
        get('m4-detail').textContent = result.error || `${time(result.completedAt || result.requestedAt)} · ${result.status.replaceAll('_', ' ')}`;
        if (completed && result.executionId !== lastM4ExecutionId) {
            lastM4ExecutionId = result.executionId; void m4Card.offsetWidth; m4Card.classList.add('pulse');
            window.setTimeout(() => m4Card.classList.remove('pulse'), 1_500);
        }
    }
    async function refreshPlcIo() {
        if (ioRefreshing || stopped || !token) return;
        ioRefreshing = true;
        try { renderPlcIo(await request<PlcOperational>('GET', '/api/plc-controls/operational')); }
        catch (error) {
            for (const id of ['m23-card', 'm4-card']) get(id).className = 'plc-io-card error';
            get('m23-state').textContent = 'MONITOR INDISPONÍVEL'; get('m4-state').textContent = 'MONITOR INDISPONÍVEL';
            const detail = error instanceof Error ? error.message : 'Falha ao consultar a CLP.';
            get('m23-detail').textContent = detail; get('m4-detail').textContent = detail;
        } finally { ioRefreshing = false; }
    }
    async function refresh(showError = false) { try { renderStatus(await request<BridgeStatus>('GET', '/api/ifts-bridge/status')); } catch (error) { if (showError) message(error instanceof Error ? error.message : 'Consulta indisponível.', true); } }
    async function action(kind: 'start'|'finish'|'retry') {
        if (busy || !cycleId()) { message('Informe ou gere um cycleId.', true); return; }
        if (!confirm(`${kind.toUpperCase()} do ciclo ${cycleId()}?`)) return;
        setBusy(true); message(''); get('operation-detail').textContent = `Enviando ${kind.toUpperCase()} ao Bridge…`;
        try {
            await request('POST', `/api/ifts-bridge/${kind}`, { cycleId: cycleId() });
            if (kind === 'start') { get('step-start').className = 'done'; get('step-test').className = 'active'; get('operation-detail').textContent = 'START confirmado. Execute ou aguarde o teste no IFTS e a geração do CSV.'; }
            else { get('step-start').className = 'done'; get('step-test').className = 'done'; get('step-finish').className = 'done'; get('step-result').className = 'active'; get('operation-detail').textContent = `${kind.toUpperCase()} confirmado. Consultando o resultado salvo na IHM…`; await checkResult(false); }
            await refresh();
        } catch (error) { get(kind === 'start' ? 'step-start' : 'step-finish').className = 'failed'; const detail = error instanceof Error ? error.message : 'Operação recusada.'; get('operation-detail').textContent = detail; message(detail, true); await refresh(); }
        finally { setBusy(false); }
    }
    async function checkResult(showMissing = true) {
        if (!cycleId()) { if (showMissing) message('Informe o cycleId.', true); return; }
        try {
            const value = await request<TestCycle>('GET', `/api/test-results/${encodeURIComponent(cycleId())}`);
            get('result-empty').hidden = true; get('result-content').hidden = false; get('result-cycle').textContent = `Ciclo: ${value.cycleId}`;
            const badge = get('result-status'); badge.textContent = value.result; badge.className = `result-badge ${value.result === 'PASS' ? 'pass' : 'fail'}`;
            get('result-model').textContent = `Modelo: ${value.model}`; get('result-count').textContent = `Posições: ${value.passedPositions}/${value.totalPositions} aprovadas · ${value.failedPositions} reprovadas`;
            get('result-received').textContent = `Recebido: ${new Date(value.receivedAt).toLocaleString('pt-BR')}`;
            const body = get<HTMLTableSectionElement>('result-failures'); body.replaceChildren();
            const failures = value.positions.filter(position => !position.passed);
            if (!failures.length) { const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 5; cell.className = 'result-pass'; cell.textContent = 'Nenhuma posição reprovada.'; }
            for (const failure of failures) { const row = body.insertRow(); for (const value of [String(failure.position), failure.result, failure.judgment || '—', failure.ngStep || '—', failure.message || '—']) { const cell = row.insertCell(); cell.textContent = value; } row.cells[1].className = 'result-fail'; }
            get('step-result').className = 'done'; get('operation-detail').textContent = 'Resultado recebido pelo endpoint /api/test-results e confirmado no MongoDB.'; message('Fluxo completo confirmado com sucesso.');
        } catch (error) { if (showMissing) message(error instanceof Error ? error.message : 'Resultado ainda não encontrado.', true); }
    }
    async function debugReset() {
        if (busy || !confirm('Resetar o estado local do Bridge? Use somente em testes. CSVs e outbox não serão excluídos.')) return;
        setBusy(true); message(''); get('operation-detail').textContent = 'Enviando RESET DEBUG ao Bridge…';
        try {
            await request('POST', '/api/ifts-bridge/debug/reset');
            resetSteps(); message('Bridge resetado para o estado ocioso.'); await refresh(true);
        } catch (error) {
            const detail = error instanceof Error ? error.message : 'Reset recusado pelo Bridge.';
            get('operation-detail').textContent = detail; message(detail, true);
        } finally { setBusy(false); }
    }
    get<HTMLFormElement>('login-form').onsubmit = event => { event.preventDefault(); void (async () => { try { token = (await request<{token:string}>('POST','/api/admin/sessions',{ password:get<HTMLInputElement>('admin-password').value },false)).token; get('login-panel').hidden = true; get('test-content').hidden = false; generateCycle(); await Promise.all([refresh(true), refreshPlcIo()]); timer = window.setInterval(() => { if (!busy) { void refresh(); void checkResult(false); } }, 3000); ioTimer = window.setInterval(() => void refreshPlcIo(), 750); } catch (error) { get('connection-status').textContent = error instanceof Error ? error.message : 'Acesso recusado.'; } })(); };
    get<HTMLButtonElement>('new-cycle').onclick = () => { if (lastStatus?.cycleId && !['idle','completed'].includes(lastStatus.status) && !confirm('O Bridge informa um ciclo ativo. Gerar outro ID apenas altera a tela. Continuar?')) return; generateCycle(); };
    get<HTMLButtonElement>('start-cycle').onclick = () => void action('start'); get<HTMLButtonElement>('finish-cycle').onclick = () => void action('finish'); get<HTMLButtonElement>('retry-cycle').onclick = () => void action('retry'); get<HTMLButtonElement>('check-result').onclick = () => void checkResult();
    get<HTMLButtonElement>('debug-reset').onclick = () => void debugReset();
    get<HTMLFormElement>('model-form').onsubmit = event => { event.preventDefault(); void (async () => { const model = get<HTMLInputElement>('model-input').value.trim(); if (!confirm(`Alterar o modelo para ${model}?`)) return; setBusy(true); try { const result = await request<{warning:string}>('PUT','/api/ifts-bridge/model',{ model }); message(result.warning); await refresh(); } catch (error) { message(error instanceof Error ? error.message : 'Modelo não alterado.',true); } finally { setBusy(false); } })(); };
    window.addEventListener('pagehide', () => { stopped = true; window.clearInterval(timer); window.clearInterval(ioTimer); }, { once:true }); void stopped;
})();
