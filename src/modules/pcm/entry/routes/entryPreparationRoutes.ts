import { Router } from 'express';
import type { Response } from 'express';
import type { EntryPreparationService } from '../services/entryPreparationService';
import { WorkflowError } from '../../workflow/errors/workflowError';
import { InvalidEntryError } from '../errors/invalidEntryError';

type PreparationResponse = { status: 'OK'; data: unknown } | { status: 'ERROR'; msg: string };

function failure(error: unknown, res: Response<PreparationResponse>): void {
    if (error instanceof WorkflowError) res.status(error.status).json({ status: 'ERROR', msg: error.message });
    else if (error instanceof InvalidEntryError) res.status(400).json({ status: 'ERROR', msg: error.message });
    else res.status(503).json({ status: 'ERROR', msg: 'Não foi possível confirmar a preparação no MongoDB.' });
}

export function createEntryPreparationRoutes(service?: EntryPreparationService) {
    const router = Router();
    const unavailable = () => { throw new WorkflowError(503, 'Preparação de bandejas indisponível sem MongoDB e linha configurada.'); };
    router.get<Record<string, never>, PreparationResponse>('/entry-preparation/current', async (_req, res) => {
        try { res.json({ status: 'OK', data: service ? await service.current() : unavailable() }); } catch (error) { failure(error, res); }
    });
    router.post<Record<string, never>, PreparationResponse, unknown>('/entry-preparation/tray', async (req, res) => {
        try { res.status(201).json({ status: 'OK', data: service ? await service.start(req.body) : unavailable() }); } catch (error) { failure(error, res); }
    });
    router.post<{ entryId: string }, PreparationResponse, unknown>('/entry-preparation/:entryId/chips', async (req, res) => {
        try { res.json({ status: 'OK', data: service ? await service.addChip(req.params.entryId, req.body) : unavailable() }); } catch (error) { failure(error, res); }
    });
    router.delete<{ entryId: string }, PreparationResponse>('/entry-preparation/:entryId/chips/last', async (req, res) => {
        try { res.json({ status: 'OK', data: service ? await service.undoLast(req.params.entryId) : unavailable() }); } catch (error) { failure(error, res); }
    });
    router.post<{ entryId: string }, PreparationResponse, unknown>('/entry-preparation/:entryId/release', async (req, res) => {
        try { res.json({ status: 'OK', data: service ? await service.release(req.params.entryId, req.body) : unavailable() }); } catch (error) { failure(error, res); }
    });
    router.delete<{ entryId: string }, PreparationResponse>('/entry-preparation/:entryId', async (req, res) => {
        try { res.json({ status: 'OK', data: service ? await service.cancel(req.params.entryId) : unavailable() }); } catch (error) { failure(error, res); }
    });
    return router;
}
