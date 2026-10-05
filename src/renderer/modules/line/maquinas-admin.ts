(() => {
    type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
    type Action = 'start' | 'stop' | 'reset';
    type Command = import('../../../modules/plcSignals/models/plcSignalModel').PlcCommand;
    interface IhmMachine {
        ihmMachineId: string; name: string; enabled: boolean; order: number;
        commandIds: Partial<Record<Action, string>>;
    }
    interface PlcView { commands: Command[]; }

    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    let token = '', machines: IhmMachine[] = [], commands: Command[] = [], editing: IhmMachine | undefined, busy = false;

    async function request<T>(method: Method, path: string, body?: unknown, authenticated = true): Promise<T> {
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
            if (response.httpStatus === 401 && authenticated) logout();
            throw new Error(response.msg || 'Operação não confirmada.');
        }
        return response.data as T;
    }
    function setBusy(value: boolean) {
        busy = value;
        document.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('#login-panel button, #login-panel input, #admin-content button, #admin-content input, #admin-content select')
            .forEach(control => control.disabled = value || control.id === 'machine-id' && !!editing);
    }
    function message(value: string, error = false) {
        const notice = get('message'); notice.textContent = value; notice.hidden = !value;
        notice.className = error ? 'notice error' : 'notice';
    }
    function option(select: HTMLSelectElement, optionValue: string, text: string) {
        const item = document.createElement('option'); item.value = optionValue; item.textContent = text; select.append(item);
    }
    function commandName(commandId?: string) {
        if (!commandId) return 'Não configurado';
        const command = commands.find(item => item.commandId === commandId);
        return command ? `${command.label} (${command.code})` : `Comando removido (${commandId})`;
    }
    function fillCommandSelects(selected: Partial<Record<Action, string>> = {}) {
        for (const action of ['start', 'stop', 'reset'] as Action[]) {
            const select = get<HTMLSelectElement>(`machine-${action}`); select.replaceChildren();
            option(select, '', 'Não configurado');
            for (const command of commands) {
                const target = command.scope === 'machine' ? `Máquina ${command.targetMachineId || 'sem destino'}` : 'Linha';
                option(select, command.commandId, `${command.label} · ${command.code} · ${target}`);
            }
            select.value = selected[action] || '';
        }
    }
    function resetEditor() {
        editing = undefined; get<HTMLFormElement>('machine-form').reset();
        get<HTMLInputElement>('machine-order').value = '0'; get<HTMLInputElement>('machine-enabled').checked = true;
        get<HTMLInputElement>('machine-id').disabled = false; fillCommandSelects();
        get('editor-title').textContent = 'Nova máquina IHM'; get('save-machine').textContent = 'Cadastrar máquina';
        get<HTMLButtonElement>('cancel-edit').hidden = true;
    }
    function edit(machine: IhmMachine) {
        editing = machine;
        get<HTMLInputElement>('machine-id').value = machine.ihmMachineId;
        get<HTMLInputElement>('machine-id').disabled = true;
        get<HTMLInputElement>('machine-name').value = machine.name;
        get<HTMLInputElement>('machine-order').value = String(machine.order);
        get<HTMLInputElement>('machine-enabled').checked = machine.enabled;
        fillCommandSelects(machine.commandIds);
        get('editor-title').textContent = 'Editar máquina IHM'; get('save-machine').textContent = 'Salvar alterações';
        get<HTMLButtonElement>('cancel-edit').hidden = false;
        get<HTMLInputElement>('machine-name').focus();
    }
    async function remove(machine: IhmMachine) {
        if (busy || !window.confirm(`Remover ${machine.name} da tela IHM? Os comandos e sinais não serão removidos.`)) return;
        setBusy(true);
        try {
            await request('DELETE', `/api/ihm-machines/${encodeURIComponent(machine.ihmMachineId)}`);
            if (editing?.ihmMachineId === machine.ihmMachineId) resetEditor();
            await refresh(); message('Máquina IHM removida.');
        } catch (error) { message(error instanceof Error ? error.message : 'Remoção não confirmada.', true); }
        finally { setBusy(false); }
    }
    function actionButton(label: string, style: string, callback: () => void) {
        const button = document.createElement('button'); button.type = 'button'; button.className = `button ${style}`;
        button.textContent = label; button.onclick = callback; return button;
    }
    function render() {
        const output = get<HTMLTableSectionElement>('machine-list'); output.replaceChildren();
        for (const machine of machines) {
            const row = document.createElement('tr');
            const identity = document.createElement('td'); identity.className = 'machine-name-cell';
            const name = document.createElement('strong'); name.textContent = `${machine.order} · ${machine.name}`;
            const id = document.createElement('code'); id.textContent = machine.ihmMachineId; identity.append(name, id);
            const status = document.createElement('td'), badge = document.createElement('span');
            badge.className = `status-badge ${machine.enabled ? 'active' : 'inactive'}`;
            badge.textContent = machine.enabled ? 'Visível' : 'Oculta'; status.append(badge);
            const commandCell = document.createElement('td'), summary = document.createElement('div'); summary.className = 'command-summary';
            for (const action of ['start', 'stop', 'reset'] as Action[]) {
                const line = document.createElement('span'), prefix = document.createElement('strong');
                prefix.textContent = action.toUpperCase(); line.append(prefix, document.createTextNode(commandName(machine.commandIds[action]))); summary.append(line);
            }
            commandCell.append(summary);
            const actions = document.createElement('td'), actionGroup = document.createElement('div'); actionGroup.className = 'row-actions';
            actionGroup.append(actionButton('Editar', 'secondary', () => edit(machine)),
                actionButton('Remover', 'danger', () => void remove(machine))); actions.append(actionGroup);
            row.append(identity, status, commandCell, actions); output.append(row);
        }
        if (!machines.length) {
            const row = document.createElement('tr'), empty = document.createElement('td'); empty.colSpan = 4;
            empty.className = 'table-empty'; empty.textContent = 'Nenhuma máquina IHM cadastrada.'; row.append(empty); output.append(row);
        }
        get('machine-total').textContent = String(machines.length);
    }
    async function refresh() {
        const [configured, plcView] = await Promise.all([
            request<IhmMachine[]>('GET', '/api/ihm-machines/configuration'),
            request<PlcView>('GET', '/api/plc-signals')
        ]);
        machines = configured; commands = plcView.commands;
        fillCommandSelects(editing?.commandIds); render();
    }
    function logout() {
        token = ''; machines = []; commands = []; editing = undefined;
        get('login-panel').hidden = false; get('admin-content').hidden = true;
        get('connection-dot').className = 'dot'; get('admin-status').textContent = 'Acesso ADMIN necessário';
        get<HTMLInputElement>('admin-password').value = '';
    }

    get<HTMLFormElement>('admin-login-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            const result = await request<{ token: string }>('POST', '/api/admin/sessions',
                { password: get<HTMLInputElement>('admin-password').value }, false);
            token = result.token; get('login-panel').hidden = true; get('admin-content').hidden = false;
            get('connection-dot').className = 'dot green'; get('admin-status').textContent = 'Sessão ADMIN ativa';
            resetEditor(); await refresh();
        } catch (error) {
            get('admin-status').textContent = error instanceof Error ? error.message : 'Autenticação não confirmada.';
            get<HTMLInputElement>('admin-password').select();
        } finally { setBusy(false); }
    })(); };
    get<HTMLFormElement>('machine-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            const commandIds = Object.fromEntries((['start', 'stop', 'reset'] as Action[]).flatMap(action => {
                const commandId = get<HTMLSelectElement>(`machine-${action}`).value;
                return commandId ? [[action, commandId]] : [];
            }));
            const payload = {
                ...(!editing ? { ihmMachineId: get<HTMLInputElement>('machine-id').value.trim() } : {}),
                name: get<HTMLInputElement>('machine-name').value.trim(),
                order: Number(get<HTMLInputElement>('machine-order').value),
                enabled: get<HTMLInputElement>('machine-enabled').checked, commandIds
            };
            if (editing) {
                await request('PUT', `/api/ihm-machines/${encodeURIComponent(editing.ihmMachineId)}`, payload);
                message('Máquina IHM atualizada.');
            } else {
                await request('POST', '/api/ihm-machines', payload); message('Máquina IHM cadastrada.');
            }
            resetEditor(); await refresh();
        } catch (error) { message(error instanceof Error ? error.message : 'Cadastro não confirmado.', true); }
        finally { setBusy(false); }
    })(); };
    get('cancel-edit').onclick = resetEditor;
    get('admin-exit').onclick = logout;
})();
