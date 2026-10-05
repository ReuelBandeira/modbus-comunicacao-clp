import type { SystemTemperature } from '../modules/system/services/systemTemperature';

export type StationRole = 'main' | 'end-of-line';

export interface StationConfiguration {
    version: 1;
    role: StationRole;
    serverUrl: string;
}

export interface StationSetupInput {
    role: StationRole;
    serverUrl?: string;
    password: string;
}

export interface RealtimeEvent {
    type: 'connection' | 'line:state' | 'error';
    data: unknown;
}

export interface StationApiContract {
    getConfiguration(): Promise<StationConfiguration | null>;
    saveConfiguration(input: StationSetupInput): Promise<void>;
    startRealtime(): Promise<void>;
    stopRealtime(): Promise<void>;
    getTemperature(): Promise<SystemTemperature>;
    openCommunicationWindow(): Promise<void>;
    closeApplication(): Promise<void>;
    onRealtime(callback: (event: RealtimeEvent) => void): () => void;
}
