import type { PhysicalLineStateSnapshot, PhysicalLineStrategy } from '../../availability/models/availabilityModel';
import type { PlcProductionState } from '../models/plcSignalModel';

export interface PhysicalSignalInput {
    signalId: string;
    label: string;
    plcId?: string;
    value?: number;
    productionState?: PlcProductionState;
    error?: string;
}

export function aggregatePhysicalLineState(inputs: PhysicalSignalInput[], strategy: PhysicalLineStrategy,
    referenceSignalId: string | undefined, capturedAt = new Date()): PhysicalLineStateSnapshot {
    const signals = inputs.map(item => ({ ...item }));
    const result = (state: PhysicalLineStateSnapshot['state'], reason: string): PhysicalLineStateSnapshot =>
        ({ state, strategy, signals, reason, capturedAt });
    if (!signals.length) return result('UNKNOWN', 'Nenhum sinal participa do estado físico da linha.');

    const emergencies = signals.filter(item => item.productionState === 'emergency' && !item.error);
    if (emergencies.length) return result('STOPPED',
        `Emergência informada por ${emergencies.map(item => item.label).join(', ')}.`);

    const invalid = signals.filter(item => item.error || !item.productionState);
    if (invalid.length) return result('UNKNOWN', invalid.map(item =>
        `${item.label}: ${item.error || 'estado produtivo não mapeado'}`).join(' · '));

    if (strategy === 'reference_signal') {
        const reference = signals.find(item => item.signalId === referenceSignalId);
        if (!reference) return result('UNKNOWN', 'O sinal de referência configurado não está disponível.');
        if (reference.productionState === 'running') return result('RUNNING', `${reference.label} está produzindo.`);
        if (reference.productionState === 'stopped') return result('STOPPED', `${reference.label} está parada.`);
        return result('TRANSITION', `${reference.label} está em alerta.`);
    }

    const running = signals.filter(item => item.productionState === 'running');
    const stopped = signals.filter(item => item.productionState === 'stopped');
    const warnings = signals.filter(item => item.productionState === 'warning');
    if (strategy === 'all_required') {
        if (stopped.length) return result('STOPPED', `${stopped.map(item => item.label).join(', ')} fora de produção.`);
        if (warnings.length) return result('TRANSITION', `${warnings.map(item => item.label).join(', ')} em alerta.`);
        return result('RUNNING', 'Todas as CLPs estão produzindo.');
    }

    if (running.length) return result('RUNNING', `${running.length} de ${signals.length} CLPs produzindo.`);
    if (stopped.length === signals.length) return result('STOPPED', 'Todas as CLPs estão paradas.');
    return result('TRANSITION', 'As CLPs estão em estados diferentes, sem produção confirmada.');
}
