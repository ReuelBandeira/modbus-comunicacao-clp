import { Router, type RequestHandler } from 'express';
import { AdminAccessError, AdminAccessService } from '../services/adminAccessService';
import { OperatorError, OperatorService } from '../services/operatorService';

export function createOperatorRoutes(operators?: OperatorService, admin?: AdminAccessService) {
    const router = Router();
    router.post('/admin/sessions', (req, res) => {
        try {
            if (!admin) throw new AdminAccessError(503, 'Administracao indisponivel.');
            res.json({ status: 'OK', data: admin.login(req.body) });
        } catch (error) { respondError(res, error); }
    });
    const protectedRoute = (action: (service: OperatorService, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler =>
        async (req, res) => {
            try {
                if (!operators || !admin) throw new OperatorError(503, 'Cadastro de operadores exige MongoDB configurado.');
                admin.authorize(req.get('authorization'));
                res.json({ status: 'OK', data: await action(operators, req) });
            } catch (error) { respondError(res, error); }
        };
    router.get('/operators', protectedRoute(service => service.list()));
    router.post('/operators', protectedRoute((service, req) => service.create(req.body)));
    router.put('/operators/:registration', protectedRoute((service, req) => service.update(String(req.params.registration), req.body)));
    router.delete('/operators/:registration', protectedRoute((service, req) => service.remove(String(req.params.registration))));
    return router;
}

function respondError(res: Parameters<RequestHandler>[1], error: unknown) {
    const known = error instanceof OperatorError || error instanceof AdminAccessError;
    res.status(known ? error.status : 503).json({ status: 'ERROR', msg: known ? error.message : 'Operacao nao confirmada no MongoDB.' });
}
