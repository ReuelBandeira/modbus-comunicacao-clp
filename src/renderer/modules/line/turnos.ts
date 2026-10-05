(() => {
    type Shift = import('../../../modules/shifts/models/shiftModel').Shift;
    type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
    const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
    let token = '', editing: Shift | undefined, busy = false, shifts: Shift[] = [];

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
        const notice = get('shift-message'); notice.textContent = value; notice.hidden = !value;
        notice.className = error ? 'notice error' : 'notice';
    }
    function resetEditor() {
        editing = undefined; get<HTMLFormElement>('shift-form').reset(); get<HTMLInputElement>('shift-active').checked = true;
        get('editor-title').textContent = 'Novo turno'; get('save-shift').textContent = 'Cadastrar';
        get<HTMLButtonElement>('cancel-edit').hidden = true;
    }
    function logout() {
        token = ''; shifts = []; resetEditor(); get('login-panel').hidden = false; get('shifts-panel').hidden = true;
        get('connection-dot').className = 'dot'; get('admin-status').textContent = 'Acesso ADMIN necessário';
        get<HTMLInputElement>('admin-password').value = '';
    }
    function edit(shift: Shift) {
        editing = shift; get<HTMLInputElement>('shift-name').value = shift.name;
        get<HTMLInputElement>('shift-start').value = shift.startTime; get<HTMLInputElement>('shift-end').value = shift.endTime;
        get<HTMLInputElement>('shift-active').checked = shift.active;
        get('editor-title').textContent = 'Editar turno'; get('save-shift').textContent = 'Salvar alterações';
        get<HTMLButtonElement>('cancel-edit').hidden = false; get<HTMLInputElement>('shift-name').focus();
    }
    async function toggle(shift: Shift) {
        if (busy) return;
        setBusy(true);
        try {
            await request('PUT', `/api/shifts/${encodeURIComponent(shift.shiftId)}`,
                { name: shift.name, startTime: shift.startTime, endTime: shift.endTime, active: !shift.active });
            if (editing?.shiftId === shift.shiftId) resetEditor();
            message(shift.active ? 'Turno desativado.' : 'Turno ativado.'); await refresh();
        } catch (error) { message(error instanceof Error ? error.message : 'Alteração não confirmada.', true); }
        finally { setBusy(false); }
    }
    async function remove(shift: Shift) {
        if (busy || !window.confirm(`Remover o turno ${shift.name} (${shift.startTime}–${shift.endTime})?`)) return;
        setBusy(true);
        try {
            await request('DELETE', `/api/shifts/${encodeURIComponent(shift.shiftId)}`);
            if (editing?.shiftId === shift.shiftId) resetEditor();
            message('Turno removido.'); await refresh();
        } catch (error) { message(error instanceof Error ? error.message : 'Remoção não confirmada.', true); }
        finally { setBusy(false); }
    }
    function render() {
        const list = get<HTMLTableSectionElement>('shift-list'); list.replaceChildren();
        for (const shift of shifts) {
            const row = document.createElement('tr');
            for (const value of [shift.name, shift.startTime, shift.endTime]) {
                const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
            }
            const status = document.createElement('td'), badge = document.createElement('span');
            badge.className = `status-badge ${shift.active ? 'active' : 'inactive'}`;
            badge.textContent = shift.active ? 'Ativo' : 'Inativo'; status.append(badge);
            const actions = document.createElement('td'), editButton = document.createElement('button');
            editButton.type = 'button'; editButton.className = 'button secondary'; editButton.textContent = 'Editar';
            editButton.onclick = () => edit(shift);
            const toggleButton = document.createElement('button'); toggleButton.type = 'button';
            toggleButton.className = shift.active ? 'button danger' : 'button success';
            toggleButton.textContent = shift.active ? 'Desativar' : 'Ativar'; toggleButton.onclick = () => void toggle(shift);
            const removeButton = document.createElement('button'); removeButton.type = 'button';
            removeButton.className = 'button danger'; removeButton.textContent = 'Remover';
            removeButton.onclick = () => void remove(shift);
            actions.className = 'shift-actions'; actions.append(editButton, toggleButton, removeButton); row.append(status, actions); list.append(row);
        }
        if (!shifts.length) {
            const row = document.createElement('tr'), empty = document.createElement('td'); empty.colSpan = 5;
            empty.className = 'table-empty'; empty.textContent = 'Nenhum turno cadastrado.'; row.append(empty); list.append(row);
        }
    }
    async function refresh() { shifts = await request<Shift[]>('GET', '/api/shifts'); render(); }

    get<HTMLFormElement>('admin-login-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            const result = await request<{ token: string }>('POST', '/api/admin/sessions',
                { password: get<HTMLInputElement>('admin-password').value }, false);
            token = result.token; get('login-panel').hidden = true; get('shifts-panel').hidden = false;
            get('connection-dot').className = 'dot green'; get('admin-status').textContent = 'Sessão ADMIN ativa'; await refresh();
        } catch (error) {
            get('admin-status').textContent = error instanceof Error ? error.message : 'Autenticação não confirmada.';
            get<HTMLInputElement>('admin-password').select();
        } finally { setBusy(false); }
    })(); };
    get<HTMLFormElement>('shift-form').onsubmit = event => { event.preventDefault(); void (async () => {
        if (busy) return; setBusy(true);
        try {
            const payload = { name: get<HTMLInputElement>('shift-name').value.trim(),
                startTime: get<HTMLInputElement>('shift-start').value, endTime: get<HTMLInputElement>('shift-end').value,
                active: get<HTMLInputElement>('shift-active').checked };
            if (editing) {
                await request('PUT', `/api/shifts/${encodeURIComponent(editing.shiftId)}`, payload);
                message('Turno atualizado.');
            } else {
                await request('POST', '/api/shifts', payload); message('Turno cadastrado.');
            }
            resetEditor(); await refresh();
        } catch (error) { message(error instanceof Error ? error.message : 'Cadastro não confirmado.', true); }
        finally { setBusy(false); }
    })(); };
    get('cancel-edit').onclick = resetEditor;
    get('admin-exit').onclick = logout;
})();
