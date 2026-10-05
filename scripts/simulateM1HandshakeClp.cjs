const { ServerTCP } = require('modbus-serial');

// Mailbox de desenvolvimento (offset base zero):
// sequence 0..1, length 2, serial 3..34, position_count 35, position_bits 36..39.
const PLC_PORT = Number(process.env.PLC_PORT || 1502), UNIT_ID = 1;
const MAILBOX_SIZE = 40, SERIAL_START = 3, SERIAL_REGISTERS = 32;
const registers = new Uint16Array(MAILBOX_SIZE);
let requestQr = false, processing = false, stopped = false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const invalid = () => { throw { modbusErrorCode: 2, message: 'Endereco fora do mapa de teste.' }; };
const decode = values => {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16BE(value, index * 2));
    return bytes.toString('utf8').replace(/\0+$/, '');
};

const server = new ServerTCP({
    getCoil(address) { if (address !== 0) return invalid(); return requestQr; },
    getHoldingRegister(address) { if (address < 0 || address >= MAILBOX_SIZE) return invalid(); return registers[address]; },
    getMultipleHoldingRegisters(address, length) {
        if (address < 0 || address + length > MAILBOX_SIZE) return invalid();
        return Array.from(registers.slice(address, address + length));
    },
    setRegisterArray(address, values) {
        if (address !== 0 || values.length !== MAILBOX_SIZE || processing) return invalid();
        registers.set(values);
        const sequence = registers[0] * 0x10000 + registers[1];
        const length = registers[2];
        const serial = decode(Array.from(registers.slice(SERIAL_START, SERIAL_START + SERIAL_REGISTERS))).slice(0, length);
        if (!sequence || !serial) return;
        processing = true; requestQr = false;
        console.log(`Recebido sequence=${sequence} serial=${serial}. Simulando passagem...`);
        void (async () => {
            await sleep(500);
            registers.fill(0);
            console.log(`Mailbox zerado: passagem confirmada para sequence=${sequence}.`);
            await sleep(500);
            processing = false;
            if (!stopped) { requestQr = true; console.log('CHEGADA / REQUEST_QR=true para a proxima unidade.'); }
        })();
    }
}, { host: '127.0.0.1', port: PLC_PORT, unitID: UNIT_ID });

server.on('initialized', () => {
    console.log(`CLP da estacao 1 simulada em 127.0.0.1:${PLC_PORT}, Unit ID ${UNIT_ID}.`);
    console.log('O Node conecta nesta porta; nao existe mais servidor Modbus no Node.');
    setTimeout(() => { if (!stopped) { requestQr = true; console.log('CHEGADA / REQUEST_QR=true'); } }, 500);
});
server.on('socketError', error => console.error(`Conexao: ${error.message}`));
server.on('serverError', error => console.error(error.message));
process.on('SIGINT', () => { stopped = true; server.close(); });
