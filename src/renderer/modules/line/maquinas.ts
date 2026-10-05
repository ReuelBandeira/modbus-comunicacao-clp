(() => {
    type Method = 'GET' | 'POST';
    type Action = 'start' | 'stop' | 'reset';
    type CommandStatus = 'requested' | 'validating' | 'sending' | 'waiting_ack' | 'acknowledged' | 'completing' | 'completed' | 'failed' | 'uncertain';
    interface IhmMachine {
        ihmMachineId: string; name: string; order: number;
        commandIds: Partial<Record<Action, string>>;
    }
    interface Command {
        commandId: string; code?: string; label: string; scope?: 'line' | 'machine'; requiresConfirmation?: boolean;
        available: boolean; blockedReasons: string[];
    }
    interface Execution { label: string; status: CommandStatus; error?: string; warning?: string; }
    interface StationTestResetResult {
        removedTrays: number;
        tray: { entryId: string; serialNumber: string; chipCount: number; status: 'ready' };
        machines: Array<{ machineId: string }>;
    }
    type AlarmSeverity = 'info' | 'warning' | 'critical' | 'emergency';
    interface AlarmOccurrence { occurrenceId: string; code: string; ihmMachineId?: string; title: string; description?: string;
        instruction?: string; severity: AlarmSeverity; value: number; status: 'active' | 'acknowledged' | 'cleared';
        requiresAcknowledgment: boolean; acknowledgedAt?: string; openedAt: string; }
    type MachineStatusColor = 'gray' | 'green' | 'yellow' | 'red' | 'blue';
    interface MachineStatus { ihmMachineId: string; signalId: string; signalLabel: string; status: string; color: MachineStatusColor;
        value?: number; rawValue?: number; readAt?: string; error?: string; }
    interface OperationalView { commands: Command[]; history: Array<{ label: string; status: CommandStatus; requestedAt: string }>;
        activeAlarms: AlarmOccurrence[]; alarmHistory: AlarmOccurrence[]; machineStatuses: MachineStatus[]; }
    interface WorkflowStage { machineId: string; communicationState?: string; communicationData?: Record<string, unknown>; }
    interface WorkflowTray { serialNumber: string; workflow?: { stages: WorkflowStage[] }; }
    interface WorkflowDashboard {
        line: { machines: Array<{ machineId: string; name: string }> };
        snapshot: { active: WorkflowTray[] };
    }

    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const actions: Array<{ action: Action; label: string; icon: string }> = [
        { action: 'start', label: 'Start', icon: '▶' },
        { action: 'stop', label: 'Stop', icon: '■' },
        { action: 'reset', label: 'Reset', icon: '↺' }
    ];
    let machines: IhmMachine[] = [], operational: OperationalView | undefined;
    let lineId = '', workflowDashboard: WorkflowDashboard | undefined;
    let controlsError = '', stopped = false, refreshing = false, timer: number | undefined, messageTimer: number | undefined;
    const executing = new Set<string>();
    const actionAliases: Record<Action, string[]> = {
        start: ['START', 'INICIAR', 'INICIO', 'LIGAR', 'PARTIR'],
        stop: ['STOP', 'PARAR', 'PARADA', 'DESLIGAR'],
        reset: ['RESET', 'REARMAR', 'REINICIAR']
    };
    const stationRestartCode = 'REINICIAR_ESTACAO';

    async function request<T>(method: Method, path: string, body?: unknown, authorization?: string): Promise<T> {
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request(method, path, body, authorization);
        else {
            const result = await fetch(path, { method, headers: { 'Content-Type': 'application/json',
                    ...(authorization ? { Authorization: authorization } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(65_000) });
            response = { ...await result.json(), httpStatus: result.status };
        }
        if (response.httpStatus >= 400 || response.status !== 'OK') throw new Error(response.msg || 'Operação não confirmada.');
        return response.data as T;
    }

    function commandFor(machine: IhmMachine, action: Action) {
        const commandId = machine.commandIds[action];
        return commandId ? operational?.commands.find(command => command.commandId === commandId) : undefined;
    }
    function actionFor(command: Command): Action | undefined {
        const tokens = `${command.code || ''} ${command.label}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
            .toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
        return actions.find(item => actionAliases[item.action].some(alias => tokens.includes(alias)))?.action;
    }
    function stationRestartCommand() {
        return operational?.commands.find(command => command.scope !== 'machine' && command.code?.toUpperCase() === stationRestartCode);
    }
    function generalCommand(action: Action) {
        return operational?.commands.find(command => command.scope !== 'machine'
            && command.code?.toUpperCase() !== stationRestartCode && actionFor(command) === action);
    }
    function notice(message: string, error = false, durationMs = error ? 5_000 : 2_500) {
        window.clearTimeout(messageTimer);
        const target = get('message'); target.hidden = !message; target.textContent = message;
        target.className = `notice${error ? ' error' : ''}`;
        if (message && durationMs > 0) {
            messageTimer = window.setTimeout(() => { target.hidden = true; target.textContent = ''; }, durationMs);
        }
    }
    function setLineState(text: string, tone: 'waiting' | 'running' | 'offline') {
        const state = document.getElementById('line-state');
        if (!state) return;
        state.className = `line-state ${tone}`; state.textContent = text;
    }
    function machineCommands(machine: IhmMachine) {
        return actions.map(item => commandFor(machine, item.action)).filter(Boolean) as Command[];
    }
    function detailFor(machine: IhmMachine) {
        if (controlsError) return { text: `Controles indisponíveis: ${controlsError}`, error: true };
        const configuredIds = Object.values(machine.commandIds).filter(Boolean);
        const commands = machineCommands(machine);
        const missing = configuredIds.length - commands.length;
        const reasons = commands.flatMap(command => command.blockedReasons || []);
        if (!configuredIds.length) return { text: '', error: true };
        if (missing) return { text: 'Um ou mais comandos vinculados não estão ativos na configuração de sinais.', error: true };
        if (reasons.length) return { text: [...new Set(reasons)].join(' '), error: true };
        if (configuredIds.length < actions.length) return { text: `${configuredIds.length} de ${actions.length} comandos configurados.`, error: false };
        return { text: 'Comandos vinculados ao módulo de sinais e prontos para operação.', error: false };
    }
    function renderGeneralControls() {
        for (const item of actions) {
            const command = generalCommand(item.action);
            const button = get<HTMLButtonElement>(`general-${item.action}`);
            const status = button.querySelector<HTMLElement>('.control-status')!;
            button.disabled = executing.size > 0 || !command?.available || !command.code;
            button.title = command ? (command.available ? command.label : command.blockedReasons.join(' '))
                : `${item.label} geral não configurado`;
            status.textContent = executing.has('general') ? 'Executando…'
                : command ? (command.available ? 'Disponível' : 'Bloqueado') : 'Não configurado';
            button.onclick = command ? () => void execute('a linha completa', 'general', command) : null;
        }
        const restart = stationRestartCommand(), button = get<HTMLButtonElement>('station-restart');
        button.disabled = executing.size > 0 || !restart?.available;
        button.title = restart ? (restart.available ? restart.label : restart.blockedReasons.join(' '))
            : `Cadastre o comando ${stationRestartCode} com destino Linha`;
    }
    const severityLabels: Record<AlarmSeverity, string> = {
        info: 'Informação', warning: 'Alerta', critical: 'Crítico', emergency: 'Emergência'
    };
    function alarmAge(openedAt: string) {
        const seconds = Math.max(0, Math.floor((Date.now() - new Date(openedAt).getTime()) / 1000));
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.floor(seconds / 60); return minutes < 60 ? `${minutes}min` : `${Math.floor(minutes / 60)}h ${minutes % 60}min`;
    }
    async function acknowledgeAlarm(alarm: AlarmOccurrence) {
        try { await request('POST', `/api/plc-alarms/occurrences/${alarm.occurrenceId}/acknowledge`, { acknowledgedBy: 'IHM Principal' });
            notice(`Alarme ${alarm.code} reconhecido.`); await refresh(false); }
        catch (error) { notice(error instanceof Error ? error.message : 'Reconhecimento não confirmado.', true); }
    }
    function alarmElement(alarm: AlarmOccurrence, compact = false) {
        const item = document.createElement('article'); item.className = `active-alarm ${alarm.severity}${compact ? ' compact' : ''}`;
        const header = document.createElement('div'); header.className = 'active-alarm-heading';
        const title = document.createElement('strong'); title.textContent = alarm.title;
        const badge = document.createElement('span'); badge.textContent = severityLabels[alarm.severity]; header.append(title, badge);
        const meta = document.createElement('span'); meta.className = 'active-alarm-meta';
        meta.textContent = `${alarm.code} · valor ${alarm.value} · ativo há ${alarmAge(alarm.openedAt)}`;
        item.append(header, meta);
        if (!compact && alarm.description) { const description = document.createElement('p'); description.textContent = alarm.description; item.append(description); }
        if (!compact && alarm.instruction) { const instruction = document.createElement('p'); instruction.className = 'alarm-instruction';
            instruction.textContent = `Orientação: ${alarm.instruction}`; item.append(instruction); }
        if (!compact && alarm.requiresAcknowledgment) {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'button secondary alarm-ack';
            button.textContent = alarm.acknowledgedAt ? 'Reconhecido' : 'Reconhecer'; button.disabled = !!alarm.acknowledgedAt;
            if (!alarm.acknowledgedAt) button.onclick = () => void acknowledgeAlarm(alarm); item.append(button);
        }
        return item;
    }
    function renderAlarmPanel() {
        const priority: Record<AlarmSeverity, number> = { info: 0, warning: 1, critical: 2, emergency: 3 };
        const alarms = [...(operational?.activeAlarms ?? [])].sort((left, right) => priority[right.severity] - priority[left.severity]
            || new Date(left.openedAt).getTime() - new Date(right.openedAt).getTime());
        const panel = get('active-alarm-panel'), list = get('active-alarm-list');
        panel.hidden = !alarms.length; get('active-alarm-count').textContent = String(alarms.length); list.replaceChildren();
        for (const alarm of alarms) list.append(alarmElement(alarm));
        const history = (operational?.alarmHistory ?? []).filter(alarm => alarm.status === 'cleared').slice(0, 10);
        const historyPanel = get('alarm-history-panel'), historyList = get('alarm-history-list');
        historyPanel.hidden = !history.length; historyList.replaceChildren();
        for (const alarm of history) {
            const row = document.createElement('div'), title = document.createElement('strong'), meta = document.createElement('span');
            title.textContent = `${alarm.code} · ${alarm.title}`;
            meta.textContent = `${alarm.ihmMachineId || 'Linha'} · aberto em ${new Date(alarm.openedAt).toLocaleString('pt-BR')}`;
            row.append(title, meta); historyList.append(row);
        }
    }
    function renderWorkflowAlert() {
        const panel = get('workflow-alert-panel');
        const fault = workflowDashboard?.snapshot.active.flatMap(tray => tray.workflow?.stages
            .filter(stage => stage.communicationState === 'correlation_error')
            .map(stage => ({ tray, stage })) || [])[0];
        panel.hidden = !fault;
        if (!fault) return;
        const data = fault.stage.communicationData;
        const expected = String(data?.expectedSerial ?? fault.tray.serialNumber);
        const received = String(data?.reportedSerial ?? 'QR inválido');
        const machine = workflowDashboard?.line.machines.find(item => item.machineId === fault.stage.machineId);
        get('workflow-alert-title').textContent = 'QR de saída divergente';
        get('workflow-alert-message').textContent = `${machine?.name || fault.stage.machineId}: a CLP informou uma bandeja diferente da esperada.`;
        get('workflow-alert-expected').textContent = expected;
        get('workflow-alert-received').textContent = received;
    }
    function render() {
        renderGeneralControls(); renderAlarmPanel(); renderWorkflowAlert();
        const grid = get('machine-grid'); grid.replaceChildren();
        machines.forEach((machine, index) => {
            const commands = machineCommands(machine);
            const configured = Object.values(machine.commandIds).filter(Boolean).length;
            const ready = commands.filter(command => command.available).length;
            const machineAlarms = (operational?.activeAlarms ?? []).filter(alarm => alarm.ihmMachineId === machine.ihmMachineId);
            const machineStatus = operational?.machineStatuses?.find(item => item.ihmMachineId === machine.ihmMachineId);
            const severityOrder: Record<AlarmSeverity, number> = { info: 0, warning: 1, critical: 2, emergency: 3 };
            const highestAlarm = machineAlarms.reduce<AlarmOccurrence | undefined>((selected, alarm) =>
                !selected || severityOrder[alarm.severity] > severityOrder[selected.severity] ? alarm : selected, undefined);
            const card = document.createElement('article');
            card.className = `machine-card${machineStatus ? ` status-${machineStatus.color}` : ''}${executing.has(machine.ihmMachineId) ? ' busy' : ''}${highestAlarm ? ` alarm-${highestAlarm.severity}` : ''}`;
            const heading = document.createElement('header'); heading.className = 'machine-heading';
            const identity = document.createElement('div'); identity.className = 'machine-identity';
            const order = document.createElement('span'); order.className = 'machine-order'; order.textContent = String(index + 1).padStart(2, '0');
            const name = document.createElement('strong'); name.textContent = machine.name;
            const id = document.createElement('code'); id.textContent = machine.ihmMachineId;
            identity.append(order, name, id);
            const state = document.createElement('span');
            state.className = `machine-state ${highestAlarm ? `alarm ${highestAlarm.severity}` : machineStatus ? `status ${machineStatus.color}`
                : ready ? 'online' : configured ? 'offline' : ''}`;
            state.textContent = highestAlarm ? severityLabels[highestAlarm.severity] : machineStatus?.status
                ?? (ready ? 'Pronta' : configured ? 'Bloqueada' : 'Sem comandos');
            heading.append(identity, state);

            const statusDetail = document.createElement('div'); statusDetail.className = `machine-operational-status ${machineStatus?.color || 'gray'}`;
            if (machineStatus) {
                const statusName = document.createElement('strong'); statusName.textContent = machineStatus.signalLabel;
                const statusMeta = document.createElement('span');
                const parts = [machineStatus.value === undefined ? '' : `valor ${machineStatus.value}`,
                    machineStatus.readAt ? `leitura ${new Date(machineStatus.readAt).toLocaleTimeString('pt-BR')}` : '',
                    machineStatus.error || ''].filter(Boolean);
                statusMeta.textContent = parts.join(' · ') || machineStatus.status;
                statusDetail.append(statusName, statusMeta);
            }

            const controls = document.createElement('div'); controls.className = 'machine-controls';
            for (const item of actions) {
                const command = commandFor(machine, item.action);
                const button = document.createElement('button'); button.type = 'button'; button.className = `ihm-control ${item.action}`;
                button.disabled = executing.size > 0 || !command?.available || !command.code;
                button.title = command ? (command.available ? command.label : command.blockedReasons.join(' ')) : `${item.label} não configurado`;
                const icon = document.createElement('span'); icon.className = 'control-icon'; icon.textContent = item.icon; icon.setAttribute('aria-hidden', 'true');
                const label = document.createElement('span'); label.className = 'control-label'; label.textContent = item.label;
                const status = document.createElement('span'); status.className = 'control-status';
                status.textContent = command ? (command.available ? 'Disponível' : 'Bloqueado') : 'Não configurado';
                button.append(icon, label, status);
                if (command) button.onclick = () => void execute(machine.name, machine.ihmMachineId, command);
                controls.append(button);
            }
            const detail = detailFor(machine); const detailElement = document.createElement('p');
            detailElement.className = `machine-detail${detail.error ? ' error' : ''}`; detailElement.textContent = detail.text;
            const alarmList = document.createElement('div'); alarmList.className = 'machine-alarm-list';
            for (const alarm of machineAlarms) alarmList.append(alarmElement(alarm, true));
            card.append(heading, ...(machineStatus ? [statusDetail] : []), ...(machineAlarms.length ? [alarmList] : []), controls, detailElement); grid.append(card);
        });
        if (!machines.length) {
            const empty = document.createElement('div'); empty.className = 'empty';
            empty.innerHTML = '<strong>Nenhuma máquina IHM cadastrada</strong><span>Cadastre as máquinas na interface gerencial e vincule seus comandos.</span>';
            grid.append(empty);
        }
        const latest = operational?.history[0];
        get('last-command').textContent = latest ? `Último: ${latest.label} · ${latest.status.replace('_', ' ')}` : 'Nenhum comando executado';
        const readyMachines = machines.filter(machine => machineCommands(machine).some(command => command.available)).length;
        const generalReady = actions.some(item => generalCommand(item.action)?.available);
        if (executing.size) setLineState('COMANDO EM EXECUÇÃO', 'running');
        else if ((machines.length || operational?.commands.length) && !readyMachines && !generalReady) setLineState('COMANDOS BLOQUEADOS', 'offline');
        else if (readyMachines || generalReady) setLineState('IHM PRONTA', 'running');
        else setLineState('AGUARDANDO CADASTRO', 'waiting');
    }
    async function execute(targetName: string, executionKey: string, command: Command) {
        if (!command.available || !command.code || executing.size) return;
        executing.add(executionKey); render();
        notice(`Enviando ${command.label} para ${targetName} e aguardando confirmação da CLP…`, false, 0);
        try {
            const execution = await request<Execution>('POST', `/api/plc-controls/${encodeURIComponent(command.code)}/execute`,
                { requestId: crypto.randomUUID() });
            if (execution.status !== 'completed') throw new Error(execution.error || `Comando retornou o estado ${execution.status}.`);
            notice(execution.warning || `${execution.label} em ${targetName}: comando confirmado e concluído.`, false, execution.warning ? 7_000 : 2_500);
        } catch (error) {
            notice(error instanceof Error ? error.message : 'A execução não foi confirmada.', true);
        } finally {
            executing.delete(executionKey); await refresh(false);
        }
    }
    function closeStationRestart() {
        const dialog = get<HTMLDialogElement>('station-restart-dialog');
        if (dialog.open) dialog.close();
        get<HTMLFormElement>('station-restart-form').reset();
        const error = get('station-restart-error'); error.hidden = true; error.textContent = '';
    }
    get<HTMLButtonElement>('station-restart').onclick = () => {
        if (!stationRestartCommand()?.available || executing.size) return;
        get<HTMLDialogElement>('station-restart-dialog').showModal();
        get<HTMLInputElement>('station-restart-password').focus();
    };
    get<HTMLButtonElement>('station-restart-cancel').onclick = closeStationRestart;
    get<HTMLDialogElement>('station-restart-dialog').addEventListener('cancel', event => {
        event.preventDefault(); closeStationRestart();
    });
    get<HTMLFormElement>('station-restart-form').onsubmit = event => { event.preventDefault(); void (async () => {
        const command = stationRestartCommand();
        if (!command?.available || executing.size) return;
        const form = get<HTMLFormElement>('station-restart-form');
        const password = get<HTMLInputElement>('station-restart-password'), errorTarget = get('station-restart-error');
        const controls = form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input');
        controls.forEach(control => control.disabled = true); errorTarget.hidden = true; errorTarget.textContent = '';
        try {
            const session = await request<{ token: string }>('POST', '/api/admin/sessions', { password: password.value });
            executing.add('station-restart'); render();
            notice('Reiniciando a estação, limpando os handshakes e preparando uma nova bandeja de teste…', false, 0);
            const result = await request<StationTestResetResult>('POST', '/api/station-test-reset',
                { requestId: crypto.randomUUID() }, `Bearer ${session.token}`);
            closeStationRestart();
            notice(`Reset concluído: ${result.removedTrays} bandeja(s) removida(s), ${result.machines.length} CLP(s) conferida(s) e ${result.tray.serialNumber} pronta para liberar.`, false, 8_000);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Não foi possível confirmar a reinicialização.';
            errorTarget.textContent = message; errorTarget.hidden = false; notice(message, true); password.select();
        } finally {
            executing.delete('station-restart'); controls.forEach(control => control.disabled = false); await refresh(false);
        }
    })(); };
    async function refresh(showError = true) {
        if (refreshing) return;
        refreshing = true;
        try {
            const [machinesResult, controlsResult, workflowResult] = await Promise.allSettled([
                request<IhmMachine[]>('GET', '/api/ihm-machines'),
                request<OperationalView>('GET', '/api/plc-controls/operational'),
                (async () => {
                    if (!lineId) lineId = (await request<{ entryLineId: string }>('GET', '/api/line-context')).entryLineId;
                    return request<WorkflowDashboard>('GET', `/api/lines/${encodeURIComponent(lineId)}/status`);
                })()
            ]);
            if (machinesResult.status === 'rejected') throw machinesResult.reason;
            machines = machinesResult.value;
            if (controlsResult.status === 'fulfilled') {
                operational = controlsResult.value; controlsError = '';
            } else {
                operational = { commands: [], history: [], activeAlarms: [], alarmHistory: [], machineStatuses: [] };
                controlsError = controlsResult.reason instanceof Error ? controlsResult.reason.message : 'Falha ao consultar os comandos.';
            }
            workflowDashboard = workflowResult.status === 'fulfilled' ? workflowResult.value : undefined;
            get('connection-dot').className = 'dot green';
            get('sync-status').textContent = controlsError ? 'Máquinas IHM carregadas · controles indisponíveis'
                : `Atualizado às ${new Date().toLocaleTimeString('pt-BR')}`;
            render();
            if (controlsError && showError) notice(controlsError, true);
        } catch (error) {
            get('connection-dot').className = 'dot red'; get('sync-status').textContent = 'Máquinas IHM indisponíveis';
            setLineState('COMUNICAÇÃO PERDIDA', 'offline');
            if (showError) notice(error instanceof Error ? error.message : 'Não foi possível carregar as máquinas IHM.', true);
        } finally { refreshing = false; }
    }

    async function poll() {
        if (stopped) return;
        if (!executing.size && !document.hidden) await refresh(false);
        if (!stopped) timer = window.setTimeout(poll, 2_000);
    }
    window.addEventListener('pagehide', () => { stopped = true; window.clearTimeout(timer); window.clearTimeout(messageTimer); }, { once: true });
    void refresh().finally(poll);
})();
