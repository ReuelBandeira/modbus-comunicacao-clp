import express = require('express');
import * as path from 'node:path';
import { notFound, handleError } from './middlewares/httpErrors';
import { registerSwagger } from './docs/swagger';

import { createEntryRoutes } from '../modules/pcm/entry/routes/entryRoutes';
import type { PcmRepositoryContract } from '../modules/pcm/repositories/pcmRepositoryContract';
import { EntryService } from '../modules/pcm/entry/services/entryService';
import type { LineCoordinatorService } from '../modules/pcm/workflow/services/lineCoordinatorService';
import { createLineRoutes } from '../modules/pcm/workflow/routes/lineRoutes';
import { createRealtimeHandler } from './realtime';
import { getSystemTemperature } from '../modules/system/services/systemTemperature';
import type { OperatorService } from '../modules/operators/services/operatorService';
import type { AdminAccessService } from '../modules/operators/services/adminAccessService';
import { createOperatorRoutes } from '../modules/operators/routes/operatorRoutes';
import type { ShiftService } from '../modules/shifts/services/shiftService';
import { createShiftRoutes } from '../modules/shifts/routes/shiftRoutes';
import type { OperatorSessionService } from '../modules/operatorSessions/services/operatorSessionService';
import { createOperatorSessionRoutes } from '../modules/operatorSessions/routes/operatorSessionRoutes';
import type { AvailabilityService } from '../modules/availability/services/availabilityService';
import { createAvailabilityRoutes } from '../modules/availability/routes/availabilityRoutes';
import type { PlcSignalService } from '../modules/plcSignals/services/plcSignalService';
import type { PlcSignalOperationalControl } from '../modules/plcSignals/services/plcSignalRuntime';
import { createPlcSignalRoutes } from '../modules/plcSignals/routes/plcSignalRoutes';
import type { EntryPreparationService } from '../modules/pcm/entry/services/entryPreparationService';
import { createEntryPreparationRoutes } from '../modules/pcm/entry/routes/entryPreparationRoutes';
import type { StationPresenceService } from '../modules/stations/services/stationPresenceService';
import { createStationPresenceRoutes } from '../modules/stations/routes/stationPresenceRoutes';
import type { TestResultService } from '../modules/testResults/services/testResultService';
import { createTestResultRoutes } from '../modules/testResults/routes/testResultRoutes';
import type { IftsBridgeClient } from '../modules/iftsBridge/services/iftsBridgeClient';
import type { LineOperationService } from '../modules/lineOperations/services/lineOperationService';
import { createLineOperationRoutes } from '../modules/lineOperations/routes/lineOperationRoutes';
import { createIftsBridgeRoutes, type IftsBridgeDebugGuard } from '../modules/iftsBridge/routes/iftsBridgeRoutes';
import type { IhmMachineService } from '../modules/ihmMachines/services/ihmMachineService';
import { createIhmMachineRoutes } from '../modules/ihmMachines/routes/ihmMachineRoutes';
import type { OperationalLogService } from '../modules/operationalLogs/services/operationalLogService';
import { operationalAudit } from '../modules/operationalLogs/middlewares/operationalAudit';
import { createOperationalLogRoutes } from '../modules/operationalLogs/routes/operationalLogRoutes';
import type { StationTestResetService } from '../modules/machines/services/stationTestResetService';
import { createStationTestResetRoutes } from '../modules/machines/routes/stationTestResetRoutes';

function isLoopback(address?: string): boolean {
    if (!address) return false;
    const normalized = address.replace(/^::ffff:/, '');
    return normalized === '127.0.0.1' || normalized === '::1';
}

