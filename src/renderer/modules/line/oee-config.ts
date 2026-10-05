(() => {
    type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
    interface Shift { shiftId: string; name: string; startTime: string; endTime: string; active: boolean }
    interface Reason { reasonId: string; code: string; name: string; classification: 'planned' | 'unplanned'; countsAgainstAvailability: boolean; active: boolean }
    interface ShiftBreak { breakId: string; shiftId: string; name: string; startTime: string; endTime: string; excludeFromPlannedTime: boolean; active: boolean }
    interface CalendarItem { exceptionId: string; shiftId: string; date: string; productionEnabled: boolean; notes?: string }
    interface PhysicalMonitoring { enabled: boolean; strategy: 'serial_any_running' | 'all_required' | 'reference_signal';
        stopConfirmationMs: number; resumeConfirmationMs: number; defaultReasonId?: string; referenceSignalId?: string;
        manualContingencyEnabled: boolean; manualContingencyRequiresAdmin: boolean }
    interface OeeConfiguration { idealCycleTimeSeconds: number | null; physicalMonitoring: PhysicalMonitoring; updatedAt: string | null }
    interface PlcSignal { signalId: string; label: string; enabled: boolean;
        aggregateStatusMappings?: Array<{ productionState?: string }> }
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    let token = '', busy = false, shifts: Shift[] = [], reasons: Reason[] = [], breaks: ShiftBreak[] = [], calendar: CalendarItem[] = [];
    let physicalSignals: PlcSignal[] = [];
    const defaultPhysical: PhysicalMonitoring = { enabled: false, strategy: 'serial_any_running', stopConfirmationMs: 5000,
        resumeConfirmationMs: 2000, manualContingencyEnabled: true, manualContingencyRequiresAdmin: true };
    let configuration: OeeConfiguration = { idealCycleTimeSeconds: null, physicalMonitoring: defaultPhysical, updatedAt: null };
    let editingReason: Reason | undefined, editingBreak: ShiftBreak | undefined;

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
        document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea').forEach(item => item.disabled = value);
    }
    function message(value: string, error = false) {
        const notice = get('config-message'); notice.hidden = !value; notice.textContent = value; notice.className = `notice${error ? ' error' : ''}`;
    }
    function shiftName(shiftId: string) { const shift = shifts.find(value => value.shiftId === shiftId); return shift ? `${shift.name} (${shift.startTime}–${shift.endTime})` : 'Turno não encontrado'; }
    function button(label: string, className: string, action: () => void) {
        const value = document.createElement('button'); value.type = 'button'; value.className = `button ${className}`; value.textContent = label; value.onclick = action; return value;
    }
    function cell(value: string) { const result = document.createElement('td'); result.textContent = value; return result; }
    function empty(body: HTMLTableSectionElement, columns: number, value: string) {
        const row = document.createElement('tr'), content = cell(value); content.colSpan = columns; content.className = 'table-empty'; row.append(content); body.append(row);
    }
    function populateShifts() {
        for (const id of ['break-shift', 'calendar-shift']) {
            const select = get<HTMLSelectElement>(id), selected = select.value; select.replaceChildren();
            for (const shift of shifts) select.append(new Option(shiftName(shift.shiftId), shift.shiftId));
            select.value = selected;
        }
    }
    function renderReasons() {
        const body = get<HTMLTableSectionElement>('reason-list'); body.replaceChildren();
        for (const reason of reasons) {
            const row = document.createElement('tr'), actions = document.createElement('td');
            actions.append(button('Editar', 'secondary', () => editReason(reason)),
                button(reason.active ? 'Desativar' : 'Ativar', reason.active ? 'danger' : 'success', () => void toggleReason(reason)),
                button('Remover', 'danger', () => void removeReason(reason)));
            row.append(cell(reason.code), cell(reason.name), cell(reason.classification === 'planned' ? 'Planejada' : 'Não planejada'),
                cell(reason.countsAgainstAvailability ? 'Reduz disponibilidade' : 'Exclui do planejado'), cell(reason.active ? 'Ativo' : 'Inativo'), actions); body.append(row);
        }
        if (!body.children.length) empty(body, 6, 'Nenhum motivo cadastrado.');
    }
    function renderBreaks() {
        const body = get<HTMLTableSectionElement>('break-list'); body.replaceChildren();
        for (const item of breaks) {
            const row = document.createElement('tr'), actions = document.createElement('td');
            actions.append(button('Editar', 'secondary', () => editBreak(item)), button('Remover', 'danger', () => void removeBreak(item)));
            row.append(cell(shiftName(item.shiftId)), cell(item.name), cell(item.startTime), cell(item.endTime),
                cell(item.excludeFromPlannedTime ? 'Exclui do planejado' : 'Informativa'), cell(item.active ? 'Ativa' : 'Inativa'), actions); body.append(row);
        }
        if (!body.children.length) empty(body, 7, 'Nenhuma pausa cadastrada.');
    }
    function renderCalendar() {
        const body = get<HTMLTableSectionElement>('calendar-list'); body.replaceChildren();
        for (const item of calendar) {
            const row = document.createElement('tr'), actions = document.createElement('td');
            actions.append(button('Remover', 'danger', () => void removeCalendar(item)));
            row.append(cell(new Date(`${item.date}T12:00:00`).toLocaleDateString('pt-BR')), cell(shiftName(item.shiftId)),
                cell(item.productionEnabled ? 'Habilitada' : 'Cancelada'), cell(item.notes || '—'), actions); body.append(row);
        }
        if (!body.children.length) empty(body, 5, 'Nenhuma exceção cadastrada.');
    }
    function renderConfiguration() {
        const input = get<HTMLInputElement>('ideal-cycle-seconds');
        input.value = configuration.idealCycleTimeSeconds === null ? '' : String(configuration.idealCycleTimeSeconds);
        get('ideal-cycle-status').textContent = configuration.idealCycleTimeSeconds === null
            ? 'Nenhum ciclo ideal configurado. Performance e OEE permanecem pendentes.'
            : `Ciclo ideal ativo: ${configuration.idealCycleTimeSeconds.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} s por chip.${configuration.updatedAt ? ` Atualizado em ${new Date(configuration.updatedAt).toLocaleString('pt-BR')}.` : ''}`;
        renderPhysicalConfiguration();
    }
    function participatingSignals() {
        return physicalSignals.filter(signal => signal.enabled
            && signal.aggregateStatusMappings?.some(mapping => !!mapping.productionState));
    }
    function updatePhysicalFields() {
        const reference = get<HTMLSelectElement>('physical-strategy').value === 'reference_signal';
        get('physical-reference-field').hidden = !reference;
        get<HTMLSelectElement>('physical-reference-signal').required = reference && get<HTMLInputElement>('physical-enabled').checked;
        get<HTMLSelectElement>('physical-default-reason').required = get<HTMLInputElement>('physical-enabled').checked;
    }
    function renderPhysicalConfiguration() {
        const value = configuration.physicalMonitoring ?? defaultPhysical;
        get<HTMLInputElement>('physical-enabled').checked = value.enabled;
        get<HTMLSelectElement>('physical-strategy').value = value.strategy;
        get<HTMLInputElement>('physical-stop-seconds').value = String(value.stopConfirmationMs / 1000);
        get<HTMLInputElement>('physical-resume-seconds').value = String(value.resumeConfirmationMs / 1000);
        get<HTMLInputElement>('physical-manual-enabled').checked = value.manualContingencyEnabled;
        get<HTMLInputElement>('physical-manual-admin').checked = value.manualContingencyRequiresAdmin;
        const reasonSelect = get<HTMLSelectElement>('physical-default-reason'); reasonSelect.replaceChildren(new Option('Selecione…', ''));
        for (const reason of reasons.filter(item => item.active)) reasonSelect.append(new Option(`${reason.code} · ${reason.name}`, reason.reasonId));
        reasonSelect.value = value.defaultReasonId || '';
        const signals = participatingSignals(), referenceSelect = get<HTMLSelectElement>('physical-reference-signal');
        referenceSelect.replaceChildren(new Option('Selecione…', ''));
        for (const signal of signals) referenceSelect.append(new Option(signal.label, signal.signalId));
        referenceSelect.value = value.referenceSignalId || '';
        get('physical-signals-status').textContent = signals.length
            ? `${signals.length} sinal(is) participando: ${signals.map(signal => signal.label).join(', ')}.`
            : 'Nenhum sinal possui significado produtivo. Configure os estados na tela Sinais / CLPs antes de ativar.';
        updatePhysicalFields();
    }
    async function refresh() {
        const result = await Promise.all([
            request<Shift[]>('GET', '/api/shifts'), request<Reason[]>('GET', '/api/availability/reasons'),
            request<ShiftBreak[]>('GET', '/api/availability/breaks'), request<CalendarItem[]>('GET', '/api/availability/calendar'),
            request<OeeConfiguration>('GET', '/api/availability/configuration'),
            request<{ signals: PlcSignal[] }>('GET', '/api/plc-signals')
        ]);
        [shifts, reasons, breaks, calendar, configuration] = result;
        physicalSignals = result[5].signals;
        populateShifts(); renderReasons(); renderBreaks(); renderCalendar(); renderConfiguration();
    }
    function resetReason() {
        editingReason = undefined; get<HTMLFormElement>('reason-form').reset();
        get<HTMLInputElement>('reason-impact').checked = true; get<HTMLInputElement>('reason-active').checked = true;
        get('reason-save').textContent = 'Cadastrar'; get<HTMLButtonElement>('reason-cancel').hidden = true;
    }
    function editReason(reason: Reason) {
        editingReason = reason; get<HTMLInputElement>('reason-code').value = reason.code; get<HTMLInputElement>('reason-name').value = reason.name;
        get<HTMLSelectElement>('reason-classification').value = reason.classification;
        get<HTMLInputElement>('reason-impact').checked = reason.countsAgainstAvailability; get<HTMLInputElement>('reason-active').checked = reason.active;
        get('reason-save').textContent = 'Salvar'; get<HTMLButtonElement>('reason-cancel').hidden = false; get<HTMLInputElement>('reason-code').focus();
    }
    function reasonPayload(reason?: Reason) { return { code: reason?.code ?? get<HTMLInputElement>('reason-code').value.trim(),
        name: reason?.name ?? get<HTMLInputElement>('reason-name').value.trim(),
        classification: reason?.classification ?? get<HTMLSelectElement>('reason-classification').value,
        countsAgainstAvailability: reason?.countsAgainstAvailability ?? get<HTMLInputElement>('reason-impact').checked,
        active: reason?.active ?? get<HTMLInputElement>('reason-active').checked }; }
    async function toggleReason(reason: Reason) {
        if (busy) return; setBusy(true);
        try { await request('PUT', `/api/availability/reasons/${reason.reasonId}`, { ...reasonPayload(reason), active: !reason.active }); await refresh(); }
        catch (error) { message(error instanceof Error ? error.message : 'Alteração não confirmada.', true); } finally { setBusy(false); }
    }
    async function removeReason(reason: Reason) {
        if (busy || !confirm(`Remover o motivo ${reason.name}?`)) return; setBusy(true);
        try { await request('DELETE', `/api/availability/reasons/${reason.reasonId}`); resetReason(); await refresh(); message('Motivo removido.'); }
        catch (error) { message(error instanceof Error ? error.message : 'Remoção não confirmada.', true); } finally { setBusy(false); }
    }
    function resetBreak() {
        editingBreak = undefined; get<HTMLFormElement>('break-form').reset();
        get<HTMLInputElement>('break-exclude').checked = true; get<HTMLInputElement>('break-active').checked = true;
        get('break-save').textContent = 'Cadastrar'; get<HTMLButtonElement>('break-cancel').hidden = true; populateShifts();
    }
    function editBreak(item: ShiftBreak) {
        editingBreak = item; get<HTMLSelectElement>('break-shift').value = item.shiftId; get<HTMLInputElement>('break-name').value = item.name;
        get<HTMLInputElement>('break-start').value = item.startTime; get<HTMLInputElement>('break-end').value = item.endTime;
        get<HTMLInputElement>('break-exclude').checked = item.excludeFromPlannedTime; get<HTMLInputElement>('break-active').checked = item.active;
        get('break-save').textContent = 'Salvar'; get<HTMLButtonElement>('break-cancel').hidden = false; get<HTMLInputElement>('break-name').focus();
    }
    async function removeBreak(item: ShiftBreak) {
        if (busy || !confirm(`Remover a pausa ${item.name}?`)) return; setBusy(true);
        try { await request('DELETE', `/api/availability/breaks/${item.breakId}`); resetBreak(); await refresh(); message('Pausa removida.'); }
        catch (error) { message(error instanceof Error ? error.message : 'Remoção não confirmada.', true); } finally { setBusy(false); }
    }
    async function removeCalendar(item: CalendarItem) {
        if (busy || !confirm('Remover esta exceção do calendário?')) return; setBusy(true);
        try { await request('DELETE', `/api/availability/calendar/${item.exceptionId}`); await refresh(); message('Exceção removida.'); }
        catch (error) { message(error instanceof Error ? error.message : 'Remoção não confirmada.', true); } finally { setBusy(false); }
    }
    function logout() {
        token = ''; shifts = []; reasons = []; breaks = []; calendar = []; physicalSignals = [];
        configuration = { idealCycleTimeSeconds: null, physicalMonitoring: defaultPhysical, updatedAt: null }; resetReason(); resetBreak();
        get('login-panel').hidden = false; get('config-panel').hidden = true; get('connection-dot').className = 'dot';
        get('admin-status').textContent = 'Acesso ADMIN necessário'; get<HTMLInputElement>('admin-password').value = '';
    }

    get<HTMLFormElement>('admin-login-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            token = (await request<{ token: string }>('POST', '/api/admin/sessions', { password: get<HTMLInputElement>('admin-password').value }, false)).token;
            get('login-panel').hidden = true; get('config-panel').hidden = false; get('connection-dot').className = 'dot green';
            get('admin-status').textContent = 'Sessão ADMIN ativa'; await refresh();
        } catch (error) { get('admin-status').textContent = error instanceof Error ? error.message : 'Autenticação não confirmada.'; }
        finally { setBusy(false); }
    })(); };
    get<HTMLFormElement>('ideal-cycle-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            configuration = await request<OeeConfiguration>('PUT', '/api/availability/configuration', {
                idealCycleTimeSeconds: Number(get<HTMLInputElement>('ideal-cycle-seconds').value)
            });
            renderConfiguration(); message('Ciclo ideal salvo. A tela OEE atualizará Performance e OEE automaticamente.');
        } catch (error) { message(error instanceof Error ? error.message : 'Ciclo ideal não confirmado.', true); } finally { setBusy(false); }
    })(); };
    get<HTMLFormElement>('physical-state-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            configuration = await request<OeeConfiguration>('PUT', '/api/availability/configuration', { physicalMonitoring: {
                enabled: get<HTMLInputElement>('physical-enabled').checked,
                strategy: get<HTMLSelectElement>('physical-strategy').value,
                stopConfirmationMs: Math.round(Number(get<HTMLInputElement>('physical-stop-seconds').value) * 1000),
                resumeConfirmationMs: Math.round(Number(get<HTMLInputElement>('physical-resume-seconds').value) * 1000),
                defaultReasonId: get<HTMLSelectElement>('physical-default-reason').value,
                referenceSignalId: get<HTMLSelectElement>('physical-reference-signal').value,
                manualContingencyEnabled: get<HTMLInputElement>('physical-manual-enabled').checked,
                manualContingencyRequiresAdmin: get<HTMLInputElement>('physical-manual-admin').checked
            } });
            renderConfiguration(); message('Consolidação física salva. O runtime aplicará a configuração automaticamente.');
        } catch (error) { message(error instanceof Error ? error.message : 'Estado físico não confirmado.', true); }
        finally { setBusy(false); }
    })(); };
    get<HTMLFormElement>('reason-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            const method = editingReason ? 'PUT' : 'POST', path = editingReason ? `/api/availability/reasons/${editingReason.reasonId}` : '/api/availability/reasons';
            await request(method, path, reasonPayload()); resetReason(); await refresh(); message('Motivo salvo.');
        } catch (error) { message(error instanceof Error ? error.message : 'Motivo não confirmado.', true); } finally { setBusy(false); }
    })(); };
    get<HTMLFormElement>('break-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            const payload = { shiftId: get<HTMLSelectElement>('break-shift').value, name: get<HTMLInputElement>('break-name').value.trim(),
                startTime: get<HTMLInputElement>('break-start').value, endTime: get<HTMLInputElement>('break-end').value,
                excludeFromPlannedTime: get<HTMLInputElement>('break-exclude').checked, active: get<HTMLInputElement>('break-active').checked };
            const method = editingBreak ? 'PUT' : 'POST', path = editingBreak ? `/api/availability/breaks/${editingBreak.breakId}` : '/api/availability/breaks';
            await request(method, path, payload); resetBreak(); await refresh(); message('Pausa salva.');
        } catch (error) { message(error instanceof Error ? error.message : 'Pausa não confirmada.', true); } finally { setBusy(false); }
    })(); };
    get<HTMLFormElement>('calendar-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            await request('POST', '/api/availability/calendar', { shiftId: get<HTMLSelectElement>('calendar-shift').value,
                date: get<HTMLInputElement>('calendar-date').value, productionEnabled: get<HTMLInputElement>('calendar-enabled').checked,
                notes: get<HTMLInputElement>('calendar-notes').value.trim() });
            get<HTMLFormElement>('calendar-form').reset(); populateShifts(); await refresh(); message('Exceção adicionada.');
        } catch (error) { message(error instanceof Error ? error.message : 'Exceção não confirmada.', true); } finally { setBusy(false); }
    })(); };
    get<HTMLSelectElement>('physical-strategy').onchange = updatePhysicalFields;
    get<HTMLInputElement>('physical-enabled').onchange = updatePhysicalFields;
    get('reason-cancel').onclick = resetReason; get('break-cancel').onclick = resetBreak; get('admin-exit').onclick = logout;
})();
