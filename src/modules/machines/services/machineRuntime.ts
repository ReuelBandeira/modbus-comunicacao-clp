import type { LineCoordinatorService } from '../../pcm/workflow/services/lineCoordinatorService';
import { MachineModbusSession } from '../../modbus/sessions/machineModbusSession';
import type { MachineConfig } from '../models/lineModel';
import type { MachineProtocolAdapter } from './machineProtocolAdapter';

/** Preparado para um loop por máquina. Não iniciado pela API enquanto não houver adaptador validado. */
export class MachineRuntime {
    private busy = false;
    private readonly session: MachineModbusSession;
    constructor(private readonly lineId: string, private readonly machine: MachineConfig,
        private readonly coordinator: LineCoordinatorService, private readonly adapter?: MachineProtocolAdapter,
        session?: MachineModbusSession) {
        this.session = session ?? new MachineModbusSession(machine);
    }
    async pollOnce(): Promise<void> {
        if (!this.adapter) throw new Error('Mapa Modbus não configurado. Use o debug para definir o protocolo da CLP.');
        if (this.busy) throw new Error('Leitura da máquina já em andamento.');
        this.busy = true;
        try {
            const event = await this.adapter.poll(this.session);
            if (!event) return;
            const assignment = event.type === 'arrival'
                ? await this.coordinator.arrive(this.lineId, this.machine.machineId, event.cycleId)
                : event.type === 'result'
                    ? await this.coordinator.result(this.lineId, this.machine.machineId, event.operationId, event.result, event.data)
                    : await this.coordinator.passage(this.lineId, this.machine.machineId, event.operationId);
            // A confirmação só sai depois do MongoDB. Repetições do evento são idempotentes.
            await this.adapter.respond(this.session, event, assignment);
        } finally { this.busy = false; }
    }
    dispose(): void { this.session.dispose(); }
}
