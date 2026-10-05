import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { TcpService } from '../modules/tcp/services/tcpService';
import { TcpSession } from '../modules/tcp/sessions/tcpSession';
import { startApi } from '../api/server';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { ModbusTestService } from '../modules/modbus/services/modbusTestService';
import { createLineApiBridge } from './lineApiBridge';
import { readHttpConfig } from '../api/config';
import { StationConfigStore } from './stationConfig';
import type { StationConfiguration, StationSetupInput } from './stationContract';
import { RealtimeClient } from './realtimeClient';
import { getSystemTemperature } from '../modules/system/services/systemTemperature';

let api: Awaited<ReturnType<typeof startApi>> | undefined;
let shuttingDown = false;

function apiUrlFromAddress() {
    const address = api?.address;
    if (!address || typeof address === 'string') return undefined;
    const host = address.address === '0.0.0.0' ? '127.0.0.1' : address.address === '::' ? '[::1]'
        : address.family === 'IPv6' ? `[${address.address}]` : address.address;
    return `http://${host}:${address.port}`;
}

function configuredLocalUrl() {
    return `http://127.0.0.1:${readHttpConfig().port}`;
}

function createWindow(configuration: StationConfiguration | null, store: StationConfigStore) {

    const window = new BrowserWindow({
        width: 1000,
        height: 700,
        fullscreen: true,

        webPreferences: {
            preload: path.join(__dirname, '../preload/preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });

    const session = new TcpSession();
    const baseUrl = configuration?.role === 'main' ? apiUrlFromAddress() : configuration?.serverUrl;
    const lineApi = baseUrl ? createLineApiBridge(baseUrl) : undefined;
    const lineApiWindows = new Set([window.webContents.id]);
    let communicationWindow: BrowserWindow | undefined;
    ipcMain.handle('line:request', (event, method, pathname, body, authorization) => {
        if (!lineApiWindows.has(event.sender.id)) throw new Error('Janela inválida.');
        if (!lineApi) throw new Error('Configure a área deste computador antes de acessar a linha.');
        if (configuration?.role !== 'main' && method !== 'GET') throw new Error('Esta estação permite somente leitura.');
        return lineApi.request(method, pathname, body, authorization);
    });
    ipcMain.handle('communication:open', event => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        if (communicationWindow && !communicationWindow.isDestroyed()) {
            if (communicationWindow.isMinimized()) communicationWindow.restore();
            communicationWindow.show(); communicationWindow.focus(); return;
        }
        communicationWindow = new BrowserWindow({
            show: false, width: 1180, height: 760, minWidth: 760, minHeight: 480,
            title: 'PCM · Comunicação Node ↔ CLP', backgroundColor: '#1a1e22', autoHideMenuBar: true,
            webPreferences: {
                preload: path.join(__dirname, '../preload/preload.js'),
                contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
            }
        });
        const openedWindow = communicationWindow;
        const openedWindowId = openedWindow.webContents.id;
        lineApiWindows.add(openedWindowId);
        openedWindow.on('closed', () => {
            lineApiWindows.delete(openedWindowId);
            if (communicationWindow === openedWindow) communicationWindow = undefined;
        });
        openedWindow.once('ready-to-show', () => {
            if (!openedWindow.isDestroyed()) { openedWindow.center(); openedWindow.show(); }
        });
        void openedWindow.loadFile(path.join(__dirname, '../renderer/modules/line/communication.html'));
    });
    let realtime: RealtimeClient | undefined;
    ipcMain.handle('station:get', event => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        return configuration;
    });
    ipcMain.handle('station:save', async (event, input: StationSetupInput) => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        await store.save(input, configuredLocalUrl());
        setTimeout(() => { app.relaunch(); app.quit(); }, 250);
    });
    ipcMain.handle('station:realtime:start', event => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        if (!configuration || configuration.role === 'main') return;
        realtime ??= new RealtimeClient(window, configuration.serverUrl);
        realtime.start();
    });
    ipcMain.handle('station:realtime:stop', event => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        realtime?.stop();
    });
    ipcMain.handle('station:temperature', event => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        return getSystemTemperature();
    });
    ipcMain.handle('station:close', event => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        setTimeout(() => app.quit(), 50);
    });
    const modbus = new ModbusTestService();
    ipcMain.handle('modbus:execute', (event, action, options) => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        if (configuration?.role !== 'main') throw new Error('Teste Modbus disponível somente no computador Principal.');
        return modbus.execute(action, options);
    });
    const tcp = new TcpService((event) => {
        const entry = session.record(event);
        if (!window.isDestroyed()) window.webContents.send('tcp:event', entry);
    });
    const connectChannel = 'tcp:connect';
    ipcMain.handle(connectChannel, (event, options) => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        tcp.connect(options);
        session.state.options = { host: options.host.trim(), port: options.port };
    });
    ipcMain.handle('tcp:disconnect', (event) => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        tcp.disconnect();
    });
    ipcMain.handle('tcp:saveLog', async (event, content: unknown) => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > 16 * 1024 * 1024) {
            throw new Error('Conteúdo do arquivo inválido ou maior que 16 MB.');
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const result = await dialog.showSaveDialog(window, {
            title: 'Salvar registros do teste TCP/IP',
            defaultPath: path.join(app.getPath('documents'), `testeTcp-${timestamp}.txt`),
            filters: [{ name: 'Arquivo de texto', extensions: ['txt'] }]
        });
        if (result.canceled || !result.filePath) return null;
        await writeFile(result.filePath, content, 'utf8');
        return result.filePath;
    });
    ipcMain.handle('tcp:getState', (event) => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        return session.state;
    });
    ipcMain.handle('tcp:clearLog', (event) => {
        if (event.sender !== window.webContents) throw new Error('Janela inválida.');
        return session.clear();
    });
    window.on('closed', () => {
        if (communicationWindow && !communicationWindow.isDestroyed()) communicationWindow.close();
        realtime?.stop();
        ipcMain.removeHandler('line:request');
        ipcMain.removeHandler('communication:open');
        ipcMain.removeHandler('station:get');
        ipcMain.removeHandler('station:save');
        ipcMain.removeHandler('station:realtime:start');
        ipcMain.removeHandler('station:realtime:stop');
        ipcMain.removeHandler('station:close');
        modbus.dispose();
        ipcMain.removeHandler('modbus:execute');
        tcp.disconnect();
        ipcMain.removeHandler(connectChannel);
        ipcMain.removeHandler('tcp:disconnect');
        ipcMain.removeHandler('tcp:saveLog');
        ipcMain.removeHandler('tcp:getState');
        ipcMain.removeHandler('tcp:clearLog');
    });

    window.loadFile(
        path.join(__dirname, '../index.html')
    );
}

