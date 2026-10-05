import { Router, type RequestHandler } from 'express';
import { AdminAccessError, type AdminAccessService } from '../../operators/services/adminAccessService';
import { PlcSignalError, type PlcSignalService } from '../services/plcSignalService';
import type { PlcSignalOperationalControl } from '../services/plcSignalRuntime';

export function createPlcSignalRoutes(service?: PlcSignalService, admin?: AdminAccessService, runtime?: PlcSignalOperationalControl) {
    const router = Router();
    const failure = (error: unknown, res: Parameters<RequestHandler>[1]) => {
        const known = error instanceof PlcSignalError || error instanceof AdminAccessError;
        res.status(known ? error.status : 503).json({ status: 'ERROR', msg: known ? error.message : 'Nao foi possivel confirmar a operacao.' });
    };
    const handle = (action: (value: PlcSignalService, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler => async (req, res) => {
        try { if (!service || !admin) throw new PlcSignalError(503, 'Integracao de sinais exige MongoDB configurado.'); admin.authorize(req.get('authorization')); res.json({ status: 'OK', data: await action(service, req) }); }
        catch (error) { failure(error, res); }
    };
    const operational = (action: (value: PlcSignalOperationalControl, req: Parameters<RequestHandler>[0]) => Promise<unknown>): RequestHandler => async (req, res) => {
        try { if (!runtime) throw new PlcSignalError(503, 'Runtime de comandos indisponivel.'); res.json({ status: 'OK', data: await action(runtime, req) }); }
        catch (error) { failure(error, res); }
    };
    router.get('/plc-signals', handle(value => value.view()));
    router.post('/plc-devices', handle((value, req) => value.saveDevice(undefined, req.body)));
    router.put('/plc-devices/:plcId', handle((value, req) => value.saveDevice(String(req.params.plcId), req.body)));
    router.delete('/plc-devices/:plcId', handle((value, req) => value.removeDevice(String(req.params.plcId))));
    router.post('/plc-signals', handle((value, req) => value.saveSignal(undefined, req.body)));
    router.put('/plc-signals/:signalId', handle((value, req) => value.saveSignal(String(req.params.signalId), req.body)));
    router.delete('/plc-signals/:signalId', handle((value, req) => value.removeSignal(String(req.params.signalId))));
    router.post('/plc-alarms', handle((value, req) => value.saveAlarm(undefined, req.body)));
    router.put('/plc-alarms/:alarmId', handle((value, req) => value.saveAlarm(String(req.params.alarmId), req.body)));
    router.delete('/plc-alarms/:alarmId', handle((value, req) => value.removeAlarm(String(req.params.alarmId))));
    router.post('/plc-commands', handle((value, req) => value.saveCommand(undefined, req.body)));
    router.put('/plc-commands/:commandId', handle((value, req) => value.saveCommand(String(req.params.commandId), req.body)));
    router.delete('/plc-commands/:commandId', handle((value, req) => value.removeCommand(String(req.params.commandId))));
    router.get('/plc-signals/states', handle(async () => runtime?.states() ?? []));
    router.post('/plc-commands/:commandId/execute', handle(async (_value, req) => { if (!runtime) throw new PlcSignalError(503, 'Runtime de sinais indisponivel.'); return runtime.execute(String(req.params.commandId)); }));
    router.get('/plc-controls/operational', operational(value => value.operational()));
    router.get('/line-status', operational(value => value.lineStatus()));
    router.get('/plc-alarms/operational', operational(value => value.alarms()));
    router.post('/plc-alarms/occurrences/:occurrenceId/acknowledge', operational((value, req) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
        return value.acknowledgeAlarm(String(req.params.occurrenceId), typeof body.acknowledgedBy === 'string' ? body.acknowledgedBy : undefined);
    }));
    router.post('/plc-controls/:code/execute', operational((value, req) => {
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
        return value.executeByCode(String(req.params.code).toUpperCase(), String(body.requestId ?? ''), 'IHM Principal');
    }));
    return router;
}
