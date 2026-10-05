import type { MachineModbusSession } from '../../modbus/sessions/machineModbusSession';
import type { MachineAssignment, ProcessResult } from '../../pcm/workflow/models/workflowModel';

export type MachineEvent =
    | { type: 'arrival'; cycleId: string }
    | { type: 'result'; operationId: string; result: ProcessResult; data?: Record<string, unknown> }
    | { type: 'passage'; operationId: string };

/** Implementar por modelo de CLP após descobrir os registradores no debug.
 * O adaptador deve correlacionar o ciclo físico, inclusive após reconexões, e distinguir
 * aceite, resultado e passagem. Nenhum endereço ou valor de OK é presumido aqui.
 */
export interface MachineProtocolAdapter {
    poll(session: MachineModbusSession): Promise<MachineEvent | null>;
    respond(session: MachineModbusSession, event: MachineEvent, assignment: MachineAssignment): Promise<void>;
}
