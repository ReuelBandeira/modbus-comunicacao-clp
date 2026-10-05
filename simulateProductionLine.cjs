const { ServerTCP } = require('modbus-serial');
const readline = require('node:readline');

const UNIT_ID = integerEnv('SIM_UNIT_ID', 1, 1, 247);
const MAILBOX_START = integerEnv('SIM_MAILBOX_START', 0, 0, 65535);
const SERIAL_REGISTERS = integerEnv('SIM_SERIAL_REGISTERS', 32, 1, 117);
const POSITION_REGISTERS = integerEnv('SIM_POSITION_REGISTERS', 4, 1, 117);
const CHIP_POSITION_COUNT = 20;
const PROCESS_MS = integerEnv('SIM_PROCESS_MS', 800, 50, 60000);
const TRANSFER_MS = integerEnv('SIM_TRANSFER_MS', 800, 50, 60000);
const CLEAR_MS = integerEnv('SIM_CLEAR_MS', 500, 50, 60000);
const BYTE_ORDER = process.env.SIM_BYTE_ORDER || 'be';
const WORD_ORDER = process.env.SIM_WORD_ORDER || 'high-low';
let randomFailureEnabled = booleanEnv('SIM_RANDOM_FAILURE', true);
let compatibilityProfile = enumEnv('SIM_COMPATIBILITY_PROFILE', 'current', ['current', 'hardened']);
const ENTRY_SEQUENCE_START = integerEnv('SIM_ENTRY_SEQUENCE_START', 1, 1, 0xffffffff);
let simulatedSequence = ENTRY_SEQUENCE_START;

if (!['be', 'le'].includes(BYTE_ORDER)) throw new Error('SIM_BYTE_ORDER deve ser be ou le.');
if (!['high-low', 'low-high'].includes(WORD_ORDER)) throw new Error('SIM_WORD_ORDER deve ser high-low ou low-high.');

const LENGTH_OFFSET = 2;
const SERIAL_OFFSET = 3;
const POSITION_COUNT_OFFSET = SERIAL_OFFSET + SERIAL_REGISTERS;
const POSITION_START_OFFSET = POSITION_COUNT_OFFSET + 1;
const MAILBOX_SIZE = POSITION_START_OFFSET + POSITION_REGISTERS;
if (MAILBOX_SIZE > 123 || MAILBOX_START + MAILBOX_SIZE > 65536) {
    throw new Error('Mailbox inválido: o bloco precisa caber em uma única FC16.');
}

const configs = [
    endpoint(1, 1502), endpoint(2, 1503), endpoint(3, 1504), endpoint(4, 1505)
];
const positionProfiles = new Map([
    [2, positionsEnv('SIM_M2_POSITIONS')],
    [3, positionsEnv('SIM_M3_POSITIONS')],
    [4, positionsEnv('SIM_M4_POSITIONS')]
]);

let running = false;
let closing = false;
let completedUnits = 0;
let randomScenarioIndex = 0;
const timers = new Set();

function integerEnv(name, fallback, min, max) {
    const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} deve ser inteiro entre ${min} e ${max}.`);
    }
    return value;
}

function booleanEnv(name, fallback) {
    if (process.env[name] === undefined) return fallback;
    const value = process.env[name].trim().toLowerCase();
    if (['1', 'true', 'on', 'sim'].includes(value)) return true;
    if (['0', 'false', 'off', 'nao', 'não'].includes(value)) return false;
    throw new Error(`${name} deve ser true/false, on/off ou 1/0.`);
}

function parseInteger(value, min, max, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${label} deve ser inteiro entre ${min} e ${max}.`);
    }
    return parsed;
}

function enumEnv(name, fallback, allowed) {
    const value = (process.env[name] || fallback).trim().toLowerCase();
    if (!allowed.includes(value)) throw new Error(`${name} deve ser ${allowed.join(' ou ')}.`);
    return value;
}

function shuffledStations(count) {
    return [2, 3, 4].sort(() => Math.random() - 0.5).slice(0, count);
}

