(() => {
    const ids = ['host', 'port', 'unitId', 'timeout', 'writeAddress', 'registerCount', 'byteOrder', 'text', 'responseAddress', 'responseCount', 'responseMode', 'expected', 'responseTimeout'] as const;
    const field = (id: string) => document.getElementById(id) as HTMLInputElement;
    const status = document.getElementById('status')!;
    const log = document.getElementById('log')!;
    const connection = document.getElementById('connection-status')!;
    const plc = document.getElementById('plc-status')!;
    let active = false;
    let stopped = false;
    let revision = 0;
    let probing: Promise<void> | undefined;
    const indicate = (element: HTMLElement, state: string, text: string) => {
        element.dataset.state = state; element.textContent = text;
    };
    const optionsFromFields = () => Object.fromEntries(ids.map(id => [id, numeric.has(id) ? Number(field(id).value) : field(id).value])) as unknown as Parameters<typeof window.modbus.execute>[1];
    const showConnection = (ok: boolean) => {
        indicate(connection, ok ? 'ok' : 'error', ok ? 'ONLINE' : 'OFFLINE');
        if (!ok) indicate(plc, 'idle', 'SEM CONEXÃO');
        else if (plc.textContent === 'SEM CONEXÃO') indicate(plc, 'idle', 'AGUARDANDO ENVIO');
    };
    const checkConnection = (): Promise<void> => {
        if (stopped || active || pollingEnabled) return Promise.resolve();
        if (probing) return probing;
        if (!field('host').value.trim()) {
            indicate(connection, 'idle', 'NÃO CONFIGURADO');
            indicate(plc, 'idle', 'AGUARDANDO ENVIO');
            return Promise.resolve();
        }
        const current = revision;
        probing = (async () => {
            try {
                const result = await window.modbus.execute('probe', { ...optionsFromFields(), timeout: 1500 });
                if (!stopped && current === revision) showConnection(result.ok);
            } catch {
                if (!stopped && current === revision) showConnection(false);
            } finally { probing = undefined; }
        })();
        return probing;
    };
    const numeric = new Set(['port', 'unitId', 'timeout', 'writeAddress', 'registerCount', 'responseAddress', 'responseCount', 'responseTimeout']);
    try { const saved = JSON.parse(sessionStorage.getItem('pcm.modbus.test') || '{}'); ids.forEach(id => { if (typeof saved[id] === 'string') field(id).value = saved[id]; }); } catch {}
    const save = () => { try { sessionStorage.setItem('pcm.modbus.test', JSON.stringify(Object.fromEntries(ids.map(id => [id, field(id).value])))); } catch {} };
    ids.forEach(id => field(id).addEventListener('change', save));
    ids.forEach(id => field(id).addEventListener('input', () => {
        revision++;
        indicate(plc, 'idle', 'AGUARDANDO ENVIO');
        if (id === 'host' || id === 'port') indicate(connection, 'idle', field('host').value.trim() ? 'AGUARDANDO VERIFICAÇÃO' : 'NÃO CONFIGURADO');
    }));
    const record = (message: string) => {
        const row = document.createElement('pre'); row.textContent = `${new Date().toLocaleTimeString('pt-BR')} · ${message}`; log.prepend(row);
        while (log.children.length > 100) log.lastElementChild?.remove();
    };
    const execute = async (action: 'ping' | 'read' | 'send') => {
        if (active || stopped) return;
        if (pollingEnabled) { stopPolling(); monitorRecord('Polling pausado para executar o teste manual.'); }
        active = true;
        save();
        const options = Object.fromEntries(ids.map(id => [id, numeric.has(id) ? Number(field(id).value) : field(id).value]));
        const controls = document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,select,textarea,button');
        controls.forEach(control => { control.disabled = true; }); status.textContent = 'Teste em andamento…';
        if (action === 'send') indicate(plc, 'pending', 'AGUARDANDO');
        record(`${action === 'send' ? 'Envio solicitado' : action === 'read' ? 'Leitura solicitada' : 'Ping ICMP + TCP'} para ${options.host}:${options.port}`);
        try {
            await probing;
            if (stopped) return;
            if (action === 'send') indicate(plc, 'pending', 'AGUARDANDO');
            const result = await window.modbus.execute(action, options as unknown as Parameters<typeof window.modbus.execute>[1]);
            if (stopped) return;
            if (action === 'ping') showConnection(result.ok);
            if (action === 'send') indicate(plc, result.ok && result.written ? 'ok' : 'error', result.ok && result.written ? 'OK' : 'ERRO');
            status.textContent = result.ok ? 'Teste concluído' : 'Verifique o resultado';
            record(result.message);
            if (result.registers) record(`Registradores: ${result.registers.join(', ')}\nHex: ${result.registers.map(value => value.toString(16).padStart(4, '0')).join(' ')}\nTexto: ${JSON.stringify(result.text)}`);
        } catch (error) {
            status.textContent = 'Erro no teste'; record((error as Error).message);
            if (action === 'send') indicate(plc, 'error', 'ERRO');
        }
        finally {
            active = false;
            controls.forEach(control => { control.disabled = false; });
            void checkConnection();
        }
    };
    (['ping', 'read', 'send'] as const).forEach(action => { field(action).onclick = () => void execute(action); });
    field('clear').onclick = () => log.replaceChildren();
    type Config = import('../../../modules/pcm/workflow/dtos/lineDashboardDto').Json<import('../../../modules/machines/models/lineModel').LineConfig>;
    type Dashboard = import('../../../modules/pcm/workflow/dtos/lineDashboardDto').Json<import('../../../modules/pcm/workflow/dtos/lineDashboardDto').LineDashboard>;
    type MonitorResult = import('../../../modules/modbus/types/modbusTypes').ModbusMonitorResult;
    let pollingMachine: Config['machines'][number] | undefined;
    let pollingLineId = '';
    let pollingMachines: Config['machines'] = [];
    let pollingEnabled = false;
    let pollingTimer: number | undefined;
    let pollingCount = 0;
    let lastRequest: boolean | undefined;
    let lastExit: boolean | undefined;
    let lastReady: boolean | undefined;
    let pollingConnected: boolean | undefined;
    const pollingToggle = document.getElementById('polling-toggle') as HTMLButtonElement;
    const pollingReload = document.getElementById('polling-reload') as HTMLButtonElement;
    const pollingMachineSelect = document.getElementById('polling-machine') as HTMLSelectElement;
    const pollingLog = document.getElementById('polling-log')!;
    const monitorText = (id: string, text: string) => { document.getElementById(id)!.textContent = text; };
    const monitorRecord = (message: string) => {
        const row = document.createElement('pre'); row.textContent = `${new Date().toLocaleTimeString('pt-BR')} · ${message}`; pollingLog.prepend(row);
        while (pollingLog.children.length > 100) pollingLog.lastElementChild?.remove();
    };
    const showSignal = (id: string, value: boolean | undefined) => {
        const element = document.getElementById(id)!; element.textContent = value === undefined ? '—' : String(value).toUpperCase();
        element.dataset.value = value === undefined ? 'unknown' : String(value);
    };
    const showPollingConnection = (state: 'stopped' | 'connecting' | 'connected' | 'disconnected') => {
        const element = document.getElementById('polling-connection')!;
        element.dataset.value = state === 'stopped' ? 'unknown' : state;
        element.textContent = state === 'connected' ? 'CONECTADO' : state === 'connecting' ? 'CONECTANDO'
            : state === 'disconnected' ? 'DESCONECTADO' : 'PARADO';
    };
    async function lineRequest<T>(path: string): Promise<T> {
        if (!window.lineApi) throw new Error('API do cadastro indisponível. Abra esta tela pelo aplicativo desktop.');
        const response = await window.lineApi.request('GET', path);
        if (response.httpStatus >= 400 || response.status !== 'OK') throw new Error(response.msg || 'Cadastro não encontrado.');
        return response.data as T;
    }
    async function loadPollingConfig() {
        pollingReload.disabled = true;
        try {
            const context = await lineRequest<{ entryLineId: string }>('/api/line-context');
            pollingLineId = context.entryLineId;
            const config = await lineRequest<Config>(`/api/lines/${encodeURIComponent(context.entryLineId)}`);
            const previous = pollingMachineSelect.value;
            pollingMachines = config.machines.filter(machine => machine.protocol !== 'unmapped' && machine.modbus?.enabled);
            pollingMachineSelect.replaceChildren(...pollingMachines.map(machine => {
                const option = document.createElement('option'); option.value = machine.machineId;
                option.textContent = `${machine.name} · QR + resultado`; return option;
            }));
            if (pollingMachines.some(machine => machine.machineId === previous)) pollingMachineSelect.value = previous;
            pollingMachine = pollingMachines.find(machine => machine.machineId === pollingMachineSelect.value) ?? pollingMachines[0];
            if (!pollingMachine?.modbus) throw new Error('Nenhuma máquina com protocolo M1 e integração habilitada foi encontrada no CRUD.');
            const machine = pollingMachine, modbus = machine.modbus!, map = modbus.map;
            monitorText('polling-config', `${machine.name} · ${machine.host}:${machine.port} · Unit ID ${machine.unitId} · intervalo ${modbus.pollingMs} ms · revisão ${config.revision}`);
            monitorText('polling-endpoint', `${machine.host}:${machine.port} · Unit ${machine.unitId}`);
            const usesQr = machine.protocol !== 'unmapped';
            const isQrHandshake = ['m1-qr-handshake-v1', 'ifts-qr-handshake-v1'].includes(machine.protocol);
            monitorText('request-address', usesQr ? `Coil ${map.requestQrCoil} · base zero` : 'Não utilizado nesta máquina');
            showSignal('request-qr', undefined);
            monitorText('exit-address', isQrHandshake ? `Coil ${map.resultReadyCoil} · base zero` : 'Não utilizado nesta máquina');
            showSignal('exit-confirmed', undefined);
            const positionStart = map.positionStartRegister ?? map.serialStartRegister + map.serialRegisterCount + 1;
            const positionRegisters = map.positionRegisterCount ?? 4;
            const mailboxEnd = isQrHandshake ? map.qrEntrySequenceRegister + map.serialRegisterCount - 1
                : positionStart + positionRegisters - 1;
            monitorText('result-address', `HR ${map.qrEntrySequenceRegister}–${mailboxEnd} · base zero`);
            pollingToggle.disabled = false;
            monitorRecord(`Cadastro carregado: ${machine.machineId}, polling ${modbus.pollingMs} ms.`);
        } catch (error) {
            pollingMachine = undefined; pollingMachines = []; pollingEnabled = false; pollingToggle.disabled = true;
            monitorText('polling-config', (error as Error).message); monitorRecord(`ERRO · ${(error as Error).message}`);
        } finally { pollingReload.disabled = false; }
    }
    function stopPolling() {
        pollingEnabled = false; window.clearTimeout(pollingTimer); pollingTimer = undefined;
        pollingToggle.textContent = 'INICIAR POLLING'; pollingToggle.className = 'btn btn-success';
        pollingConnected = undefined; showPollingConnection('stopped');
    }
    async function showQueuedQr(machineId: string) {
        try {
            const dashboard = await lineRequest<Dashboard>(`/api/lines/${encodeURIComponent(pollingLineId)}/status`);
            const active = dashboard.snapshot.active.find(item => item.workflow?.activeMachineId === machineId);
            const queued = dashboard.snapshot.queues.find(item => item.machineId === machineId)?.next;
            const pcm = active ?? queued;
            if (pcm) {
                const sequence = pcm.workflow?.entrySequence;
                monitorRecord(`REQUEST_QR=TRUE Â· QR que a CLP deve ler: ${pcm.serialNumber}${sequence ? ` Â· SEQUENCE=${sequence}` : ''}`);
                if (sequence !== undefined && pollingMachine?.modbus) {
                    const config = pollingMachine.modbus, map = config.map;
                    const bytes = new TextEncoder().encode(pcm.serialNumber);
                    const serialRegisters = Array.from({ length: map.serialRegisterCount }, (_, index) => {
                        const first = bytes[index * 2] ?? 0, second = bytes[index * 2 + 1] ?? 0;
                        return config.byteOrder === 'be' ? first * 256 + second : second * 256 + first;
                    });
                    const hex = serialRegisters.map(value => value.toString(16).toUpperCase().padStart(4, '0')).join(' ');
                    monitorRecord([
                        active ? 'MAILBOX DA CLP GRAVADO PELO NODE' : 'CONTEUDO PREVISTO (BANDEJA AINDA NA FILA)',
                        `Holding SERIAL: endereço ${map.qrEntrySequenceRegister}, quantidade ${map.serialRegisterCount}`,
                        `Valores decimais: [${serialRegisters.join(', ')}]`,
                        `Valores hex: ${hex}`,
                        `Texto esperado: ${pcm.serialNumber}`
                        , ...(bytes.length > map.serialRegisterCount * 2
                            ? [`ATENÃ‡ÃƒO: QR com ${bytes.length} bytes excede a capacidade de ${map.serialRegisterCount * 2} bytes.`] : [])
                    ].join('\n'));
                }
            } else monitorRecord('REQUEST_QR=TRUE Â· nenhum QR aguardando na fila.');
        } catch (error) {
            monitorRecord(`REQUEST_QR=TRUE Â· nÃ£o foi possÃ­vel consultar a fila: ${(error as Error).message}`);
        }
    }
    async function pollingCycle() {
        if (!pollingEnabled || stopped || !pollingMachine?.modbus) return;
        const machine = pollingMachine, config = machine.modbus!;
        try {
            if (active) return;
            if (pollingConnected !== true) showPollingConnection('connecting');
            const result: MonitorResult = await window.modbus.execute('monitor', {
                host: machine.host, port: machine.port, unitId: machine.unitId, timeout: machine.timeoutMs,
                includeRequestQr: machine.protocol !== 'unmapped',
                serialOnly: ['m1-qr-handshake-v1', 'ifts-qr-handshake-v1'].includes(machine.protocol),
                byteOrder: config.byteOrder, wordOrder: config.wordOrder,
                map: {
                    requestQrCoil: config.map.requestQrCoil,
                    resultReadyCoil: config.map.resultReadyCoil,
                    qrEntrySequenceRegister: config.map.qrEntrySequenceRegister,
                    serialLengthRegister: config.map.serialLengthRegister,
                    serialStartRegister: config.map.serialStartRegister,
                    serialRegisterCount: config.map.serialRegisterCount,
                    positionCountRegister: config.map.positionCountRegister ?? config.map.serialStartRegister + config.map.serialRegisterCount,
                    positionStartRegister: config.map.positionStartRegister ?? config.map.serialStartRegister + config.map.serialRegisterCount + 1,
                    positionRegisterCount: config.map.positionRegisterCount ?? 4
                }
            });
            if (!result.ok) throw new Error(result.message);
            pollingCount++;
            if (pollingConnected !== true) monitorRecord(`CONECTADO · ${machine.host}:${machine.port} · Unit ID ${machine.unitId}.`);
            pollingConnected = true; showPollingConnection('connected');
            showSignal('request-qr', result.requestQr); showSignal('exit-confirmed', result.exitConfirmed);
            showSignal('result-ready', result.mailboxEmpty === undefined ? undefined : !result.mailboxEmpty);
            monitorText('polling-count', String(pollingCount));
            monitorText('polling-last', `Última consulta: ${new Date(result.readAt || Date.now()).toLocaleTimeString('pt-BR')}`);
            if (result.requestQr !== undefined && lastRequest !== result.requestQr) monitorRecord(`REQUEST_QR = ${String(result.requestQr).toUpperCase()}`);
            if (result.exitConfirmed !== undefined && lastExit !== result.exitConfirmed) monitorRecord(`CONFIRMAR_SAIDA = ${String(result.exitConfirmed).toUpperCase()}`);
            if (result.requestQr === true && lastRequest !== true) await showQueuedQr(machine.machineId);
            const mailboxOccupied = result.mailboxEmpty === undefined ? undefined : !result.mailboxEmpty;
            if (lastReady !== mailboxOccupied) monitorRecord(`MAILBOX_OCUPADO = ${String(mailboxOccupied).toUpperCase()}`);
            monitorRecord(`POLL #${pollingCount}${result.requestQr === undefined ? '' : ` · REQUEST_QR=${String(result.requestQr).toUpperCase()}`} · MAILBOX_OCUPADO=${String(mailboxOccupied).toUpperCase()}`);
            lastRequest = result.requestQr; lastExit = result.exitConfirmed; lastReady = mailboxOccupied;
            const readingPanel = document.querySelector<HTMLElement>('.reading-panel')!;
            readingPanel.dataset.active = String(mailboxOccupied === true);
            if (mailboxOccupied && result.mailbox) {
                monitorText('reading-state', `Leitura FC03 realizada às ${new Date().toLocaleTimeString('pt-BR')}`);
                monitorText('result-sequence', result.mailbox.entrySequence === undefined ? 'Não enviado' : String(result.mailbox.entrySequence));
                monitorText('result-value', result.mailbox.serial);
                monitorText('result-error', String(result.mailbox.positionCount));
                monitorText('result-cycle', result.mailbox.positions.map(value => value ? '1' : '0').join(', ') || '—');
                monitorRecord(`Leitura: sequência=${result.mailbox.entrySequence ?? 'não enviada'}, serial=${result.mailbox.serial}, posições=[${result.mailbox.positions.join(', ')}].`);
            } else monitorText('reading-state', 'Aguardando mailbox ocupado');
        } catch (error) {
            if (pollingConnected !== false) monitorRecord(`DESCONECTADO · ${(error as Error).message}`);
            else monitorRecord(`POLL SEM RESPOSTA · ${(error as Error).message}`);
            pollingConnected = false; showPollingConnection('disconnected');
        }
        finally { if (pollingEnabled && !stopped) pollingTimer = window.setTimeout(pollingCycle, pollingMachine?.modbus?.pollingMs || 1000); }
    }
    pollingToggle.onclick = () => {
        if (pollingEnabled) { stopPolling(); monitorRecord('Polling interrompido pelo operador.'); return; }
        if (!pollingMachine?.modbus) return;
        pollingEnabled = true; pollingToggle.textContent = 'PARAR POLLING'; pollingToggle.className = 'btn btn-warning';
        monitorRecord('Polling iniciado.'); void pollingCycle();
    };
    pollingReload.onclick = () => { stopPolling(); void loadPollingConfig(); };
    pollingMachineSelect.onchange = () => {
        stopPolling(); pollingCount = 0; lastRequest = undefined; lastExit = undefined; lastReady = undefined;
        pollingMachine = pollingMachines.find(machine => machine.machineId === pollingMachineSelect.value);
        void loadPollingConfig();
    };
    const monitor = window.setInterval(() => void checkConnection(), 3000);
    window.addEventListener('pagehide', () => { stopped = true; stopPolling(); window.clearInterval(monitor); revision++; });
    pollingToggle.disabled = true;
    void loadPollingConfig(); void checkConnection();
})();
