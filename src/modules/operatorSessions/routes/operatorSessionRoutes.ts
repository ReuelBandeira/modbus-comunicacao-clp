import { Router, type RequestHandler } from 'express';
import { OperatorSessionError, type OperatorSessionService } from '../services/operatorSessionService';

export function createOperatorSessionRoutes(service?: OperatorSessionService) {
    const router = Router();
    const action = (handler: (req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler => async (req, res) => {
        try {
            if (!service) throw new OperatorSessionError(503, 'Presenca de operadores exige MongoDB configurado.');
            res.json({ status: 'OK', data: await handler(req) });
        } catch (error) {
            const known = error instanceof OperatorSessionError;
            res.status(known ? error.status : 503).json({ status: 'ERROR',
                msg: known ? error.message : 'Operacao nao confirmada no MongoDB.' });
        }
    };
    router.get('/operator-station/context', action(() => service!.context()));
    router.post('/operator-station/entries', action(req => service!.enter(req.body)));
    router.post('/operator-station/sessions/:sessionId/exit', action(req => service!.exit(String(req.params.sessionId), req.body)));
    return router;
}