function distinctPositions(count) {
    const positions = [];
    while (positions.length < count) {
        const position = 1 + Math.floor(Math.random() * CHIP_POSITION_COUNT);
        if (!positions.includes(position)) positions.push(position);
    }
    return positions;
}

function nextRandomScenario() {
    const scenario = randomScenarioIndex++ % 5;
    if (scenario === 0) return { name: '100% aprovada', failures: [] };
    if (scenario === 1) return { name: 'uma posição em uma estação', failures: [
        { station: shuffledStations(1)[0], position: distinctPositions(1)[0] }
    ] };
    if (scenario === 2) {
        const position = distinctPositions(1)[0];
        return { name: 'a mesma posição em duas estações', failures: shuffledStations(2).map(station => ({ station, position })) };
    }
    if (scenario === 3) {
        const position = distinctPositions(1)[0];
        return { name: 'a mesma posição nas três estações', failures: [2, 3, 4].map(station => ({ station, position })) };
    }
    const stations = shuffledStations(2), positions = distinctPositions(2);
    return { name: 'duas posições distintas', failures: stations.map((station, index) => ({ station, position: positions[index] })) };
}

function endpoint(number, defaultPort) {
    const byteOrder = (process.env[`SIM_M${number}_BYTE_ORDER`] || BYTE_ORDER).toLowerCase();
    if (!['be', 'le'].includes(byteOrder)) throw new Error(`SIM_M${number}_BYTE_ORDER deve ser be ou le.`);
    return {
        number,
        host: process.env[`SIM_M${number}_HOST`] || '127.0.0.1',
        port: integerEnv(`SIM_M${number}_PORT`, defaultPort, 1, 65535),
        byteOrder
    };
}

function parsePositions(text) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('Informe posições como 1,1,0,1.');
    const result = text.split(',').map(item => {
        const normalized = item.trim().toLowerCase();
        if (['1', 'true', 'ok'].includes(normalized)) return true;
        if (['0', 'false', 'nok', 'nao', 'não'].includes(normalized)) return false;
        throw new Error(`Posição inválida: ${item}. Use 1/0 ou true/false.`);
    });
    if (result.length !== CHIP_POSITION_COUNT) {
        throw new Error(`Informe exatamente ${CHIP_POSITION_COUNT} posições.`);
    }
    return result;
}

function positionsEnv(name) {
    return parsePositions(process.env[name] || Array(CHIP_POSITION_COUNT).fill('1').join(','));
}

function modbusError(code, message) {
    throw { modbusErrorCode: code, message };
}

function later(action, delay = TRANSFER_MS) {
    const timer = setTimeout(() => {
        timers.delete(timer);
        if (!closing) action();
    }, delay);
    timers.add(timer);
}

function encodeSequence(value) {
    const high = Math.floor(value / 0x10000), low = value & 0xffff;
    return WORD_ORDER === 'high-low' ? [high, low] : [low, high];
}

function decodeSequence(values) {
    const [high, low] = WORD_ORDER === 'high-low' ? values : [values[1], values[0]];
    return high * 0x10000 + low;
}

function encodeSerial(text, byteOrder = BYTE_ORDER) {
    const source = Buffer.from(text, 'utf8');
    if (!source.length || source.length > SERIAL_REGISTERS * 2) {
        throw new Error(`QR excede a capacidade de ${SERIAL_REGISTERS * 2} bytes.`);
    }
    const bytes = Buffer.alloc(SERIAL_REGISTERS * 2); source.copy(bytes);
    return { length: source.length, registers: Array.from({ length: SERIAL_REGISTERS }, (_, index) =>
        byteOrder === 'be' ? bytes.readUInt16BE(index * 2) : bytes.readUInt16LE(index * 2)) };
}

function decodeSerial(registers, length, byteOrder = BYTE_ORDER) {
    const bytes = Buffer.alloc(registers.length * 2);
    registers.forEach((value, index) => byteOrder === 'be'
        ? bytes.writeUInt16BE(value, index * 2) : bytes.writeUInt16LE(value, index * 2));
    return bytes.subarray(0, length).toString('utf8');
}

function encodePositionRegisters(positions) {
    const registers = Array(POSITION_REGISTERS).fill(0);
    positions.forEach((value, index) => {
        if (value) registers[Math.floor(index / 16)] |= 1 << (index % 16);
    });
    return registers;
}