const lanReads = [
    /^\/api\/health$/,
    /^\/api\/line-context$/,
    /^\/api\/line-status$/,
    /^\/api\/plc-alarms\/operational$/,
    /^\/api\/entry-preparation\/current$/,
    /^\/api\/line-operation$/,
    /^\/api\/operator-station\/context$/,
    /^\/api\/ihm-machines$/,
    /^\/api\/stations\/end-of-line\/status$/,
    /^\/api\/availability\/(?:current|report|reasons)$/,
    /^\/api\/realtime$/,
    /^\/api\/lines\/[a-zA-Z0-9_-]{1,80}(?:\/status|\/trays(?:\/[0-9]+)?|\/chip-metrics)?$/,
    /^\/api\/trays\/[^/?#]+$/,
    /^\/api\/test-results(?:\/[^/?#]+)?$/
    ,/^\/api\/ifts-bridge\/status$/
];

export function isLanRequestAllowed(method: string, pathname: string, remoteAddress?: string) {
    return isLoopback(remoteAddress)
        || method === 'POST' && pathname === '/api/serial-numbers'
        || method === 'POST' && pathname === '/api/line-operation/start'
        || method === 'POST' && /^\/api\/entry-preparation\/(?:tray|[0-9a-f-]{36}\/(?:chips|release))$/i.test(pathname)
        || method === 'POST' && pathname === '/api/stations/end-of-line/heartbeat'
        || method === 'POST' && pathname === '/api/test-results'
        || method === 'POST' && /^\/api\/ifts-bridge\/(?:start|finish|retry|debug\/reset)$/.test(pathname)
        || method === 'PUT' && pathname === '/api/ifts-bridge/model'
        || method === 'GET' && lanReads.some(pattern => pattern.test(pathname));
}

function lanReadOnly(): express.RequestHandler {
    return (req, res, next) => {
        if (!isLanRequestAllowed(req.method, req.path, req.socket.remoteAddress)) {
            res.status(403).json({ status: 'ERROR', msg: 'Esta operação só pode ser executada no computador Principal.' });
            return;
        }
        next();
    };
}

export function createApp(pcmRepository: PcmRepositoryContract = {
    inProgress: async () => { throw new Error('MongoDB não configurado.'); },
    insert: async () => { throw new Error('MongoDB não configurado.'); }
}, coordinator?: LineCoordinatorService, operatorService?: OperatorService, adminAccess?: AdminAccessService,
shiftService?: ShiftService, operatorSessionService?: OperatorSessionService, availabilityService?: AvailabilityService,
plcSignalService?: PlcSignalService, plcSignalRuntime?: PlcSignalOperationalControl,
entryPreparationService?: EntryPreparationService, stationPresenceService?: StationPresenceService,
testResultService?: TestResultService, iftsBridgeClient?: IftsBridgeClient, ihmMachineService?: IhmMachineService,
iftsBridgeDebugGuard?: IftsBridgeDebugGuard, lineOperationService?: LineOperationService,
operationalLogService?: OperationalLogService, stationTestResetService?: StationTestResetService) {
    const app = express();
    app.disable('x-powered-by');
    app.use(lanReadOnly());
    app.use('/api/test-results', express.json({ limit: '12mb', strict: true }));
    app.use(express.json({ limit: '32kb', strict: false }));
    app.use(operationalAudit(operationalLogService));
    registerSwagger(app);
    app.use('/line', express.static(path.join(__dirname, '../renderer/modules/line'), { index: 'line.html' }));
    app.use('/css', express.static(path.join(__dirname, '../renderer/css')));
    app.use('/vendor', express.static(path.join(__dirname, '../renderer/vendor')));
    app.get('/js/navigation.js', (_req, res) => res.sendFile(path.join(__dirname, '../renderer/js/navigation.js')));
    app.get('/js/line-status.js', (_req, res) => res.sendFile(path.join(__dirname, '../renderer/js/line-status.js')));

    app.get('/api/health', async (_req, res) => res.json({ status: 'OK', data: {
        service: 'pcm-main', databaseConfigured: !!coordinator, realtime: true,
        temperature: await getSystemTemperature(), capturedAt: new Date()
    } }));
    app.get('/api/realtime', createRealtimeHandler(coordinator));

    app.use('/api/serial-numbers', createEntryRoutes(new EntryService(pcmRepository, coordinator, entryPreparationService)));
    app.use('/api', createEntryPreparationRoutes(entryPreparationService));
    app.use('/api', createLineOperationRoutes(lineOperationService));
    if (stationPresenceService) app.use('/api', createStationPresenceRoutes(stationPresenceService));
    app.use('/api', createLineRoutes(coordinator, undefined, adminAccess));
    app.use('/api', createOperatorRoutes(operatorService, adminAccess));
    app.use('/api', createShiftRoutes(shiftService, adminAccess));
    app.use('/api', createOperatorSessionRoutes(operatorSessionService));
    app.use('/api', createAvailabilityRoutes(availabilityService, adminAccess));
    app.use('/api', createPlcSignalRoutes(plcSignalService, adminAccess, plcSignalRuntime));
    app.use('/api', createIhmMachineRoutes(ihmMachineService, adminAccess));
    app.use('/api', createOperationalLogRoutes(operationalLogService, adminAccess));
    app.use('/api', createStationTestResetRoutes(stationTestResetService, adminAccess));
    app.use('/api', createTestResultRoutes(testResultService));
    if (iftsBridgeClient) app.use('/api', createIftsBridgeRoutes(iftsBridgeClient, adminAccess, iftsBridgeDebugGuard));

    app.use(notFound);
    app.use(handleError);
    return app;
}
