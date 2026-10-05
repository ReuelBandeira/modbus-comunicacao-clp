import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createApp } from './app';
import { readBypassEnabled, readHttpConfig, readOfflineInspectionAllowed } from './config';
import { connectMongo } from '../database/mongo';
import { PcmRepository } from '../modules/pcm/repositories/pcmRepository';
import { pcmCollection, type PCM } from '../modules/pcm/models/pcmModel';
import { LineRepository } from '../modules/machines/repositories/lineRepository';
import { linesCollection, lineCountersCollection, type LineConfig, type LineCounter } from '../modules/machines/models/lineModel';
import { PcmWorkflowRepository } from '../modules/pcm/repositories/pcmWorkflowRepository';
import { LineCoordinatorService } from '../modules/pcm/workflow/services/lineCoordinatorService';
import { identifier } from '../modules/machines/validators/lineValidation';
import { MachineRuntimeManager } from '../modules/machines/services/machineRuntimeManager';
import { operatorsCollection, type Operator } from '../modules/operators/models/operatorModel';
import { OperatorRepository } from '../modules/operators/repositories/operatorRepository';
import { OperatorService } from '../modules/operators/services/operatorService';
import { AdminAccessService } from '../modules/operators/services/adminAccessService';
import { shiftsCollection, type Shift } from '../modules/shifts/models/shiftModel';
import { ShiftRepository } from '../modules/shifts/repositories/shiftRepository';
import { ShiftService } from '../modules/shifts/services/shiftService';
import { operatorSessionsCollection, type OperatorStationSession } from '../modules/operatorSessions/models/operatorSessionModel';
import { OperatorSessionRepository } from '../modules/operatorSessions/repositories/operatorSessionRepository';
import { OperatorSessionService } from '../modules/operatorSessions/services/operatorSessionService';
import { downtimeEventsCollection, downtimeReasonsCollection, productionCalendarCollection, shiftBreaksCollection,
    productionPeriodsCollection, type DowntimeEvent, type DowntimeReason, type ProductionCalendarException,
    type ProductionPeriod, type ShiftBreak, oeeConfigurationsCollection, type OeeConfiguration
} from '../modules/availability/models/availabilityModel';
import { AvailabilityRepository } from '../modules/availability/repositories/availabilityRepository';
import { AvailabilityService } from '../modules/availability/services/availabilityService';
import { PlcSignalRepository } from '../modules/plcSignals/repositories/plcSignalRepository';
import { plcAlarmDefinitionsCollection, plcAlarmOccurrencesCollection, plcCommandExecutionsCollection, plcCommandsCollection,
    plcDevicesCollection, plcSignalActionExecutionsCollection, plcSignalsCollection, type PlcAlarmDefinition,
    type PlcAlarmOccurrence, type PlcCommandExecution, type PlcSignalActionExecution } from '../modules/plcSignals/models/plcSignalModel';
import { PlcSignalService } from '../modules/plcSignals/services/plcSignalService';
import { PlcSignalRuntime } from '../modules/plcSignals/services/plcSignalRuntime';
import { PlcCommandTextLog } from '../modules/plcSignals/services/plcCommandTextLog';
import { EntryPreparationRepository } from '../modules/pcm/entry/repositories/entryPreparationRepository';
import { EntryPreparationService } from '../modules/pcm/entry/services/entryPreparationService';
import { WorkflowError } from '../modules/pcm/workflow/errors/workflowError';
import { StationPresenceService } from '../modules/stations/services/stationPresenceService';
import { testResultsCollection, type TestResultCycle } from '../modules/testResults/models/testResultModel';
import { TestResultRepository } from '../modules/testResults/repositories/testResultRepository';
import { TestResultService } from '../modules/testResults/services/testResultService';
import { IftsBridgeClient, readIftsBridgeConfig } from '../modules/iftsBridge/services/iftsBridgeClient';
import { IftsLineIntegrationService, readIftsLineIntegrationConfig } from '../modules/iftsBridge/services/iftsLineIntegrationService';
import { ihmMachinesCollection, type IhmMachine } from '../modules/ihmMachines/models/ihmMachineModel';
import { IhmMachineRepository } from '../modules/ihmMachines/repositories/ihmMachineRepository';
import { IhmMachineService } from '../modules/ihmMachines/services/ihmMachineService';
import { lineOperationsCollection, type LineOperationState } from '../modules/lineOperations/models/lineOperationModel';
import { LineOperationRepository } from '../modules/lineOperations/repositories/lineOperationRepository';
import { LineOperationService } from '../modules/lineOperations/services/lineOperationService';
import { operationalLogsCollection, type OperationalLogEvent } from '../modules/operationalLogs/models/operationalLogModel';
import { OperationalLogRepository } from '../modules/operationalLogs/repositories/operationalLogRepository';
import { OperationalLogService } from '../modules/operationalLogs/services/operationalLogService';
import { StationTestResetService } from '../modules/machines/services/stationTestResetService';

