import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { AirQError, deviceInfo, readRoute } from '../src/airq.js';
import { createCipher } from '../src/cipher.js';
import { MAX_BODY } from '../src/constants.js';
import { CONFIG, PASSWORD, airq, installFetch, json } from './helpers/fakes.js';

let fake;
afterEach(() => fake?.restore());

const cipher = createCipher(PASSWORD);

const failure = async (promise) => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof AirQError, String(err));
    assert.ok(!err.message.includes(PASSWORD));
    return err;
  }
  assert.fail('no error');
};

test('GET http://<address>/<route>, opened with the password', async () => {
  fake = installFetch([[/^http:\/\/192\.168\.1\.50\/config$/, () => airq(CONFIG)]]);
  assert.deepEqual(await readRoute('192.168.1.50', cipher, 'config'), CONFIG);
  const [call] = fake.calls;
  assert.equal(call.init.redirect, 'error', 'no redirection followed');
  assert.match(call.init.headers['User-Agent'], /^gladys-air-q/);
  assert.equal(call.init.method, undefined, 'a GET, never a POST');
  assert.ok(!call.url.includes(PASSWORD), 'the password never travels');
});

test('only the read routes', async () => {
  for (const route of ['blink', 'config?x', 'file', '']) {
    assert.equal((await failure(readRoute('h', cipher, route))).kind, 'invalid');
  }
});

test('a wrong password is "refused"', async () => {
  fake = installFetch([[/./, () => airq(CONFIG, 'another one')]]);
  assert.equal((await failure(readRoute('h', cipher, 'data'))).kind, 'refused');
});

test('429 and 5xx: "busy", with Retry-After', async () => {
  fake = installFetch([[/./, () => json({}, 429, { 'retry-after': '120' })]]);
  const err = await failure(readRoute('h', cipher, 'data'));
  assert.equal(err.kind, 'busy');
  assert.equal(err.retryAfterMs, 120_000);
  fake.restore();
  fake = installFetch([[/./, () => json({}, 503)]]);
  assert.equal((await failure(readRoute('h', cipher, 'data'))).kind, 'busy');
});

test('other statuses, the network, odd answers', async () => {
  fake = installFetch([[/./, () => json({}, 404)]]);
  assert.equal((await failure(readRoute('h', cipher, 'data'))).kind, 'failed');
  fake.restore();
  fake = installFetch([
    [
      /./,
      () => {
        throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EHOSTUNREACH' } });
      },
    ],
  ]);
  const network = await failure(readRoute('h', cipher, 'data'));
  assert.equal(network.kind, 'failed');
  assert.match(network.message, /EHOSTUNREACH/);
  for (const answer of [
    () => new Response('<html>'),
    () => json([1]),
    () => json({ content: 42 }),
    () => json({ content: 'not base64 !' }),
    () => json({ content: cipher.encode('not json') }),
    () => json({ content: cipher.encode('[1,2]') }),
  ]) {
    fake.restore();
    fake = installFetch([[/./, answer]]);
    assert.equal((await failure(readRoute('h', cipher, 'data'))).kind, 'invalid');
  }
});

test('a body too large is cut and fails', async () => {
  fake = installFetch([[/./, () => new Response('x'.repeat(MAX_BODY + 10))]]);
  const err = await failure(readRoute('h', cipher, 'data'));
  assert.equal(err.kind, 'failed');
  assert.match(err.message, /too large/);
});

test('device info: a stable id, cleaned texts', () => {
  assert.deepEqual(deviceInfo({ ...CONFIG, devicename: 'Salon\u0007' }), {
    id: CONFIG.id,
    name: 'Salon',
    model: 'air-Q Pro',
    software: '1.8.5',
  });
  for (const bad of [{}, { id: 'ab' }, { id: '../x' }, { id: 12345 }, null]) {
    assert.throws(() => deviceInfo(bad), AirQError);
  }
});
