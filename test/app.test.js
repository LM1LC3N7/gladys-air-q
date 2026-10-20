// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and a fake air-Q.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AirQApp } from '../src/app.js';
import { ACTIONS, REFUSED_BACKOFF, TICK } from '../src/constants.js';
import { T } from '../src/i18n.js';
import { memoryStorage } from '../src/store.js';
import {
  AVERAGE,
  CONFIG,
  PASSWORD,
  airq,
  createFakeTimers,
  installFetch,
  json,
  recordingLogger,
} from './helpers/fakes.js';

const NOW = Date.parse('2026-10-20T18:00:00Z');
const DEVICE = `ext:air-q:airq:${CONFIG.id}`;
const BASE = { airq_1_address: '192.168.1.50', airq_1_password: PASSWORD };

let fake;
afterEach(() => fake?.restore());

async function setup({ config = BASE, storage = memoryStorage(), start = true } = {}) {
  const answers = {
    config: () => airq(CONFIG),
    average: () => airq(AVERAGE),
    data: () => airq({ ...AVERAGE, co2: 700 }),
  };
  fake = installFetch([
    [/^http:\/\/[^/]+\/config$/, (c) => answers.config(c)],
    [/^http:\/\/[^/]+\/average$/, (c) => answers.average(c)],
    [/^http:\/\/[^/]+\/data$/, (c) => answers.data(c)],
  ]);
  const gladys = createFakeGladys({ selector: 'air-q', config });
  const timers = createFakeTimers();
  const clock = { now: NOW };
  const logger = recordingLogger();
  const app = new AirQApp({ gladys, logger, now: () => clock.now, timers, storage });
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onDeviceCreated(() => app.publishStates());
  await gladys.connect();
  if (start) {
    await app.start(config);
  }
  return { app, gladys, timers, clock, answers, logger, storage };
}

const calls = (route) => fake.calls.filter((c) => c.url.endsWith(`/${route}`));

async function createAll(gladys) {
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
}

async function runMinutes(timers, clock, minutes) {
  for (let i = 0; i < (minutes * 60_000) / TICK; i += 1) {
    clock.now += TICK;
    await timers.runIntervals();
  }
}

test('a start reads /config then /average; one device with the measured features', async () => {
  const { gladys } = await setup();
  assert.equal(calls('config').length, 1);
  assert.equal(calls('average').length, 1);
  const [device] = gladys.fake.discoveredDevices;
  assert.equal(device.name, 'Salon (air-Q)');
  assert.equal(device.external_id, DEVICE);
  assert.equal(device.should_poll, false);
  assert.deepEqual(
    device.features.map((f) => [f.external_id.slice(DEVICE.length + 1), f.category, f.unit]),
    [
      ['co2', 'co2-sensor', 'ppm'],
      ['tvoc', 'voc-sensor', 'ppb'],
      ['pm2_5', 'pm25-sensor', 'microgram-per-cubic-meter'],
      ['pm10', 'pm10-sensor', 'microgram-per-cubic-meter'],
      ['co', 'co-sensor', 'ppm'],
      ['no2', 'no2-sensor', 'microgram-per-cubic-meter'],
      ['o3', 'o3-sensor', 'microgram-per-cubic-meter'],
      ['temperature', 'temperature-sensor', 'celsius'],
      ['humidity', 'humidity-sensor', 'percent'],
      ['pressure', 'pressure-sensor', 'hPa'],
      ['sound', 'noise-sensor', 'decibel'],
      ['sound_max', 'noise-sensor', 'decibel'],
    ],
  );
  assert.ok(device.features.every((f) => f.read_only && !f.has_feedback));
  assert.equal(gladys.fake.states.length, 0, 'nothing created: nothing published');
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: T.ok({ devices: 1, interval: 2 }),
  });
});

test('a created device gets its values at once', async () => {
  const { gladys } = await setup();
  await createAll(gladys);
  assert.equal(gladys.fake.lastState(`${DEVICE}:co2`), 612);
  assert.equal(gladys.fake.lastState(`${DEVICE}:temperature`), 21.8);
  assert.equal(gladys.fake.lastState(`${DEVICE}:sound`), 38.4);
});

test('read every 2 minutes, /config only once', async () => {
  const { gladys, timers, clock } = await setup();
  await createAll(gladys);
  await runMinutes(timers, clock, 1.5);
  assert.equal(calls('average').length, 1);
  await runMinutes(timers, clock, 0.5);
  assert.equal(calls('average').length, 2);
  await runMinutes(timers, clock, 60);
  assert.equal(calls('average').length, 32);
  assert.equal(calls('config').length, 1);
});

