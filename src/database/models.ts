import type { IndexDescription } from 'mongodb';
import { pcmCollection, pcmIndexes } from '../modules/pcm/models/pcmModel';
import { linesCollection, lineIndexes } from '../modules/machines/models/lineModel';
import { operatorIndexes, operatorsCollection } from '../modules/operators/models/operatorModel';
import { shiftIndexes, shiftsCollection } from '../modules/shifts/models/shiftModel';
import { operatorSessionIndexes, operatorSessionsCollection } from '../modules/operatorSessions/models/operatorSessionModel';
import { downtimeEventIndexes, downtimeEventsCollection, downtimeReasonIndexes, downtimeReasonsCollection,
    productionCalendarCollection, productionCalendarIndexes, productionPeriodIndexes, productionPeriodsCollection,
    shiftBreakIndexes, shiftBreaksCollection, oeeConfigurationIndexes, oeeConfigurationsCollection
} from '../modules/availability/models/availabilityModel';
import { plcAlarmDefinitionIndexes, plcAlarmDefinitionsCollection, plcAlarmOccurrenceIndexes, plcAlarmOccurrencesCollection,
    plcCommandExecutionIndexes, plcCommandExecutionsCollection, plcCommandIndexes, plcCommandsCollection, plcDeviceIndexes, plcDevicesCollection,
    plcSignalActionExecutionIndexes, plcSignalActionExecutionsCollection, plcSignalIndexes, plcSignalsCollection
} from '../modules/plcSignals/models/plcSignalModel';
import { testResultIndexes, testResultsCollection } from '../modules/testResults/models/testResultModel';
import { ihmMachineIndexes, ihmMachinesCollection } from '../modules/ihmMachines/models/ihmMachineModel';
import { lineOperationIndexes, lineOperationsCollection } from '../modules/lineOperations/models/lineOperationModel';
import { operationalLogIndexes, operationalLogsCollection } from '../modules/operationalLogs/models/operationalLogModel';

export interface MongoModel {
    collection: string;
    indexes: IndexDescription[];
}

// Toda coleção com índice a garantir na conexão precisa estar listada aqui.
export const mongoModels: MongoModel[] = [
    { collection: pcmCollection, indexes: pcmIndexes },
    { collection: linesCollection, indexes: lineIndexes },
    { collection: operatorsCollection, indexes: operatorIndexes },
    { collection: shiftsCollection, indexes: shiftIndexes },
    { collection: operatorSessionsCollection, indexes: operatorSessionIndexes },
    { collection: downtimeReasonsCollection, indexes: downtimeReasonIndexes },
    { collection: shiftBreaksCollection, indexes: shiftBreakIndexes },
    { collection: productionCalendarCollection, indexes: productionCalendarIndexes },
    { collection: downtimeEventsCollection, indexes: downtimeEventIndexes },
    { collection: productionPeriodsCollection, indexes: productionPeriodIndexes },
    { collection: oeeConfigurationsCollection, indexes: oeeConfigurationIndexes },
    { collection: plcDevicesCollection, indexes: plcDeviceIndexes },
    { collection: plcSignalsCollection, indexes: plcSignalIndexes },
    { collection: plcCommandsCollection, indexes: plcCommandIndexes },
    { collection: plcCommandExecutionsCollection, indexes: plcCommandExecutionIndexes },
    { collection: plcSignalActionExecutionsCollection, indexes: plcSignalActionExecutionIndexes },
    { collection: plcAlarmDefinitionsCollection, indexes: plcAlarmDefinitionIndexes },
    { collection: plcAlarmOccurrencesCollection, indexes: plcAlarmOccurrenceIndexes },
    { collection: testResultsCollection, indexes: testResultIndexes },
    { collection: ihmMachinesCollection, indexes: ihmMachineIndexes },
    { collection: lineOperationsCollection, indexes: lineOperationIndexes },
    { collection: operationalLogsCollection, indexes: operationalLogIndexes }
];
