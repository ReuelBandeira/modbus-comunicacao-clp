// Executar com Electron. Usa uma janela oculta e collections temporárias no MongoDB.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdir, writeFile } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { buildMongoUri } = require('../dist/database/mongo');
const { pcmIndexes } = require('../dist/modules/pcm/models/pcmModel');
const { lineIndexes } = require('../dist/modules/machines/models/lineModel');
const { LineRepository } = require('../dist/modules/machines/repositories/lineRepository');
const { PcmRepository } = require('../dist/modules/pcm/repositories/pcmRepository');
const { PcmWorkflowRepository } = require('../dist/modules/pcm/repositories/pcmWorkflowRepository');
const { LineCoordinatorService } = require('../dist/modules/pcm/workflow/services/lineCoordinatorService');
const { createApp } = require('../dist/api/app');
const { createLineApiBridge } = require('../dist/main/lineApiBridge');

let window, server, client;
const created = [];
app.setPath('userData', path.resolve(__dirname, '../out/line-ui/profile'));
app.commandLine.appendSwitch('disable-gpu');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
    if (process.env.PCM_TEST_MONGO !== 'true') throw new Error('Defina PCM_TEST_MONGO=true para o teste visual com banco isolado.');
    const envPath = path.resolve(__dirname, '../.env');
    if (existsSync(envPath)) process.loadEnvFile(envPath);
    client = new MongoClient(buildMongoUri(), { serverSelectionTimeoutMS: 5000 }); await client.connect();
    const db = client.db(process.env.MONGO_DATABASE), prefix = `test_ui_${randomUUID().replaceAll('-', '')}`;
    async function collection(suffix) {
        const name = `${prefix}_${suffix}`; await db.createCollection(name); created.push(name); return db.collection(name);
    }
    const pcms = await collection('pcms'), lines = await collection('lines'), counters = await collection('counters');
    await pcms.createIndexes(pcmIndexes); await lines.createIndexes(lineIndexes);
    const coordinator = new LineCoordinatorService(new LineRepository(lines, counters), new PcmWorkflowRepository(pcms), 'linha-01');
    server = createApp(new PcmRepository(pcms), coordinator).listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = createLineApiBridge(base);
    ipcMain.handle('line:request', (_event, method, url, body) => api.request(method, url, body));
    const errors = [];
    function newWindow(withPreload) {
        const win = new BrowserWindow({ show: false, width: 1360, height: 1100,
            webPreferences: { backgroundThrottling: false, ...(withPreload ? { preload: path.resolve(__dirname, '../dist/preload/preload.js') } : {}) } });
        win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
        return win;
    }
    window = newWindow(false);
    const run = code => window.webContents.executeJavaScript(code, true);
    const wait = async (condition, label) => {
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) {
            if (await run(condition)) return;
            await new Promise(resolve => setTimeout(resolve, 80));
        }
        throw new Error(`Timeout: ${label}. ${await run('document.getElementById("notice").textContent')}`);
    };
    const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const fill = (selector, value) => run(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const enabled = id => wait(`!document.getElementById(${JSON.stringify(id)}).disabled`, id);
    const screenshot = async name => {
        const folder = path.resolve(__dirname, '../out/line-ui'); await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, name), (await window.webContents.capturePage()).toPNG());
    };
    await window.loadURL(base + '/line/');
    await wait('document.getElementById("sync-status").textContent.includes("não cadastrada")', 'estado vazio');
    assert.equal(await run('document.getElementById("machines-panel").hidden'), false);
    assert.equal(await run('document.getElementById("overview-tab").disabled'), true);
    assert.equal(await run('getComputedStyle(document.querySelector(".top-bar")).height'), '70px');
    assert.equal(await run('getComputedStyle(document.querySelector(".nav-button")).height'), '50px');
    assert.equal(await run('getComputedStyle(document.querySelector("main")).overflow'), 'hidden');
    assert.equal(await run('getComputedStyle(document.querySelector("#machines-panel > .panel")).overflow'), 'auto');
    await click('#machines-tab');
    await fill('#config-name', 'Linha de montagem · PCM');
    await fill('[data-index="0"] [data-field="host"]', '192.168.1.25');
    await click('#add-machine'); await fill('[data-index="1"] [data-field="host"]', '192.168.1.35');
    await click('#add-machine'); await fill('[data-index="2"] [data-field="host"]', '192.168.1.45');
    await click('#save-config');
    await wait('document.getElementById("revision-label").textContent === "Revisão 1"', 'cadastro salvo');
    assert.equal((await lines.findOne({ lineId: 'linha-01' })).machines.length, 3);
    await fill('[data-index="0"] [data-field="name"]', 'Entrada e identificação');
    await click('#refresh'); await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await run(`document.querySelector('[data-index="0"] [data-field="name"]').value`), 'Entrada e identificação');
    await click('#save-config'); await wait('document.getElementById("revision-label").textContent === "Revisão 2"', 'edição salva');
    await screenshot('machines.png');
    await click('#simulation-tab');
    async function scan(serial, total) {
        await enabled('scan-submit'); await fill('#scan-serial', serial); await click('#scan-submit');
        await wait(`document.getElementById('metric-total').textContent === '${total}'`, 'bip ' + serial);
    }
    await scan('BANDEJA-A', 1); await scan('BANDEJA-B', 2);
    await enabled('scan-submit');
    await wait(`document.activeElement?.id === 'scanner-capture'`, 'foco do scanner');
    for (const key of 'BANDEJA-SCANNER') {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
        window.webContents.sendInputEvent({ type: 'char', keyCode: key });
        window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    }
    await wait(`document.getElementById('metric-total').textContent === '3'`, 'leitura do scanner');
    assert.equal(await run('document.getElementById("save-config").disabled'), true);
    await enabled('sim-arrival'); await click('#sim-arrival');
    await wait('document.getElementById("sim-current").textContent.includes("BANDEJA-A")', 'chegada A');
    await enabled('sim-ok'); await click('#sim-ok'); await enabled('sim-passage'); await click('#sim-passage');
    await wait('!document.getElementById("sim-current").textContent.includes("BANDEJA-A")', 'passagem m1');
    await fill('#sim-machine', 'm2'); await enabled('sim-arrival'); await click('#sim-arrival');
    await wait('document.getElementById("sim-current").textContent.includes("BANDEJA-A")', 'chegada m2');
    await enabled('sim-no'); await click('#sim-no'); await enabled('sim-passage');
    // B pode iniciar na primeira estação enquanto A espera passagem na segunda.
    await fill('#sim-machine', 'm1'); await click('#sim-arrival');
    await wait('document.getElementById("sim-current").textContent.includes("BANDEJA-B")', 'chegada B');
    assert.equal(await run('document.getElementById("overview-tab").disabled'), true);
    await click('#overview-tab');
    assert.equal(await run('document.getElementById("overview-panel").hidden'), true);
    await screenshot('simulation.png');
    await click('#simulation-tab'); await fill('#sim-machine', 'm2'); await enabled('sim-passage'); await click('#sim-passage');
    await enabled('sim-arrival'); await fill('#sim-machine', 'm3'); await click('#sim-arrival');
    await wait('document.getElementById("sim-current").textContent.includes("Bypass")', 'bypass');
    assert.equal(await run('document.getElementById("sim-ok").disabled'), true);
    await enabled('sim-passage'); await click('#sim-passage');
    await wait('document.getElementById("metric-completed").textContent === "1"', 'conclusão A');
    const a = await pcms.findOne({ serialNumber: 'BANDEJA-A' });
    assert.equal(a.workflow.quality, 'rejected'); assert.equal(a.workflow.stages[2].state, 'skipped');
    // A página local usa o preload real e a ponte IPC para a mesma API, sem CORS liberado.
    window.destroy(); window = newWindow(true);
    await window.loadFile(path.resolve(__dirname, '../dist/renderer/modules/line/line.html'));
    await wait('document.getElementById("metric-total").textContent === "2"', 'Electron com preload');
    assert.equal(await run('typeof window.lineApi.request'), 'function');
    window.setSize(620, 1100); await new Promise(resolve => setTimeout(resolve, 100));
    await screenshot('mobile.png');
    assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'), true);
    // Indisponibilidade da API é apresentada como dado desatualizado, sem apagar o último estado.
    await new Promise(resolve => server.close(resolve)); server = undefined;
    await click('#refresh');
    await wait('document.getElementById("sync-status").textContent.includes("Sem atualização")', 'offline');
    assert.equal(await run('document.getElementById("metric-total").textContent'), '2');
    assert.equal(await run('document.getElementById("scan-submit").disabled'), true);
    assert.equal(errors.filter(message => !/ERR_CONNECTION_REFUSED|Content-Security-Policy/.test(message)).length, 0, errors.join('\n'));
    console.log('PASS: cadastro, edição, polling, bipagem, estações, reprovação, bypass, histórico, IPC Electron e estado offline.');
    console.log('Capturas: out/line-ui/');
}).then(() => cleanup(0), error => { console.error(error); return cleanup(1); });

async function cleanup(code) {
    try {
        if (window && !window.isDestroyed()) window.destroy();
        if (server) await new Promise(resolve => server.close(resolve));
        if (client) { for (const name of created) await client.db(process.env.MONGO_DATABASE).collection(name).drop(); await client.close(); }
    } catch (error) { console.error('Falha ao limpar collections temporárias:', error.message); code = 1; }
    app.exit(code);
}