test('momentary values read /data', async () => {
  const { gladys } = await setup({ config: { ...BASE, values: 'momentary' } });
  await createAll(gladys);
  assert.equal(calls('average').length, 0);
  assert.equal(gladys.fake.lastState(`${DEVICE}:co2`), 700);
});

test('a refused password stops the reads for 6 hours, says so, and never logs it', async () => {
  const { gladys, timers, clock, answers, logger } = await setup({ start: false });
  answers.config = () => airq(CONFIG, 'the real one');
  const instance = new AirQApp({
    gladys,
    logger,
    now: () => clock.now,
    timers,
    storage: memoryStorage(),
  });
  await instance.start(BASE);
  assert.equal(calls('config').length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /password refused/);
  assert.match(gladys.fake.connectionStatus.message.fr, /mot de passe refusé/);
  await runMinutes(timers, clock, 6 * 60 - 1);
  assert.equal(calls('config').length, 1, 'no retry before 6 hours');
  await runMinutes(timers, clock, 1);
  assert.equal(calls('config').length, 2, 'one new try after 6 hours');
  for (const line of logger.lines) {
    assert.ok(!line.includes(PASSWORD), line);
  }
});

test('the refusal survives a restart of the container, not a new password', async () => {
  const storage = memoryStorage();
  const first = await setup({ storage, start: false });
  first.answers.config = () => airq(CONFIG, 'the real one');
  const app1 = new AirQApp({
    gladys: first.gladys,
    logger: first.logger,
    now: () => first.clock.now,
    timers: first.timers,
    storage,
  });
  await app1.start(BASE);
  assert.equal(calls('config').length, 1);
  const saved = JSON.stringify(storage.load());
  assert.ok(!saved.includes(PASSWORD), 'the password is never written');
  assert.match(saved, /refusedUntil/);
  fake.restore();

  // The container restarts: same password, still refused, no call.
  const second = await setup({ storage });
  assert.equal(calls('config').length, 0);
  assert.equal(second.gladys.fake.connectionStatus.connected, false);
  fake.restore();

  // The user enters another password (after a restart too): read at once.
  const third = await setup({ storage, start: false });
  third.answers.config = () => airq(CONFIG, 'another');
  third.answers.average = () => airq(AVERAGE, 'another');
  await third.app.start({ ...BASE, airq_1_password: 'another' });
  assert.equal(calls('config').length, 1);
  assert.equal(third.gladys.fake.connectionStatus.connected, true);
});

test('a refused password, then the right one in the configuration: read at once', async () => {
  const { app, gladys, answers } = await setup({ start: false });
  answers.config = () => airq(CONFIG, 'right');
  answers.average = () => airq(AVERAGE, 'right');
  await app.start(BASE);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  await app.start({ ...BASE, airq_1_password: 'right' });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(calls('average').length, 1);
});

test('429 / 5xx: a pause from Retry-After, persisted, never faster than the interval', async () => {
  const storage = memoryStorage();
  const { app, timers, clock, answers } = await setup({ storage, start: false });
  answers.config = () => json({}, 429, { 'retry-after': '1800' });
  await app.start(BASE);
  assert.equal(calls('config').length, 1);
  await runMinutes(timers, clock, 29);
  assert.equal(calls('config').length, 1, 'paused for 30 minutes');
  fake.restore();
  // A restart during the pause makes no call either.
  await setup({ storage });
  assert.equal(calls('config').length, 0);
  fake.restore();
  // Without Retry-After: 5 minutes, then 10, never under the interval.
  const other = await setup({ start: false });
  other.answers.average = () => json({}, 503);
  await other.app.start(BASE);
  assert.equal(calls('average').length, 1);
  await runMinutes(other.timers, other.clock, 4.5);
  assert.equal(calls('average').length, 1);
  await runMinutes(other.timers, other.clock, 0.5);
  assert.equal(calls('average').length, 2);
  await runMinutes(other.timers, other.clock, 9.5);
  assert.equal(calls('average').length, 2);
  await runMinutes(other.timers, other.clock, 0.5);
  assert.equal(calls('average').length, 3);
});

