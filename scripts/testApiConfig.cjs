const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readBypassEnabled, readOfflineInspectionAllowed } = require('../dist/api/config');

test('bypass fica desabilitado por padrão e aceita ativação explícita', () => {
    assert.equal(readBypassEnabled({}), false);
    assert.equal(readBypassEnabled({ PCM_BYPASS_ENABLED: 'true' }), true);
    assert.equal(readBypassEnabled({ PCM_BYPASS_ENABLED: 'ON' }), true);
    assert.equal(readBypassEnabled({ PCM_BYPASS_ENABLED: '0' }), false);
    assert.throws(() => readBypassEnabled({ PCM_BYPASS_ENABLED: 'talvez' }), /PCM_BYPASS_ENABLED/);
});

test('inspeção offline só é liberada por configuração explícita', () => {
    assert.equal(readOfflineInspectionAllowed({}), false);
    assert.equal(readOfflineInspectionAllowed({ ALLOW_OFFLINE_INSPECTION: 'true' }), true);
    assert.equal(readOfflineInspectionAllowed({ ALLOW_OFFLINE_INSPECTION: 'ON' }), true);
    assert.equal(readOfflineInspectionAllowed({ ALLOW_OFFLINE_INSPECTION: '0' }), false);
    assert.throws(() => readOfflineInspectionAllowed({ ALLOW_OFFLINE_INSPECTION: 'talvez' }), /ALLOW_OFFLINE_INSPECTION/);
});
