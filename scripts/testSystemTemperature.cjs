const assert = require('node:assert/strict');
const { test } = require('node:test');
const { classifyTemperature, temperaturesFromLibreHardwareMonitor,
    primaryTemperatureFromLibreHardwareMonitor } = require('../dist/modules/system/services/systemTemperature');

test('temperatura do PC classifica normal, atenção, crítico e sensor indisponível', () => {
    assert.equal(classifyTemperature(79.9, 80, 90), 'normal');
    assert.equal(classifyTemperature(80, 80, 90), 'warning');
    assert.equal(classifyTemperature(89.9, 80, 90), 'warning');
    assert.equal(classifyTemperature(90, 80, 90), 'critical');
    assert.equal(classifyTemperature(null, 80, 90), 'unavailable');
});

test('temperaturas do data.json do LibreHardwareMonitor aceitam valores numéricos e formatados', () => {
    const payload = { Children: [
        { Text:'CPU', Children:[
            { Type:'Temperature', Value:'52,5 °C', RawValue:52.5, Children:[] },
            { Type:'Load', Value:'70,0 %', RawValue:70, Children:[] }
        ] },
        { Text:'GPU', Children:[{ Type:'Temperature', Value:'61.2 °C', Children:[] }] }
    ] };
    assert.deepEqual(temperaturesFromLibreHardwareMonitor(payload),[52.5,61.2]);
});

test('temperaturas do LibreHardwareMonitor ignoram payload inválido e valores fora da faixa', () => {
    assert.deepEqual(temperaturesFromLibreHardwareMonitor(null),[]);
    assert.deepEqual(temperaturesFromLibreHardwareMonitor({ Children:[
        { Type:'Temperature', RawValue:180 }, { Type:'Temperature', Value:'sem leitura' }
    ] }),[]);
});

test('temperaturas do LibreHardwareMonitor ignoram limites térmicos e distância para TjMax', () => {
    const payload = { Children:[
        { Type:'Temperature', Text:'Core Average', RawValue:'55,2 °C' },
        { Type:'Temperature', Text:'Critical Temperature', RawValue:'94,0 °C' },
        { Type:'Temperature', Text:'Warning Temperature', RawValue:'89,0 °C' },
        { Type:'Temperature', Text:'Thermal Sensor Critical High Limit', RawValue:'85,0 °C' },
        { Type:'Temperature', Text:'P-Core #1 Distance to TjMax', RawValue:'50,0 °C' },
        { Type:'Temperature', Text:'Temperature Sensor Resolution', RawValue:'0,3 °C' }
    ] };
    assert.deepEqual(temperaturesFromLibreHardwareMonitor(payload),[55.2]);
});

test('temperatura principal prioriza Core Max sobre outros sensores reais', () => {
    const payload = { Children:[
        { Type:'Temperature', Text:'GPU Hot Spot', SensorId:'/gpu-nvidia/0/temperature/2', RawValue:'71,0 °C' },
        { Type:'Temperature', Text:'Core Average', SensorId:'/intelcpu/0/temperature/1', RawValue:'52,7 °C' },
        { Type:'Temperature', Text:'Core Max', SensorId:'/intelcpu/0/temperature/0', RawValue:'55,0 °C' },
        { Type:'Temperature', Text:'CPU Package', SensorId:'/intelcpu/0/temperature/26', RawValue:'58,0 °C' }
    ] };
    assert.equal(primaryTemperatureFromLibreHardwareMonitor(payload),55);
});

test('temperatura principal usa CPU Package, Core Average e maior leitura como fallback', () => {
    assert.equal(primaryTemperatureFromLibreHardwareMonitor({ Children:[
        { Type:'Temperature', Text:'Core Average', RawValue:51 },
        { Type:'Temperature', Text:'CPU Package', RawValue:54 }
    ] }),54);
    assert.equal(primaryTemperatureFromLibreHardwareMonitor({ Children:[
        { Type:'Temperature', Text:'GPU Core', RawValue:48 },
        { Type:'Temperature', Text:'Composite Temperature', RawValue:46 }
    ] }),48);
});
