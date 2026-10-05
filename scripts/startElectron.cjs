const { spawn } = require('node:child_process');
const path = require('node:path');

const projectDirectory = path.resolve(__dirname, '..');
const electronExecutable = require('electron');
const environment = { ...process.env };

// Alguns terminais e agentes de desenvolvimento definem esta variável para
// executar o binário do Electron como Node. A aplicação precisa do runtime
// gráfico normal para disponibilizar app, BrowserWindow e ipcMain.
delete environment.ELECTRON_RUN_AS_NODE;

const child = spawn(electronExecutable, ['.'], {
    cwd: projectDirectory,
    env: environment,
    stdio: 'inherit'
});

child.once('error', error => {
    console.error('Não foi possível iniciar o Electron:', error.message);
    process.exitCode = 1;
});
child.once('exit', code => { process.exitCode = code ?? 1; });