app.whenReady().then(async () => {

    let configuration: StationConfiguration | null = null;
    let store: StationConfigStore;
    try {
        const configDir = app.isPackaged
            ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath('exe')))
            : app.getAppPath();
        const envPath = path.join(configDir, '.env');
        if (existsSync(envPath)) loadEnvFile(envPath);
        process.env.PLC_COMMAND_LOG_DIR ||= path.join(app.getPath('documents'), 'PCM-IHM', 'logs');
        store = new StationConfigStore(app.getPath('userData'), process.env.SETUP_PASSWORD || '123');
        configuration = await store.read();
        if (configuration?.role === 'main') api = await startApi();
    } catch (error) {
        const cause = error as NodeJS.ErrnoException;
        dialog.showErrorBox('Não foi possível iniciar a API', cause.code === 'EADDRINUSE'
            ? 'A porta da API está ocupada. Encerre a outra instância ou altere API_PORT no arquivo .env.'
            : `Verifique a configuração da API. ${cause.message}`);
        app.quit();
        return;
    }

    createWindow(configuration, store!);

    app.on('activate', () => {

        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow(configuration, store!);
        }

    });

});

app.on('before-quit', event => {
    if (!api || shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    void api.stop().catch(error => {
        console.error('Erro ao encerrar a API:', error);
    }).finally(() => app.quit());
});

app.on('window-all-closed', () => {

    if (process.platform !== 'darwin') {
        app.quit();
    }

}); 
