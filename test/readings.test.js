import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { CO_PPM_PER_MG_M3, deviceOf, statesOf, valuesOf, warmingUp } from '../src/readings.js';
import { AVERAGE } from './helpers/fakes.js';

test('values: [value, uncertainty], the _SPS30 suffix, conversions, rounding', () => {
  assert.deepEqual(valuesOf(AVERAGE), {
    co2: 612,
    tvoc: 151,
    pm2_5: 4.3,
    pm10: 6.1,
    co: Math.round(0.42 * CO_PPM_PER_MG_M3 * 10) / 10,
    no2: 12.5,
    o3: 0,
    temperature: 21.8,
    humidity: 44.2,
    pressure: 1013.3,
    sound: 38.4,
    sound_max: 52.9,
  });
});

test('values: a negative concentration reads 0, a negative temperature stays', () => {
  const values = valuesOf({ co2: -3, temperature: [-5.2, 0.3], humidity: -1 });
  assert.equal(values.co2, 0);
  assert.equal(values.temperature, -5.2);
  assert.equal(values.humidity, undefined, 'out of the bounds: left out, never clamped');
});

test('values: never NaN, null or undefined; unknown and inherited keys ignored', () => {
  const document = JSON.parse(
    '{"co2":"abc","tvoc":null,"pm10":[],"temperature":"21.5","humidity":true,"__proto__":{"co2":1},"pressure":1e400}',
  );
  const values = valuesOf(document);
  assert.deepEqual(values, { temperature: 21.5 });
  assert.equal({}.co2, undefined, 'no prototype pollution');
  assert.deepEqual(valuesOf(null), {});
  assert.deepEqual(valuesOf('text'), {});
});

test('warming up sensors (aioairq identify_warming_up_sensors)', () => {
  assert.deepEqual(warmingUp({ Status: 'OK' }), []);
  assert.deepEqual(
    warmingUp({
      Status: { no2: 'no2 sensor still in warm up phase; waiting time = 90 s', co: 'x' },
    }),
    ['no2'],
  );
});

test('the device keeps the features already created, even without a value now', () => {
  const gladys = createFakeGladys({ selector: 'air-q' });
  const info = { id: 'abc12def' };
  const first = deviceOf(gladys, {
    info,
    fields: new Set(['co2', 'sound']),
    name: 'Salon (air-Q)',
  });
  assert.equal(first.external_id, 'ext:air-q:airq:abc12def');
  assert.deepEqual(
    first.features.map((f) => f.external_id),
    ['ext:air-q:airq:abc12def:co2', 'ext:air-q:airq:abc12def:sound'],
  );
  // The user created it, with a feature a future version would not know.
  gladys.devices = [
    {
      ...first,
      features: [
        ...first.features,
        {
          name: 'Old',
          external_id: 'ext:air-q:airq:abc12def:legacy',
          category: 'co2-sensor',
          type: 'integer',
          unit: 'ppm',
          min: 0,
          max: 10,
        },
      ],
    },
  ];
  const next = deviceOf(gladys, { info, fields: new Set(['co2']), name: 'Salon (air-Q)' });
  assert.deepEqual(
    next.features.map((f) => f.external_id),
    [
      'ext:air-q:airq:abc12def:co2',
      'ext:air-q:airq:abc12def:sound',
      'ext:air-q:airq:abc12def:legacy',
    ],
  );
  assert.ok(next.features.every((f) => f.read_only === true));
});

test('states: numbers only', () => {
  const gladys = createFakeGladys({ selector: 'air-q' });
  assert.deepEqual(statesOf(gladys, 'abc12def', { co2: 500, tvoc: NaN, pm10: undefined }), [
    { device_feature_external_id: 'ext:air-q:airq:abc12def:co2', state: 500 },
  ]);
});
