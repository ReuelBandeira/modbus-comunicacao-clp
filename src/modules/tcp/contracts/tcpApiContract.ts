import type { TcpOptions, TcpSessionEvent, TcpSnapshot } from '../types/tcpTypes';

export interface TcpApiContract {
    connect(options: TcpOptions): Promise<void>;
    disconnect(): Promise<void>;
    saveLog(content: string): Promise<string | null>;
    getState(): Promise<TcpSnapshot>;
    clearLog(): Promise<TcpSnapshot>;
    onEvent(callback: (event: TcpSessionEvent) => void): () => void;
}
