import { Router, type RequestHandler } from 'express';
import { TestResultError, type TestResultService } from '../services/testResultService';

export function createTestResultRoutes(service?: TestResultService) {
    const router = Router();
    router.post('/test-results', async (req, res) => {
        if (!req.is('application/json')) {
            res.status(415).json({ status: 'ERROR', msg: 'Use Content-Type: application/json.' }); return;
        }
        try {
            if (!service) throw new TestResultError(503, 'Recebimento de testes exige MongoDB configurado.');
            console.info(`[IFTS] Requisição de resultado recebida cycleId=${typeof req.body?.cycleId === 'string' ? req.body.cycleId : 'inválido'}.`);
            const result = await service.receive(req.body, req.get('idempotency-key'), req.get('x-api-key'));
            res.status(result.duplicate ? 200 : 201).json(result);
        } catch (error) {
            // Nunca registrar headers: X-API-Key é uma credencial compartilhada.
            console.warn(`[IFTS] Requisição rejeitada: ${error instanceof Error ? error.message : 'erro desconhecido'}`);
            respond(res, error);
        }
    });
    router.get('/test-results', handle(service, (value, req) => value.list(req.query as Record<string, unknown>)));
    router.get('/test-results/:cycleId', handle(service, (value, req) => value.byCycleId(String(req.params.cycleId))));
    return router;
}

function handle(service: TestResultService | undefined,
    action: (value: TestResultService, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler {
    return async (req, res) => {
        try {
            if (!service) throw new TestResultError(503, 'Consulta de testes exige MongoDB configurado.');
            res.json({ status: 'OK', data: await action(service, req) });
        } catch (error) { respond(res, error); }
    };
}

function respond(res: Parameters<RequestHandler>[1], error: unknown) {
    const known = error instanceof TestResultError;
    res.status(known ? error.status : 500).json({ status: 'ERROR',
        msg: known ? error.message : 'Não foi possível processar o resultado do teste.' });
}
