const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EntryPreparationService } = require('../dist/modules/pcm/entry/services/entryPreparationService');

function fixture(staffing) {
    let value = null;
    const preparations = {
        current: async () => value?.preparation?.active ? value : null,
        byEntryId: async id => value?.entryId === id ? value : null,
        byStartRequestId: async requestId => value?.preparation?.startRequestId === requestId ? value : null,
        insert: async pcm => { value = structuredClone(pcm); },
        appendChip: async (id, version, chip, status, completedAt) => {
            if (value.entryId !== id || value.preparation.version !== version || value.preparation.status !== 'scanning') return false;
            value.preparation.chips.push(chip); value.preparation.status = status; value.preparation.updatedAt = chip.scannedAt;
            if (completedAt) value.preparation.completedAt = completedAt; value.preparation.version++; return true;
        },
        undoLast: async (id, version, updatedAt) => {
            if (value.entryId !== id || value.preparation.version !== version) return false;
            value.preparation.chips.pop(); value.preparation.status = 'scanning'; value.preparation.updatedAt = updatedAt;
            delete value.preparation.completedAt; value.preparation.version++; return true;
        },
        cancel: async () => false,
        release: async (id, version, workflow, releasedAt) => {
            if (value.entryId !== id || value.preparation.version !== version || value.preparation.chips.length !== 20) return false;
            value.workflow = workflow; value.preparation.status = 'released'; value.preparation.active = false;
            value.preparation.releasedAt = releasedAt; value.preparation.version++; return true;
        }
    };
    const pcms = { inProgress: async () => false, insert: async () => assert.fail('Não deve inserir outro documento') };
    const workflow = { admit: async (pcm, persist) => { pcm.workflow = { lineId:'linha-01',entrySequence:7,version:0,status:'in_progress',quality:'pending',stages:[] }; await persist(); } };
    return { service:new EntryPreparationService(preparations,pcms,workflow,'linha-01','entrada','Entrada',staffing), read:()=>value };
}

test('preparação bloqueia a bandeja enquanto a equipe mínima não estiver presente', async () => {
    let allowed = false;
    const { service } = fixture({ assertMinimumOperators: async () => {
        if (!allowed) throw Object.assign(new Error('Bipagem bloqueada: 2 de 3 operadores ativos na estação principal.'), { status: 409 });
    } });
    await assert.rejects(service.start({ 'qr-code':'BANDEJA-EQUIPE' }), /2 de 3 operadores/);
    allowed = true;
    const tray = await service.start({ 'qr-code':'BANDEJA-EQUIPE' });
    assert.equal(tray.preparation.status, 'scanning');
});

test('preparação exige operação da linha iniciada somente para a primeira bandeja', async () => {
    let running = false;
    const { service } = fixture({ assertMinimumOperators: async () => {}, assertOperationRunning: async () => {
        if (!running) throw Object.assign(new Error('Bipagem bloqueada: inicie a operação da linha.'), { status: 409 });
    } });
    await assert.rejects(service.start({ 'qr-code':'BANDEJA-OPERACAO' }), /inicie a operação/);
    running = true;
    const tray = await service.start({ 'qr-code':'BANDEJA-OPERACAO' });
    running = false;
    const updated = await service.addChip(tray.entryId, { 'qr-code':'CHIP-1' });
    assert.equal(updated.preparation.chips.length, 1);
});

test('preparação bloqueia bandeja e chip quando a estação obrigatória está offline', async () => {
    let stationOnline = false;
    const staffing = {
        assertMinimumOperators: async () => {},
        assertRequiredStation: async () => {
            if (!stationOnline) throw Object.assign(new Error('Final de Linha está desconectada.'), { status: 409 });
        }
    };
    const { service } = fixture(staffing);
    await assert.rejects(service.start({ 'qr-code':'BANDEJA-ESTACAO' }), /desconectada/);
    stationOnline = true;
    const tray = await service.start({ 'qr-code':'BANDEJA-ESTACAO' });
    stationOnline = false;
    await assert.rejects(service.addChip(tray.entryId, { 'qr-code':'CHIP-1' }), /desconectada/);
});

test('preparação exige 20 chips em ordem antes de liberar a bandeja', async () => {
    const { service } = fixture();
    const tray = await service.start({ 'qr-code':'BANDEJA-01',requestId:'tray-1' });
    assert.match(tray.entryId,/^[0-9a-f-]{36}$/); assert.equal(tray.preparation.chips.length,0);
    await assert.rejects(service.release(tray.entryId,{}),/20 posições/);
    for(let index=1;index<=20;index++) {
        const current = await service.addChip(tray.entryId,{ 'qr-code':`CHIP-${index}`,requestId:`chip-${index}` });
        assert.equal(current.preparation.chips.at(-1).position,index);
    }
    const released = await service.release(tray.entryId,{requestId:'release-1'});
    assert.equal(released.preparation.status,'released'); assert.equal(released.workflow.entrySequence,7);
});

test('preparação confere novamente a equipe mínima antes de liberar a bandeja', async () => {
    let allowed = true;
    const { service } = fixture({ assertMinimumOperators: async () => {
        if (!allowed) throw Object.assign(new Error('Bipagem bloqueada: 2 de 3 operadores ativos.'), { status: 409 });
    } });
    const tray = await service.start({ 'qr-code':'BANDEJA-SAIDA' });
    for(let index=1;index<=20;index++) await service.addChip(tray.entryId,{ 'qr-code':`CHIP-SAIDA-${index}` });
    allowed = false;
    await assert.rejects(service.release(tray.entryId,{}), /2 de 3 operadores/);
});

test('retry do mesmo chip é idempotente e chip repetido em outra posição é recusado', async () => {
    const { service } = fixture(); const tray = await service.start({'serial-number':'BANDEJA-02'});
    await service.addChip(tray.entryId,{'serial-number':'CHIP-A',requestId:'read-a'});
    const retry = await service.addChip(tray.entryId,{'serial-number':'CHIP-A',requestId:'read-a'});
    assert.equal(retry.preparation.chips.length,1);
    await assert.rejects(service.addChip(tray.entryId,{'serial-number':'CHIP-A',requestId:'read-b'}),/já foi lido/);
});

test('QR da bandeja não pode ocupar uma posição de chip', async () => {
    const { service, read } = fixture();
    const tray = await service.start({'qr-code':'BANDEJA-03'});
    await assert.rejects(service.addChip(tray.entryId,{'qr-code':'BANDEJA-03'}),/QR da bandeja/);
    assert.equal(read().preparation.chips.length,0);
});
