import { contextBridge, ipcRenderer } from 'electron';
import type { TcpApiContract } from '../modules/tcp/contracts/tcpApiContract';
import type { TcpSessionEvent } from '../modules/tcp/types/tcpTypes';
import type { ModbusApiContract } from '../modules/modbus/contracts/modbusApiContract';
import type { LineApiContract } from '../modules/pcm/workflow/contracts/lineApiContract';
import type { RealtimeEvent, StationApiContract } from '../main/stationContract';

const tcp: TcpApiContract = {
    connect: (options) => ipcRenderer.invoke('tcp:connect', options),
    disconnect: () => ipcRenderer.invoke('tcp:disconnect'),
    saveLog: (content) => ipcRenderer.invoke('tcp:saveLog', content),
    getState: () => ipcRenderer.invoke('tcp:getState'),
    clearLog: () => ipcRenderer.invoke('tcp:clearLog'),
    onEvent: (callback) => {
        const listener = (_event: Electron.IpcRendererEvent, data: TcpSessionEvent) => callback(data);
        ipcRenderer.on('tcp:event', listener);
        return () => ipcRenderer.removeListener('tcp:event', listener);
    }
};

contextBridge.exposeInMainWorld('tcp', tcp);
const modbus: ModbusApiContract = { execute: (action, options) => ipcRenderer.invoke('modbus:execute', action, options) };
contextBridge.exposeInMainWorld('modbus', modbus);
const lineApi: LineApiContract = { request: (method, path, body, authorization) =>
    ipcRenderer.invoke('line:request', method, path, body, authorization) };
contextBridge.exposeInMainWorld('lineApi', lineApi);
const station: StationApiContract = {
    getConfiguration: () => ipcRenderer.invoke('station:get'),
    saveConfiguration: input => ipcRenderer.invoke('station:save', input),
    startRealtime: () => ipcRenderer.invoke('station:realtime:start'),
    stopRealtime: () => ipcRenderer.invoke('station:realtime:stop'),
    getTemperature: () => ipcRenderer.invoke('station:temperature'),
    openCommunicationWindow: () => ipcRenderer.invoke('communication:open'),
    closeApplication: () => ipcRenderer.invoke('station:close'),
    onRealtime: callback => {
        const listener = (_event: Electron.IpcRendererEvent, data: RealtimeEvent) => callback(data);
        ipcRenderer.on('station:realtime', listener);
        return () => ipcRenderer.removeListener('station:realtime', listener);
    }
};
contextBridge.exposeInMainWorld('station', station);
