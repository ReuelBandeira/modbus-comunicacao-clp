const { rmSync } = require('node:fs');
const path = require('node:path');

const project = path.resolve(__dirname, '..');
const target = path.resolve(project, 'dist');
if (path.dirname(target) !== project || path.basename(target) !== 'dist') {
    throw new Error('Diretório de build fora do projeto.');
}
// Remove somente a saída gerada, para não empacotar módulos excluídos do src.
rmSync(target, { recursive: true, force: true });
