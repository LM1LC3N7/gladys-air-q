// -----------------------------------------------------------------------------
// Fakes for the tests: fetch (routes requests to handlers, records every call,
// fails loudly on an unexpected URL), an air-Q answer built with the real
// cipher, and timers (nothing fires by itself). No test touches the network
// nor the disk.
// -----------------------------------------------------------------------------

import { createCipher } from '../../src/cipher.js';
import { setFetch } from '../../src/http.js';

setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export const PASSWORD = 'airq-Secret-42';

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** An air-Q answer: `{"content": ...}` opened by `password`. */
export const airq = (document, password = PASSWORD) =>
  json({ content: createCipher(password).encode(JSON.stringify(document)) });

export const CONFIG = {
  id: '123ab4567890abcdef1234567890abcd',
  devicename: 'Salon',
  type: 'air-Q Pro',
  'air-Q-Software-Version': '1.8.5',
  'air-Q-Hardware-Version': 'D_1.1',
};

export const AVERAGE = {
  DeviceID: '123ab4567890abcdef1234567890abcd',
  Status: 'OK',
  timestamp: 1760983200000,
  co2: [612.3, 40.1],
  tvoc: [151, 20],
  pm1_SPS30: [3, 1],
  pm2_5_SPS30: [4.27, 1],
  pm10_SPS30: [6.1, 1],
  co: [0.42, 0.1],
  no2: [12.5, 3],
  o3: [-2.1, 4],
  temperature: [21.84, 0.3],
  humidity: [44.2, 1],
  humidity_abs: [8.5, 0.2],
  dewpt: [9.1, 0.5],
  pressure: [1013.25, 1],
  sound: 38.4,
  sound_max: 52.9,
  radon: [12, 4],
  health: 912,
  performance: 845,
};

/** Install a fake fetch; `routes` is a list of [RegExp, handler(call)]. */
export function installFetch(routes) {
  const calls = [];
  const previous = setFetch(async (url, init = {}) => {
    const call = { url, init };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) {
      throw new Error(`Unexpected network call in a test: ${url}`);
    }
    return route[1](call);
  });
  return { calls, restore: () => setFetch(previous) };
}

export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const add = (kind, fn, ms) => {
    const id = nextId++;
    pending.set(id, { id, kind, fn, ms });
    return id;
  };
  return {
    pending,
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    intervals: () => [...pending.values()].filter((t) => t.kind === 'interval'),
    async runIntervals() {
      for (const t of [...pending.values()].filter((t) => t.kind === 'interval')) {
        await t.fn();
      }
    },
  };
}

/** A logger that keeps every line, to check that no password reaches it. */
export function recordingLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => String(a?.message ?? a)).join(' ')}`);
  return {
    lines,
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    debug: keep('debug'),
  };
}