export async function startApi(config = readHttpConfig()) {
    const entryLineId = identifier(process.env.PCM_LINE_ID || 'linha-01', 'PCM_LINE_ID');
    const allowOfflineInspection = readOfflineInspectionAllowed();
    // Sem configuração, o endpoint retorna 503; nunca confirma uma gravação fictícia.
    const mongo = process.env.MONGO_HOST ? await connectMongo() : undefined;
    const configuredRetention = Number(process.env.OPERATIONAL_LOG_RETENTION_DAYS ?? 365);
    const retentionDays = Number.isInteger(configuredRetention) && configuredRetention >= 1 && configuredRetention <= 3650
        ? configuredRetention : 365;
    const operationalLogService = mongo ? new OperationalLogService(new OperationalLogRepository(
        mongo.db.collection<OperationalLogEvent>(operationalLogsCollection)), entryLineId, retentionDays) : undefined;
    const pcmRepository = mongo ? new PcmRepository(mongo.db.collection<PCM>(pcmCollection)) : undefined;
    const lineRepository = mongo ? new LineRepository(
        mongo.db.collection<LineConfig>(linesCollection), mongo.db.collection<LineCounter>(lineCountersCollection)) : undefined;
    const coordinator = mongo && lineRepository ? new LineCoordinatorService(
        lineRepository,
        new PcmWorkflowRepository(mongo.db.collection<PCM>(pcmCollection)), entryLineId, readBypassEnabled()
    ) : undefined;
    const entryStationId = identifier(process.env.PCM_STATION_ID || entryLineId, 'PCM_STATION_ID');
    const entryStationName = process.env.PCM_STATION_NAME?.trim() || 'Principal';
    const operatorRepository = mongo ? new OperatorRepository(mongo.db.collection<Operator>(operatorsCollection)) : undefined;
    const adminAccess = new AdminAccessService(process.env.ADMIN_PASSWORD);
    const operatorSessionRepository = mongo
        ? new OperatorSessionRepository(mongo.db.collection<OperatorStationSession>(operatorSessionsCollection)) : undefined;
    const shiftService = mongo ? new ShiftService(new ShiftRepository(mongo.db.collection<Shift>(shiftsCollection)),
        operatorSessionRepository) : undefined;
    const operatorSessionService = mongo && operatorRepository && shiftService ? new OperatorSessionService(
        operatorSessionRepository!,
        operatorRepository, shiftService, entryStationId, entryStationName,
        async () => (await lineRepository?.get(entryLineId))?.minimumOperators ?? 3
    ) : undefined;
    const operatorService = operatorRepository ? new OperatorService(operatorRepository, operatorSessionService) : undefined;
    const stationPresence = new StationPresenceService(async () =>
        !allowOfflineInspection && (await lineRepository?.get(entryLineId))?.mode === 'production',
    Number(process.env.END_OF_LINE_HEARTBEAT_TIMEOUT_MS ?? 15_000));
    let lineOperationService: LineOperationService | undefined;
    const entryPreparationRepository = mongo
        ? new EntryPreparationRepository(mongo.db.collection<PCM>(pcmCollection)) : undefined;
    const entryPreparationService = entryPreparationRepository && coordinator && pcmRepository && lineRepository && operatorSessionService
        ? new EntryPreparationService(
            entryPreparationRepository, pcmRepository, coordinator,
            entryLineId, entryStationId, entryStationName, {
                async assertMinimumOperators() {
                    const context = await operatorSessionService.context();
                    if (!context.currentShift) throw new WorkflowError(409,
                        'Bipagem bloqueada: nenhum turno vigente para este horário.');
                    if (!context.staffing.satisfied) throw new WorkflowError(409,
                        `Bipagem bloqueada: ${context.staffing.active} de ${context.staffing.minimum} operadores ativos na estação principal.`);
                },
                async assertRequiredStation() {
                    await stationPresence.assertAvailable();
                },
                async assertOperationRunning() {
                    if (!lineOperationService) throw new WorkflowError(503, 'Controle de operação indisponível.');
                    await lineOperationService.assertRunning();
                }
            }) : undefined;
    const availabilityService = mongo ? new AvailabilityService(new AvailabilityRepository(
        mongo.db.collection<DowntimeReason>(downtimeReasonsCollection),
        mongo.db.collection<ShiftBreak>(shiftBreaksCollection),
        mongo.db.collection<ProductionCalendarException>(productionCalendarCollection),
        mongo.db.collection<DowntimeEvent>(downtimeEventsCollection),
        mongo.db.collection<ProductionPeriod>(productionPeriodsCollection),
        mongo.db.collection<OeeConfiguration>(oeeConfigurationsCollection)
    ), new ShiftRepository(mongo.db.collection<Shift>(shiftsCollection)),
    new PcmWorkflowRepository(mongo.db.collection<PCM>(pcmCollection)), entryLineId, operationalLogService) : undefined;
    const iftsLineConfig = readIftsLineIntegrationConfig(entryLineId);
    const machineRuntimes = coordinator && lineRepository
        ? new MachineRuntimeManager(entryLineId, lineRepository, coordinator,
            new Set(iftsLineConfig ? [iftsLineConfig.machineId] : [])) : undefined;
    if (coordinator && machineRuntimes) coordinator.setRuntimeInterventionControl(machineRuntimes);
    const iftsBridgeClient = new IftsBridgeClient(readIftsBridgeConfig());
    const iftsLineIntegration = coordinator && iftsLineConfig
        ? new IftsLineIntegrationService(iftsLineConfig, coordinator, iftsBridgeClient) : undefined;
    const activeIftsCycle = async () => {
        const status = await iftsBridgeClient.status();
        if (!status.online) throw new Error(status.detail ?? 'IFTS Bridge indisponível.');
        if (!status.cycleId) throw new Error('O IFTS Bridge não possui ciclo ativo.');
        return status.cycleId;
    };
    const signalRepository = mongo ? new PlcSignalRepository(mongo.db.collection(plcSignalsCollection),
        mongo.db.collection(plcCommandsCollection), mongo.db.collection(plcDevicesCollection),
        mongo.db.collection<PlcCommandExecution>(plcCommandExecutionsCollection),
        mongo.db.collection<PlcSignalActionExecution>(plcSignalActionExecutionsCollection),
        mongo.db.collection<PlcAlarmDefinition>(plcAlarmDefinitionsCollection),
        mongo.db.collection<PlcAlarmOccurrence>(plcAlarmOccurrencesCollection)) : undefined;
    const commandTextLog = new PlcCommandTextLog();
    const signalRuntime = signalRepository && lineRepository ? new PlcSignalRuntime(
        entryLineId, lineRepository, signalRepository, availabilityService, {}, {
            ...(availabilityService ? {
                line_started: async ({ signal }) => { await availabilityService.reconcilePlcRunningSignal(
                    signal.signalId, true, signal.downtimeReasonId ?? '', signal.label); },
                line_stopped: async ({ signal }) => {
                    await Promise.all([
                        availabilityService.reconcilePlcRunningSignal(
                            signal.signalId, false, signal.downtimeReasonId!, signal.label),
                        lineOperationService?.markStopped()
                    ]);
                }
            } : {}),
            ifts_start: async () => {
                if (iftsLineIntegration) {
                    await iftsLineIntegration.start();
                    return;
                }
                const status = await iftsBridgeClient.status();
                if (!status.online) throw new Error(status.detail ?? 'IFTS Bridge indisponível.');
                const active = status.cycleId && !['idle', 'completed'].includes(status.status) ? status.cycleId : undefined;
                const generated = `PLC-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
                await iftsBridgeClient.start({ cycleId: active ?? generated });
            },
            ...(iftsLineIntegration ? {
                ifts_passage: async () => {
                    throw new Error('A passagem da estação IFTS é confirmada pelo QR de saída em D21-D35 e M1.');
                }
            } : {}),
            ifts_finish: async () => { await iftsBridgeClient.finish({ cycleId: await activeIftsCycle() }); },
            ifts_retry: async () => { await iftsBridgeClient.retry({ cycleId: await activeIftsCycle() }); },
            ifts_reset: async () => { await iftsBridgeClient.resetDebug(); }
        }, commandTextLog, operationalLogService) : undefined;
    const signalService = signalRepository && lineRepository ? new PlcSignalService(signalRepository, lineRepository, entryLineId) : undefined;
    if (mongo && lineRepository && operatorSessionService && signalRuntime) {
        const generalStart = (commands: Array<{ code?: string; label: string; scope?: 'line' | 'machine';
            available: boolean; blockedReasons: string[] }>) => commands.find(command => {
                if (command.scope === 'machine') return false;
                const tokens = `${command.code ?? ''} ${command.label}`.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
                return ['START', 'INICIAR', 'INICIO', 'LIGAR', 'PARTIR'].some(alias => tokens.includes(alias));
            });
        lineOperationService = new LineOperationService(entryLineId,
            new LineOperationRepository(mongo.db.collection<LineOperationState>(lineOperationsCollection)), {
                async operators() {
                    const context = await operatorSessionService.context();
                    if (!context.currentShift) return { ok: false, detail: 'Nenhum turno vigente para este horário.' };
                    return { ok: context.staffing.satisfied,
                        detail: `${context.staffing.active} de ${context.staffing.minimum} operadores ativos.` };
                },
                async endOfLine() {
                    const status = await stationPresence.status();
                    return { ok: status.satisfied, detail: status.required
                        ? status.connected ? 'Estação conectada.' : 'Estação de Final de Linha desconectada.'
                        : 'Estação opcional neste modo.' };
                },
                async bridge(startIfOffline) {
                    const status = await iftsBridgeClient.readiness(startIfOffline);
                    return { ok: status.ready, actionable: status.online && !status.ready, detail: status.ready
                        ? status.startAttempted ? 'Bridge e estação IFTS preparados.' : 'Bridge online e estação IFTS pronta.'
                        : status.detail ?? 'Bridge offline.' };
                },
                async plcs() {
                    const view = await signalRuntime.operational() as { commands: Array<{ code?: string; label: string;
                        scope?: 'line' | 'machine'; available: boolean; blockedReasons: string[] }> };
                    const command = generalStart(view.commands);
                    if (!command?.code) return { ok: false, detail: 'Comando START geral não configurado.' };
                    if (!command.available) return { ok: false, commandCode: command.code,
                        detail: command.blockedReasons.join(' ') || 'Comando START bloqueado.' };
                    const preflight = await signalRuntime.preflightByCode(command.code);
                    return { ok: true, commandCode: command.code,
                        detail: `${preflight.targets.length} CLP(s) pronta(s): ${preflight.targets.join(', ')}.` };
                }
            });
    }
    const ihmMachineService = mongo && signalRepository ? new IhmMachineService(
        new IhmMachineRepository(mongo.db.collection<IhmMachine>(ihmMachinesCollection)), signalRepository, entryLineId
    ) : undefined;
    const testResultService = mongo ? new TestResultService(
        new TestResultRepository(mongo.db.collection<TestResultCycle>(testResultsCollection)),
        process.env.IFTS_CSV_BRIDGE_API_KEY?.trim() || undefined,
        signalRepository && signalRuntime ? async cycle => {
            const code = `IFTS_RESULT_${cycle.result}`;
            const command = await signalRepository.commandByCode(entryLineId, code);
            if (!command?.enabled) return;
            const requestId = `ifts-${createHash('sha256').update(`${cycle.cycleId}:${cycle.result}`).digest('hex').slice(0, 32)}`;
            const execution = await signalRuntime.executeByCode(code, requestId, 'IFTS Bridge');
            if (execution.status !== 'completed') {
                throw new Error(execution.error || `comando ${code} terminou com estado ${execution.status}`);
            }
            if (iftsLineIntegration && !cycle.cycleId.startsWith('SIM-')) {
                await iftsLineIntegration.completeAfterResultWrite(cycle.cycleId);
            }
        } : undefined,
        iftsLineIntegration ? async cycle => { await iftsLineIntegration.apply(cycle); } : undefined
    ) : undefined;
    if (coordinator && signalRuntime) coordinator.setOperationalControl(signalRuntime);
    const stationTestResetService = lineRepository && entryPreparationRepository && machineRuntimes && signalRuntime
        ? new StationTestResetService(entryLineId, entryStationId, entryStationName, lineRepository,
            entryPreparationRepository, machineRuntimes, signalRuntime,
            process.env.PCM_TEST_RESET_TRAY_SERIAL?.trim() || 'BANDEJA-TESTE-01',
            process.env.PCM_TEST_RESET_CHIP_PREFIX?.trim() || 'CHIP-TESTE')
        : undefined;
    const server = createServer(createApp(pcmRepository, coordinator, operatorService, adminAccess, shiftService,
        operatorSessionService, availabilityService, signalService, signalRuntime, entryPreparationService,
        stationPresence, testResultService, iftsBridgeClient, ihmMachineService, iftsLineIntegration, lineOperationService,
        operationalLogService, stationTestResetService));
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    try { await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
            server.removeListener('error', reject);
            resolve();
        });
    }); } catch (error) { await mongo?.client.close(); throw error; }
    machineRuntimes?.start();
    signalRuntime?.start();
    const synchronizeAvailability = () => availabilityService?.synchronizeCurrentPeriod().catch(error =>
        console.error('Falha ao materializar o turno atual:', error instanceof Error ? error.message : error));
    void synchronizeAvailability();
    const availabilityTimer = availabilityService ? setInterval(() => { void synchronizeAvailability(); }, 30_000) : undefined;
    availabilityTimer?.unref();
    let stopping: Promise<void> | undefined;
    return {
        address: server.address(),
        stop(): Promise<void> {
            if (availabilityTimer) clearInterval(availabilityTimer);
            return stopping ??= new Promise<void>((resolve, reject) => {
                const deadline = setTimeout(() => server.closeAllConnections(), 5000);
                deadline.unref();
                server.close(error => {
                    clearTimeout(deadline);
                    void Promise.all([machineRuntimes?.stop() ?? Promise.resolve(), signalRuntime?.stop() ?? Promise.resolve(),
                        commandTextLog.flush()])
                        .then(() => operationalLogService?.flush() ?? Promise.resolve())
                        .then(() => mongo?.client.close() ?? Promise.resolve())
                        .then(() => { if (error) reject(error); else resolve(); }, reject);
                });
            });
        }
    };
}

// Importar no Electron não inicia outro servidor nem registra sinais de processo.
if (require.main === module) {
    void startApi().then(api => {
        console.log('API iniciada. Entrada e controle da linha persistidos no MongoDB.', api.address);
        const shutdown = () => { void api.stop().catch(() => { process.exitCode = 1; }); };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
    }).catch(error => {
        console.error('Falha ao iniciar a API:', error.message);
        process.exitCode = 1;
    });
}
