import { Router, type RequestHandler } from 'express';
import type { LineCoordinatorService } from '../services/lineCoordinatorService';
import { WorkflowError } from '../errors/workflowError';
import { identifier, object } from '../../../machines/validators/lineValidation';
import type { ProcessResult } from '../models/workflowModel';
import { MachineConnectionProbe } from '../../../modbus/services/machineConnectionProbe';
import { communicationLog } from '../../../modbus/services/communicationLog';
import { AdminAccessError, type AdminAccessService } from '../../../operators/services/adminAccessService';

export function createLineRoutes(coordinator?: LineCoordinatorService, connectionProbe = new MachineConnectionProbe(),
admin?: AdminAccessService) {
    const router = Router();
    router.use((req, res, next) => {
        if (['POST', 'PUT'].includes(req.method) && !req.is('application/json')) {
            res.status(415).json({ status: 'ERROR', msg: 'Use Content-Type: application/json.' }); return;
        }
        next();
    });
    const handle = (action: (service: LineCoordinatorService, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler =>
        async (req, res) => {
            try {
                if (!coordinator) throw new WorkflowError(503, 'Controle da linha exige MongoDB configurado.');
                res.json({ status: 'OK', data: await action(coordinator, req) });
            } catch (error) {
                const known = error instanceof WorkflowError || error instanceof AdminAccessError;
                res.status(known ? error.status : 503).json({ status: 'ERROR',
                    msg: known ? error.message : 'Não foi possível confirmar a operação no MongoDB.' });
            }
        };
    router.post('/lines', handle((service, req) => service.createLine(req.body)));
    router.get('/line-context', handle(async service => service.context()));
    router.get('/lines/:lineId/status', handle((service, req) => service.dashboard(String(req.params.lineId))));
    router.get('/lines/:lineId/chip-metrics', handle((service, req) => service.chipMetrics(String(req.params.lineId),
        req.query.from, req.query.to, req.query.timezoneOffsetMinutes)));
    router.put('/lines/:lineId', handle((service, req) => service.updateLine(String(req.params.lineId), req.body)));
    router.put('/lines/:lineId/minimum-operators', async (req, res) => {
        try {
            if (!coordinator || !admin) throw new WorkflowError(503, 'Configuração de operadores indisponível.');
            admin.authorize(req.get('authorization'));
            res.json({ status: 'OK', data: await coordinator.updateMinimumOperators(String(req.params.lineId), req.body) });
        } catch (error) {
            const known = error instanceof WorkflowError || error instanceof AdminAccessError;
            res.status(known ? error.status : 503).json({ status: 'ERROR',
                msg: known ? error.message : 'Não foi possível atualizar a equipe mínima.' });
        }
    });
    router.get('/lines/:lineId', handle((service, req) => service.getLine(String(req.params.lineId))));
    router.get('/lines/:lineId/trays', handle((service, req) => service.list(String(req.params.lineId),
        req.query.limit === undefined ? 50 : Number(req.query.limit))));
    router.get('/lines/:lineId/trays/:entrySequence', handle((service, req) =>
        service.trayBySequence(String(req.params.lineId), Number(req.params.entrySequence))));
    router.post('/lines/:lineId/trays/:entrySequence/interventions', async (req, res) => {
        try {
            if (!coordinator || !admin) throw new WorkflowError(503, 'Gerenciamento de bandejas indisponivel.');
            admin.authorize(req.get('authorization'));
            res.json({ status: 'OK', data: await coordinator.intervene(String(req.params.lineId),
                Number(req.params.entrySequence), req.body) });
        } catch (error) {
            const known = error instanceof WorkflowError || error instanceof AdminAccessError;
            res.status(known ? error.status : 503).json({ status: 'ERROR',
                msg: known ? error.message : 'Nao foi possivel confirmar a intervencao no MongoDB.' });
        }
    });
    router.post('/lines/:lineId/trays/:entrySequence/advance', async (req, res) => {
        try {
            if (!coordinator || !admin) throw new WorkflowError(503, 'Avanco manual de bandeja indisponivel.');
            admin.authorize(req.get('authorization'));
            res.json({ status: 'OK', data: await coordinator.advanceTray(String(req.params.lineId),
                Number(req.params.entrySequence), req.body) });
        } catch (error) {
            const known = error instanceof WorkflowError || error instanceof AdminAccessError;
            res.status(known ? error.status : 503).json({ status: 'ERROR',
                msg: known ? error.message : 'Nao foi possivel avancar a bandeja.' });
        }
    });
    router.get('/trays/:serialNumber', handle((service, req) => service.tray(String(req.params.serialNumber))));
    router.get('/communication-logs', (_req, res) => res.json({ status: 'OK', data: communicationLog.list() }));
    router.post('/lines/:lineId/machines/:machineId/connection-test', async (req, res) => {
        try {
            identifier(req.params.lineId, 'lineId'); identifier(req.params.machineId, 'machineId');
            res.json({ status: 'OK', data: await connectionProbe.execute(req.body) });
        } catch (error) {
            const known = error instanceof WorkflowError;
            res.status(known ? error.status : 503).json({ status: 'ERROR',
                msg: known ? error.message : 'Não foi possível executar o teste de comunicação.' });
        }
    });
    // Eventos internos de simulação. Não abrem conexão nem escrevem na CLP.
    router.post('/lines/:lineId/machines/:machineId/arrival', handle((service, req) => {
        const body = object(req.body);
        return service.arrive(String(req.params.lineId), String(req.params.machineId), body.cycleId as string);
    }));
    router.post('/lines/:lineId/machines/:machineId/result', handle((service, req) => {
        const body = object(req.body);
        return service.result(String(req.params.lineId), String(req.params.machineId), body.operationId as string,
            body.result as ProcessResult, body.data === undefined ? {} : object(body.data));
    }));
    router.post('/lines/:lineId/machines/:machineId/passage', handle((service, req) => {
        const body = object(req.body);
        return service.passage(String(req.params.lineId), String(req.params.machineId), body.operationId as string);
    }));
    return router;
}
