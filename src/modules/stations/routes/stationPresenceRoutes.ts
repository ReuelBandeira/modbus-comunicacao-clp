import { Router } from 'express';
import { WorkflowError } from '../../pcm/workflow/errors/workflowError';
import type { StationPresenceService } from '../services/stationPresenceService';

export function createStationPresenceRoutes(service: StationPresenceService) {
    const router = Router();
    router.get('/stations/end-of-line/status', async (_req, res) => {
        try { res.json({ status: 'OK', data: await service.status() }); }
        catch (error) { failure(error, res); }
    });
    router.post('/stations/end-of-line/heartbeat', async (req, res) => {
        try { res.json({ status: 'OK', data: await service.heartbeat(req.body) }); }
        catch (error) { failure(error, res); }
    });
    return router;
}

function failure(error: unknown, res: import('express').Response) {
    const known = error instanceof WorkflowError;
    res.status(known ? error.status : 503).json({ status: 'ERROR',
        msg: known ? error.message : 'Não foi possível confirmar a presença da estação.' });
}
