const { ServerTCP } = require('modbus-serial');
const readline = require('node:readline');

const HOST = process.env.IFTS_SIM_HOST || '127.0.0.1';
const PORT = integerEnv('IFTS_SIM_PORT', 1506, 1, 65535);
const UNIT_ID = integerEnv('IFTS_SIM_UNIT_ID', 1, 1, 247);
const START_COIL = 23; // M23: CLP solicita o início do teste IFTS.
const RESULT_COIL = 4; // M4: PCM informa PASS ou FAIL por pulso.
const LINE_COMMANDS = new Map([[20, 'START'], [21, 'STOP (fim de ciclo)'], [22, 'RESET']]);
const coils = new Map();
let startTimer;

function integerEnv(name, fallback, min, max) {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} deve ser inteiro entre ${min} e ${max}.`);
    return value;
}

function setCoil(address, value, source = 'CLP') {
    const previous = coils.get(address) === true;
    coils.set(address, value);
    if (address === START_COIL && previous !== value) {
        console.log(`[${source}] M23 ${value ? 'ATIVO: pedido de START IFTS' : 'INATIVO'}`);
    }
}

function pulseStart() {
    clearTimeout(startTimer);
    setCoil(START_COIL, true);
    startTimer = setTimeout(() => setCoil(START_COIL, false), 700);
}

const server = new ServerTCP({
    getCoil(address) { return coils.get(address) === true; },
    setCoil(address, value) {
        const active = value === true;
        const previous = coils.get(address) === true;
        coils.set(address, active);
        if (address === RESULT_COIL && previous !== active) {
            console.log(`[PCM] M4 ${active ? 'ATIVO: resultado IFTS recebido' : 'INATIVO: pulso de resultado concluído'}`);
        } else if (LINE_COMMANDS.has(address) && previous !== active) {
            console.log(`[PCM] M${address} ${active ? `ATIVO: ${LINE_COMMANDS.get(address)}` : 'INATIVO: pulso concluído'}`);
        } else if (previous !== active) {
            console.log(`[PCM] M${address}=${active ? 1 : 0}`);
        }
    }
}, { host: HOST, port: PORT, unitID: UNIT_ID });

const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
terminal.on('line', raw => {
    const command = raw.trim().toLowerCase();
    if (command === 'start') return pulseStart();
    if (command === 'on') return setCoil(START_COIL, true);
    if (command === 'off') return setCoil(START_COIL, false);
    if (command === 'status') return console.log(`M23=${coils.get(START_COIL) ? 1 : 0} | M4=${coils.get(RESULT_COIL) ? 1 : 0}`);
    if (['help', 'ajuda', '?'].includes(command)) return help();
    if (command) console.log('Comando inválido. Digite help para ver as opções.');
});

function help() {
    console.log('Comandos: start (pulso M23), on (mantém M23=1), off (M23=0), status, help.');
}

server.on('initialized', () => {
    console.log(`Simulador IFTS CLP ativo em ${HOST}:${PORT} · Unit ID ${UNIT_ID}`);
    console.log('M23 inicia o teste; M4 registra o pulso de resultado enviado pelo PCM.');
    help();
});
server.on('socketError', error => console.error(`Conexão Modbus: ${error.message}`));
server.on('serverError', error => {
    console.error(`Não foi possível iniciar: ${error.message}`);
    terminal.close();
    process.exitCode = 1;
});
process.on('SIGINT', () => {
    clearTimeout(startTimer);
    terminal.close();
    server.close();
});
