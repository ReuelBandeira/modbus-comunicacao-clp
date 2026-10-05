import { Router } from 'express';
import { AdminAccessError, type AdminAccessService } from '../../operators/services/adminAccessService';
import { StationTestResetError, type StationTestResetService } from '../services/stationTestResetService';

export function createStationTestResetRoutes(service?: StationTestResetService, admin?: AdminAccessService) {
    const router = Router();
    router.post('/station-test-reset', async (req, res) => {
        try {
            if (!service || !admin) throw new StationTestResetError(503,
                'Reset de teste exige MongoDB e comunicação CLP configurados.');
            admin.authorize(req.get('authorization'));
            res.json({ status: 'OK', data: await service.execute(req.body) });
        } catch (error) {
            const known = error instanceof StationTestResetError || error instanceof AdminAccessError;
            res.status(known ? error.status : 503).json({
                status: 'ERROR', msg: known ? error.message : 'Não foi possível concluir o reset de teste.'
            });
        }
    });
    return router;
}