function encodeMailbox(unit, positions, byteOrder = BYTE_ORDER) {
    const result = new Uint16Array(MAILBOX_SIZE);
    const sequence = encodeSequence(unit.sequence), serial = encodeSerial(unit.serial, byteOrder);
    result[0] = sequence[0]; result[1] = sequence[1]; result[LENGTH_OFFSET] = serial.length;
    result.set(serial.registers, SERIAL_OFFSET);
    result[POSITION_COUNT_OFFSET] = positions.length;
    result.set(encodePositionRegisters(positions), POSITION_START_OFFSET);
    return result;
}

class SimulatedStation {
    memory = new Uint16Array(MAILBOX_SIZE);
    state = 'idle';
    requestQr = false;
    exitConfirmed = false;
    unit = undefined;
    faults = {
        network: false, communication: false, delayMs: 0, partialMailbox: false, sequenceDelta: 0,
        serialSuffix: '', rejectAck: false, holdExit: false, holdClear: false, stuckExit: false
    };
    delayedUnit = undefined;
    server;

    constructor(config) {
        this.config = config;
        this.vector = {
            getHoldingRegister: address => this.readOne(address),
            getMultipleHoldingRegisters: (address, length) => this.readMany(address, length),
            setRegisterArray: (address, values) => this.receiveWrite(address, values)
        };
        if (config.number === 1) this.vector.getCoil = address => this.readCoil(address);
        this.openServer();
    }

    openServer() {
        if (closing || this.faults.network || this.server) return;
        const config = this.config;
        this.server = new ServerTCP(this.vector, { host: config.host, port: config.port, unitID: UNIT_ID });
        this.server.on('initialized', () => {
            const visibleRegisters = config.number === 1 ? SERIAL_REGISTERS : MAILBOX_SIZE;
            log(config.number,
                `ONLINE em ${config.host}:${config.port}, Unit ID ${UNIT_ID}, HR${MAILBOX_START}..HR${MAILBOX_START + visibleRegisters - 1}, bytes=${config.byteOrder.toUpperCase()}`);
        });
        this.server.on('socketError', error => log(config.number, `conexão: ${error.message}`));
        this.server.on('serverError', error => log(config.number, `servidor: ${error.message}`));
    }

    setNetworkFailure(enabled) {
        this.faults.network = enabled;
        if (enabled) {
            const server = this.server; this.server = undefined;
            if (server) server.close(() => {
                log(this.config.number, 'FALHA: endpoint TCP fechado, simulando perda física de conexão');
                if (!this.faults.network) this.openServer();
            });
        } else {
            this.openServer();
            log(this.config.number, 'endpoint TCP solicitado novamente; aguardando ONLINE');
        }
    }

    offset(address) { return address - MAILBOX_START; }
    empty(values = this.memory) { return Array.from(values).every(value => value === 0); }

    ensureCommunication() {
        if (this.faults.communication) return modbusError(4, `M${this.config.number} indisponível por falha simulada.`);
    }

    readCoil(address) {
        this.ensureCommunication();
        if (address === 0) return this.requestQr;
        if (address === 1) return this.exitConfirmed;
        return modbusError(2, 'Somente as Coils REQUEST_QR 0 e CONFIRMAR_SAIDA 1 estão disponíveis.');
    }

    readOne(address) {
        this.ensureCommunication();
        const offset = this.offset(address);
        if (offset < 0 || offset >= MAILBOX_SIZE) return modbusError(2, 'Register fora do mailbox.');
        return this.memory[offset];
    }

    readMany(address, length) {
        this.ensureCommunication();
        const offset = this.offset(address);
        if (offset < 0 || length < 1 || offset + length > MAILBOX_SIZE) return modbusError(2, 'Faixa FC03 fora do mailbox.');
        return Array.from(this.memory.slice(offset, offset + length));
    }

