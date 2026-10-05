const { ServerTCP } = require('modbus-serial');
const fsp = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const UNIT_ID = integerEnv('SIM_UNIT_ID', 1, 1, 247);
const MAILBOX_START = integerEnv('SIM_MAILBOX_START', 0, 0, 65535);
const SERIAL_REGISTERS = integerEnv('SIM_SERIAL_REGISTERS', 32, 1, 117);
const POSITION_REGISTERS = integerEnv('SIM_POSITION_REGISTERS', 4, 1, 117);
const CHIP_POSITION_COUNT = 20;
const configuredMemoryStation = /^m([2-4])$/i.exec(process.env.IFTS_MEMORY_MACHINE_ID || '');
const IFTS_STATION = integerEnv('SIM_IFTS_STATION', configuredMemoryStation ? Number(configuredMemoryStation[1]) : 2, 2, 4);
const IFTS_START_COIL = integerEnv('SIM_IFTS_START_COIL', 23, 0, 65535);
const IFTS_RESULT_COIL = integerEnv('SIM_IFTS_RESULT_COIL', 24, 0, 65535);
const IFTS_QR_REGISTERS = integerEnv('SIM_IFTS_QR_REGISTERS', 15, 1, 117);
const IFTS_OUTPUT_START = integerEnv('SIM_IFTS_OUTPUT_START', 21, 0, 65535);
const IFTS_RESULT_SOURCE = enumEnv('SIM_IFTS_RESULT_SOURCE', 'simulated', ['simulated', 'real']);
const IFTS_BRIDGE_URL = (process.env.SIM_IFTS_BRIDGE_URL || process.env.IFTS_BRIDGE_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const IFTS_BRIDGE_API_KEY = process.env.SIM_IFTS_BRIDGE_API_KEY || process.env.IFTS_BRIDGE_API_KEY || '';
const IFTS_LOG_ROOT = path.resolve(process.env.SIM_IFTS_LOG_ROOT
    || path.join(__dirname, '..', '..', 'desktop-bridge', 'Log'));
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
        if (!closing) Promise.resolve().then(action).catch(error => console.error(`ERRO ASSÍNCRONO: ${error.message}`));
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

function localDateParts(date = new Date()) {
    const year = String(date.getFullYear()), month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return { monthKey: `${year}${month}`, dayKey: `${year}${month}${day}`,
        display: `${String(date.getDate()).padStart(2, '0')}/${month}/${year}` };
}

async function bridgeGet(resource) {
    const response = await fetch(`${IFTS_BRIDGE_URL}${resource}`, {
        headers: { ...(IFTS_BRIDGE_API_KEY ? { 'X-API-Key': IFTS_BRIDGE_API_KEY } : {}) },
        signal: AbortSignal.timeout(3000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Bridge respondeu HTTP ${response.status} em ${resource}.`);
    return body;
}

async function activeBridgeCycle() {
    const health = await bridgeGet('/health');
    const state = health.state || {};
    if (state.status !== 'started' || !state.cycleId) {
        throw new Error(`Bridge ainda não iniciou o ciclo da estação IFTS (estado=${state.status || 'desconhecido'}).`);
    }
    const model = state.model || (await bridgeGet('/model')).model;
    if (!model) throw new Error('Bridge não informou o modelo usado pelo IFTS.');
    let monitoring = {};
    try { monitoring = await bridgeGet('/monitoring'); } catch {}
    const logRoot = process.env.SIM_IFTS_LOG_ROOT
        ? IFTS_LOG_ROOT
        : (monitoring.logRoot ? path.resolve(monitoring.logRoot) : IFTS_LOG_ROOT);
    return { cycleId: state.cycleId, model, logRoot };
}

function iftsPositions(unit) {
    const profile = positionProfiles.get(IFTS_STATION);
    const positions = unit.generatedProfile ? profile.map(() => true) : [...profile];
    for (const failure of unit.failures || []) {
        if (failure.station === IFTS_STATION) positions[failure.position - 1] = false;
    }
    return positions;
}

async function writeIftsCsv(unit) {
    const { cycleId, model, logRoot } = await activeBridgeCycle();
    const positions = iftsPositions(unit), now = new Date(), date = localDateParts(now);
    const directory = path.join(logRoot, date.monthKey, 'Normal');
    const safeModel = String(model).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
    const file = path.join(directory, `${safeModel}_SIM_${Date.now()}_${date.dayKey}.Csv`);
    const header = 'Station ID,Equipment ID,LotNo,Union Code,QRCode,JigId,Temperature,Date,Time,Test Time,Channel,Barcode,Equipment Number,Judgment,NG Step,Server Data Send';
    const rows = positions.map((passed, index) => {
        const position = index + 1, judgment = passed ? 'OK' : 'NG';
        const ngStep = passed ? '' : 'DDR_TEST', message = passed ? '' : `Falha simulada de memória na posição ${position}`;
        return `,,0,,${unit.serial},,0,0,${date.display},'${now.toTimeString().slice(0, 8)}.000,'1,100,${position},,,${judgment},${ngStep},${message},`;
    });
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(file, [header, ...rows, ''].join('\r\n'), 'utf8');
    return { file, cycleId, positions };
}

class SimulatedStation {
    memory = new Uint16Array(MAILBOX_SIZE);
    state = 'idle';
    requestQr = false;
    exitConfirmed = false;
    iftsStart = false;
    iftsResult = false;
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
        if (config.number === 1 || config.number === IFTS_STATION) this.vector.getCoil = address => this.readCoil(address);
        if (config.number === IFTS_STATION) this.vector.setCoil = (address, value) => this.receiveIftsCoil(address, value);
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
        if (this.config.number === 1 && address === 0) return this.requestQr;
        if (this.config.number === 1 && address === 1) return this.exitConfirmed;
        if (this.config.number === IFTS_STATION && address === 0) return this.requestQr;
        if (this.config.number === IFTS_STATION && address === 1) return this.exitConfirmed;
        if (this.config.number === IFTS_STATION && address === 2) return false;
        if (this.config.number === IFTS_STATION && address === IFTS_START_COIL) return this.iftsStart;
        if (this.config.number === IFTS_STATION && address === IFTS_RESULT_COIL) return this.iftsResult;
        return modbusError(2, `Coil ${address} não disponível na M${this.config.number}.`);
    }

    receiveIftsCoil(address, value) {
        this.ensureCommunication();
        if (address === 2) return this.receiveIftsOutputAck(value === true);
        if (address !== IFTS_RESULT_COIL) return modbusError(2, `A M${IFTS_STATION} aceita escrita somente nas Coils 2 e ${IFTS_RESULT_COIL}.`);
        const active = value === true, previous = this.iftsResult;
        this.iftsResult = active;
        if (previous === active) return;
        log(this.config.number, `RESULT_READY M${IFTS_RESULT_COIL}=${active ? 1 : 0}`);
        if (active && this.unit && ['ifts-testing', 'ifts-awaiting-result'].includes(this.state)) {
            this.state = 'ifts-result-received';
        }
        if (!active && previous && this.unit && this.state === 'ifts-result-received') {
            this.iftsStart = false;
            later(() => this.publishIftsOutput(), 100);
        }
    }

    receiveIftsOutputAck(active) {
        const unit = this.unit;
        if (active && unit && this.state === 'ifts-output-ready') {
            this.exitConfirmed = false;
            this.memory.fill(0, IFTS_OUTPUT_START, IFTS_OUTPUT_START + IFTS_QR_REGISTERS);
            this.state = 'ifts-output-acknowledged';
            log(this.config.number, `ACK_SAIDA M2=1 recebido; M1=0 e D${IFTS_OUTPUT_START}–D${IFTS_OUTPUT_START + IFTS_QR_REGISTERS - 1} limpos`);
        } else if (!active && unit && this.state === 'ifts-output-acknowledged') {
            this.unit = undefined;
            this.state = 'idle';
            log(this.config.number, 'ACK_SAIDA M2=0; bandeja liberada');
            forwardUnit(this.config.number, unit);
        }
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
        if (this.config.number === IFTS_STATION && address === MAILBOX_START && values.length === IFTS_QR_REGISTERS) {
            return this.receiveIftsEntry(values);
        }
        const expectedLength = this.config.number === 1 ? SERIAL_REGISTERS : MAILBOX_SIZE;
        if (address !== MAILBOX_START || values.length !== expectedLength) {
            return modbusError(2, `FC16 deve cobrir os ${expectedLength} registers esperados pela M${this.config.number}.`);
        }
        if (this.config.number === 1) this.receiveM1Payload(values);
        else this.receiveAck(values);
    }

    receiveIftsEntry(values) {
        if (this.state === 'ifts-requesting-entry' && this.requestQr
            && this.empty(this.memory.slice(0, IFTS_QR_REGISTERS))) {
            const serial = decodeSerial(values, IFTS_QR_REGISTERS * 2, this.config.byteOrder).replace(/\0+$/, '');
            if (!this.unit || serial !== this.unit.serial) {
                return modbusError(3, `QR de entrada divergente na M${this.config.number}.`);
            }
            this.memory.set(values, 0);
            this.requestQr = false;
            this.state = 'ifts-entry-captured';
            this.memory.fill(0, 0, IFTS_QR_REGISTERS);
            log(this.config.number, `QR recebido em D0–D${IFTS_QR_REGISTERS - 1}: ${serial}; M0=0 e entrada limpa pela CLP`);
            later(() => this.startIftsTest(), 100);
            return;
        }
        return modbusError(3, `M${this.config.number} não aguarda escrita em D0–D${IFTS_QR_REGISTERS - 1}.`);
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
        forwardUnit(1, unit);
    }

    receiveAck(values) {
        if (!this.empty(values)) return modbusError(3, `M${this.config.number} aceita somente zeros como ACK.`);
        if (this.faults.rejectAck) return modbusError(4, `M${this.config.number} rejeitou o ACK por falha simulada.`);
        const unit = this.unit;
        this.memory.fill(0); this.unit = undefined; this.state = 'idle';
        if (!unit) { log(this.config.number, 'ACK zerado recebido sem unidade pendente'); return; }
        log(this.config.number, `ACK do PCM recebido para sequence=${unit.sequence}`);
        forwardUnit(this.config.number, unit);
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
        if (this.config.number === IFTS_STATION) return this.beginIfts(unit);
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

    beginIfts(unit) {
        if (this.config.number !== IFTS_STATION) throw new Error('A estação não está configurada como IFTS.');
        if (this.state !== 'idle' || this.unit) {
            log(this.config.number, `estação IFTS ocupada; transferência de sequence=${unit.sequence} não realizada`);
            return;
        }
        this.unit = unit;
        this.requestQr = true;
        this.exitConfirmed = false;
        this.iftsStart = false;
        this.iftsResult = false;
        this.state = 'ifts-requesting-entry';
        log(this.config.number, `REQ_INFO_BANDEJA M0=1 para sequence=${unit.sequence}; aguardando D0–D${IFTS_QR_REGISTERS - 1}`);
    }

    startIftsTest() {
        const unit = this.unit;
        if (!unit || this.state !== 'ifts-entry-captured') return;
        this.iftsStart = true;
        this.state = IFTS_RESULT_SOURCE === 'real' ? 'ifts-awaiting-result' : 'ifts-testing';
        log(this.config.number, `IFTS_START M${IFTS_START_COIL}=1 para sequence=${unit.sequence}, QR=${unit.serial}`);
        if (IFTS_RESULT_SOURCE === 'real') {
            log(this.config.number, 'modo REAL: aguardando o IFTS produzir o CSV e o PCM retornar o resultado');
        } else {
            later(() => this.produceIftsResult(unit), PROCESS_MS);
        }
    }

    async produceIftsResult(unit) {
        if (this.config.number !== IFTS_STATION || this.unit !== unit || this.state !== 'ifts-testing') return;
        try {
            const result = await writeIftsCsv(unit);
            if (this.unit !== unit || this.state !== 'ifts-testing') return;
            this.state = 'ifts-awaiting-result';
            log(this.config.number, `CSV do ciclo ${result.cycleId} criado em ${result.file}`);
            log(this.config.number, `posições IFTS=[${result.positions.map(Number).join(',')}]; aguardando pulso M${IFTS_RESULT_COIL} do PCM`);
        } catch (error) {
            log(this.config.number, `aguardando Bridge iniciar o teste: ${error.message}`);
            later(() => this.produceIftsResult(unit), 1000);
        }
    }

    publishIftsOutput() {
        if (this.config.number !== IFTS_STATION || !this.unit || this.state !== 'ifts-result-received') return;
        const unit = this.unit;
        const encoded = encodeSerial(unit.serial, this.config.byteOrder).registers.slice(0, IFTS_QR_REGISTERS);
        this.memory.set(encoded, IFTS_OUTPUT_START);
        this.exitConfirmed = true;
        this.state = 'ifts-output-ready';
        log(this.config.number, `QR de saída em D${IFTS_OUTPUT_START}–D${IFTS_OUTPUT_START + IFTS_QR_REGISTERS - 1}; M1=1 para sequence=${unit.sequence}`);
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
        if (this.config.number === IFTS_STATION) throw new Error(`M${IFTS_STATION} usa o Bridge IFTS e não possui mailbox para republicar.`);
        if (!this.unit) throw new Error(`M${this.config.number} não possui bandeja pendente para republicar.`);
        const unit = this.unit;
        this.memory.fill(0); this.unit = undefined; this.delayedUnit = undefined; this.state = 'idle';
        this.publish(unit, true);
    }

    reset() {
        this.memory.fill(0); this.requestQr = false; this.exitConfirmed = false; this.unit = undefined;
        this.iftsStart = false; this.iftsResult = false;
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

function forwardUnit(fromNumber, unit) {
    if (fromNumber < 4) {
        later(() => stations[fromNumber].publish(unit));
        return;
    }
    completedUnits++;
    log(4, `linha concluída para sequence=${unit.sequence}; total=${completedUnits}`);
    if (running) later(() => stations[0].requestNext());
}

const stations = configs.map(config => new SimulatedStation(config));
const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });

function help() {
    console.log(`
Estação IFTS: M${IFTS_STATION} | fonte=${IFTS_RESULT_SOURCE.toUpperCase()} | ENTRADA=M0/D0–D${IFTS_QR_REGISTERS - 1} | START=M${IFTS_START_COIL} | FIM=M${IFTS_RESULT_COIL} | SAÍDA=M1/D${IFTS_OUTPUT_START}–D${IFTS_OUTPUT_START + IFTS_QR_REGISTERS - 1} | ACK=M2
Bridge: ${IFTS_BRIDGE_URL} | Log: ${IFTS_LOG_ROOT}

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
            stations.forEach(station => {
                const ifts = station.config.number === IFTS_STATION
                    ? ` | IFTS REQ(M0)=${Number(station.requestQr)} START(M${IFTS_START_COIL})=${Number(station.iftsStart)} FIM(M${IFTS_RESULT_COIL})=${Number(station.iftsResult)} SAÍDA(M1)=${Number(station.exitConfirmed)}`
                    : '';
                console.log(`M${station.config.number} ${station.config.host}:${station.config.port} | bytes=${station.config.byteOrder.toUpperCase()} | ${station.state} | ${station.empty() ? 'vazio' : 'ocupado'}${station.unit ? ` | seq=${station.unit.sequence}` : ''}${ifts}`);
            });
            console.log(`Automático=${running} | perfil=${compatibilityProfile === 'current' ? 'atual' : 'robusto'} | falha aleatória=${randomFailureEnabled} | unidades concluídas=${completedUnits}`);
            console.log(`IFTS=${IFTS_RESULT_SOURCE.toUpperCase()} | Bridge=${IFTS_BRIDGE_URL} | pasta CSV simulada=${IFTS_LOG_ROOT}`);
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
