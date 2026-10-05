import { Router, type Response } from 'express';
import { WorkflowError } from '../../pcm/workflow/errors/workflowError';
import type { LineOperationService } from '../services/lineOperationService';

export function createLineOperationRoutes(service?: LineOperationService) {
    const router = Router();
    router.get('/line-operation', async (_req, res) => {
        try { res.json({ status: 'OK', data: service ? await service.status() : unavailable() }); }
        catch (error) { failure(error, res); }
    });
    router.post('/line-operation/start', async (req, res) => {
        try { res.json({ status: 'OK', data: service ? await service.start(req.body) : unavailable() }); }
        catch (error) { failure(error, res); }
    });
    return router;
}

function unavailable(): never { throw new WorkflowError(503, 'Controle de operação indisponível.'); }
function failure(error: unknown, res: Response) {
    const known = error instanceof WorkflowError;
    res.status(known ? error.status : 503).json({ status: 'ERROR',
        msg: error instanceof Error ? error.message : 'Não foi possível confirmar o estado da operação.' });
}
