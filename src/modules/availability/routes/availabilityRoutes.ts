import { Router, type RequestHandler } from 'express';
import { AdminAccessError, type AdminAccessService } from '../../operators/services/adminAccessService';
import { AvailabilityError, type AvailabilityService } from '../services/availabilityService';

export function createAvailabilityRoutes(service?: AvailabilityService, admin?: AdminAccessService) {
    const router = Router();
    const handle = (action: (value: AvailabilityService, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler =>
        async (req, res) => {
            try {
                if (!service) throw new AvailabilityError(503, 'Disponibilidade exige MongoDB configurado.');
                res.json({ status: 'OK', data: await action(service, req) });
            } catch (error) { respond(res, error); }
        };
    const protectedHandle = (action: (value: AvailabilityService, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler =>
        async (req, res) => {
            try {
                if (!service || !admin) throw new AvailabilityError(503, 'Configuracao de disponibilidade exige MongoDB configurado.');
                admin.authorize(req.get('authorization'));
                res.json({ status: 'OK', data: await action(service, req) });
            } catch (error) { respond(res, error); }
        };

    router.get('/availability/current', handle(value => value.current()));
    router.get('/availability/report', handle((value, req) => value.report(req.query.from, req.query.to, req.query.timezoneOffsetMinutes)));
    router.get('/availability/reasons', handle(value => value.listReasons()));
    router.post('/availability/stops', handle((value, req) => {
        let adminAuthorized = false;
        if (req.get('authorization')) {
            if (!admin) throw new AdminAccessError(503, 'Administracao indisponivel.');
            admin.authorize(req.get('authorization')); adminAuthorized = true;
        }
        return value.stop(req.body, adminAuthorized);
    }));
    router.post('/availability/stops/:eventId/classify', handle((value, req) =>
        value.classify(String(req.params.eventId), req.body)));
    router.post('/availability/resume', handle((value, req) => value.resume(req.body)));

    router.get('/availability/configuration', protectedHandle(value => value.configuration()));
    router.put('/availability/configuration', protectedHandle((value, req) => value.updateConfiguration(req.body)));
    router.post('/availability/reasons', protectedHandle((value, req) => value.createReason(req.body)));
    router.put('/availability/reasons/:reasonId', protectedHandle((value, req) => value.updateReason(String(req.params.reasonId), req.body)));
    router.delete('/availability/reasons/:reasonId', protectedHandle((value, req) => value.removeReason(String(req.params.reasonId))));
    router.get('/availability/breaks', protectedHandle(value => value.listBreaks()));
    router.post('/availability/breaks', protectedHandle((value, req) => value.createBreak(req.body)));
    router.put('/availability/breaks/:breakId', protectedHandle((value, req) => value.updateBreak(String(req.params.breakId), req.body)));
    router.delete('/availability/breaks/:breakId', protectedHandle((value, req) => value.removeBreak(String(req.params.breakId))));
    router.get('/availability/calendar', protectedHandle((value, req) => value.listCalendar(req.query.from, req.query.to)));
    router.post('/availability/calendar', protectedHandle((value, req) => value.createCalendar(req.body)));
    router.delete('/availability/calendar/:exceptionId', protectedHandle((value, req) => value.removeCalendar(String(req.params.exceptionId))));
    return router;
}

function respond(res: Parameters<RequestHandler>[1], error: unknown) {
    const known = error instanceof AvailabilityError || error instanceof AdminAccessError;
    res.status(known ? error.status : 503).json({ status: 'ERROR',
        msg: known ? error.message : 'Nao foi possivel confirmar a operacao no MongoDB.' });
}
