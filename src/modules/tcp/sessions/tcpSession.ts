import type { TcpEvent, TcpSessionEvent, TcpSnapshot } from '../types/tcpTypes';

// A sessão vive no processo principal, mesmo quando a tela TCP está fechada.
export class TcpSession {
    readonly state: TcpSnapshot = {
        events: [], bytes: 0, sequence: 0, status: 'Desconectado.', busy: false
    };

    record(event: TcpEvent): TcpSessionEvent {
        const entry = {
            ...event,
            message: event.message.slice(0, 4096),
            hex: event.hex?.slice(0, 8192),
            sequence: ++this.state.sequence
        };
        if (event.kind === 'data') this.state.bytes += event.bytes ?? 0;
        else {
            this.state.status = event.message;
            this.state.busy = event.connected || event.message === 'Conectando…';
        }
        this.state.events.push(entry);
        if (this.state.events.length > 200) this.state.events.shift();
        return entry;
    }

    clear(): TcpSnapshot {
        this.state.events = [];
        this.state.bytes = 0;
        ++this.state.sequence;
        return this.state;
    }
}
