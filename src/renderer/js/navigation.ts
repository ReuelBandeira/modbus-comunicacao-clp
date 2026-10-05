(() => {
    const script = document.currentScript as HTMLScriptElement;
    const renderer = new URL('../', script.src);
    const lineStatusScript = document.createElement('script');
    lineStatusScript.src = new URL('line-status.js', script.src).href;
    document.head.append(lineStatusScript);
    const footer = document.querySelector<HTMLElement>('[data-navigation]');
    const pages = [
        { label: 'MÁQUINAS', path: 'modules/line/maquinas.html', webPath: '/line/maquinas.html' },
        { label: 'OPERADORES', path: 'modules/line/principal.html', webPath: '/line/principal.html' },
        { label: 'ENTRADA', path: 'modules/line/bipagem.html', webPath: '/line/bipagem.html' },
        { label: 'ACOMPANHAMENTO', path: 'modules/line/line.html', webPath: '/line/' },
        // { label: 'BANDEJAS', path: 'modules/line/bandejas.html', webPath: '/line/bandejas.html' },
        { label: 'MONITORES', path: 'modules/line/relatorios.html', webPath: '/line/relatorios.html' },
        // { label: 'TESTE TCP', path: 'views/tcp.html' },
        // { label: 'TESTE CLP', path: 'modules/modbus/modbus.html' }
    ];
    if (footer) {
        for (const page of pages) {
            const browser = location.protocol !== 'file:';
            const available = page.path && (!browser || !!page.webPath);
            const control = document.createElement(available ? 'a' : 'button');
            control.className = 'nav-button';
            control.textContent = page.label;
            if (control instanceof HTMLAnchorElement && page.path) {
                const target = browser ? new URL(page.webPath!, location.href) : new URL(page.path, renderer);
                control.href = target.href;
                const monitorSubpage = page.label === 'MONITORES' && /\/line\/oee\.html$/.test(location.pathname);
                if (location.pathname === target.pathname && location.search === target.search
                    || browser && target.pathname === '/line/' && location.pathname === '/line/line.html' && location.search === target.search
                    || monitorSubpage) {
                    control.classList.add('active');
                    control.setAttribute('aria-current', 'page');
                }
            } else if (control instanceof HTMLButtonElement) {
                control.type = 'button';
                control.disabled = true;
                control.title = page.path ? 'Disponível no aplicativo desktop' : 'Acompanhamento obsoleto e desativado';
            }
            footer.append(control);
        }
    }
    const toolbar = document.querySelector<HTMLElement>('.top-bar .connection');
    const topBar = toolbar?.closest<HTMLElement>('.top-bar');
    const toolbarActions = topBar ? document.createElement('div') : undefined;
    if (toolbar) {
        toolbarActions!.className = 'toolbar-actions';
        topBar!.append(toolbarActions!);

        const temperature = document.createElement('span');
        temperature.className = 'pc-temperature unavailable';
        temperature.textContent = 'PC -- °C';
        temperature.title = 'Temperatura do computador indisponível';
        temperature.setAttribute('role', 'status');
        temperature.setAttribute('aria-live', 'polite');
        toolbarActions!.append(temperature);
        const temperatureAlert = document.createElement('div');
        temperatureAlert.className = 'temperature-alert';
        temperatureAlert.setAttribute('role', 'alert');
        temperatureAlert.hidden = true;
        document.body.append(temperatureAlert);

        let temperatureTimer: number | undefined, temperatureStopped = false;
        const updateTemperature = async () => {
            try {
                let reading: { celsius?: number | null; status?: string; warningAt?: number; criticalAt?: number } | undefined;
                if ('station' in window) reading = await window.station.getTemperature();
                else {
                    const result = await fetch('/api/health', { signal: AbortSignal.timeout(5_000) });
                    const response = { ...await result.json(), httpStatus: result.status } as import('../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
                    reading = (response.data as { temperature?: typeof reading } | undefined)?.temperature;
                }
                const celsius = typeof reading?.celsius === 'number' ? reading.celsius : null;
                const status = ['normal', 'warning', 'critical'].includes(reading?.status || '') ? reading!.status! : 'unavailable';
                temperature.className = `pc-temperature ${status}`;
                temperature.textContent = celsius === null ? 'PC -- °C' : `PC ${celsius.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} °C`;
                temperature.title = celsius === null ? 'O sistema operacional não disponibilizou um sensor térmico'
                    : `Temperatura do computador Principal · atenção em ${reading?.warningAt} °C · crítico em ${reading?.criticalAt} °C`;
                temperatureAlert.hidden = status !== 'warning' && status !== 'critical';
                temperatureAlert.className = `temperature-alert ${status}`;
                temperatureAlert.textContent = status === 'critical' ? `ALERTA CRÍTICO · computador em ${temperature.textContent.replace('PC ', '')}`
                    : status === 'warning' ? `ATENÇÃO · temperatura elevada: ${temperature.textContent.replace('PC ', '')}` : '';
            } catch {
                temperature.className = 'pc-temperature unavailable'; temperature.textContent = 'PC -- °C';
                temperature.title = 'Não foi possível consultar a temperatura do computador'; temperatureAlert.hidden = true;
            } finally {
                if (!temperatureStopped) temperatureTimer = window.setTimeout(updateTemperature, 15_000);
            }
        };
        void updateTemperature();
        window.addEventListener('pagehide', () => { temperatureStopped = true; window.clearTimeout(temperatureTimer); }, { once: true });

    }
    if (toolbar) {
        const browser = location.protocol !== 'file:';
        const configTarget = browser
            ? new URL('/line/?tab=machines', location.href)
            : new URL('modules/line/line.html?tab=machines', renderer);
        const communicationTarget = browser
            ? new URL('/line/?dialog=communication', location.href)
            : new URL('modules/line/line.html?dialog=communication', renderer);
        const operatorsTarget = browser
            ? new URL('/line/operadores.html', location.href)
            : new URL('modules/line/operadores.html', renderer);
        const shiftsTarget = browser
            ? new URL('/line/turnos.html', location.href)
            : new URL('modules/line/turnos.html', renderer);
        const oeeConfigTarget = browser
            ? new URL('/line/oee-config.html', location.href)
            : new URL('modules/line/oee-config.html', renderer);
        const plcSignalsTarget = browser ? new URL('/line/plc-signals.html', location.href) : new URL('modules/line/plc-signals.html', renderer);
        const ihmMachinesTarget = browser ? new URL('/line/maquinas-admin.html', location.href) : new URL('modules/line/maquinas-admin.html', renderer);
        const iftsTestTarget = browser ? new URL('/line/ifts-teste.html', location.href) : new URL('modules/line/ifts-teste.html', renderer);
        const operationalLogsTarget = browser ? new URL('/line/logs-operacionais.html', location.href)
            : new URL('modules/line/logs-operacionais.html', renderer);
        const stationTarget = 'station' in window ? new URL('../index.html?setup=1', renderer) : undefined;
        const stationSettingsCard = stationTarget ? `
                <a class="settings-card" data-station-setting href="${stationTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">PC</span>
                    <span class="settings-card-content"><strong>Mudar estação</strong><small>Alterar este computador entre Principal e Final de Linha.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>` : '';
        const settings = document.createElement('button');
        settings.type = 'button';
        settings.className = 'toolbar-settings-button';
        settings.textContent = '⚙';
        settings.title = 'Abrir configurações';
        settings.setAttribute('aria-label', 'Abrir configurações');

        const dialog = document.createElement('dialog');
        dialog.className = 'settings-dialog';
        dialog.setAttribute('aria-labelledby', 'settings-dialog-title');
        dialog.innerHTML = `
            <div class="settings-dialog-heading">
                <div><span>AJUSTES DO SISTEMA</span><h2 id="settings-dialog-title">Configurações</h2></div>
                <button type="button" class="settings-dialog-close" aria-label="Fechar configurações">×</button>
            </div>
            <div class="settings-card-grid">
                <a class="settings-card" href="${configTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">CLP</span>
                    <span class="settings-card-content"><strong>Configurações da CLP</strong><small>Cadastro das máquinas, conexão Modbus e handshake.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>
                <a class="settings-card" data-communication-setting href="${communicationTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">I/O</span>
                    <span class="settings-card-content"><strong>Comunicação</strong><small>Acompanhar em tempo real os dados trafegados entre Node e CLP.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>
                <a class="settings-card" href="${operatorsTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">ADM</span>
                    <span class="settings-card-content"><strong>Operadores</strong><small>Cadastrar e editar nome e matrícula com acesso ADMIN.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>
                <a class="settings-card" href="${shiftsTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">H</span>
                    <span class="settings-card-content"><strong>Turnos</strong><small>Cadastrar horários e ativar ou desativar turnos com acesso ADMIN.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>
                <a class="settings-card" href="${oeeConfigTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">OEE</span>
                    <span class="settings-card-content"><strong>Disponibilidade e OEE</strong><small>Configurar motivos, pausas e exceções do calendário produtivo.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>
                <a class="settings-card" href="${plcSignalsTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">SIG</span>
                    <span class="settings-card-content"><strong>Sinais e comandos CLP</strong><small>Monitorar estados e cadastrar comandos operacionais da linha.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>
                <a class="settings-card" href="${ihmMachinesTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">IHM</span>
                    <span class="settings-card-content"><strong>Máquinas da IHM</strong><small>Cadastrar cartões e vincular comandos Start, Stop e Reset.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>
                <a class="settings-card" href="${iftsTestTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">IFTS</span>
                    <span class="settings-card-content"><strong>Teste da integração IFTS</strong><small>Executar START, FINISH e RETRY e conferir o resultado persistido.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>
                <a class="settings-card" href="${operationalLogsTarget.href}">
                    <span class="settings-card-icon" aria-hidden="true">LOG</span>
                    <span class="settings-card-content"><strong>Registro operacional</strong><small>Consultar ações, responsáveis, falhas e resultados do sistema.</small></span>
                    <span class="settings-card-arrow" aria-hidden="true">›</span>
                </a>${stationSettingsCard}
            </div>`;
        settings.onclick = () => { void (async () => {
            settings.disabled = true;
            try {
                const configuration = 'station' in window
                    ? await window.station.getConfiguration().catch(() => null) : null;
                const endOfLine = configuration?.role === 'end-of-line'
                    || /(?:^|\/)end-of-line(?:\/|\.html|$)/.test(location.pathname);
                dialog.querySelectorAll<HTMLElement>('.settings-card').forEach(card => {
                    card.hidden = endOfLine && !card.hasAttribute('data-station-setting');
                });
                dialog.showModal();
            } finally { settings.disabled = false; }
        })(); };
        dialog.querySelector<HTMLButtonElement>('.settings-dialog-close')!.onclick = () => dialog.close();
        dialog.onclick = event => { if (event.target === dialog) dialog.close(); };
        dialog.querySelector<HTMLElement>('[data-communication-setting]')!.onclick = event => {
            if (!('station' in window)) return;
            event.preventDefault(); dialog.close(); void window.station.openCommunicationWindow();
        };
        document.body.append(dialog);
        toolbarActions!.append(settings);
        if ('station' in window) {
            const close = document.createElement('button'); close.type = 'button';
            close.className = 'toolbar-close-application'; close.textContent = '×';
            close.title = 'Fechar aplicativo'; close.setAttribute('aria-label', 'Fechar aplicativo');
            close.onclick = () => {
                if (!window.confirm('Deseja fechar o PCM IHM?')) return;
                close.disabled = true;
                void window.station.closeApplication().catch(() => { close.disabled = false; });
            };
            toolbarActions!.append(close);
        }
    }
})();