    receiveWrite(address, values) {
        this.ensureCommunication();
        const expectedLength = this.config.number === 1 ? SERIAL_REGISTERS : MAILBOX_SIZE;
        if (address !== MAILBOX_START || values.length !== expectedLength) {
            return modbusError(2, `FC16 deve cobrir os ${expectedLength} registers esperados pela M${this.config.number}.`);
        }
        if (this.config.number === 1) this.receiveM1Payload(values);
        else this.receiveAck(values);
    }

    receiveM1Payload(values) {
        if (this.state !== 'requesting' || !this.requestQr || !this.empty()) {
            return modbusError(3, 'M1 não aguarda QR ou o mailbox está ocupado.');
        }
        const incoming = Uint16Array.from(values);
        const decoded = decodeSerial(Array.from(incoming), SERIAL_REGISTERS * 2, this.config.byteOrder);
        const serial = decoded.replace(/\0+$/, '');
        const length = Buffer.byteLength(serial, 'utf8');
        const sequence = simulatedSequence++;
        if (length < 1 || length > SERIAL_REGISTERS * 2) return modbusError(3, 'QR vazio ou inválido.');
        if (!serial || Buffer.byteLength(serial, 'utf8') !== length) return modbusError(3, 'QR inválido ou incompleto.');
        const scenario = randomFailureEnabled ? nextRandomScenario() : { name: 'perfil manual', failures: [] };
        this.memory.fill(0); this.memory.set(incoming); this.unit = { sequence, serial, failures: scenario.failures,
            generatedProfile: randomFailureEnabled }; this.requestQr = false; this.state = 'processing';
        log(1, `recebeu sequence=${sequence}, QR=${serial}; processando por ${PROCESS_MS} ms`);
        if (randomFailureEnabled) log(1, `cenário aleatório: ${scenario.name}${scenario.failures.length ? `; falhas: ${scenario.failures.map(failure =>
            `M${failure.station} posição ${failure.position}`).join(' e ')}` : ''}`);
        later(() => this.beginM1Exit(), PROCESS_MS);
    }

    beginM1Exit() {
        if (this.config.number !== 1 || !this.unit || !['processing', 'blocked-exit'].includes(this.state)) return;
        if (this.faults.holdExit) {
            this.state = 'blocked-exit';
            log(1, `FALHA: saída retida para sequence=${this.unit.sequence}; Coil 1 permanece FALSE`);
            return;
        }
        const unit = this.unit;
        this.exitConfirmed = true; this.state = 'confirming-exit';
        log(1, `CONFIRMAR_SAIDA=TRUE para sequence=${unit.sequence}`);
        if (compatibilityProfile === 'current') this.clearM1Memory();
        else later(() => this.clearM1Memory(), CLEAR_MS);
    }

    clearM1Memory() {
        if (this.config.number !== 1 || !this.unit || !['confirming-exit', 'blocked-clear'].includes(this.state)) return;
        if (this.faults.holdClear) {
            this.state = 'blocked-clear';
            log(1, `FALHA: HR${MAILBOX_START}–HR${MAILBOX_START + SERIAL_REGISTERS - 1} não foram zerados`);
            return;
        }
        const unit = this.unit;
        this.memory.fill(0); this.state = 'confirming-exit';
        log(1, `serial zerado pela CLP para sequence=${unit.sequence}`);
        later(() => this.finishM1Exit(unit));
    }

    finishM1Exit(unit) {
        if (this.config.number !== 1 || this.unit !== unit || this.state !== 'confirming-exit') return;
        if (!this.faults.stuckExit) this.exitConfirmed = false;
        this.unit = undefined; this.state = 'idle';
        log(1, this.faults.stuckExit
            ? `FALHA: Coil 1 permaneceu TRUE após sequence=${unit.sequence}`
            : `CONFIRMAR_SAIDA=FALSE para sequence=${unit.sequence}`);
        later(() => stations[1].publish(unit));
    }

