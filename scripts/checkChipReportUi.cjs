const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');

let window;
app.setPath('userData', path.resolve(__dirname, '../out/chip-report/profile'));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});

function summary(produced, approved, rejected, indeterminate = 0) {
    return { produced, approved, rejected, indeterminate,
        approvalRate: produced ? Math.round(approved / produced * 10000) / 100 : null,
        averageCycleTimeMs: produced ? 425000 : null, traysWithoutPositions: 0 };
}

app.whenReady().then(async () => {
    const now = new Date(), hour = new Date(now); hour.setMinutes(0, 0, 0);
    const last24Hours = Array.from({ length: 24 }, (_, index) => {
        const produced = index % 5 === 0 ? 0 : 36 + index * 3;
        const rejected = produced ? index % 4 : 0;
        return { hourStart: new Date(hour.getTime() - (23 - index) * 3600000).toISOString(),
            ...summary(produced, produced - rejected, rejected) };
    });
    const report = { unit: 'chips', generatedAt: now.toISOString(),
        currentHour: { from: hour.toISOString(), to: new Date(hour.getTime() + 3600000).toISOString(), summary: summary(148, 143, 5) },
        period: { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), to: now.toISOString(), summary: summary(1280, 1244, 34, 2) },
        periodHourly: last24Hours.slice(-12), last24Hours };
    ipcMain.handle('line:request', (_event, method, url) => {
        assert.equal(method, 'GET');
        if (url === '/api/line-context') return { httpStatus: 200, status: 'OK', data: { entryLineId: 'linha-01' } };
        if (url.startsWith('/api/lines/linha-01/chip-metrics?')) return { httpStatus: 200, status: 'OK', data: report };
        throw new Error(`Rota inesperada: ${url}`);
    });
    const errors = [];
    window = new BrowserWindow({ show: false, width: 1440, height: 980,
        webPreferences: { backgroundThrottling: false, preload: path.resolve(__dirname, '../dist/preload/preload.js') } });
    window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
    await window.loadFile(path.resolve(__dirname, '../dist/renderer/modules/line/relatorios.html'));
    const run = code => window.webContents.executeJavaScript(code, true);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await run('document.getElementById("period-produced").textContent !== "1.280"')) {
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(await run('document.getElementById("current-produced").textContent'), '148');
    assert.equal(await run('document.getElementById("period-produced").textContent'), '1.280');
    assert.equal(await run('document.querySelectorAll("#trend-chart .hour-column").length'), 24);
    assert.equal(await run('getComputedStyle(document.querySelector(".top-bar")).height'), '70px');
    assert.equal(await run('getComputedStyle(document.querySelector(".bottom-nav")).height'), '75px');
    assert.deepEqual(errors, []);
    const folder = path.resolve(__dirname, '../out/chip-report'); await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, 'dashboard.png'), (await window.webContents.capturePage()).toPNG());
    console.log('PASS: relatório de chips renderizado com cards, gráfico, histórico e moldura padronizada.');
    console.log('Captura: out/chip-report/dashboard.png');
    app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
