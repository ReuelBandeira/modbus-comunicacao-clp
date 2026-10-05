import type { BrowserWindow } from 'electron';
import type { RealtimeEvent } from './stationContract';

export class RealtimeClient {
    private controller?: AbortController;
    private heartbeatTimer?: NodeJS.Timeout;
    private running = false;
    constructor(private readonly window: BrowserWindow, private readonly baseUrl: string) {}

    start() {
        if (this.running) return;
        this.running = true;
        void this.heartbeat();
        this.heartbeatTimer = setInterval(() => { void this.heartbeat(); }, 5_000);
        this.heartbeatTimer.unref();
        void this.run();
    }
    stop() {
        this.running = false;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        this.controller?.abort();
        this.controller = undefined;
    }
    private send(event: RealtimeEvent) {
        if (!this.window.isDestroyed()) this.window.webContents.send('station:realtime', event);
    }
    private async heartbeat() {
        if (!this.running) return;
        try {
            const response = await fetch(new URL('/api/stations/end-of-line/heartbeat', this.baseUrl), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'end-of-line' }), signal: AbortSignal.timeout(4_000)
            });
            if (!response.ok) throw new Error(`Heartbeat recusado (${response.status}).`);
        } catch (error) {
            if (this.running) this.send({ type: 'error', data: { message: (error as Error).message } });
        }
    }
    private async run() {
        while (this.running && !this.window.isDestroyed()) {
            this.controller = new AbortController();
            try {
                this.send({ type: 'connection', data: { connected: false, status: 'connecting' } });
                const contextResponse = await fetch(new URL('/api/line-context', this.baseUrl), {
                    signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(10000)])
                });
                const context = await contextResponse.json() as { status?: string; data?: { entryLineId?: string } };
                if (!contextResponse.ok || context.status !== 'OK' || !context.data?.entryLineId) {
                    throw new Error('Contexto da linha indisponível.');
                }
                const url = new URL('/api/realtime', this.baseUrl);
                url.searchParams.set('lineId', context.data.entryLineId);
                const response = await fetch(url, { headers: { Accept: 'text/event-stream' }, signal: this.controller.signal });
                if (!response.ok || !response.body) throw new Error(`Canal em tempo real indisponível (${response.status}).`);
                this.send({ type: 'connection', data: { connected: true, status: 'online' } });
                const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
                let buffer = '';
                while (this.running) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += value;
                    let boundary = buffer.indexOf('\n\n');
                    while (boundary >= 0) {
                        const block = buffer.slice(0, boundary).replace(/\r/g, '');
                        buffer = buffer.slice(boundary + 2);
                        const eventName = block.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim();
                        const payload = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
                        if (eventName === 'line:state' && payload) {
                            try { this.send({ type: 'line:state', data: JSON.parse(payload) }); } catch { /* próximo evento */ }
                        }
                        boundary = buffer.indexOf('\n\n');
                    }
                }
            } catch (error) {
                if (this.running) this.send({ type: 'error', data: { message: (error as Error).message } });
            } finally {
                if (this.running) this.send({ type: 'connection', data: { connected: false, status: 'offline' } });
            }
            if (this.running) await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }
}