    receiveAck(values) {
        if (!this.empty(values)) return modbusError(3, `M${this.config.number} aceita somente zeros como ACK.`);
        if (this.faults.rejectAck) return modbusError(4, `M${this.config.number} rejeitou o ACK por falha simulada.`);
        const unit = this.unit;
        this.memory.fill(0); this.unit = undefined; this.state = 'idle';
        if (!unit) { log(this.config.number, 'ACK zerado recebido sem unidade pendente'); return; }
        log(this.config.number, `ACK do PCM recebido para sequence=${unit.sequence}`);
        if (this.config.number < 4) later(() => stations[this.config.number].publish(unit));
        else {
            completedUnits++;
            log(4, `linha concluída para sequence=${unit.sequence}; total=${completedUnits}`);
            if (running) later(() => stations[0].requestNext());
        }
    }

    requestNext() {
        if (this.config.number !== 1 || !running || this.state !== 'idle' || !this.empty()) return;
        this.requestQr = true; this.state = 'requesting';
        log(1, 'REQUEST_QR=TRUE; aguardando o próximo bip disponível no PCM');
    }

    publish(unit, afterDelay = false) {
        if (this.config.number === 1) throw new Error('M1 recebe o mailbox do PCM.');
        if (!afterDelay && this.faults.delayMs > 0) {
            this.delayedUnit = unit; this.state = 'delayed';
            log(this.config.number, `ATRASO: publicação de sequence=${unit.sequence} em ${this.faults.delayMs} ms`);
            later(() => {
                if (this.delayedUnit !== unit) return;
                this.delayedUnit = undefined; this.state = 'idle'; this.publish(unit, true);
            }, this.faults.delayMs);
            return;
        }
        if (this.state !== 'idle' || !this.empty()) {
            log(this.config.number, `mailbox ocupado; transferência de sequence=${unit.sequence} não realizada`);
            return;
        }
        const profile = positionProfiles.get(this.config.number);
        const positions = unit.generatedProfile ? profile.map(() => true) : [...profile];
        for (const failure of unit.failures || []) {
            if (failure.station === this.config.number) positions[failure.position - 1] = false;
        }
        const publishedSequence = Math.max(0, Math.min(0xffffffff, unit.sequence + this.faults.sequenceDelta));
        const published = { ...unit, sequence: publishedSequence,
            serial: `${unit.serial}${this.faults.serialSuffix}` };
        if (this.faults.partialMailbox) {
            this.memory.fill(0); this.memory[0] = encodeSequence(published.sequence)[0] || 1;
            this.unit = unit; this.state = 'waiting-ack';
            log(this.config.number, `FALHA: publicou mailbox parcial para sequence=${published.sequence}`);
            return;
        }
        this.memory.set(encodeMailbox(published, positions, this.config.byteOrder)); this.unit = unit; this.state = 'waiting-ack';
        log(this.config.number, `publicou sequence=${published.sequence}, QR=${published.serial}, posições=[${positions.map(Number).join(',')}]`);
    }

    setFault(name, value) {
        const booleanFaults = {
            comunicacao: 'communication', parcial: 'partialMailbox', ack: 'rejectAck',
            saida: 'holdExit', limpeza: 'holdClear', 'coil-presa': 'stuckExit'
        };
        if (name === 'rede') this.setNetworkFailure(value === 'on');
        else if (name in booleanFaults) this.faults[booleanFaults[name]] = value === 'on';
        else if (name === 'atraso') this.faults.delayMs = parseInteger(value, 0, 600000, 'atraso');
        else if (name === 'sequencia') this.faults.sequenceDelta = parseInteger(value, -1000000, 1000000, 'sequencia');
        else if (name === 'qr') this.faults.serialSuffix = value === 'off' ? '' : value;
        else throw new Error('Falha inválida. Use rede, comunicacao, atraso, parcial, sequencia, qr, ack, saida, limpeza ou coil-presa.');
        log(this.config.number, `falha ${name} configurada como ${value}`);
        if (name === 'saida' && value === 'off') this.beginM1Exit();
        if (name === 'limpeza' && value === 'off') this.clearM1Memory();
    }

    republish() {
        if (this.config.number === 1) throw new Error('A M1 recebe o QR do PCM e não pode republicar resultado.');
        if (!this.unit) throw new Error(`M${this.config.number} não possui bandeja pendente para republicar.`);
        const unit = this.unit;
        this.memory.fill(0); this.unit = undefined; this.delayedUnit = undefined; this.state = 'idle';
        this.publish(unit, true);
    }

