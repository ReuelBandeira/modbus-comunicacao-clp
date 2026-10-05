import { readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { StationConfiguration, StationRole, StationSetupInput } from './stationContract';

const roles = new Set<StationRole>(['main', 'end-of-line']);

function normalizeServerUrl(value: string): string {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || !['', '/'].includes(url.pathname)) {
        throw new Error('Informe uma URL HTTP válida, sem usuário, parâmetros ou fragmentos.');
    }
    url.pathname = '/';
    return url.toString().replace(/\/$/, '');
}

export class StationConfigStore {
    private readonly file: string;
    constructor(userDataDirectory: string, private readonly setupPassword = '123') {
        this.file = path.join(userDataDirectory, 'station.json');
    }
    async read(): Promise<StationConfiguration | null> {
        try {
            const value = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StationConfiguration>;
            if (value.version !== 1 || !roles.has(value.role as StationRole) || typeof value.serverUrl !== 'string') return null;
            return { version: 1, role: value.role as StationRole, serverUrl: normalizeServerUrl(value.serverUrl) };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            return null;
        }
    }
    async save(input: StationSetupInput, localServerUrl: string): Promise<StationConfiguration> {
        if (!input || input.password !== this.setupPassword) throw new Error('Senha de configuração inválida.');
        if (!roles.has(input.role)) throw new Error('Área de trabalho inválida.');
        const serverUrl = input.role === 'main' ? normalizeServerUrl(localServerUrl)
            : normalizeServerUrl(input.serverUrl || '');
        const value: StationConfiguration = { version: 1, role: input.role, serverUrl };
        const temporary = `${this.file}.tmp`;
        await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, this.file);
        return value;
    }
}
