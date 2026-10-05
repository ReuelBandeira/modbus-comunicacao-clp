import { Router, type RequestHandler } from 'express';
import { AdminAccessError, type AdminAccessService } from '../../operators/services/adminAccessService';
import { ShiftError, type ShiftService } from '../services/shiftService';

export function createShiftRoutes(shifts?: ShiftService, admin?: AdminAccessService) {
    const router = Router();
    const protectedRoute = (action: (service: ShiftService, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler =>
        async (req, res) => {
            try {
                if (!shifts || !admin) throw new ShiftError(503, 'Cadastro de turnos exige MongoDB configurado.');
                admin.authorize(req.get('authorization'));
                res.json({ status: 'OK', data: await action(shifts, req) });
            } catch (error) { respondError(res, error); }
        };
    router.get('/shifts', protectedRoute(service => service.list()));
    router.post('/shifts', protectedRoute((service, req) => service.create(req.body)));
    router.put('/shifts/:shiftId', protectedRoute((service, req) => service.update(String(req.params.shiftId), req.body)));
    router.delete('/shifts/:shiftId', protectedRoute((service, req) => service.remove(String(req.params.shiftId))));
    return router;
}

function respondError(res: Parameters<RequestHandler>[1], error: unknown) {
    const known = error instanceof ShiftError || error instanceof AdminAccessError;
    res.status(known ? error.status : 503).json({ status: 'ERROR', msg: known ? error.message : 'Operacao nao confirmada no MongoDB.' });
}
