import type { RequestHandler } from 'express';
import type { OperationalLogService } from '../services/operationalLogService';

export function operationalAudit(service?: OperationalLogService): RequestHandler {
    return (req, res, next) => {
        if (!service || !['POST', 'PUT', 'DELETE'].includes(req.method) || !req.path.startsWith('/api/')) return next();
        const startedAt = Date.now(), pathname = req.path, method = req.method;
        const authorization = req.get('authorization'), body = auditableBody(req.body), requestId = req.get('x-request-id');
        res.once('finish', () => {
            void service.recordHttp({ method, path: pathname, status: res.statusCode,
                durationMs: Date.now() - startedAt, authorization, body, requestId }).catch(error => console.error('[OPERATIONAL_LOG]',
                    error instanceof Error ? error.message : error));
        });
        next();
    };
}

function auditableBody(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>, result: Record<string, string | number | boolean> = {};
    for (const key of ['requestId', 'reasonId', 'registration', 'shiftId', 'cycleId', 'action', 'code', 'lineId',
        'physicalMovementConfirmed', 'acknowledgedBy']) {
        const item = input[key];
        if (typeof item === 'string' && item.length <= 120 || typeof item === 'number' || typeof item === 'boolean') result[key] = item;
    }
    return result;
}
