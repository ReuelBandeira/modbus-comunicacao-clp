export interface TcpOptions {
    host: string;
    port: number;
}

export interface TcpEvent {
    kind: 'status' | 'data';
    message: string;
    time: string;
    connected: boolean;
    hex?: string;
    bytes?: number;
}

export interface TcpSessionEvent extends TcpEvent {
    sequence: number;
}

export interface TcpSnapshot {
    events: TcpSessionEvent[];
    bytes: number;
    sequence: number;
    status: string;
    busy: boolean;
    options?: TcpOptions;
}
