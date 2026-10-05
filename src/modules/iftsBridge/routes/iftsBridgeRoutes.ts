import { Router, type RequestHandler } from 'express';
import { AdminAccessError, type AdminAccessService } from '../../operators/services/adminAccessService';
import { IftsBridgeClient, IftsBridgeError } from '../services/iftsBridgeClient';

export interface IftsBridgeDebugGuard { assertDebugStart(body: unknown): Promise<void>; }

export function createIftsBridgeRoutes(client: IftsBridgeClient, admin?: AdminAccessService,
    debugGuard?: IftsBridgeDebugGuard) {
    const router = Router();
    const protectedRoute = (action: (req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler => async (req, res) => {
        try {
            if (!admin) throw new AdminAccessError(503, 'Administração indisponível.');
            admin.authorize(req.get('authorization'));
            res.json({ status: 'OK', data: await action(req) });
        } catch (error) {
            const known = error instanceof IftsBridgeError || error instanceof AdminAccessError;
            res.status(known ? error.status : 502).json({ status: 'ERROR', msg: error instanceof Error ? error.message : 'Operação do Bridge não confirmada.' });
        }
    };
    router.get('/ifts-bridge/status', protectedRoute(() => client.status()));
    router.post('/ifts-bridge/start', protectedRoute(async req => {
        await debugGuard?.assertDebugStart(req.body);
        return client.start(req.body);
    }));
    router.post('/ifts-bridge/finish', protectedRoute(req => client.finish(req.body)));
    router.post('/ifts-bridge/retry', protectedRoute(req => client.retry(req.body)));
    router.post('/ifts-bridge/debug/reset', protectedRoute(() => client.resetDebug()));
    router.put('/ifts-bridge/model', protectedRoute(req => client.changeModel(req.body)));
    return router;
}
