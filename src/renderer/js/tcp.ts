(() => {
    const form = document.getElementById('tcp-form') as HTMLFormElement;
    const host = document.getElementById('host') as HTMLInputElement;
    const port = document.getElementById('port') as HTMLInputElement;
    const connect = document.getElementById('connect') as HTMLButtonElement;
    const disconnect = document.getElementById('disconnect') as HTMLButtonElement;
    const status = document.getElementById('tcp-status')!;
    const log = document.getElementById('tcp-log')!;
    const count = document.getElementById('byte-count')!;
    const save = document.getElementById('save-log') as HTMLButtonElement;
    const saveStatus = document.getElementById('save-status')!;
    let saving = false;
    let bytes = 0;
    let sequence = 0;
    let restoring = true;
    type SessionEvent = Parameters<Parameters<Window['tcp']['onEvent']>[0]>[0];
    let pending: SessionEvent[] = [];
    const clear = document.getElementById('clear') as HTMLButtonElement;

    host.value = sessionStorage.getItem('tcpHost') ?? '';
    port.value = sessionStorage.getItem('tcpPort') ?? '';
    host.addEventListener('input', () => sessionStorage.setItem('tcpHost', host.value));
    port.addEventListener('input', () => sessionStorage.setItem('tcpPort', port.value));

    function setBusy(busy: boolean) {
        connect.disabled = busy;
        host.disabled = busy;
        port.disabled = busy;
        disconnect.disabled = !busy;
    }

    function appendEvent(event: SessionEvent) {
        if (event.kind === 'status') {
            status.textContent = event.message;
            if (event.connected) setBusy(true);
            else if (event.message !== 'Conectando…') setBusy(false);
        } else {
            bytes += event.bytes ?? 0;
            count.textContent = String(bytes);
        }
        const entry = document.createElement('pre');
        entry.style.whiteSpace = 'pre-wrap';
        entry.style.overflowWrap = 'anywhere';
        const heading = `[${new Date(event.time).toLocaleTimeString()}] `;
        entry.textContent = event.kind === 'data'
            ? `${heading}${event.bytes} bytes\nTexto: ${JSON.stringify(event.message.slice(0, 4096))}\nHex: ${event.hex?.slice(0, 8192).match(/.{1,2}/g)?.join(' ') ?? ''}`
            : heading + event.message;
        log.append(entry);
        save.disabled = saving;
        while (log.childElementCount > 200) log.firstElementChild?.remove();
        log.scrollTop = log.scrollHeight;
    }

    function acceptEvent(event: SessionEvent) {
        if (event.sequence <= sequence) return;
        sequence = event.sequence;
        appendEvent(event);
    }

    const unsubscribe = window.tcp.onEvent((event) => {
        if (restoring) pending.push(event);
        else acceptEvent(event);
    });

    async function restoreState(clearHistory = false) {
        restoring = true;
        clear.disabled = true;
        setBusy(true);
        disconnect.disabled = true;
        try {
            const snapshot = await (clearHistory ? window.tcp.clearLog() : window.tcp.getState());
            log.replaceChildren();
            bytes = 0;
            snapshot.events.forEach(appendEvent);
            bytes = snapshot.bytes;
            count.textContent = String(bytes);
            status.textContent = snapshot.status;
            setBusy(snapshot.busy);
            if (snapshot.options && snapshot.busy) {
                host.value = snapshot.options.host;
                port.value = String(snapshot.options.port);
            }
            sequence = snapshot.sequence;
            save.disabled = saving || !log.childElementCount;
            pending.forEach(acceptEvent);
        } catch (error) {
            status.textContent = `Não foi possível restaurar a sessão: ${String(error)}`;
            setBusy(false);
            pending.forEach(acceptEvent);
        } finally {
            pending = [];
            restoring = false;
            clear.disabled = false;
        }
    }

    void restoreState();

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        setBusy(true);
        sessionStorage.setItem('tcpHost', host.value);
        sessionStorage.setItem('tcpPort', port.value);
        try {
            await window.tcp.connect({ host: host.value.trim(), port: Number(port.value) });
        } catch (error) {
            status.textContent = String(error);
            setBusy(false);
        }
    });
    disconnect.addEventListener('click', async () => {
        try {
            await window.tcp.disconnect();
            setBusy(false);
        } catch (error) {
            status.textContent = String(error);
        }
    });
    clear.addEventListener('click', () => {
        void restoreState(true);
        saveStatus.textContent = '';
    });
    save.addEventListener('click', async () => {
        // Salva uma cópia dos registros atuais, mesmo se chegarem novos dados durante a escolha da pasta.
        const entries = Array.from(log.children, (entry) => entry.textContent ?? '');
        if (!entries.length || saving) return;
        const content = [
            'PCM - TESTE TCP/IP',
            `Exportado em: ${new Date().toLocaleString()}`,
            `Total recebido desde a última limpeza: ${bytes} bytes`,
            `Registros exportados: ${entries.length}`,
            'Exportação dos registros visíveis (até 200). Blocos longos têm prévia limitada a 4096 caracteres de texto e 4096 bytes em hexadecimal.',
            '',
            ...entries
        ].join('\r\n\r\n');
        saving = true;
        save.disabled = true;
        saveStatus.textContent = 'Escolha onde salvar o arquivo.';
        try {
            const filePath = await window.tcp.saveLog(content);
            saveStatus.textContent = filePath ? `Arquivo salvo: ${filePath}` : 'Salvamento cancelado.';
        } catch (error) {
            saveStatus.textContent = `Não foi possível salvar: ${String(error)}`;
        } finally {
            saving = false;
            save.disabled = log.childElementCount === 0;
        }
    });
    window.addEventListener('pagehide', unsubscribe, { once: true });
})();
