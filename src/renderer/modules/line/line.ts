(() => {
    type Json<T> = import('../../../modules/pcm/workflow/dtos/lineDashboardDto').Json<T>;
    type Dashboard = Json<import('../../../modules/pcm/workflow/dtos/lineDashboardDto').LineDashboard>;
    type Config = Json<import('../../../modules/machines/models/lineModel').LineConfig>;
    type Machine = Config['machines'][number];
    type Handshake = NonNullable<Machine['modbus']>;
    type Tray = Json<import('../../../modules/pcm/models/pcmModel').PCM>;
    type Stage = NonNullable<Tray['workflow']>['stages'][number];
    type ConnectionTest = import('../../../modules/modbus/services/machineConnectionProbe').MachineConnectionProbeResult;
    type CommunicationRecord = Json<import('../../../modules/modbus/services/communicationLog').CommunicationLogRecord>;
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') => {
        const element = document.createElement(tag); element.className = className; element.textContent = text; return element;
    };
    const button = (text: string, onClick: () => void, className = 'button secondary') => {
        const element = node('button', className, text); element.type = 'button'; element.onclick = onClick; return element;
    };
    const date = (value?: string) => value ? new Date(value).toLocaleString('pt-BR') : '—';
    const labels: Record<Stage['state'], string> = {
        waiting: 'Aguardando', processing: 'Em processo',
        result_recorded: 'Aguardando passagem', completed: 'Concluída', skipped: 'Não executada', cancelled: 'Cancelada'
    };
    let lineId = '', dashboard: Dashboard | undefined, draft: Config | undefined;
    let dirty = false, online = false, busy = false, stopped = false;
    let refreshing: Promise<void> | undefined, timer: number | undefined, lastSuccess = '';
    let selectedTray: { serial: string; entrySequence?: number } | undefined;
    let selectedTrayDetails: Tray | undefined, advanceToken = '', advanceBusy = false;
    let communicationRecords: CommunicationRecord[] = [], communicationTimer: number | undefined;
    let communicationPaused = false, communicationFloor = 0;
    class ApiError extends Error { constructor(public code: number, message: string) { super(message); } }

    async function request<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown, authorization?: string): Promise<T> {
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request(method, path, body, authorization);
        else {
            const result = await fetch(path, {
                method, headers: { 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
                body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)
            });
            response = { ...await result.json(), httpStatus: result.status };
        }
        if (response.httpStatus >= 400 || response.status !== 'OK') throw new ApiError(response.httpStatus, response.msg || 'Operação não confirmada.');
        return response.data as T;
    }
    function notice(text: string, error = false) {
        get('notice').hidden = !text; get('notice').className = `notice${error ? ' error' : ''}`; get('notice').textContent = text;
    }
    function setLineState(text: string, tone: 'online' | 'waiting' | 'running' | 'offline' | 'stale' | 'blocked') {
        const state = document.getElementById('line-state');
        if (!state) return;
        state.className = `line-state ${tone}`; state.textContent = text;
    }
    function errorText(error: unknown) {
        return error instanceof ApiError ? error.message : 'Não foi possível acessar a API. Confira se o serviço e o MongoDB estão disponíveis.';
    }
    const configurationMode = new URLSearchParams(location.search).get('tab') === 'machines';
    get('overview-panel').hidden = configurationMode;
    get('machines-panel').hidden = !configurationMode;
    get('screen-title').textContent = configurationMode ? 'PCM - CONFIGURAÇÃO DE ESTAÇÃO' : 'PCM - ACOMPANHAMENTO DA LINHA';
    document.title = configurationMode ? 'PCM · Cadastro de máquinas' : 'PCM · Acompanhamento da linha';

    function openMachineConfig() {
        const target = new URL(location.href); target.searchParams.set('tab', 'machines'); location.assign(target.href);
    }

    const base = () => `/api/lines/${encodeURIComponent(lineId)}`;
    function stageTone(stage?: Stage): string {
        if (stage?.communicationState) return 'blocked';
        if (stage?.action === 'BYPASS' || stage?.state === 'skipped') return 'bypass';
        if (stage?.result === 'NAO') return 'rejected';
        if (stage?.result === 'OK') return 'ok';
        return stage?.state === 'processing' ? 'processing' : 'neutral';
    }
    function stageLabel(stage?: Stage): string {
        if (!stage) return 'Aguardando chegada';
        if (stage.communicationState === 'correlation_error') return 'QR DIVERGENTE';
        if (stage.communicationState === 'protocol_error') return 'DADOS INVÁLIDOS';
        if (stage.communicationState === 'timeout') return 'TEMPO EXCEDIDO';
        if (stage.communicationState === 'connection_error') return 'SEM COMUNICAÇÃO';
        if (stage.action === 'BYPASS') return stage.state === 'skipped' ? 'Passou sem processar' : 'Bypass · sem processar';
        return `${stage.result ? stage.result === 'NAO' ? 'NÃO · ' : 'OK · ' : ''}${labels[stage.state]}`;
    }
    function operatorStageLabel(stage: Stage): string {
        if (stage.communicationState === 'correlation_error') return 'Bloqueada · QR divergente';
        if (stage.communicationState === 'protocol_error') return 'Bloqueada · dados inválidos da CLP';
        if (stage.communicationState === 'timeout') return 'Bloqueada · resposta da CLP demorando';
        if (stage.communicationState === 'connection_error') return 'Bloqueada · comunicação perdida';
        if (stage.state === 'waiting') return 'Aguardando chegada';
        if (stage.state === 'processing') return 'Na máquina · teste em andamento';
        if (stage.state === 'result_recorded') return 'Teste concluído · aguardando saída';
        if (stage.state === 'skipped') return 'Saiu sem executar o teste';
        return stage.result === 'NAO' ? 'Saiu · falha identificada' : 'Saiu · etapa aprovada';
    }
    function plcDetails(stage?: Stage): string {
        if (!stage || !stage.data && !stage.communicationData) return '';
        const communication = stage.communicationData || stage.data;
        if (stage.communicationState === 'correlation_error') {
            return `Falha de correlação · esperado ${String(communication?.expectedSerial ?? '—')} · recebido ${String(communication?.reportedSerial ?? '—')}`;
        }
        if (stage.communicationState === 'protocol_error') {
            return `Quantidade inválida · esperado ${String(communication?.expectedPositionCount ?? '—')} · recebido ${String(communication?.reportedPositionCount ?? '—')}`;
        }
        if (stage.communicationState === 'timeout') {
            return `Tempo excedido · fase ${String(communication?.phase ?? 'handshake')} · limite ${String(communication?.timeoutMs ?? '—')} ms`;
        }
        if (stage.communicationState === 'connection_error') {
            return 'Conexão Modbus indisponível; a bandeja permanece pendente.';
        }
        const data = stage.data || {};
        const error = data.errorCode, cycle = data.cycleTimeMs;
        const positions = Array.isArray(data.positions) ? data.positions : [];
        const failed = positions.flatMap((value, index) => value === false ? [index + 1] : []);
        const positionSummary = positions.length
            ? failed.length
                ? `${failed.length === 1 ? 'Posição com falha' : 'Posições com falha'}: ${failed.join(', ')}`
                : `${positions.length} posições aprovadas`
            : '';
        return [cycle !== undefined ? `Ciclo ${cycle} ms` : '', error !== undefined ? `Erro ${error}` : '', positionSummary]
            .filter(Boolean).join(' · ');
    }
    function activeMachine(machineId: string) {
        const active = dashboard?.snapshot.active.filter(tray => tray.workflow?.activeMachineId === machineId) || [];
        const pcm = active.sort((left, right) => (left.workflow?.entrySequence || 0) - (right.workflow?.entrySequence || 0))[0];
        return { pcm, activeCount: active.length, stage: pcm?.workflow?.stages.find(stage => stage.machineId === machineId) };
    }
    function recentMachineOutcome(machineId: string) {
        let latest: { pcm: Dashboard['snapshot']['recent'][number]; stage: Stage; passedAt: number } | undefined;
        for (const pcm of dashboard?.snapshot.recent || []) {
            const stage = pcm.workflow?.stages.find(item => item.machineId === machineId);
            const passedAt = stage?.passedAt ? new Date(stage.passedAt).getTime() : 0;
            if (stage && ['completed', 'skipped'].includes(stage.state) && passedAt > (latest?.passedAt || 0)) latest = { pcm, stage, passedAt };
        }
        if (!latest) return undefined;
        const visibleFor = latest.stage.result === 'NAO' ? 6000 : 4000;
        return Date.now() - latest.passedAt <= visibleFor ? latest : undefined;
    }
    function outcomeLabel(stage: Stage) {
        if (stage.action === 'BYPASS' || stage.state === 'skipped') return 'BYPASS';
        return stage.result === 'NAO' ? 'REPROVADA' : 'APROVADA';
    }
    function machineName(id?: string) { return dashboard?.line.machines.find(machine => machine.machineId === id)?.name || id || '—'; }
    function advanceRoute(tray: Tray) {
        const workflow = tray.workflow;
        if (!workflow || workflow.status !== 'in_progress') return undefined;
        const fromMachineId = workflow.activeMachineId || workflow.nextMachineId;
        const index = workflow.stages.findIndex(stage => stage.machineId === fromMachineId);
        if (!fromMachineId || index < 0 || index >= workflow.stages.length - 1) return undefined;
        return { fromMachineId, toMachineId: workflow.stages[index + 1].machineId };
    }

    function renderDashboard() {
        const stations = get('stations'); stations.replaceChildren();
        const history = get<HTMLTableSectionElement>('history'); history.replaceChildren();
        const totals = dashboard?.snapshot.totals;
        const correlationFault = dashboard?.snapshot.active.flatMap(pcm => pcm.workflow?.stages
            .filter(stage => Boolean(stage.communicationState))
            .map(stage => ({ pcm, stage })) || [])[0];
        const offlineMachine = dashboard?.communication?.find(health => health.status === 'offline');
        if (!configurationMode) {
            if (correlationFault) {
                const communication = correlationFault.stage.communicationData || correlationFault.stage.data;
                const detail = correlationFault.stage.communicationState === 'correlation_error'
                    ? `recebeu QR ${String(communication?.reportedSerial ?? 'inválido')}; esperado ${correlationFault.pcm.serialNumber}`
                    : correlationFault.stage.communicationState === 'protocol_error'
                        ? `recebeu ${String(communication?.reportedPositionCount ?? '—')} posições; esperado ${String(communication?.expectedPositionCount ?? '—')}`
                        : correlationFault.stage.communicationState === 'timeout' ? 'excedeu o tempo esperado do handshake'
                            : 'perdeu a comunicação Modbus';
                notice(`LINHA BLOQUEADA · ${machineName(correlationFault.stage.machineId)} ${detail}.`, true);
            }
            else if (offlineMachine) notice(`COMUNICAÇÃO PERDIDA · ${machineName(offlineMachine.machineId)} · ${offlineMachine.error || 'CLP indisponível'}. A bandeja permanece pendente.`, true);
            else if (get('notice').textContent?.startsWith('LINHA BLOQUEADA')) notice('');
            else if (get('notice').textContent?.startsWith('COMUNICAÇÃO PERDIDA')) notice('');
        }
        get('metric-progress').textContent = totals ? String(totals.inProgress) : '—';
        get('metric-completed').textContent = totals ? String(totals.completed) : '—';
        get('metric-rejected').textContent = totals ? String(totals.rejected) : '—';
        get('metric-total').textContent = totals ? String(totals.total) : '—';
        get('machine-count').textContent = dashboard ? `${dashboard.line.machines.length} estações` : '';
        if (!dashboard) {
            const empty = node('div', 'empty'); empty.append(node('strong', '', online ? 'Cadastre sua linha para começar' : 'Aguardando conexão'));
            empty.append(node('p', '', online ? 'Adicione as máquinas, seus endereços e a ordem de produção.' : 'Os dados serão exibidos assim que o banco estiver disponível.'));
            if (online) empty.append(button('Cadastrar máquinas', openMachineConfig, 'button primary'));
            stations.append(empty);
        } else {
            dashboard.line.machines.forEach((machine, index) => {
                const { pcm, activeCount, stage } = activeMachine(machine.machineId);
                const outcome = pcm ? undefined : recentMachineOutcome(machine.machineId);
                const visibleStage = stage || outcome?.stage;
                const queue = dashboard!.snapshot.queues.find(item => item.machineId === machine.machineId);
                const waiting = dashboard!.snapshot.waiting.find(item => item.machineId === machine.machineId)?.count || 0;
                const card = node('article', `station ${stageTone(visibleStage)}`); card.dataset.machine = machine.machineId;
                const heading = node('div', 'station-heading'); heading.append(node('span', 'station-order', String(index + 1).padStart(2, '0')));
                const title = node('div'); title.append(node('h3', '', machine.name), node('span', 'station-address', `${machine.host}:${machine.port}`)); heading.append(title);
                const status = outcome ? outcomeLabel(outcome.stage) : stageLabel(stage);
                const capacity = machine.protocol === 'm1-qr-handshake-v1' ? machine.modbus?.inFlightCapacity ?? 1 : 1;
                card.append(heading, node('span', `badge ${stageTone(visibleStage)}`, status),
                    node('p', 'station-label', pcm ? capacity > 1
                        ? `${activeCount} de ${capacity} bandejas na célula · primeira da fila`
                        : 'Bandeja nesta estação' : outcome ? 'Resultado da última passagem' : 'Próxima bandeja na fila'));
                const displayedTray = pcm || outcome?.pcm || queue?.next;
                const serial = displayedTray?.serialNumber;
                const serialArea = node('div', 'station-serial');
                if (serial) serialArea.append(button(serial, () => {
                    void showTray(serial, displayedTray?.workflow?.entrySequence);
                }, '')); else serialArea.textContent = '—';
                card.append(serialArea);
                if (displayedTray && advanceRoute(displayedTray)) {
                    card.append(button('ENVIAR À PRÓXIMA ESTAÇÃO', () => openAdvance(displayedTray), 'button warning station-advance'));
                }
                const details = plcDetails(visibleStage); if (details) card.append(node('p', 'plc-details', details));
                const ready = node('div', 'station-queue'); ready.append(node('span', '', 'Na fila desta estação '), node('strong', '', String(queue?.count || 0))); card.append(ready);
                card.append(node('p', 'upstream-note', `${Math.max(0, waiting - (queue?.count || 0))} aguardando etapas anteriores`));
                stations.append(card);
            });
        }
        for (const pcm of dashboard?.snapshot.recent || []) {
            const row = node('tr'); const cell = (text = '') => { const td = node('td', '', text); row.append(td); return td; };
            const workflow = pcm.workflow!;
            cell(String(workflow.entrySequence).padStart(3, '0'));
            const code = node('code', '', pcm.serialNumber); code.title = pcm.serialNumber; cell().append(code);
            cell(date(pcm.enteredAt));
            cell(workflow.status === 'completed' ? 'Percurso concluído'
                : workflow.status === 'removed' ? 'Retirada da linha'
                    : workflow.status === 'quarantined' ? 'Em quarentena'
                        : workflow.activeMachineId ? machineName(workflow.activeMachineId) : `Fila · ${machineName(workflow.nextMachineId)}`);
            cell().append(node('span', `badge ${workflow.quality === 'rejected' ? 'rejected' : workflow.quality === 'approved' ? 'ok' : 'neutral'}`,
                workflow.quality === 'rejected' ? 'Reprovada' : workflow.quality === 'approved' ? 'Aprovada' : 'Em avaliação'));
            const view = button('Ver etapas →', () => { void showTray(pcm.serialNumber, workflow.entrySequence); }, 'text-button');
            view.setAttribute('aria-label', `Ver etapas da passagem ${workflow.entrySequence} da bandeja ${pcm.serialNumber}`); cell().append(view); history.append(row);
        }
        if (!history.children.length) { const row = node('tr'); const td = node('td', 'table-empty', 'Nenhuma bandeja registrada nesta linha.'); td.colSpan = 6; row.append(td); history.append(row); }
    }

    function blankHandshake(): Handshake {
        return {
            enabled: true, inFlightCapacity: 1, outputAckMode: 'pulse', outputAckPulseMs: 600,
            pollingMs: 200, reconnectInitialMs: 1000, reconnectMaxMs: 30000,
            acceptInitialRequest: false, completePassageOnResult: true, byteOrder: 'be', wordOrder: 'high-low',
            expectedPositionCount: 20, phaseTimeoutMs: 120000,
            resultOkValue: 1, resultErrorValue: 2,
            map: {
                requestQrCoil: 0, resultReadyCoil: 1, resultAckCoil: 2,
                resultEntrySequenceRegister: 100, resultRegister: 102, errorCodeRegister: 103,
                cycleTimeRegister: 104, qrReadyCoil: 0, qrAckCoil: 1,
                qrEntrySequenceRegister: 0, serialLengthRegister: 2,
                serialStartRegister: 3, serialRegisterCount: 32, outputSerialStartRegister: 32,
                positionCountRegister: 35, positionStartRegister: 36, positionRegisterCount: 4
            }
        };
    }
    function blankMachine(): Machine {
        let number = 1; while (draft?.machines.some(machine => machine.machineId === `m${number}`)) number++;
        return { machineId: `m${number}`, name: `Máquina ${number}`, host: '', port: 502, unitId: 1, timeoutMs: 3000, protocol: 'unmapped' };
    }
    function loadDraft() {
        draft = dashboard ? structuredClone(dashboard.line) : {
            lineId, name: '', mode: 'simulation', minimumOperators: 3,
            ipRange: { min: 25, max: 75 }, machines: [], createdAt: '', revision: 1
        };
        draft.minimumOperators ??= 3;
        if (!draft.machines.length) {
            for (let index = 0; index < 4; index++) {
                const machine = blankMachine();
                machine.protocol = index === 0 ? 'm1-qr-handshake-v1' : 'result-handshake-v1';
                machine.modbus = blankHandshake();
                draft.machines.push(machine);
            }
        }
        draft.machines.forEach(machine => {
            machine.protocol ??= 'unmapped';
            if (machine.modbus) {
                const map = machine.modbus.map;
                map.positionCountRegister ??= map.serialStartRegister + map.serialRegisterCount;
                map.positionStartRegister ??= map.positionCountRegister + 1;
                map.positionRegisterCount ??= 4;
                machine.modbus.expectedPositionCount ??= 20;
                machine.modbus.phaseTimeoutMs ??= 120000;
                machine.modbus.inFlightCapacity ??= 1;
                machine.modbus.outputAckMode ??= 'pulse';
                machine.modbus.outputAckPulseMs = Math.max(600, machine.modbus.outputAckPulseMs ?? 600);
                map.outputSerialStartRegister ??= map.qrEntrySequenceRegister + map.serialRegisterCount;
            }
        });
        dirty = false; renderEditor();
    }
    function changed() { dirty = true; updateControls(); }
    function renderEditor() {
        if (!draft) return;
        get<HTMLInputElement>('config-line-id').value = draft.lineId;
        get<HTMLInputElement>('config-name').value = draft.name;
        get<HTMLInputElement>('config-min').value = String(draft.ipRange.min);
        get<HTMLInputElement>('config-max').value = String(draft.ipRange.max);
        const list = get('machine-editor'); list.replaceChildren();
        draft.machines.forEach((machine, index) => {
            const row = node('div', 'machine-row'); row.dataset.index = String(index);
            row.append(node('span', 'station-order', String(index + 1).padStart(2, '0')));
            function field(key: 'name' | 'machineId' | 'host' | 'port' | 'unitId' | 'timeoutMs', title: string, type = 'text', min?: number, max?: number) {
                const label = node('label', '', title), input = node('input'); input.type = type; input.required = true;
                input.value = String(machine[key]); input.dataset.field = key;
                input.setAttribute('aria-label', `${title} da máquina ${index + 1}`);
                if (min !== undefined) input.min = String(min); if (max !== undefined) input.max = String(max);
                if (key === 'name') input.maxLength = 100;
                if (key === 'machineId') { input.pattern = '[a-zA-Z0-9_\\-]{1,80}'; input.maxLength = 80; }
                if (key === 'host') { input.placeholder = '192.168.1.25'; input.maxLength = 15; }
                input.oninput = () => {
                    if (key === 'port' || key === 'unitId' || key === 'timeoutMs') machine[key] = Number(input.value);
                    else machine[key] = input.value;
                    changed();
                };
                label.append(input); return label;
            }
            row.append(field('name', 'Nome'), field('machineId', 'Identificador'), field('host', 'Endereço IP'), field('port', 'Porta', 'number', 1, 65535));
            const actions = node('div', 'row-actions');
            const move = (delta: number) => {
                const target = index + delta; const [item] = draft!.machines.splice(index, 1); draft!.machines.splice(target, 0, item);
                changed(); renderEditor(); list.querySelector<HTMLInputElement>(`[data-index="${target}"] input`)?.focus();
            };
            const up = button('↑', () => move(-1), ''); up.disabled = index === 0; up.setAttribute('aria-label', `Mover ${machine.name} para cima`);
            const down = button('↓', () => move(1), ''); down.disabled = index === draft!.machines.length - 1; down.setAttribute('aria-label', `Mover ${machine.name} para baixo`);
            const remove = button('×', () => { draft!.machines.splice(index, 1); changed(); renderEditor(); }, 'remove'); remove.disabled = draft!.machines.length === 1; remove.setAttribute('aria-label', `Remover ${machine.name}`);
            const testStatus = node('div', 'connection-test-status', 'Comunicação ainda não testada.');
            testStatus.setAttribute('role', 'status');
            const testConnection = button('Testar comunicação', () => {
                void (async () => {
                    testConnection.dataset.testing = 'true'; testConnection.disabled = true;
                    testStatus.className = 'connection-test-status testing'; testStatus.textContent = 'Testando comunicação Modbus…';
                    try {
                        const result = await request<ConnectionTest>('POST', `${base()}/machines/${encodeURIComponent(machine.machineId)}/connection-test`, {
                            host: machine.host, port: machine.port, unitId: machine.unitId, timeoutMs: machine.timeoutMs,
                            requestQrCoil: machine.modbus?.map.requestQrCoil ?? 0
                        });
                        testStatus.className = `connection-test-status ${result.ok ? 'success' : 'error'}`;
                        testStatus.textContent = result.ok
                            ? `Conectado · Modbus respondeu em ${result.latencyMs} ms · coil=${result.requestQr ? 'TRUE' : 'FALSE'}`
                            : `${result.message} (${result.latencyMs} ms)`;
                    } catch (error) {
                        testStatus.className = 'connection-test-status error'; testStatus.textContent = errorText(error);
                    } finally { delete testConnection.dataset.testing; testConnection.disabled = busy || !online; }
                })();
            }, 'test-connection');
            testConnection.dataset.testMachine = machine.machineId;
            testConnection.disabled = busy || !online;
            actions.append(up, down, remove, testConnection); row.append(actions, testStatus);
            const advanced = node('details', 'machine-advanced');
            advanced.append(node('summary', '', 'Configuração Modbus e handshake'));
            const fields = node('div', 'advanced-fields');
            fields.append(field('unitId', 'Unit ID da CLP', 'number', 1, 247), field('timeoutMs', 'Timeout (ms)', 'number', 100, 10000));
            const protocolLabel = node('label', '', 'Protocolo');
            const protocol = node('select');
            const unmapped = node('option', '', 'Não configurado'); unmapped.value = 'unmapped'; protocol.append(unmapped);
            if (index === 0) { const m1 = node('option', '', 'Estação 1 · Node envia QR'); m1.value = 'm1-qr-handshake-v1'; protocol.append(m1); }
            else {
                const ifts = node('option', '', 'Estação IFTS · QR de entrada e saída'); ifts.value = 'ifts-qr-handshake-v1';
                const result = node('option', '', 'Estação 2–4 · CLP envia dados'); result.value = 'result-handshake-v1';
                protocol.append(ifts, result);
            }
            protocol.value = machine.protocol;
            protocol.onchange = () => {
                machine.protocol = protocol.value as Machine['protocol'];
                if (machine.protocol !== 'unmapped') machine.modbus ??= blankHandshake();
                else delete machine.modbus;
                if (machine.protocol === 'ifts-qr-handshake-v1' && machine.modbus) {
                    machine.modbus.inFlightCapacity = 1;
                    Object.assign(machine.modbus.map, {
                        requestQrCoil: 0, resultReadyCoil: 1, resultAckCoil: 2,
                        qrEntrySequenceRegister: 0, serialLengthRegister: 2, serialStartRegister: 3,
                        serialRegisterCount: 15, outputSerialStartRegister: 21,
                        positionCountRegister: 18, positionStartRegister: 19
                    });
                }
                changed(); renderEditor();
            };
            protocolLabel.append(protocol); fields.prepend(protocolLabel); advanced.append(fields);
            if (machine.protocol !== 'unmapped' && machine.modbus) {
                const modbus = machine.modbus;
                const section = (title: string) => { const box = node('fieldset', 'modbus-section'); box.append(node('legend', '', title)); return box; };
                const inputField = <K extends keyof Handshake>(key: K, title: string, type = 'number', min?: number, max?: number) => {
                    const label = node('label', '', title), input = node('input'); input.type = type;
                    const value = modbus[key]; input.value = typeof value === 'number' && !Number.isFinite(value) ? '' : String(value);
                    input.required = true; input.dataset.modbusField = String(key);
                    if (min !== undefined) input.min = String(min); if (max !== undefined) input.max = String(max);
                    input.oninput = () => { (modbus as unknown as Record<string, unknown>)[key] = type === 'number' ? Number(input.value) : input.value; changed(); };
                    label.append(input); return label;
                };
                const mapField = (key: keyof Handshake['map'], title: string, min = 0, max = 65535) => {
                    const label = node('label', '', title), input = node('input'); input.type = 'number'; input.required = true;
                    input.min = String(min); input.max = String(max); input.dataset.mapField = key;
                    input.value = Number.isFinite(modbus.map[key]) ? String(modbus.map[key]) : '';
                    input.oninput = () => { modbus.map[key] = Number(input.value); changed(); };
                    label.append(input); return label;
                };
                const check = (key: 'enabled' | 'acceptInitialRequest' | 'completePassageOnResult', title: string) => {
                    const label = node('label', 'check-field', title), input = node('input'); input.type = 'checkbox'; input.checked = modbus[key];
                    input.onchange = () => { modbus[key] = input.checked; changed(); }; label.prepend(input); return label;
                };
                const ackModeField = () => {
                    const label = node('label', '', 'Responsável por limpar o ACK de saída'), select = node('select');
                    ([['pulse', 'IHM · envia pulso e limpa'], ['plc-reset', 'CLP · recebe TRUE e limpa']] as const)
                        .forEach(([value, text]) => { const option = node('option', '', text); option.value = value; select.append(option); });
                    select.value = modbus.outputAckMode;
                    select.onchange = () => { modbus.outputAckMode = select.value as Handshake['outputAckMode']; changed(); renderEditor(); };
                    label.append(select); return label;
                };
                const connection = section('Conexão e execução'), connectionFields = node('div', 'modbus-grid');
                connectionFields.append(check('enabled', 'Habilitar integração'), inputField('pollingMs', 'Polling (ms)', 'number', 50, 60000),
                    inputField('reconnectInitialMs', 'Reconexão inicial (ms)', 'number', 100, 60000),
                    inputField('reconnectMaxMs', 'Reconexão máxima (ms)', 'number', 100, 300000),
                    inputField('phaseTimeoutMs', 'Alerta de demora da fase (ms)', 'number', 1000, 3600000));
                const qrHandshake = index === 0 || machine.protocol === 'ifts-qr-handshake-v1';
                if (qrHandshake) connectionFields.append(
                    ...(index === 0 ? [inputField('inFlightCapacity', 'Bandejas simultâneas na célula', 'number', 1, 32)] : []),
                    ackModeField(),
                    ...(modbus.outputAckMode === 'pulse'
                        ? [inputField('outputAckPulseMs', 'Pulso de confirmação M2 (ms, mín. 600)', 'number', 600, 5000)] : []),
                    check('acceptInitialRequest', 'Aceitar REQUEST_QR já ativo ao iniciar'));
                connection.append(connectionFields);
                const plc = section('Mailbox na memória da CLP'), plcFields = node('div', 'modbus-grid');
                plc.append(node('p', 'modbus-note', qrHandshake
                    ? `${machine.protocol === 'ifts-qr-handshake-v1' ? 'Na estação IFTS' : 'Na célula paralela'}: M0 pede o QR em D0; M1 informa o QR de saída e a IHM confirma a persistência em M2. ${modbus.outputAckMode === 'plc-reset' ? 'A CLP deve limpar M2 antes da próxima saída.' : 'A IHM envia e encerra o pulso.'}`
                    : 'A CLP grava QR e posições; o Node persiste, zera como ACK e só libera a próxima estação após confirmar o bloco vazio.'));
                if (qrHandshake) plcFields.append(mapField('requestQrCoil', 'M0 · REQ_INFO_BANDEJA'),
                    mapField('resultReadyCoil', 'M1 · QR_SAÍDA_PRONTO'),
                    mapField('resultAckCoil', `M2 · ACK_SAÍDA (${modbus.outputAckMode === 'plc-reset' ? 'CLP limpa' : 'pulso'})`),
                    mapField('qrEntrySequenceRegister', 'Início da escrita do SERIAL'),
                    mapField('serialRegisterCount', 'Quantidade de Words do QR', 1, 117),
                    mapField('outputSerialStartRegister', 'Início do QR de saída'));
                else plcFields.append(mapField('qrEntrySequenceRegister', 'Início · ENTRY_SEQUENCE (2)'),
                    mapField('serialLengthRegister', 'SERIAL_LENGTH'), mapField('serialStartRegister', 'Início do SERIAL'),
                    mapField('serialRegisterCount', 'Registers reservados ao SERIAL', 1, 117),
                    mapField('positionCountRegister', 'POSITION_COUNT'), mapField('positionStartRegister', 'Início de POSITION_BITS'),
                    mapField('positionRegisterCount', 'Registers de POSITION_BITS', 1, 117),
                    inputField('expectedPositionCount', 'Quantidade exata de posições', 'number', 1, 1872));
                plc.append(plcFields);
                const format = section('Formato dos dados'), formatFields = node('div', 'modbus-grid');
                const selectField = <K extends 'byteOrder' | 'wordOrder'>(key: K, title: string, options: [Handshake[K], string][]) => {
                    const label = node('label', '', title), select = node('select');
                    options.forEach(([value, text]) => { const option = node('option', '', text); option.value = value; select.append(option); });
                    select.value = modbus[key]; select.onchange = () => { modbus[key] = select.value as Handshake[K]; changed(); };
                    label.append(select); return label;
                };
                formatFields.append(selectField('byteOrder', 'Ordem dos bytes do serial', [['be', 'AB'], ['le', 'BA']]),
                    selectField('wordOrder', 'Ordem UINT32', [['high-low', 'High word → Low word'], ['low-high', 'Low word → High word']]));
                format.append(formatFields);
                advanced.append(connection);
                advanced.append(plc, format);
            }
            row.append(advanced);
            list.append(row);
        });
        updateControls();
    }
    get<HTMLInputElement>('config-name').oninput = event => { if (draft) draft.name = (event.target as HTMLInputElement).value; changed(); };
    for (const field of ['min', 'max'] as const) get<HTMLInputElement>(`config-${field}`).oninput = event => {
        if (draft) draft.ipRange[field] = Number((event.target as HTMLInputElement).value); changed();
    };
    get('add-machine').onclick = () => { if (draft && draft.machines.length < 32) { draft.machines.push(blankMachine()); changed(); renderEditor(); } };
    get('reload-config').onclick = () => { loadDraft(); notice('Cadastro recarregado. Alterações locais descartadas.'); };

    function updateControls() {
        const hasWork = (dashboard?.snapshot.totals.inProgress || 0) > 0;
        const conflict = !!dashboard && !!draft && draft.revision !== dashboard.line.revision;
        get<HTMLFieldSetElement>('config-fields').disabled = busy || !online || hasWork;
        get<HTMLButtonElement>('save-config').disabled = busy || !online || hasWork || conflict || !draft;
        get<HTMLButtonElement>('reload-config').disabled = busy || !online;
        get<HTMLButtonElement>('add-machine').disabled = (draft?.machines.length || 0) >= 32;
        document.querySelectorAll<HTMLButtonElement>('[data-test-machine]').forEach(control => {
            control.disabled = busy || !online || control.dataset.testing === 'true';
        });
        const message = hasWork ? 'Há bandejas em andamento. Finalize suas passagens antes de editar máquinas ou sequência.'
            : conflict ? 'Este cadastro foi alterado em outra sessão. Recarregue antes de salvar.' : '';
        get('config-lock').hidden = !message; get('config-lock').textContent = message;
        get('config-note').textContent = dirty ? 'Você tem alterações não salvas.' : '';
        if (!dashboard && !dirty) get('config-note').textContent = 'Preencha os endereços e salve para habilitar a linha.';
    }

    async function mutation(action: () => Promise<void>) {
        if (busy || !online) return;
        busy = true; updateControls(); notice('');
        try { await refreshing; await action(); await refresh(); }
        catch (error) { notice(errorText(error), true); await refresh(); }
        finally { busy = false; updateControls(); }
    }
    get<HTMLFormElement>('config-form').onsubmit = event => {
        event.preventDefault(); if (!draft) return;
        void mutation(async () => {
            const body = {
                lineId: draft!.lineId, name: draft!.name, mode: draft!.mode, ipRange: draft!.ipRange,
                machines: draft!.machines, ...(dashboard ? { revision: draft!.revision } : {})
            };
            const config = await request<Config>(dashboard ? 'PUT' : 'POST', dashboard ? base() : '/api/lines', body);
            draft = config; dirty = false; notice('Configuração salva no banco.'); renderEditor();
        });
    };
    async function showTray(serial: string, entrySequence?: number) {
        try {
            const path = entrySequence === undefined ? `/api/trays/${encodeURIComponent(serial)}`
                : `${base()}/trays/${entrySequence}`;
            const tray = await request<Tray>('GET', path);
            selectedTrayDetails = tray;
            selectedTray = { serial, ...(entrySequence === undefined ? {} : { entrySequence }) };
            const workflow = tray.workflow;
            get('tray-title').textContent = `Bandeja ${tray.serialNumber}${workflow ? ` · passagem ${workflow.entrySequence}` : ''}`;
            const summary = get('tray-summary'); summary.replaceChildren();
            const summaryItem = (label: string, value: string, tone = '') => {
                const item = node('div', `tray-summary-item ${tone}`.trim());
                item.append(node('span', '', label), node('strong', '', value)); return item;
            };
            summary.append(summaryItem('Serial', tray.serialNumber), summaryItem('Entrada na linha', date(tray.enteredAt)));
            if (workflow) {
                const routeStatus = workflow.status === 'completed' ? 'Processo finalizado'
                    : workflow.status === 'removed' ? 'Retirada da linha'
                        : workflow.status === 'quarantined' ? 'Em quarentena' : 'Em processo';
                const quality = workflow.quality === 'rejected' ? 'Com falha' : workflow.quality === 'approved' ? 'Aprovada' : 'Aguardando resultado';
                summary.append(summaryItem('Situação', routeStatus, workflow.status === 'completed' ? 'success'
                    : workflow.status === 'in_progress' ? 'processing' : 'error'),
                    summaryItem('Resultado da bandeja', quality, workflow.quality === 'rejected' ? 'error' : workflow.quality === 'approved' ? 'success' : 'processing'));
            } else summary.append(summaryItem('Situação', 'Registro sem etapas', 'processing'));
            const stages = get('tray-stages'); stages.replaceChildren();
            for (const [index, stage] of (workflow?.stages || []).entries()) {
                const card = node('article', 'stage-detail'); const heading = node('div');
                const title = node('div', 'stage-title');
                title.append(node('span', 'station-order', String(index + 1).padStart(2, '0')), node('strong', '', machineName(stage.machineId)));
                heading.append(title, node('span', `badge ${stageTone(stage)}`, operatorStageLabel(stage))); card.append(heading);
                const timing = node('div', 'stage-timing');
                const timingItem = (label: string, value: string) => {
                    const item = node('div'); item.append(node('span', '', label), node('strong', '', value)); return item;
                };
                timing.append(timingItem('Chegou na máquina', stage.startedAt ? date(stage.startedAt) : 'Ainda não chegou'),
                    timingItem('Saiu da máquina', stage.passedAt ? date(stage.passedAt) : 'Ainda não saiu'),
                    timingItem('Status', operatorStageLabel(stage)));
                card.append(timing);

                const rawPositions = stage.data?.positions;
                const positions = Array.isArray(rawPositions) && rawPositions.every(value => typeof value === 'boolean')
                    ? rawPositions as boolean[] : [];
                if (positions.length) {
                    const failed = positions.flatMap((value, position) => value ? [] : [position + 1]);
                    const positionBox = node('section', 'position-report');
                    positionBox.append(node('strong', '', failed.length
                        ? `${failed.length === 1 ? 'Posição com falha' : 'Posições com falha'}: ${failed.join(', ')}`
                        : `Todas as ${positions.length} posições foram aprovadas`));
                    const map = node('div', 'position-map');
                    positions.forEach((approved, position) => {
                        const chip = node('div', `position-chip ${approved ? 'approved' : 'failed'}`);
                        chip.setAttribute('aria-label', `Posição ${position + 1}: ${approved ? 'aprovada' : 'falhou'}`);
                        chip.append(node('strong', '', String(position + 1)), node('span', '', approved ? 'OK' : 'FALHA')); map.append(chip);
                    });
                    positionBox.append(map); card.append(positionBox);
                }
                const details = plcDetails(stage); if (details) card.append(node('p', 'plc-details', details));
                if (stage.data && Object.keys(stage.data).length) {
                    const technical = node('details', 'stage-technical');
                    technical.append(node('summary', '', 'Ver dados técnicos'), node('pre', '', JSON.stringify(stage.data, null, 2))); card.append(technical);
                }
                stages.append(card);
            }
            if (!stages.children.length) stages.append(node('p', 'empty tray-empty', 'Esta bandeja ainda não possui etapas registradas.'));
            get('tray-updated').textContent = `Consultado em ${new Date().toLocaleTimeString('pt-BR')}`;
            get<HTMLButtonElement>('advance-tray').hidden = !advanceRoute(tray);
            const dialog = get<HTMLDialogElement>('tray-dialog'); if (!dialog.open) dialog.showModal();
        } catch (error) { notice(errorText(error), true); }
    }
    get<HTMLFormElement>('lookup-form').onsubmit = event => { event.preventDefault(); void showTray(get<HTMLInputElement>('lookup-serial').value); };
    get('close-dialog').onclick = () => get<HTMLDialogElement>('tray-dialog').close();
    get('refresh-tray').onclick = () => { if (selectedTray) void showTray(selectedTray.serial, selectedTray.entrySequence); };
    get('advance-tray').onclick = () => { if (selectedTrayDetails) openAdvance(selectedTrayDetails); };

    function openAdvance(tray: Tray) {
        const route = advanceRoute(tray); if (!route || !tray.workflow) return;
        selectedTrayDetails = tray;
        get('advance-context').textContent = `${tray.serialNumber} · ${machineName(route.fromMachineId)} → ${machineName(route.toMachineId)}`;
        get<HTMLFormElement>('advance-form').reset();
        get<HTMLDialogElement>('advance-dialog').showModal(); get<HTMLInputElement>('advance-reason').focus();
    }
    function setAdvanceBusy(value: boolean) {
        advanceBusy = value;
        get<HTMLDialogElement>('advance-dialog').querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>(
            'button,input,textarea').forEach(control => control.disabled = value);
    }
    get<HTMLFormElement>('advance-form').onsubmit = event => { event.preventDefault(); void (async () => {
        const tray = selectedTrayDetails, workflow = tray?.workflow;
        if (advanceBusy || !tray || !workflow || !advanceRoute(tray)) return;
        setAdvanceBusy(true);
        try {
            if (!advanceToken) {
                const session = await request<{ token: string }>('POST', '/api/admin/sessions',
                    { password: get<HTMLInputElement>('advance-password').value });
                advanceToken = session.token;
            }
            await request('POST', `${base()}/trays/${workflow.entrySequence}/advance`, {
                reason: get<HTMLInputElement>('advance-reason').value.trim(),
                notes: get<HTMLTextAreaElement>('advance-notes').value.trim(),
                physicalMovementConfirmed: get<HTMLInputElement>('advance-physical').checked
            }, `Bearer ${advanceToken}`);
            get<HTMLDialogElement>('advance-dialog').close(); get<HTMLDialogElement>('tray-dialog').close();
            notice(`Bandeja ${tray.serialNumber} enviada para a fila da próxima estação.`); await refresh();
        } catch (error) {
            if (error instanceof ApiError && error.code === 401) advanceToken = '';
            notice(errorText(error), true);
        } finally { setAdvanceBusy(false); }
    })(); };
    get('close-advance').onclick = () => { if (!advanceBusy) get<HTMLDialogElement>('advance-dialog').close(); };

    function renderCommunication() {
        const output = get('communication-log');
        const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
        const selectedMachine = get<HTMLSelectElement>('communication-machine').value;
        const visible = communicationRecords.filter(record => record.id > communicationFloor
            && (!selectedMachine || record.machineId === selectedMachine));
        output.replaceChildren();
        for (const record of visible) {
            const direction = record.direction === 'PLC_TO_NODE' ? 'plc' : record.direction === 'NODE_TO_PLC' ? 'node' : 'system';
            const label = record.direction === 'PLC_TO_NODE' ? 'CLP → Node' : record.direction === 'NODE_TO_PLC' ? 'Node → CLP' : 'Sistema';
            const entry = node('article', `communication-entry ${direction}${record.level === 'error' ? ' error' : ''}`);
            const heading = node('div', 'communication-entry-heading');
            heading.append(node('time', '', new Date(record.timestamp).toLocaleTimeString('pt-BR')),
                node('strong', '', record.machineId.toUpperCase()), node('span', `communication-direction ${direction}`, label),
                node('code', '', record.event));
            entry.append(heading, node('p', '', record.message));
            if (record.data !== undefined) {
                const details = node('details', 'communication-data');
                details.append(node('summary', '', 'Ver dados trafegados'), node('pre', '', JSON.stringify(record.data, null, 2))); entry.append(details);
            }
            output.append(entry);
        }
        if (!visible.length) output.append(node('p', 'communication-empty', 'Nenhuma comunicação para exibir.'));
        get('communication-status').textContent = communicationPaused
            ? `Pausado · ${visible.length} registros na tela` : `Ao vivo · ${visible.length} registros na tela`;
        if (nearBottom) output.scrollTop = output.scrollHeight;
    }
    function updateCommunicationMachines() {
        const select = get<HTMLSelectElement>('communication-machine'), selected = select.value;
        const machines = [...new Set(communicationRecords.map(record => record.machineId))].sort();
        select.replaceChildren(); const all = node('option', '', 'Todas'); all.value = ''; select.append(all);
        for (const machine of machines) { const option = node('option', '', machine.toUpperCase()); option.value = machine; select.append(option); }
        if (machines.includes(selected)) select.value = selected;
    }
    async function loadCommunication() {
        if (!get<HTMLDialogElement>('communication-dialog').open || communicationPaused) return;
        try {
            communicationRecords = await request<CommunicationRecord[]>('GET', '/api/communication-logs');
            updateCommunicationMachines(); renderCommunication();
        } catch (error) { get('communication-status').textContent = errorText(error); }
    }
    function scheduleCommunication() {
        window.clearTimeout(communicationTimer);
        communicationTimer = window.setTimeout(async () => {
            await loadCommunication();
            if (get<HTMLDialogElement>('communication-dialog').open) scheduleCommunication();
        }, 1000);
    }
    function openCommunication() {
        const dialog = get<HTMLDialogElement>('communication-dialog'); dialog.showModal();
        void loadCommunication(); scheduleCommunication();
    }
    get('close-communication').onclick = () => {
        get<HTMLDialogElement>('communication-dialog').close(); window.clearTimeout(communicationTimer);
    };
    get('popout-communication').onclick = () => { void (async () => {
        try {
            await window.station.openCommunicationWindow();
            get<HTMLDialogElement>('communication-dialog').close(); window.clearTimeout(communicationTimer);
        } catch (error) { get('communication-status').textContent = errorText(error); }
    })(); };
    get('pause-communication').onclick = () => {
        communicationPaused = !communicationPaused;
        get('pause-communication').textContent = communicationPaused ? 'Continuar' : 'Pausar';
        renderCommunication(); if (!communicationPaused) void loadCommunication();
    };
    get('clear-communication').onclick = () => {
        communicationFloor = communicationRecords.at(-1)?.id || communicationFloor; renderCommunication();
    };
    get('communication-machine').onchange = renderCommunication;
    if (new URLSearchParams(location.search).get('dialog') === 'communication') openCommunication();

    function refresh(): Promise<void> {
        if (refreshing) return refreshing;
        refreshing = (async () => {
            try {
                if (!lineId) {
                    const context = await request<{ entryLineId: string }>('GET', '/api/line-context'); lineId = context.entryLineId;
                }
                try { dashboard = await request<Dashboard>('GET', `${base()}/status`); }
                catch (error) { if (!(error instanceof ApiError) || error.code !== 404) throw error; dashboard = undefined; }
                online = true; lastSuccess = new Date().toLocaleTimeString('pt-BR');
                get('sync-status').textContent = dashboard ? `Atualizado às ${lastSuccess}` : 'Banco disponível · linha não cadastrada';
                get('connection-dot').className = 'dot green'; document.body.classList.remove('stale');
                const correlationFault = dashboard?.snapshot.active.some(pcm => pcm.workflow?.stages
                    .some(stage => Boolean(stage.communicationState)));
                const offlineMachine = dashboard?.communication?.some(health => health.status === 'offline');
                setLineState(configurationMode ? 'CONFIGURAÇÃO' : !dashboard ? 'LINHA NÃO CADASTRADA'
                    : correlationFault ? 'LINHA BLOQUEADA' : offlineMachine ? 'CLP SEM COMUNICAÇÃO'
                        : dashboard.snapshot.totals.inProgress > 0 ? 'PRODUÇÃO EM ANDAMENTO' : 'AGUARDANDO BANDEJA',
                    configurationMode || !dashboard ? 'online' : correlationFault || offlineMachine ? 'blocked'
                        : dashboard.snapshot.totals.inProgress > 0 ? 'running' : 'waiting');
                if (!draft || !dirty && dashboard && draft.revision !== dashboard.line.revision) loadDraft();
                renderDashboard();
            } catch (error) {
                online = false; get('sync-status').textContent = lastSuccess ? `Sem atualização · última às ${lastSuccess}` : 'Banco / API indisponível';
                get('connection-dot').className = 'dot red'; document.body.classList.add('stale');
                setLineState(lastSuccess ? 'DADOS DESATUALIZADOS' : 'COMUNICAÇÃO PERDIDA', lastSuccess ? 'stale' : 'offline');
                if (!dashboard) renderDashboard();
            } finally { updateControls(); }
        })().finally(() => { refreshing = undefined; });
        return refreshing;
    }
    async function poll() {
        if (stopped) return;
        if (!busy && !document.hidden) await refresh();
        if (!stopped) timer = window.setTimeout(poll, 2000);
    }
    window.addEventListener('pagehide', () => { stopped = true; window.clearTimeout(timer); window.clearTimeout(communicationTimer); }, { once: true });
    updateControls(); void refresh().then(() => poll());
})();
