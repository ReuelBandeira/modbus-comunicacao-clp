import type { LineRepositoryContract } from '../repositories/lineRepository';
import type { LineCoordinatorService } from '../../pcm/workflow/services/lineCoordinatorService';
import { ZeroMailboxRuntime } from './zeroMailboxRuntime';

const delay = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
});

/** Observa a configuração persistida e mantém apenas o runtime correspondente à revisão ativa. */
export class MachineRuntimeManager {
    private controller?: AbortController;
    private task?: Promise<void>;
    private runtimes: ZeroMailboxRuntime[] = [];
    private appliedRevision?: number;
    private acceptInitialRequestsOnce = false;
    constructor(private readonly lineId: string, private readonly lines: LineRepositoryContract,
        private readonly coordinator: LineCoordinatorService,
        private readonly excludedMachineIds: ReadonlySet<string> = new Set(),
        private readonly refreshMs = 1000) {}
    start(): void {
        if (this.controller) return;
        this.controller = new AbortController();
        this.task = this.loop(this.controller.signal);
    }
    pause(): Promise<void> { return this.stop(); }
    resume(acceptInitialRequests = false): void {
        this.acceptInitialRequestsOnce ||= acceptInitialRequests;
        this.start();
    }
    async stop(): Promise<void> {
        this.controller?.abort();
        await this.task;
        this.controller = undefined; this.task = undefined;
        await Promise.all(this.runtimes.map(runtime => runtime.stop())); this.runtimes = []; this.appliedRevision = undefined;
    }
    private async loop(signal: AbortSignal) {
        while (!signal.aborted) {
            try { await this.reconcile(); }
            catch (error) { console.error(`[MODBUS][RUNTIME] ${(error as Error).message}`); }
            await delay(this.refreshMs, signal);
        }
    }
    private async reconcile() {
        const line = await this.lines.get(this.lineId);
        if (!line || line.revision === this.appliedRevision) return;
        await Promise.all(this.runtimes.map(runtime => runtime.stop())); this.runtimes = []; this.appliedRevision = undefined;
        try {
            for (const [stationIndex, machine] of line.machines.entries()) {
                if (this.excludedMachineIds.has(machine.machineId) && machine.protocol !== 'ifts-qr-handshake-v1') continue;
                if (!machine.modbus?.enabled) continue;
                if (['m1-qr-handshake-v1', 'ifts-qr-handshake-v1', 'result-handshake-v1'].includes(machine.protocol)) {
                    const runtime = new ZeroMailboxRuntime(line.lineId, machine, stationIndex, this.coordinator,
                        undefined, this.acceptInitialRequestsOnce);
                    runtime.start(); this.runtimes.push(runtime);
                }
            }
        } catch (error) {
            await Promise.all(this.runtimes.map(runtime => runtime.stop().catch(() => {}))); this.runtimes = []; throw error;
        }
        this.appliedRevision = line.revision;
        this.acceptInitialRequestsOnce = false;
    }
}
