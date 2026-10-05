import { Router } from 'express';
import type { EntryService } from '../services/entryService';
import { InvalidEntryError } from '../errors/invalidEntryError';
import { DuplicateSerialError } from '../../errors/duplicateSerialError';
import { WorkflowError } from '../../workflow/errors/workflowError';
import type { ApiResponseDto } from '../../../../api/dtos/apiResponseDto';

export function createEntryRoutes(service: EntryService) {
    const router = Router();
    router.post<Record<string, never>, ApiResponseDto, unknown>('/', async (req, res) => {
        if (!req.is('application/json')) {
            res.status(415).json({ status: 'ERROR', msg: 'Use Content-Type: application/json.' });
            return;
        }
        try {
            const data = await service.register(req.body);
            res.status(200).json({ status: 'OK', ...(data ? { data } : {}) });
        } catch (error) {
            if (error instanceof WorkflowError) {
                res.status(error.status).json({ status: 'ERROR', msg: error.message });
            } else if (error instanceof InvalidEntryError) {
                res.status(400).json({ status: 'ERROR', msg: error.message });
            } else if (error instanceof DuplicateSerialError) {
                res.status(409).json({ status: 'ERROR', msg: 'Este serial já está em uso na linha.' });
            } else {
                res.status(503).json({ status: 'ERROR', msg: 'Não foi possível confirmar o registro no MongoDB.' });
            }
        }
    });
    return router;
}