test('a device down: tried again at the interval, never sooner; the others go on', async () => {
  const config = {
    ...BASE,
    airq_2_address: '192.168.1.51',
    airq_2_password: PASSWORD,
  };
  const { gladys, timers, clock, answers } = await setup({ config, start: false });
  const second = { ...CONFIG, id: 'fedcb4567890abcdef1234567890abcd', devicename: 'Chambre' };
  answers.config = (c) => {
    if (c.url.includes('.51/')) {
      throw new TypeError('fetch failed');
    }
    return airq(CONFIG);
  };
  const app = new AirQApp({ gladys, logger: recordingLogger(), now: () => clock.now, timers });
  await app.start(config);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(
    gladys.fake.connectionStatus.message.en,
    /air-Q 2 \(192\.168\.1\.51\) \(no answer\)/,
  );
  const tries = () => fake.calls.filter((c) => c.url.includes('.51/')).length;
  await runMinutes(timers, clock, 1.5);
  assert.equal(tries(), 1);
  answers.config = (c) => airq(c.url.includes('.51/') ? second : CONFIG);
  answers.average = (c) =>
    airq(c.url.includes('.51/') ? { ...AVERAGE, DeviceID: second.id } : AVERAGE);
  await runMinutes(timers, clock, 0.5);
  assert.equal(tries(), 2 + 1, '/config then /average');
  assert.equal(gladys.fake.discoveredDevices.length, 2);
});

test('a reconnection to Gladys republishes the status and the Discovery, without a read', async () => {
  const { app, gladys } = await setup();
  const before = fake.calls.length;
  const statuses = gladys.fake.connectionStatuses.length;
  const discoveries = gladys.fake.bodies('POST', '/discovered_device').length;
  await app.start(BASE);
  assert.equal(fake.calls.length, before, 'nothing was due');
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, discoveries + 1);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
});

test('a sensor warming up never removes a created feature', async () => {
  const { gladys, timers, clock, answers } = await setup();
  await createAll(gladys);
  const { no2: _no2, ...without } = AVERAGE;
  answers.average = () => airq({ ...without, Status: { no2: 'sensor still in warm up phase' } });
  await runMinutes(timers, clock, 2);
  const [device] = gladys.fake.discoveredDevices;
  assert.ok(device.features.some((f) => f.external_id === `${DEVICE}:no2`));
});

test('the same air-Q at two addresses: one device, the second says so', async () => {
  const config = { ...BASE, airq_2_address: '192.168.1.51', airq_2_password: PASSWORD };
  const { gladys } = await setup({ config });
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.match(gladys.fake.connectionStatus.message.en, /same air-Q as another address/);
});

test('the test button never reads before the interval; then it may retry a refused password', async () => {
  const { app, gladys, answers, clock } = await setup({ start: false });
  answers.config = () => airq(CONFIG, 'other');
  await app.start(BASE);
  assert.equal(calls('config').length, 1);
  answers.config = () => airq(CONFIG);
  // 30 s later: no request, the last state and the time of the next read.
  clock.now += 30_000;
  const early = await app.testConnection();
  assert.equal(calls('config').length, 1, 'never sooner than the interval');
  assert.match(early.en, /password refused, next read possible at 18:02 UTC/);
  assert.match(early.fr, /mot de passe refusé, prochaine lecture possible à 18:02 UTC/);
  // Once the interval has passed, the button tries the refused password (the
  // periodic reads would wait 6 hours).
  clock.now += 90_000;
  const result = await app.testConnection();
  assert.equal(calls('config').length, 2, 'the button tries the refused password');
  assert.match(result.en, /Salon \(air-Q\): CO2 612 ppm/);
  assert.match(result.fr, /température 21,8 °C/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('nothing configured, or a slot incomplete: the status says it', async () => {
  const empty = await setup({ config: {} });
  assert.deepEqual(empty.gladys.fake.connectionStatus, {
    connected: false,
    message: T.notConfigured,
  });
  assert.equal(fake.calls.length, 0);
  fake.restore();
  const half = await setup({ config: { airq_1_address: '192.168.1.50' } });
  assert.match(
    half.gladys.fake.connectionStatus.message.fr,
    /air-Q 1 ignoré : mot de passe manquant/,
  );
});

test('the action handler answers through the SDK', async () => {
  const { gladys } = await setup();
  const answer = await gladys.fake.action(ACTIONS.TEST);
  assert.ok(answer);
});

test('a refusal ends 6 hours later, then the reads resume', async () => {
  const { app, timers, clock, answers } = await setup({ start: false });
  answers.config = () => airq(CONFIG, 'other');
  await app.start(BASE);
  answers.config = () => airq(CONFIG);
  clock.now += REFUSED_BACKOFF;
  await timers.runIntervals();
  assert.equal(calls('average').length, 1);
});
