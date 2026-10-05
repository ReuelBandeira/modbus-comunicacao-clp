(() => {
    type Json<T> = import('../../../modules/pcm/workflow/dtos/lineDashboardDto').Json<T>;
    type CommunicationRecord = Json<import('../../../modules/modbus/services/communicationLog').CommunicationLogRecord>;
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
        const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
    };
    let records: CommunicationRecord[] = [], floor = 0, paused = false, timer: number | undefined, stopped = false;

    function setConnection(online: boolean, text: string) {
        get('connection-dot').className = `dot ${online ? 'online' : 'offline'}`;
        get('connection-status').textContent = text;
    }
    function updateMachines() {
        const select = get<HTMLSelectElement>('machine-filter'), selected = select.value;
        const machines = [...new Set(records.map(record => record.machineId))].sort();
        select.replaceChildren(); const all = node('option', '', 'Todas'); all.value = ''; select.append(all);
        for (const machine of machines) {
            const option = node('option', '', machine.toUpperCase()); option.value = machine; select.append(option);
        }
        if (machines.includes(selected)) select.value = selected;
    }
    function render() {
        const output = get('communication-log');
        const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
        const machine = get<HTMLSelectElement>('machine-filter').value;
        const visible = records.filter(record => record.id > floor && (!machine || record.machineId === machine));
        output.replaceChildren();
        for (const record of visible) {
            const direction = record.direction === 'PLC_TO_NODE' ? 'plc' : record.direction === 'NODE_TO_PLC' ? 'node' : 'system';
            const label = record.direction === 'PLC_TO_NODE' ? 'CLP → Node' : record.direction === 'NODE_TO_PLC' ? 'Node → CLP' : 'Sistema';
            const entry = node('article', `communication-entry ${direction}${record.level === 'error' ? ' error' : ''}`);
            const heading = node('div', 'entry-heading');
            heading.append(node('time', '', new Date(record.timestamp).toLocaleTimeString('pt-BR')),
                node('strong', '', record.machineId.toUpperCase()), node('span', `communication-direction ${direction}`, label),
                node('code', '', record.event));
            entry.append(heading, node('p', '', record.message));
            if (record.data !== undefined) {
                const details = node('details');
                details.append(node('summary', '', 'Ver dados trafegados'), node('pre', '', JSON.stringify(record.data, null, 2)));
                entry.append(details);
            }
            output.append(entry);
        }
        if (!visible.length) output.append(node('p', 'empty', 'Nenhuma comunicação para exibir.'));
        get('record-status').textContent = paused ? `Pausado · ${visible.length} registros` : `Ao vivo · ${visible.length} registros`;
        if (nearBottom) output.scrollTop = output.scrollHeight;
    }
    async function load() {
        if (paused || stopped) return;
        try {
            if (!window.lineApi) throw new Error('API da linha indisponível.');
            const response = await window.lineApi.request('GET', '/api/communication-logs');
            if (response.httpStatus >= 400 || response.status !== 'OK') throw new Error(response.msg || 'Consulta não confirmada.');
            records = response.data as CommunicationRecord[];
            updateMachines(); render(); setConnection(true, `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`);
        } catch (error) {
            setConnection(false, error instanceof Error ? error.message : 'Comunicação indisponível.');
        }
    }
    function schedule() {
        window.clearTimeout(timer);
        timer = window.setTimeout(async () => { await load(); if (!stopped) schedule(); }, 500);
    }
    get('pause').onclick = () => {
        paused = !paused; get('pause').textContent = paused ? 'Continuar' : 'Pausar';
        render(); if (!paused) void load();
    };
    get('clear').onclick = () => { floor = records.at(-1)?.id || floor; render(); };
    get('machine-filter').onchange = render;
    window.addEventListener('pagehide', () => { stopped = true; window.clearTimeout(timer); }, { once: true });
    void load(); schedule();
})();
