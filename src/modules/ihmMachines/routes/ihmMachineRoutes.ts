import { Router, type RequestHandler } from 'express';
import { AdminAccessError, type AdminAccessService } from '../../operators/services/adminAccessService';
import { IhmMachineError, type IhmMachineService } from '../services/ihmMachineService';

export function createIhmMachineRoutes(service?: IhmMachineService, admin?: AdminAccessService) {
    const router = Router();
    const failure = (error: unknown, res: Parameters<RequestHandler>[1]) => {
        const known = error instanceof IhmMachineError || error instanceof AdminAccessError;
        res.status(known ? error.status : 503).json({ status: 'ERROR', msg: known ? error.message : 'Operação da máquina IHM não confirmada.' });
    };
    router.get('/ihm-machines', async (_req, res) => {
        try {
            if (!service) throw new IhmMachineError(503, 'Cadastro de máquinas IHM exige MongoDB configurado.');
            res.json({ status: 'OK', data: await service.list(true) });
        } catch (error) { failure(error, res); }
    });
    const protectedRoute = (action: (value: IhmMachineService, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler =>
        async (req, res) => {
            try {
                if (!service || !admin) throw new IhmMachineError(503, 'Cadastro de máquinas IHM exige MongoDB configurado.');
                admin.authorize(req.get('authorization'));
                res.json({ status: 'OK', data: await action(service, req) });
            } catch (error) { failure(error, res); }
        };
    router.get('/ihm-machines/configuration', protectedRoute(value => value.list(false)));
    router.post('/ihm-machines', protectedRoute((value, req) => value.create(req.body)));
    router.put('/ihm-machines/:ihmMachineId', protectedRoute((value, req) => value.update(String(req.params.ihmMachineId), req.body)));
    router.delete('/ihm-machines/:ihmMachineId', protectedRoute((value, req) => value.remove(String(req.params.ihmMachineId))));
    return router;
}