    reset() {
        this.memory.fill(0); this.requestQr = false; this.exitConfirmed = false; this.unit = undefined;
        this.delayedUnit = undefined; this.state = 'idle';
    }

    clearFaults() {
        this.faults = {
            ...this.faults, communication: false, delayMs: 0, partialMailbox: false, sequenceDelta: 0,
            serialSuffix: '', rejectAck: false, holdExit: false, holdClear: false, stuckExit: false
        };
        if (this.faults.network) this.setNetworkFailure(false);
    }

    close() { const server = this.server; this.server = undefined; server?.close(); }
}

function log(machine, message) {
    console.log(`${new Date().toLocaleTimeString('pt-BR')} [M${machine}] ${message}`);
}

const stations = configs.map(config => new SimulatedStation(config));
const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

function help() {
    console.log(`
Comandos:
  start                         Inicia o ciclo autônomo M1 → M2 → M3 → M4
  stop                          Impede a solicitação de uma nova bandeja
  status                        Mostra o estado das quatro estações
  perfil <atual|robusto>        Alterna somente o tempo do handshake, sem mudar o mapa Modbus
  bytes <m1..m4> <ab|ba>        Define a ordem de bytes individual da estação
  aleatorio <on|off>            Liga/desliga o ciclo dos cinco cenários automáticos
  posicoes <m2|m3|m4> <lista>  Define os resultados dos chips
  falha <m1..m4> <tipo> <valor> Injeta ou remove uma falha controlada
  republicar <m2|m3|m4>         Reescreve a bandeja pendente após corrigir uma falha
  falhas                        Mostra as falhas ativas em cada estação
  reset                         Limpa todas as memórias (use com o fluxo parado)
  help                          Exibe esta ajuda
  quit                          Encerra o simulador

Exemplos:
  posicoes m2 1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1
  posicoes m3 1,1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1
  perfil robusto
  bytes m1 ba
  bytes m2 ab
  falha m2 comunicacao on
  falha m2 comunicacao off
  falha m3 sequencia 1
  falha m3 sequencia 0
  falha m1 limpeza on
  falha m1 limpeza off
  aleatorio off
  start
`);
}

