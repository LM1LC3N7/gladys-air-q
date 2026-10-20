import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseAddress } from '../src/config.js';

test('the defaults', () => {
  const config = normalizeConfig();
  assert.deepEqual(config.devices, []);
  assert.deepEqual(config.invalid, []);
  assert.equal(config.values, DEFAULT_CONFIG.values);
  assert.equal(config.pollMinutes, DEFAULT_CONFIG.poll_interval);
});

test('the addresses an air-Q may have', () => {
  assert.equal(parseAddress('192.168.1.50'), '192.168.1.50');
  assert.equal(parseAddress(' http://192.168.1.50/ '), '192.168.1.50');
  assert.equal(parseAddress('192.168.1.50:8080'), '192.168.1.50:8080');
  assert.equal(parseAddress('AirQ-Salon.lan'), 'airq-salon.lan');
  assert.equal(parseAddress('123ab'), '123ab_air-q.local', 'the device id, as aioairq');
  assert.equal(parseAddress('123ab_air-q.local'), '123ab_air-q.local');
  for (const bad of [
    '',
    '256.1.1.1',
    '1.2.3',
    '192.168.1.50/data',
    'user:pw@192.168.1.50',
    '192.168.1.50:0',
    '192.168.1.50:70000',
    '[::1]',
    'fe80::1',
    'a b',
    'host/../x',
    'x'.repeat(300),
    '-bad.lan',
  ]) {
    assert.equal(parseAddress(bad), null, bad);
  }
});

test('up to three air-Q; incomplete or duplicate slots reported by number only', () => {
  const config = normalizeConfig({
    airq_1_address: '192.168.1.50',
    airq_1_password: ' with spaces ',
    airq_2_address: '192.168.1.51',
    airq_3_address: 'http://192.168.1.50',
    airq_3_password: 'x',
    airq_4_address: '192.168.1.53',
    airq_4_password: 'y',
  });
  assert.deepEqual(config.devices, [
    { slot: 1, address: '192.168.1.50', password: ' with spaces ' },
  ]);
  assert.deepEqual(config.invalid, [
    { slot: 2, why: 'password' },
    { slot: 3, why: 'duplicate' },
  ]);
  assert.deepEqual(normalizeConfig({ airq_1_address: '/x', airq_1_password: 'p' }).invalid, [
    { slot: 1, why: 'address' },
  ]);
});

test('values and interval are bounded', () => {
  assert.equal(normalizeConfig({ values: 'momentary' }).values, 'momentary');
  assert.equal(normalizeConfig({ values: 'other' }).values, 'average');
  assert.equal(normalizeConfig({ poll_interval: '0' }).pollMinutes, 1);
  assert.equal(normalizeConfig({ poll_interval: 600 }).pollMinutes, 60);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollMinutes, 2);
});
