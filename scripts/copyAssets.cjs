const { cpSync } = require('node:fs');
const path = require('node:path');

const projectDir = path.resolve(__dirname, '..');

// Copia as telas e os estilos mantendo os caminhos usados pelo Electron.
cpSync(path.join(projectDir, 'src'), path.join(projectDir, 'dist'), {
    recursive: true,
    filter: (source) => !source.endsWith('.ts')
});
