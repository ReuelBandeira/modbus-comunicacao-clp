const { ServerTCP } = require('modbus-serial');
const readline = require('node:readline');

// Mapa fixo de teste: texto em 0..31, resposta em 100, Unit ID 1.
const registers = new Uint16Array(32);
let response = 0;
const invalidAddress = () => { throw { modbusErrorCode: 2, message: 'Endereço fora do mapa do simulador.' }; };
const server = new ServerTCP({
    getHoldingRegister(address) {
        if (address === 100) return response;
        if (address >= 0 && address < registers.length) return registers[address];
        return invalidAddress();
    },
    setRegisterArray(address, values) {
        if (address !== 0 || values.length !== registers.length) return invalidAddress();
        registers.set(values);
        const bytes = Buffer.alloc(64);
        registers.forEach((value, index) => bytes.writeUInt16BE(value, index * 2));
        const text = bytes.toString('utf8').replace(/\0+$/, '');
        response = text.length ? 1 : 0;
        console.log(`Recebido: ${JSON.stringify(text)} | Resposta: ${response === 1 ? 'OK (1)' : 'Aguardando (0)'}`);
    }
}, { host: '127.0.0.1', port: 1502, unitID: 1 });

const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
terminal.on('line', () => {
    response = 0;
    console.log('Resposta zerada. Pronto para outro envio.');
});
server.on('initialized', () => {
    console.log('Simulador CLP em 127.0.0.1:1502 — Unit ID 1');
    console.log('Escrita: endereço 0, quantidade 32, ordem AB. Resposta: endereço 100, quantidade 1, número OK = 1.');
    console.log('Pressione Enter para zerar a resposta antes de outro envio. Ctrl+C encerra.');
});
server.on('socketError', error => console.error(`Conexão: ${error.message}`));
server.on('serverError', error => {
    console.error(`Não foi possível iniciar o simulador: ${error.message}`);
    terminal.close();
    server.close();
    process.exitCode = 1;
});
process.on('SIGINT', () => {
    terminal.close();
    server.close();
});
