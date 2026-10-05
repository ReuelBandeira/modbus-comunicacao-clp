window.addEventListener('load', () => { void (async () => {
    const configuration = await window.station.getConfiguration();
    const editing = new URLSearchParams(location.search).get('setup') === '1';
    const destinations = {
        main: 'renderer/modules/line/maquinas.html',
        'end-of-line': 'renderer/modules/end-of-line/end-of-line.html'
    } as const;
    if (configuration && !editing) {
        window.location.replace(destinations[configuration.role]);
        return;
    }
    const form = document.getElementById('station-setup') as HTMLFormElement;
    const role = document.getElementById('station-role') as HTMLSelectElement;
    const server = document.getElementById('server-url') as HTMLInputElement;
    const serverField = document.getElementById('server-field') as HTMLElement;
    const password = document.getElementById('setup-password') as HTMLInputElement;
    const error = document.getElementById('setup-error') as HTMLElement;
    const submit = document.getElementById('setup-submit') as HTMLButtonElement;
    const cancel = document.getElementById('setup-cancel') as HTMLButtonElement;
    const close = document.getElementById('setup-close') as HTMLButtonElement;
    document.getElementById('loading-state')!.hidden = true;
    form.hidden = false;
    if (configuration) { role.value = configuration.role; server.value = configuration.serverUrl; cancel.hidden = false; }
    const update = () => {
        const principal = role.value === 'main';
        serverField.hidden = principal;
        server.required = !principal;
    };
    role.onchange = update; update();
    cancel.onclick = () => location.replace(destinations[configuration!.role]);
    close.onclick = () => {
        if (!window.confirm('Deseja fechar o PCM IHM?')) return;
        close.disabled = true; close.textContent = 'Encerrando…'; void window.station.closeApplication();
    };
    form.onsubmit = event => { event.preventDefault(); void (async () => {
        submit.disabled = true; error.hidden = true;
        try {
            await window.station.saveConfiguration({
                role: role.value as import('../../main/stationContract').StationRole,
                serverUrl: server.value,
                password: password.value
            });
            submit.textContent = 'Reiniciando…';
        } catch (cause) {
            error.textContent = cause instanceof Error ? cause.message : 'Não foi possível salvar a configuração.';
            error.hidden = false; submit.disabled = false; password.select();
        }
    })(); };
})().catch(error => {
    const status = document.querySelector<HTMLElement>('[role="status"]');
    if (status) status.textContent = `Não foi possível abrir a configuração: ${error instanceof Error ? error.message : 'erro desconhecido'}`;
}); }, { once: true });
