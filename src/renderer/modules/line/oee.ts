(() => {
    type Method = 'GET' | 'POST';
    type PeriodPreset = 'current-shift' | 'today' | '24h' | 'custom';
    interface Reason { reasonId: string; name: string; code: string; active: boolean; classification: 'planned' | 'unplanned'; countsAgainstAvailability: boolean }
    interface Event { eventId: string; status: 'open' | 'closed'; startedAt: string; endedAt?: string;
        reason: Pick<Reason, 'reasonId' | 'name' | 'code' | 'classification' | 'countsAgainstAvailability'>; source: string;
        sourceSignals?: Array<{ signalId: string; label: string }>; activeSourceSignalIds?: string[]; notes?: string;
        classificationPending?: boolean }
    interface Current {
        state: 'RUNNING' | 'STOPPED' | 'IDLE' | 'TRANSITION' | 'UNKNOWN';
        openEvent?: Event;
        physicalState?: { state: 'RUNNING' | 'STOPPED' | 'TRANSITION' | 'UNKNOWN'; reason: string; capturedAt: string;
            signals: Array<{ signalId: string; label: string; value?: number; productionState?: string; error?: string }> };
        physicalMonitoring?: { enabled: boolean; strategy: string };
        manualStop?: { allowed: boolean; requiresAdmin: boolean; reason?: string };
        recentEvents: Event[];
        capturedAt: string;
        currentShift?: { name: string; startTime: string; endTime: string } | null;
        currentPeriod?: { plannedStartAt: string; plannedEndAt: string; productionEnabled?: boolean } | null;
    }
    interface Report {
        period: { from: string; to: string };
        scheduledTimeMs: number;
        excludedBreakTimeMs: number;
        excludedEventTimeMs: number;
        plannedTimeMs: number;
        operatingTimeMs: number;
        downtimeMs: number;
        availability: number | null;
        performance: number | null;
        oee: number | null;
        performanceStatus: 'available' | 'awaiting_ideal_cycle_time';
        idealCycleTimeSeconds: number | null;
        quality: { percentage: number | null; produced: number; approved: number; rejected: number; indeterminate: number };
        downtimeByReason: Array<{ reasonId: string; name: string; classification: string; durationMs: number; occurrences: number }>;
        events: Event[];
        generatedAt: string;
    }

    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const stopDialog = get<HTMLDialogElement>('stop-dialog');
    let current: Current | undefined;
    let actionBusy = false;
    let refreshing = false;
    let timer: number | undefined;
    let stopped = false, dialogMode: 'manual' | 'classify' = 'manual';

    async function request<T>(method: Method, path: string, body?: unknown, authorization?: string): Promise<T> {
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request(method, path, body, authorization);
        else {
            const result = await fetch(path, { method, headers: { 'Content-Type': 'application/json',
                ...(authorization ? { Authorization: authorization } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
            response = { ...await result.json(), httpStatus: result.status };
        }
        if (response.httpStatus >= 400 || response.status !== 'OK') throw new Error(response.msg || 'Operação não confirmada.');
        return response.data as T;
    }

    const localInput = (value: Date) =>
        new Date(value.getTime() - value.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    const dateTime = (value?: string) => value
        ? new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
        : 'Em andamento';
    const percent = (value: number | null) => value === null
        ? '—'
        : `${value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 2 })}%`;

    function duration(ms: number) {
        const totalMinutes = Math.max(0, Math.round(ms / 60_000));
        const hours = Math.floor(totalMinutes / 60), minutes = totalMinutes % 60;
        return hours ? `${hours}h ${String(minutes).padStart(2, '0')}min` : `${minutes}min`;
    }
    function notice(value: string, error = false) {
        const element = get('oee-notice');
        element.hidden = !value;
        element.textContent = value;
        element.className = `notice${error ? ' error' : ''}`;
    }
    function setActionBusy(value: boolean) {
        actionBusy = value;
        for (const control of document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
            'button,input,select,textarea')) control.disabled = value;
    }
    function setProgress(id: string, value: number | null) {
        get<HTMLElement>(id).style.width = `${Math.max(0, Math.min(100, value ?? 0))}%`;
    }

    function renderCurrent() {
        if (!current) return;
        const isStopped = current.state === 'STOPPED';
        const isRunning = current.state === 'RUNNING';
        const automatic = current.openEvent?.source === 'plc' && !!current.physicalMonitoring?.enabled;
        const state = get('production-state');
        const panel = document.querySelector<HTMLElement>('.line-state-panel');
        if (panel) panel.dataset.state = isStopped ? 'stopped' : isRunning ? 'running' : 'idle';
        state.className = `production-state ${isStopped ? 'stopped' : isRunning ? 'running' : 'unknown'}`;
        state.textContent = isStopped ? 'PARADA' : isRunning ? 'PRODUZINDO'
            : current.state === 'TRANSITION' ? 'TRANSIÇÃO' : current.state === 'UNKNOWN' ? 'DESCONHECIDO' : 'FORA DE TURNO';
        const stopButton = get<HTMLButtonElement>('open-stop-dialog');
        stopButton.hidden = automatic ? false : isStopped || current.manualStop?.allowed === false;
        stopButton.textContent = automatic ? current.openEvent?.classificationPending ? 'CLASSIFICAR PARADA' : 'ALTERAR CLASSIFICAÇÃO'
            : 'REGISTRAR PARADA';
        get<HTMLButtonElement>('resume-line').hidden = !isStopped || automatic;
        get('physical-state-detail').textContent = current.physicalMonitoring?.enabled
            ? `Estado físico: ${current.physicalState?.state || 'UNKNOWN'} · ${current.physicalState?.reason || 'Aguardando sinais.'}`
            : 'Estado físico consolidado desabilitado; apontamento em modo legado.';

        if (isStopped && current.openEvent) {
            const signals = current.openEvent.sourceSignals?.filter(item => !current!.openEvent!.activeSourceSignalIds
                || current!.openEvent!.activeSourceSignalIds!.includes(item.signalId)).map(item => item.label).join(', ');
            const detail = `${current.openEvent.reason.name} · ${current.openEvent.reason.classification === 'planned' ? 'planejada' : 'não planejada'}${signals ? ` · Sinais ativos: ${signals}` : current.openEvent.notes ? ` · ${current.openEvent.notes}` : ''}`;
            get('state-detail').textContent = detail;
            get('dialog-state-detail').textContent = detail;
            get('state-duration').textContent = duration(Date.now() - new Date(current.openEvent.startedAt).getTime());
        } else {
            const detail = current.currentShift
                ? `${current.currentShift.name} · ${current.currentShift.startTime}–${current.currentShift.endTime}`
                : 'Sem turno vigente; tempos fora da programação não entram na disponibilidade.';
            get('state-detail').textContent = detail;
            get('dialog-state-detail').textContent = detail;
            get('state-duration').textContent = 'Sem parada aberta';
        }
        get('dialog-line-state').textContent = state.textContent;
    }

    function emptyRow(body: HTMLTableSectionElement, columns: number, value: string) {
        const row = document.createElement('tr'), cell = document.createElement('td');
        cell.colSpan = columns;
        cell.className = 'table-empty';
        cell.textContent = value;
        row.append(cell);
        body.append(row);
    }

    function renderAvailabilityWaterfall(report: Report) {
        const afterBreaks = Math.max(0, report.scheduledTimeMs - report.excludedBreakTimeMs);
        const maximum = Math.max(1, report.scheduledTimeMs);
        const steps = [
            { label: 'Tempo programado', value: report.scheduledTimeMs, base: 0, kind: 'total', sign: '' },
            { label: 'Pausas e intervalos', value: report.excludedBreakTimeMs, base: afterBreaks, kind: 'loss', sign: '−' },
            { label: 'Eventos excluídos', value: report.excludedEventTimeMs, base: report.plannedTimeMs, kind: 'excluded', sign: '−' },
            { label: 'Tempo planejado', value: report.plannedTimeMs, base: 0, kind: 'subtotal', sign: '' },
            { label: 'Paradas computadas', value: report.downtimeMs, base: report.operatingTimeMs, kind: 'downtime', sign: '−' },
            { label: 'Tempo em operação', value: report.operatingTimeMs, base: 0, kind: 'operating', sign: '' }
        ];
        const chart = get('availability-waterfall'); chart.replaceChildren();
        chart.setAttribute('aria-label', steps.map(step => `${step.label}: ${step.sign}${duration(step.value)}`).join('. '));
        for (const step of steps) {
            const column = document.createElement('div'); column.className = `waterfall-step ${step.kind}`;
            const value = document.createElement('strong'); value.className = 'waterfall-value';
            value.textContent = `${step.sign}${duration(step.value)}`;
            const plot = document.createElement('div'); plot.className = 'waterfall-plot';
            const bar = document.createElement('i'); bar.className = 'waterfall-bar';
            bar.style.height = `${step.value / maximum * 100}%`;
            bar.style.bottom = `${step.base / maximum * 100}%`;
            bar.hidden = step.value <= 0;
            plot.append(bar);
            const label = document.createElement('span'); label.className = 'waterfall-label'; label.textContent = step.label;
            column.append(value, plot, label); chart.append(column);
        }
        get('waterfall-equation').textContent = `${duration(report.plannedTimeMs)} planejado − ${duration(report.downtimeMs)} parado = ${duration(report.operatingTimeMs)} em operação`;
    }

    function renderReport(report: Report) {
        const availability = percent(report.availability);
        const quality = percent(report.quality.percentage);
        const performance = percent(report.performance);
        const oee = percent(report.oee);
        get('availability-value').textContent = availability;
        get('availability-mini').textContent = availability;
        get('quality-value').textContent = quality;
        get('quality-mini').textContent = quality;
        get('performance-value').textContent = performance;
        get('performance-mini').textContent = performance;
        get('oee-value').textContent = oee;
        const configured = report.idealCycleTimeSeconds !== null;
        const cycleText = configured
            ? `Ciclo ideal: ${report.idealCycleTimeSeconds!.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} s por chip`
            : 'Aguardando tempo de ciclo ideal';
        get('oee-caption').textContent = cycleText;
        get('component-help').textContent = configured
            ? `${cycleText}. A Performance é limitada a 100%.`
            : 'Performance e OEE serão calculados quando o tempo de ciclo ideal da linha estiver definido.';
        get('performance-row').className = `component-row${configured ? ' performance-row' : ' pending-row'}`;
        setProgress('availability-bar', report.availability);
        setProgress('quality-bar', report.quality.percentage);
        setProgress('performance-bar', report.performance);

        get('planned-time').textContent = duration(report.plannedTimeMs);
        get('operating-time').textContent = duration(report.operatingTimeMs);
        get('downtime').textContent = duration(report.downtimeMs);
        get('produced').textContent = report.quality.produced.toLocaleString('pt-BR');
        get('approved').textContent = report.quality.approved.toLocaleString('pt-BR');
        get('rejected').textContent = report.quality.rejected.toLocaleString('pt-BR');
        get('indeterminate').textContent = report.quality.indeterminate.toLocaleString('pt-BR');
        renderAvailabilityWaterfall(report);

        const totals = get<HTMLTableSectionElement>('reason-totals');
        totals.replaceChildren();
        for (const value of report.downtimeByReason) {
            const row = document.createElement('tr');
            for (const item of [value.name, value.classification === 'planned' ? 'Planejada' : 'Não planejada',
                value.occurrences.toLocaleString('pt-BR'), duration(value.durationMs)]) {
                const cell = document.createElement('td');
                cell.textContent = item;
                row.append(cell);
            }
            totals.append(row);
        }
        if (!totals.children.length) emptyRow(totals, 4, 'Nenhuma parada computada no período.');

        const events = get<HTMLTableSectionElement>('downtime-events');
        events.replaceChildren();
        for (const event of [...report.events].reverse()) {
            const row = document.createElement('tr');
            for (const item of [dateTime(event.startedAt), dateTime(event.endedAt), event.reason.name,
                event.source === 'manual' ? 'Manual' : event.source.toUpperCase()]) {
                const cell = document.createElement('td');
                cell.textContent = item;
                row.append(cell);
            }
            events.append(row);
        }
        if (!events.children.length) emptyRow(events, 4, 'Nenhuma parada registrada no período.');
        get('oee-updated').textContent = `Atualizado em ${dateTime(report.generatedAt)} · ${configured
            ? `ciclo ideal de ${report.idealCycleTimeSeconds!.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} s por chip.`
            : 'Performance e OEE aguardam o tempo de ciclo ideal.'}`;
    }

    async function loadReasons() {
        const reasons = await request<Reason[]>('GET', '/api/availability/reasons');
        const select = get<HTMLSelectElement>('stop-reason'), previous = select.value;
        select.replaceChildren(new Option('Selecione…', ''));
        for (const reason of reasons.filter(value => value.active)) {
            select.append(new Option(`${reason.code} · ${reason.name}`, reason.reasonId));
        }
        select.value = previous;
    }

    function applyPreset() {
        const preset = get<HTMLSelectElement>('period-preset').value as PeriodPreset;
        const fromInput = get<HTMLInputElement>('oee-from');
        const toInput = get<HTMLInputElement>('oee-to');
        const now = new Date();
        fromInput.readOnly = preset !== 'custom';
        toInput.readOnly = preset !== 'custom';
        if (preset === 'custom') {
            if (get<HTMLInputElement>('live-update').checked) toInput.value = localInput(now);
            return;
        }
        let from: Date;
        let to = now;
        if (preset === 'current-shift' && current?.currentPeriod) {
            from = new Date(current.currentPeriod.plannedStartAt);
            to = new Date(Math.min(now.getTime(), new Date(current.currentPeriod.plannedEndAt).getTime()));
        } else if (preset === '24h') {
            from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        } else {
            from = new Date(now);
            from.setHours(0, 0, 0, 0);
        }
        fromInput.value = localInput(from);
        toInput.value = localInput(to);
    }

    async function refreshCurrent() {
        current = await request<Current>('GET', '/api/availability/current');
        renderCurrent();
    }
    async function refreshReport() {
        if (get<HTMLInputElement>('live-update').checked) applyPreset();
        const from = new Date(get<HTMLInputElement>('oee-from').value);
        const to = new Date(get<HTMLInputElement>('oee-to').value);
        if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
            throw new Error('Informe um período válido.');
        }
        const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(),
            timezoneOffsetMinutes: String(new Date().getTimezoneOffset()) });
        renderReport(await request<Report>('GET', `/api/availability/report?${query}`));
    }

    async function refreshAll(interactive = false) {
        if (refreshing || actionBusy) return;
        refreshing = true;
        if (interactive) setActionBusy(true);
        try {
            await refreshCurrent();
            applyPreset();
            await refreshReport();
            get('connection-dot').className = 'dot green';
            get('sync-status').textContent = get<HTMLInputElement>('live-update').checked ? 'OEE em tempo real' : 'Dados atualizados';
            notice('');
        } catch (error) {
            get('connection-dot').className = 'dot red';
            get('sync-status').textContent = 'Falha na atualização';
            notice(error instanceof Error ? error.message : 'Não foi possível atualizar o OEE.', true);
        } finally {
            refreshing = false;
            if (interactive) setActionBusy(false);
        }
    }

    get('open-stop-dialog').onclick = () => {
        if (actionBusy || !current) return;
        dialogMode = current.openEvent?.source === 'plc' ? 'classify' : 'manual';
        if (dialogMode === 'manual' && (current.state === 'STOPPED' || current.manualStop?.allowed === false)) return;
        get('stop-dialog-eyebrow').textContent = dialogMode === 'classify' ? 'PARADA AUTOMÁTICA' : 'APONTAMENTO MANUAL';
        get('stop-dialog-title').textContent = dialogMode === 'classify' ? 'Classificar parada detectada' : 'Registrar parada da linha';
        get('stop-submit').textContent = dialogMode === 'classify' ? 'SALVAR CLASSIFICAÇÃO' : 'CONFIRMAR PARADA';
        const adminRequired = dialogMode === 'manual' && !!current.manualStop?.requiresAdmin;
        get('stop-admin-field').hidden = !adminRequired;
        get<HTMLInputElement>('stop-admin-password').required = adminRequired;
        get<HTMLInputElement>('stop-admin-password').value = '';
        get('stop-warning').textContent = dialogMode === 'classify'
            ? 'O horário inicial veio das CLPs. A classificação altera somente o motivo e a observação.'
            : current.physicalMonitoring?.enabled
                ? 'Contingência manual disponível porque o estado físico não pôde ser confirmado.'
                : 'O registro começa imediatamente e permanece aberto até a ação “Retomar produção”.';
        stopDialog.showModal();
        get<HTMLSelectElement>('stop-reason').focus();
    };
    get('close-stop-dialog').onclick = () => {
        if (!actionBusy) stopDialog.close();
    };
    stopDialog.addEventListener('cancel', event => {
        if (actionBusy) event.preventDefault();
    });

    get<HTMLFormElement>('stop-form').onsubmit = event => {
        event.preventDefault();
        void (async () => {
            if (actionBusy) return;
            setActionBusy(true);
            try {
                const payload = { reasonId: get<HTMLSelectElement>('stop-reason').value,
                    notes: get<HTMLTextAreaElement>('stop-notes').value.trim() };
                if (dialogMode === 'classify' && current?.openEvent) {
                    await request('POST', `/api/availability/stops/${encodeURIComponent(current.openEvent.eventId)}/classify`, payload);
                } else {
                    let authorization: string | undefined;
                    if (current?.manualStop?.requiresAdmin) {
                        const session = await request<{ token: string }>('POST', '/api/admin/sessions',
                            { password: get<HTMLInputElement>('stop-admin-password').value });
                        authorization = `Bearer ${session.token}`;
                    }
                    await request('POST', '/api/availability/stops', { ...payload, requestId: crypto.randomUUID() }, authorization);
                }
                get<HTMLTextAreaElement>('stop-notes').value = '';
                stopDialog.close();
                notice(dialogMode === 'classify' ? 'Classificação da parada salva.' : 'Parada registrada.');
                await refreshCurrent();
                applyPreset();
                await refreshReport();
            } catch (error) {
                notice(error instanceof Error ? error.message : 'Parada não confirmada.', true);
            } finally {
                setActionBusy(false);
            }
        })();
    };

    get('resume-line').onclick = () => {
        void (async () => {
            if (actionBusy || !window.confirm('Confirmar a retomada da produção?')) return;
            setActionBusy(true);
            try {
                await request('POST', '/api/availability/resume', { requestId: crypto.randomUUID() });
                notice('Retomada registrada.');
                await refreshCurrent();
                applyPreset();
                await refreshReport();
            } catch (error) {
                notice(error instanceof Error ? error.message : 'Retomada não confirmada.', true);
            } finally {
                setActionBusy(false);
            }
        })();
    };

    get<HTMLSelectElement>('period-preset').onchange = () => {
        applyPreset();
        void refreshAll(true);
    };
    get<HTMLInputElement>('live-update').onchange = () => {
        const enabled = get<HTMLInputElement>('live-update').checked;
        get('live-status').textContent = enabled ? 'TEMPO REAL' : 'MANUAL';
        get('live-status').style.color = enabled ? '#226533' : '#555';
        void refreshAll(true);
    };
    get('apply-oee').onclick = () => { void refreshAll(true); };

    const now = new Date(), start = new Date(now);
    start.setHours(0, 0, 0, 0);
    get<HTMLInputElement>('oee-from').value = localInput(start);
    get<HTMLInputElement>('oee-to').value = localInput(now);
    void (async () => {
        try { await loadReasons(); } catch (error) {
            notice(error instanceof Error ? error.message : 'Não foi possível carregar os motivos de parada.', true);
        }
        await refreshAll();
    })();

    const poll = async () => {
        if (stopped) return;
        if (!document.hidden && !actionBusy) {
            if (get<HTMLInputElement>('live-update').checked) await refreshAll();
            else if (!refreshing) {
                try { await refreshCurrent(); } catch { /* Mantém o último estado visível. */ }
            }
        }
        if (!stopped) timer = window.setTimeout(poll, 3_000);
    };
    timer = window.setTimeout(poll, 3_000);
    window.addEventListener('pagehide', () => {
        stopped = true;
        window.clearTimeout(timer);
    }, { once: true });
})();
