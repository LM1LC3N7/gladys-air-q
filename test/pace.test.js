// -----------------------------------------------------------------------------
// Review 1 (scenarios H1-H6): an air-Q is never read faster than its interval
// (test button, restart, saved configuration, disconnection during a read),
// and the values of another air-Q are never published under the id of the
// first one.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AirQApp } from '../src/app.js';
import { TICK } from '../src/constants.js';
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
const BASE = { airq_1_address: '192.168.1.50', airq_1_password: PASSWORD };
const DEVICE = `ext:air-q:airq:${CONFIG.id}`;
const OTHER = { ...CONFIG, id: 'fedcb4567890abcdef1234567890abcd', devicename: 'Chambre' };

let fake;
afterEach(() => fake?.restore());

async function setup({ config = BASE, storage = memoryStorage(), clock = { now: NOW } } = {}) {
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
  const app = new AirQApp({
    gladys,
    logger: recordingLogger(),
    now: () => clock.now,
    timers,
    storage,
  });
  gladys.onDeviceCreated(() => app.publishStates());
  await gladys.connect();
  return { app, gladys, timers, clock, answers, storage };
}

const calls = (route) => fake.calls.filter((c) => c.url.endsWith(`/${route}`));
const down = () => {
  throw new TypeError('fetch failed');
};

test('H1 the test button never reads closer than the interval to the last read', async () => {
  const { app, clock } = await setup();
  await app.start(BASE);
  assert.equal(calls('average').length, 1);
  let answer;
  for (let i = 0; i < 5; i += 1) {
    clock.now += 10_000;
    answer = await app.testConnection();
  }
  assert.equal(calls('average').length, 1);
  // The button answers with the last values and the time of the next read.
  assert.match(answer.en, /CO2 612 ppm.*next read possible at 18:02 UTC/);
  clock.now += 70_000;
  await app.testConnection();
  assert.equal(calls('average').length, 2, 'once the interval has passed');
});

test('H2 the test button does not lift the interval after a passing failure', async () => {
  const { app, clock, answers } = await setup();
  answers.config = down;
  await app.start(BASE);
  assert.equal(calls('config').length, 1);
  for (let i = 0; i < 5; i += 1) {
    clock.now += 5_000;
    await app.testConnection();
  }
  assert.equal(calls('config').length, 1);
});

test('H3 a restart 30 s after a read: no read, the Discovery and the status kept', async () => {
  const storage = memoryStorage();
  const clock = { now: NOW };
  const first = await setup({ storage, clock });
  await first.app.start(BASE);
  first.app.stop();
  fake.restore();
  clock.now += 30_000;
  const second = await setup({ storage, clock });
  await second.app.start(BASE);
  assert.equal(fake.calls.length, 0, 'read again 30 s later, interval 2 min');
  const [device] = second.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE, 'the device known before the restart');
  assert.equal(device.name, 'Salon (air-Q)');
  assert.ok(device.features.some((f) => f.external_id === `${DEVICE}:co2`));
  assert.equal(second.gladys.fake.connectionStatus.connected, true);
  // The id and the name only: nothing secret in the file.
  assert.ok(!JSON.stringify(storage.load()).includes(PASSWORD));
  // At the interval, /config is read again (the address may lead elsewhere).
  clock.now += 90_000;
  await second.timers.runIntervals();
  assert.equal(calls('config').length, 1);
  assert.equal(calls('average').length, 1);
});

test('H3b a restart 30 s after a network failure does not try again at once', async () => {
  const storage = memoryStorage();
  const clock = { now: NOW };
  const first = await setup({ storage, clock });
  first.answers.config = down;
  await first.app.start(BASE);
  first.app.stop();
  fake.restore();
  clock.now += 30_000;
  const second = await setup({ storage, clock });
  second.answers.config = down;
  await second.app.start(BASE);
  assert.equal(calls('config').length, 0);
});

test('H4 saving the configuration keeps the pace; a new password or address reads at once', async () => {
  const { app, clock, answers } = await setup();
  answers.config = down;
  await app.start(BASE);
  for (const minutes of [3, 4, 5, 6]) {
    clock.now += 5_000;
    await app.start({ ...BASE, poll_interval: minutes });
  }
  assert.equal(calls('config').length, 1);
  answers.config = () => airq(CONFIG, 'new one');
  answers.average = () => airq(AVERAGE, 'new one');
  await app.start({ ...BASE, poll_interval: 6, airq_1_password: 'new one' });
  assert.equal(calls('config').length, 2, 'a new password is tried at once');
  await app.start({ ...BASE, airq_1_address: '192.168.1.60', airq_1_password: 'new one' });
  assert.equal(calls('config').length, 3, 'a new address is read at once');
});

test('M2 a new password reads /config again', async () => {
  const { app, clock, answers } = await setup();
  await app.start(BASE);
  assert.equal(calls('config').length, 1);
  clock.now += 5_000;
  answers.config = () => airq(CONFIG, 'new one');
  answers.average = () => airq(AVERAGE, 'new one');
  await app.start({ ...BASE, airq_1_password: 'new one' });
  assert.equal(calls('config').length, 2);
});

test('H5 a disconnection during a read: no second read right after the reconnection', async () => {
  const { app, answers } = await setup();
  let release;
  answers.average = () =>
    new Promise((resolve) => {
      release = () => resolve(airq(AVERAGE));
    });
  const starting = app.start(BASE);
  await new Promise((r) => setTimeout(r, 20));
  app.stop();
  release();
  await starting;
  answers.average = () => airq(AVERAGE);
  await app.start(BASE);
  assert.equal(calls('average').length, 1);
});

