import { Router, type RequestHandler } from 'express';
import { AdminAccessError, type AdminAccessService } from '../../operators/services/adminAccessService';
import { OperationalLogError, type OperationalLogService } from '../services/operationalLogService';

export function createOperationalLogRoutes(service?: OperationalLogService, admin?: AdminAccessService) {
    const router = Router();
    const list: RequestHandler = async (req, res) => {
        try {
            if (!service || !admin) throw new OperationalLogError(503, 'Registro operacional exige MongoDB configurado.');
            admin.authorize(req.get('authorization'));
            res.json({ status: 'OK', data: await service.list(req.query) });
        } catch (error) {
            const known = error instanceof OperationalLogError || error instanceof AdminAccessError;
            res.status(known ? error.status : 503).json({ status: 'ERROR',
                msg: known ? error.message : 'Não foi possível consultar o registro operacional.' });
        }
    };
    router.get('/operational-logs', list);
    return router;
}
