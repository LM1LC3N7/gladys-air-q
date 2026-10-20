// -----------------------------------------------------------------------------
// The air-Q local API, read-only, after aioairq's `core.py` (Apache-2.0,
// Corant GmbH): `GET http://<address>/<route>` answers
// `{"content": "<base64>"}`, opened with the device password (src/cipher.js),
// which gives the JSON document of the route.
//
//   /config   the device description: `id`, `devicename`, `type`,
//             `air-Q-Software-Version`, `air-Q-Hardware-Version`, ...
//   /data     the momentary values; /average the rolling averages (the
//             default of aioairq and Home Assistant). A value may be a
//             number, or `[value, uncertainty]`.
//
// Nothing is ever written to the device (no POST /config, no /blink, no
// restart): this integration only reads.
// -----------------------------------------------------------------------------

import { BadContentError, WrongPasswordError } from './cipher.js';
import { ROUTES } from './constants.js';
import { NetworkError, getText } from './http.js';

/**
 * Why a read failed: `refused` (the password does not open the answer),
 * `busy` (429 or 5xx: pause), `failed` (network, another HTTP status),
 * `invalid` (not an air-Q answer). The message never holds the password.
 */
export class AirQError extends Error {
  constructor(kind, detail, { retryAfterMs } = {}) {
    super(`${kind}${detail ? ` (${detail})` : ''}`);
    this.name = 'AirQError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read one route of an air-Q and open it. */
export async function readRoute(address, cipher, route) {
  if (!Object.values(ROUTES).includes(route)) {
    throw new AirQError('invalid', 'route');
  }
  let answer;
  try {
    answer = await getText(`http://${address}/${route}`);
  } catch (err) {
    throw new AirQError('failed', err instanceof NetworkError ? err.reason : 'network');
  }
  if (answer.status === 429 || (answer.status >= 500 && answer.status <= 599)) {
    throw new AirQError('busy', `http ${answer.status}`, { retryAfterMs: answer.retryAfterMs });
  }
  if (answer.status !== 200) {
    throw new AirQError('failed', `http ${answer.status}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(answer.text);
  } catch {
    throw new AirQError('invalid', 'not JSON');
  }
  if (!isPlainObject(envelope) || typeof envelope.content !== 'string') {
    throw new AirQError('invalid', 'no content');
  }
  let text;
  try {
    text = cipher.decode(envelope.content);
  } catch (err) {
    if (err instanceof WrongPasswordError) {
      throw new AirQError('refused');
    }
    throw new AirQError('invalid', err instanceof BadContentError ? 'content' : 'decode');
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new AirQError('invalid', 'content not JSON');
  }
  if (!isPlainObject(document)) {
    throw new AirQError('invalid', 'content not an object');
  }
  return document;
}

const text = (value, max) =>
  typeof value === 'string'
    ? [...value]
        .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim()
        .slice(0, max)
    : '';

/**
 * aioairq `fetch_device_info`: the stable id (part of the external ids, so
 * kept to [a-z0-9]) and the descriptive fields. Throws `invalid` without id.
 */
export function deviceInfo(config) {
  const id = typeof config?.id === 'string' ? config.id.trim().toLowerCase() : '';
  if (!/^[a-z0-9]{5,64}$/.test(id)) {
    throw new AirQError('invalid', 'no device id');
  }
  return {
    id,
    name: text(config.devicename, 60),
    model: text(config.type, 40),
    software: text(config['air-Q-Software-Version'], 40),
  };
}
