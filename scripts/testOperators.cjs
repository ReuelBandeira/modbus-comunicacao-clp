const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminAccessService } = require('../dist/modules/operators/services/adminAccessService');
const { OperatorService } = require('../dist/modules/operators/services/operatorService');

test('ADMIN: rejeita senha incorreta e autoriza sessao temporaria', () => {
    const service = new AdminAccessService('senha-segura');
    assert.throws(() => service.login({ password: 'errada' }), /Credencial ADMIN/);
    const session = service.login({ password: 'senha-segura' });
    assert.equal(session.role, 'ADMIN');
    assert.doesNotThrow(() => service.authorize(`Bearer ${session.token}`));
    assert.throws(() => service.authorize(), /Sessao ADMIN/);
});

test('operador: persiste somente nome e matricula', async () => {
    let saved;
    const repository = {
        create: async value => { saved = structuredClone(value); },
        list: async () => saved ? [structuredClone(saved)] : [],
        update: async (registration, value) => saved?.registration === registration ? (saved = structuredClone(value)) : null,
        remove: async registration => { if (saved?.registration !== registration) return false; saved = undefined; return true; }
    };
    const service = new OperatorService(repository);
    assert.deepEqual(await service.create({ name: 'Maria Silva', registration: 'MAT-001' }),
        { name: 'Maria Silva', registration: 'MAT-001' });
    assert.deepEqual(Object.keys(saved).sort(), ['name', 'registration']);
    await assert.rejects(service.create({ name: 'Maria', registration: 'MAT-002', active: true }), /somente nome e matricula/);
    assert.deepEqual(await service.update('MAT-001', { name: 'Maria Oliveira', registration: 'MAT-002' }),
        { name: 'Maria Oliveira', registration: 'MAT-002' });
    assert.deepEqual(Object.keys(saved).sort(), ['name', 'registration']);
    await service.remove('MAT-002');
    assert.equal(saved, undefined);
    await assert.rejects(service.remove('MAT-002'), /nao encontrado/);
    assert.deepEqual(await service.create({ name: 'João Souza', registration: 'MAT-002' }),
        { name: 'João Souza', registration: 'MAT-002' });
});

test('operador: cadastro ativo nao pode ser editado nem removido', async () => {
    const repository = {
        update: async () => assert.fail('Não deve editar operador ativo'),
        remove: async () => assert.fail('Não deve remover operador ativo')
    };
    const usage = { hasActiveForOperator: async registration => registration === 'MAT-001' };
    const service = new OperatorService(repository, usage);
    await assert.rejects(service.update('MAT-001', { name: 'Maria', registration: 'MAT-002' }), /Registre a saida/);
    await assert.rejects(service.remove('MAT-001'), /Registre a saida/);
});