terminal.on('line', line => {
    const [command = '', target, values, extra] = line.trim().split(/\s+/, 4);
    try {
        if (command.toLowerCase() === 'start') {
            if (running) return console.log('O fluxo autônomo já está ativo.');
            running = true; console.log('Fluxo autônomo iniciado. Faça o bip no PCM.'); stations[0].requestNext();
        } else if (command.toLowerCase() === 'stop') {
            running = false;
            if (stations[0].state === 'requesting') stations[0].reset();
            console.log('Novas solicitações pausadas; operações já publicadas continuam aguardando ACK.');
        } else if (command.toLowerCase() === 'status') {
            stations.forEach(station => console.log(`M${station.config.number} ${station.config.host}:${station.config.port} | bytes=${station.config.byteOrder.toUpperCase()} | ${station.state} | ${station.empty() ? 'vazio' : 'ocupado'}${station.unit ? ` | seq=${station.unit.sequence}` : ''}`));
            console.log(`Automático=${running} | perfil=${compatibilityProfile === 'current' ? 'atual' : 'robusto'} | falha aleatória=${randomFailureEnabled} | unidades concluídas=${completedUnits}`);
        } else if (command.toLowerCase() === 'perfil') {
            const profile = (target || '').toLowerCase();
            if (!['atual', 'robusto', 'current', 'hardened'].includes(profile)) throw new Error('Use: perfil <atual|robusto>');
            compatibilityProfile = ['robusto', 'hardened'].includes(profile) ? 'hardened' : 'current';
            console.log(`Perfil ${compatibilityProfile === 'current' ? 'ATUAL' : 'ROBUSTO'} ativo. O mapa e os dados Modbus permanecem iguais.`);
        } else if (command.toLowerCase() === 'bytes') {
            const match = /^m([1-4])$/i.exec(target || ''), order = (values || '').toLowerCase();
            if (!match || !['ab', 'ba', 'be', 'le'].includes(order)) throw new Error('Use: bytes <m1|m2|m3|m4> <ab|ba>');
            const station = stations[Number(match[1]) - 1];
            if (station.state !== 'idle' || !station.empty()) throw new Error(`M${station.config.number} precisa estar ociosa e com memória vazia.`);
            station.config.byteOrder = ['ab', 'be'].includes(order) ? 'be' : 'le';
            console.log(`M${station.config.number}: ordem ${station.config.byteOrder === 'be' ? 'AB' : 'BA'} configurada.`);
        } else if (command.toLowerCase() === 'aleatorio') {
            if (!['on', 'off'].includes((target || '').toLowerCase())) throw new Error('Use: aleatorio <on|off>');
            randomFailureEnabled = target.toLowerCase() === 'on';
            if (randomFailureEnabled) randomScenarioIndex = 0;
            console.log(`Cenários aleatórios ${randomFailureEnabled ? 'ativados; a próxima bandeja será 100% aprovada' : 'desativados; serão usados os perfis manuais'}.`);
        } else if (command.toLowerCase() === 'posicoes') {
            const match = /^m([234])$/i.exec(target || '');
            if (!match || !values) throw new Error('Use: posicoes <m2|m3|m4> <1,1,0,...>');
            const machine = Number(match[1]), parsed = parsePositions(values);
            positionProfiles.set(machine, parsed);
            console.log(`M${machine}: 20 posições configuradas [${parsed.map(Number).join(',')}].${randomFailureEnabled ? ' O perfil será usado quando o modo aleatório for desligado.' : ''}`);
        } else if (command.toLowerCase() === 'falha') {
            const match = /^m([1-4])$/i.exec(target || '');
            if (!match || !values || extra === undefined) throw new Error('Use: falha <m1|m2|m3|m4> <tipo> <valor>');
            const station = stations[Number(match[1]) - 1], name = values.toLowerCase(), value = extra.toLowerCase();
            if (['rede', 'comunicacao', 'parcial', 'ack', 'saida', 'limpeza', 'coil-presa'].includes(name) && !['on', 'off'].includes(value)) {
                throw new Error(`${name}: use on ou off.`);
            }
            if (station.config.number !== 1 && ['saida', 'limpeza', 'coil-presa'].includes(name)) {
                throw new Error(`${name} está disponível somente para a M1.`);
            }
            if (station.config.number === 1 && ['parcial', 'sequencia', 'qr', 'ack'].includes(name)) {
                throw new Error(`${name} está disponível somente para M2, M3 ou M4.`);
            }
            station.setFault(name, value);
        } else if (command.toLowerCase() === 'falhas') {
            if ((target || '').toLowerCase() === 'limpar') {
                stations.forEach(station => station.clearFaults());
                console.log('Todas as injeções de falha foram desativadas. Use reset separadamente para limpar memórias ocupadas.');
            } else stations.forEach(station => console.log(`M${station.config.number}: ${JSON.stringify(station.faults)}`));
        } else if (command.toLowerCase() === 'republicar') {
            const match = /^m([234])$/i.exec(target || '');
            if (!match) throw new Error('Use: republicar <m2|m3|m4>');
            stations[Number(match[1]) - 1].republish();
        } else if (command.toLowerCase() === 'reset') {
            if (running) throw new Error('Execute "stop" antes do reset.');
            timers.forEach(clearTimeout); timers.clear(); stations.forEach(station => station.reset()); completedUnits = 0; randomScenarioIndex = 0;
            console.log('Memórias e estados das quatro estações foram zerados.');
        } else if (command.toLowerCase() === 'help' || !command) help();
        else if (['quit', 'exit'].includes(command.toLowerCase())) shutdown();
        else console.log(`Comando desconhecido: ${command}. Use "help".`);
    } catch (error) { console.error(`ERRO: ${error.message}`); }
});

function shutdown() {
    if (closing) return;
    closing = true; running = false; timers.forEach(clearTimeout); timers.clear(); terminal.close(); stations.forEach(station => station.close());
    console.log('Simulador da linha encerrado.');
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('Simulador autônomo da linha com quatro estações. Aguarde os endpoints ONLINE e digite "start".');
help();