test('H5b a 429 answered during a disconnection is not forgotten', async () => {
  const { app, answers, clock, timers } = await setup();
  let release;
  answers.config = () =>
    new Promise((resolve) => {
      release = () => resolve(json({}, 429, { 'retry-after': '1800' }));
    });
  const starting = app.start(BASE);
  await new Promise((r) => setTimeout(r, 20));
  app.stop();
  release();
  await starting;
  answers.config = () => json({}, 429, { 'retry-after': '1800' });
  await app.start(BASE);
  assert.equal(calls('config').length, 1);
  // The pause of 30 minutes holds, not only the interval.
  for (let i = 0; i < (29 * 60_000) / TICK; i += 1) {
    clock.now += TICK;
    await timers.runIntervals();
  }
  assert.equal(calls('config').length, 1);
});

test('H6 two air-Q swap their addresses: values never published under the other id', async () => {
  const config = { ...BASE, airq_2_address: '192.168.1.51', airq_2_password: PASSWORD };
  const { app, gladys, timers, clock, answers } = await setup({ config });
  const swapped = { value: false };
  const isOther = (c) => c.url.includes('.51/') !== swapped.value;
  answers.config = (c) => airq(isOther(c) ? OTHER : CONFIG);
  answers.average = (c) =>
    isOther(c) ? airq({ ...AVERAGE, DeviceID: OTHER.id, co2: 2000 }) : airq(AVERAGE);
  await app.start(config);
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
  assert.equal(gladys.fake.lastState(`${DEVICE}:co2`), 612);
  assert.equal(gladys.fake.lastState(`ext:air-q:airq:${OTHER.id}:co2`), 2000);
  // A power cut: the router gives the two air-Q each other's address.
  swapped.value = true;
  for (let i = 0; i < (10 * 60_000) / TICK; i += 1) {
    clock.now += TICK;
    await timers.runIntervals();
    assert.equal(gladys.fake.lastState(`${DEVICE}:co2`), 612, 'Chambre values published as Salon');
    assert.equal(gladys.fake.lastState(`ext:air-q:airq:${OTHER.id}:co2`), 2000);
  }
  // Each device found again at its new address: still two devices.
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id).sort(),
    [DEVICE, `ext:air-q:airq:${OTHER.id}`].sort(),
  );
  // Its own values, under its own id: Salon now answers at .51.
  answers.average = (c) =>
    isOther(c)
      ? airq({ ...AVERAGE, DeviceID: OTHER.id, co2: 2100 })
      : airq({ ...AVERAGE, co2: 650 });
  for (let i = 0; i < (4 * 60_000) / TICK; i += 1) {
    clock.now += TICK;
    await timers.runIntervals();
  }
  assert.equal(gladys.fake.lastState(`${DEVICE}:co2`), 650);
  assert.equal(gladys.fake.lastState(`ext:air-q:airq:${OTHER.id}:co2`), 2100);
});

test('I3 /data never holds a fingerprint of a password that works', async () => {
  const storage = memoryStorage();
  const clock = { now: NOW };
  const fps = () => Object.values(storage.load()?.devices ?? {}).map((d) => d.fp);
  // A successful read: no fingerprint at all.
  const first = await setup({ storage, clock });
  await first.app.start(BASE);
  assert.equal(calls('average').length, 1);
  assert.deepEqual(fps(), ['']);
  // A refused password: the fingerprint of that wrong password only.
  clock.now += 2 * 60_000;
  first.answers.config = () => airq(CONFIG, 'the real one');
  await first.app.start({ ...BASE, airq_1_password: 'wrong one' });
  assert.equal(calls('config').length, 2);
  assert.match(fps()[0], /^[0-9a-f]{32}$/);
  // The right password: read at once, the fingerprint erased.
  first.answers.average = () => airq(AVERAGE, 'the real one');
  await first.app.start({ ...BASE, airq_1_password: 'the real one' });
  assert.equal(calls('average').length, 2);
  assert.deepEqual(fps(), ['']);
  first.app.stop();
  fake.restore();
  // A restart with another password and no refusal: the pace is kept (at
  // most one interval), since nothing in /data names the old password.
  clock.now += 30_000;
  const second = await setup({ storage, clock });
  second.answers.config = () => airq(CONFIG, 'changed while stopped');
  second.answers.average = () => airq(AVERAGE, 'changed while stopped');
  await second.app.start({ ...BASE, airq_1_password: 'changed while stopped' });
  assert.equal(fake.calls.length, 0);
  clock.now += 90_000;
  await second.timers.runIntervals();
  assert.equal(calls('average').length, 1);
  assert.deepEqual(fps(), ['']);
});

test('M5 an address that leads to the same air-Q as another sends no request after the first', async () => {
  const config = { ...BASE, airq_2_address: '192.168.1.51', airq_2_password: PASSWORD };
  const { app, timers, clock } = await setup({ config });
  await app.start(config);
  const second = () => fake.calls.filter((c) => c.url.includes('.51/')).length;
  assert.equal(second(), 1, '/config only, then "same air-Q"');
  for (let i = 0; i < (10 * 60_000) / TICK; i += 1) {
    clock.now += TICK;
    await timers.runIntervals();
  }
  assert.equal(second(), 1);
});
