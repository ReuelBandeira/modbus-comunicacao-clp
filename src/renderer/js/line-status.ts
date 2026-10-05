(() => {
    const header = document.querySelector<HTMLElement>('.top-bar, .topbar');
    if (!header || document.querySelector('.global-line-status')) return;

    const statusBar = document.createElement('section'); statusBar.className = 'global-line-status gray';
    statusBar.setAttribute('aria-label', 'Status geral da linha');
    const caption = document.createElement('span'); caption.className = 'global-line-status-caption'; caption.textContent = 'STATUS DA LINHA';
    const lamp = document.createElement('span'); lamp.className = 'global-line-status-lamp'; lamp.setAttribute('aria-hidden', 'true');
    const value = document.createElement('strong'); value.className = 'global-line-status-value'; value.textContent = 'CONECTANDO';
    value.setAttribute('role', 'status'); value.setAttribute('aria-live', 'polite');
    const source = document.createElement('span'); source.className = 'global-line-status-source'; source.textContent = 'Aguardando sinal da CLP';
    statusBar.append(caption, lamp, value, source); header.insertAdjacentElement('afterend', statusBar);

    let timer: number | undefined, stopped = false;
    const update = async () => {
        try {
            let response: import('../../modules/pcm/workflow/contracts/lineApiContract').LineApiResponse;
            if (window.lineApi) response = await window.lineApi.request('GET', '/api/line-status');
            else {
                const result = await fetch('/api/line-status', { signal: AbortSignal.timeout(5_000) });
                response = { ...await result.json(), httpStatus: result.status };
            }
            if (response.httpStatus >= 400 || response.status !== 'OK') throw new Error(response.msg || 'Status indisponível.');
            const data = response.data as { configured?: boolean; label?: string; status?: string;
                color?: 'gray' | 'green' | 'yellow' | 'red' | 'blue'; value?: number; error?: string };
            const color = ['gray', 'green', 'yellow', 'red', 'blue'].includes(data.color || '') ? data.color! : 'gray';
            statusBar.className = `global-line-status ${color}`; value.textContent = (data.status || 'SEM ESTADO').toUpperCase();
            source.textContent = data.configured ? `${data.label || 'Sinal da linha'}${data.value === undefined ? '' : ` · valor ${data.value}`}` : '';
            statusBar.title = data.error || source.textContent;
        } catch (error) {
            statusBar.className = 'global-line-status red'; value.textContent = 'COMUNICAÇÃO INDISPONÍVEL';
            source.textContent = error instanceof Error ? error.message : 'Não foi possível consultar o sinal da linha';
        } finally { if (!stopped) timer = window.setTimeout(update, 2_000); }
    };
    void update();
    window.addEventListener('pagehide', () => { stopped = true; window.clearTimeout(timer); }, { once: true });
})();
