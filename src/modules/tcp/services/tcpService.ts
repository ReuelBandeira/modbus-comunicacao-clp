import { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { TcpEvent, TcpOptions } from '../types/tcpTypes';

export class TcpService {
    private socket?: Socket;

    constructor(private readonly emit: (event: TcpEvent) => void) {}

    connect(options: TcpOptions): void {
        if (!options || typeof options.host !== 'string' || !options.host.trim()
            || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
            throw new Error('Informe um endereço e uma porta entre 1 e 65535.');
        }

        this.disconnect();
        const socket = new Socket();
        const decoder = new StringDecoder('utf8');
        this.socket = socket;
        let connected = false;
        const status = (message: string) => {
            this.emit({ kind: 'status', message, connected, time: new Date().toISOString() });
        };
        status('Conectando…');
        const timeout = setTimeout(() => {
            socket.destroy(new Error('Tempo de conexão esgotado (10 segundos).'));
        }, 10000);

        socket.on('connect', () => {
            clearTimeout(timeout);
            connected = true;
            status(`Conectado a ${options.host}:${options.port}`);
        });
        socket.on('data', (data: Buffer) => {
            if (this.socket !== socket) return;
            // TCP entrega blocos de bytes; um bloco pode conter parte de uma mensagem.
            this.emit({
                kind: 'data', message: decoder.write(data), hex: data.toString('hex'),
                bytes: data.length, connected, time: new Date().toISOString()
            });
        });
        socket.on('error', (error) => {
            if (this.socket !== socket) return;
            connected = false;
            status(`Erro: ${error.message}`);
        });
        socket.on('close', () => {
            clearTimeout(timeout);
            if (this.socket !== socket) return;
            this.socket = undefined;
            connected = false;
            status('Conexão encerrada.');
        });
        socket.connect(options.port, options.host.trim());
    }

    disconnect(): void {
        if (!this.socket) return;
        this.socket.destroy();
        this.socket = undefined;
        this.emit({ kind: 'status', message: 'Desconectado.', connected: false, time: new Date().toISOString() });
    }
}
