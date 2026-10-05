import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 30 * 60 * 1000;
function digest(value: string): Buffer { return createHash('sha256').update(value, 'utf8').digest(); }

export class AdminAccessError extends Error {
    constructor(public readonly status: 400 | 401 | 503, message: string) { super(message); }
}

export class AdminAccessService {
    private readonly passwordHash?: Buffer;
    private readonly sessions = new Map<string, number>();
    constructor(password?: string) { if (password?.trim()) this.passwordHash = digest(password); }
    login(value: unknown) {
        if (!this.passwordHash) throw new AdminAccessError(503, 'Defina ADMIN_PASSWORD para habilitar as configuracoes administrativas.');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdminAccessError(400, 'Informe a senha ADMIN.');
        const password = (value as Record<string, unknown>).password;
        if (typeof password !== 'string' || password.length > 200) throw new AdminAccessError(401, 'Credencial ADMIN invalida.');
        const supplied = digest(password);
        if (!timingSafeEqual(supplied, this.passwordHash)) throw new AdminAccessError(401, 'Credencial ADMIN invalida.');
        this.purge();
        const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + SESSION_MS;
        this.sessions.set(digest(token).toString('hex'), expiresAt);
        return { token, role: 'ADMIN' as const, expiresAt: new Date(expiresAt) };
    }
    authorize(header?: string) {
        const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(header || '');
        const key = match ? digest(match[1]).toString('hex') : '';
        const expiresAt = this.sessions.get(key);
        if (!expiresAt || expiresAt <= Date.now()) {
            if (key) this.sessions.delete(key);
            throw new AdminAccessError(401, 'Sessao ADMIN ausente ou expirada.');
        }
    }
    private purge() {
        const now = Date.now();
        for (const [key, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(key);
    }
}
