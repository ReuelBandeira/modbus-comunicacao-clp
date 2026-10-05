(() => {
    type Operator = import('../../../modules/operators/models/operatorModel').Operator;
    type LineConfig = import('../../../modules/machines/models/lineModel').LineConfig;
    type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    let token = '', editingRegistration = '', busy = false, lineId = '', lineRevision = 0;

    async function request<T>(method: Method, path: string, body?: unknown, authenticated = true): Promise<T> {
        const authorization = authenticated && token ? `Bearer ${token}` : undefined;
        let response: import('../../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
        if (window.lineApi) response = await window.lineApi.request(method, path, body, authorization);
        else {
            const result = await fetch(path, { method, headers: { 'Content-Type': 'application/json',
                ...(authorization ? { Authorization: authorization } : {}) },
            body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
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
        document.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button,input').forEach(control => control.disabled = value);
    }
    function message(value: string, error = false) {
        const notice = get('operator-message'); notice.textContent = value; notice.hidden = !value;
        notice.className = error ? 'notice error' : 'notice';
    }
    function resetEditor() {
        editingRegistration = '';
        get<HTMLFormElement>('operator-form').reset();
        get('editor-title').textContent = 'Novo operador'; get('save-operator').textContent = 'Cadastrar';
        get<HTMLButtonElement>('cancel-edit').hidden = true;
    }
    function logout() {
        token = ''; resetEditor(); get('login-panel').hidden = false; get('operators-panel').hidden = true;
        get('connection-dot').className = 'dot'; get('admin-status').textContent = 'Acesso ADMIN necessário';
        get<HTMLInputElement>('admin-password').value = '';
    }
    function edit(operator: Operator) {
        editingRegistration = operator.registration;
        get<HTMLInputElement>('operator-name').value = operator.name;
        const registration = get<HTMLInputElement>('operator-registration');
        registration.value = operator.registration;
        get('editor-title').textContent = 'Editar operador'; get('save-operator').textContent = 'Salvar alterações';
        get<HTMLButtonElement>('cancel-edit').hidden = false; get<HTMLInputElement>('operator-name').focus();
    }
    async function remove(operator: Operator) {
        if (busy || !window.confirm(`Remover o operador ${operator.name} (${operator.registration})?`)) return;
        setBusy(true);
        try {
            await request('DELETE', `/api/operators/${encodeURIComponent(operator.registration)}`);
            if (editingRegistration === operator.registration) resetEditor();
            message('Operador removido.'); await refresh();
        } catch (error) { message(error instanceof Error ? error.message : 'Remoção não confirmada.', true); }
        finally { setBusy(false); }
    }
    function render(operators: Operator[]) {
        const list = get<HTMLTableSectionElement>('operator-list'); list.replaceChildren();
        for (const operator of operators) {
            const row = document.createElement('tr'), name = document.createElement('td'), registration = document.createElement('td');
            name.textContent = operator.name; registration.textContent = operator.registration;
            const actions = document.createElement('td'), editButton = document.createElement('button');
            editButton.type = 'button'; editButton.className = 'button secondary'; editButton.textContent = 'Editar';
            editButton.onclick = () => edit(operator);
            const removeButton = document.createElement('button'); removeButton.type = 'button';
            removeButton.className = 'button danger'; removeButton.textContent = 'Remover';
            removeButton.onclick = () => void remove(operator);
            actions.className = 'operator-actions'; actions.append(editButton, removeButton);
            row.append(name, registration, actions); list.append(row);
        }
        if (!operators.length) {
            const row = document.createElement('tr'), empty = document.createElement('td'); empty.colSpan = 3;
            empty.className = 'table-empty'; empty.textContent = 'Nenhum operador cadastrado.'; row.append(empty); list.append(row);
        }
    }
    async function refresh() {
        if (!lineId) lineId = (await request<{ entryLineId:string }>('GET', '/api/line-context')).entryLineId;
        const [operators, line] = await Promise.all([
            request<Operator[]>('GET', '/api/operators'),
            request<LineConfig>('GET', `/api/lines/${encodeURIComponent(lineId)}`)
        ]);
        lineRevision = line.revision;
        get<HTMLInputElement>('minimum-operators').value = String(line.minimumOperators ?? 3);
        render(operators);
    }

    get<HTMLFormElement>('admin-login-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            const result = await request<{ token: string }>('POST', '/api/admin/sessions',
                { password: get<HTMLInputElement>('admin-password').value }, false);
            token = result.token; get('login-panel').hidden = true; get('operators-panel').hidden = false;
            get('connection-dot').className = 'dot green'; get('admin-status').textContent = 'Sessão ADMIN ativa'; await refresh();
        } catch (error) {
            get('admin-status').textContent = error instanceof Error ? error.message : 'Autenticação não confirmada.';
            get<HTMLInputElement>('admin-password').select();
        } finally { setBusy(false); }
    })(); };

    get<HTMLFormElement>('operator-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            const name = get<HTMLInputElement>('operator-name').value.trim();
            const registration = get<HTMLInputElement>('operator-registration').value.trim();
            if (editingRegistration) {
                await request('PUT', `/api/operators/${encodeURIComponent(editingRegistration)}`, { name, registration });
                message('Operador atualizado.');
            } else {
                await request('POST', '/api/operators', { name, registration });
                message('Operador cadastrado.');
            }
            resetEditor(); await refresh();
        } catch (error) { message(error instanceof Error ? error.message : 'Cadastro não confirmado.', true); }
        finally { setBusy(false); }
    })(); };
    get<HTMLFormElement>('staffing-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            const minimumOperators = Number(get<HTMLInputElement>('minimum-operators').value);
            const line = await request<LineConfig>('PUT',
                `/api/lines/${encodeURIComponent(lineId)}/minimum-operators`, { minimumOperators, revision: lineRevision });
            lineRevision = line.revision;
            get<HTMLInputElement>('minimum-operators').value = String(line.minimumOperators);
            message(`Equipe mínima atualizada para ${line.minimumOperators} operadores.`);
        } catch (error) {
            message(error instanceof Error ? error.message : 'Configuração da equipe mínima não confirmada.', true);
            await refresh().catch(() => {});
        } finally { setBusy(false); }
    })(); };
    get('cancel-edit').onclick = resetEditor;
    get('admin-exit').onclick = logout;
})();
