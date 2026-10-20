// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`.
// -----------------------------------------------------------------------------

import { MAX_DEVICES } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  values: 'average',
  poll_interval: 2,
};

const VALUES = ['average', 'momentary'];

const number = (value, fallback, min, max) => {
  const n = Number(value);
  return value !== '' && value !== null && value !== undefined && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
// Underscores are allowed: the air-Q announces itself as `<id>_air-q.local`.
const LABEL = /^[a-z0-9_]([a-z0-9_-]{0,62})$/;

/**
 * The address of an air-Q as the user may type it: an IPv4 address or a host
 * name, with an optional port, or the 5-character id printed on the device
 * (expanded to `<id>_air-q.local`, as aioairq does). A leading `http://` and a
 * trailing `/` are tolerated; anything else (a path, credentials, IPv6, which
 * the air-Q does not support) is refused. Returns the `host[:port]`, or null.
 */
export function parseAddress(text) {
  let value = clean(text)
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!value) {
    return null;
  }
  if (/^[0-9a-f]{5}$/.test(value)) {
    return `${value}_air-q.local`;
  }
  let port = '';
  const colon = value.lastIndexOf(':');
  if (colon !== -1) {
    port = value.slice(colon + 1);
    value = value.slice(0, colon);
    const n = Number(port);
    if (!/^\d{1,5}$/.test(port) || n < 1 || n > 65535) {
      return null;
    }
    port = `:${n}`;
  }
  if (value.length > 253) {
    return null;
  }
  const labels = value.split('.');
  const ok = IPV4.test(value) || (!/^[\d.]+$/.test(value) && labels.every((l) => LABEL.test(l)));
  return ok ? `${value}${port}` : null;
}

/**
 * The air-Q of the configuration: `airq_<n>_address` and `airq_<n>_password`.
 * A slot with an address but no password, or an address that does not parse,
 * is reported (by its number only, never its content).
 */
export function normalizeConfig(raw = {}) {
  const devices = [];
  const invalid = [];
  const seen = new Set();
  for (let n = 1; n <= MAX_DEVICES; n += 1) {
    const text = clean(raw[`airq_${n}_address`]);
    const password = typeof raw[`airq_${n}_password`] === 'string' ? raw[`airq_${n}_password`] : '';
    if (!text) {
      continue;
    }
    const address = parseAddress(text);
    if (!address || !password) {
      invalid.push({ slot: n, why: address ? 'password' : 'address' });
      continue;
    }
    if (seen.has(address)) {
      invalid.push({ slot: n, why: 'duplicate' });
      continue;
    }
    seen.add(address);
    devices.push({ slot: n, address, password });
  }
  return {
    devices,
    invalid,
    values: VALUES.includes(raw.values) ? raw.values : DEFAULT_CONFIG.values,
    pollMinutes: number(raw.poll_interval, DEFAULT_CONFIG.poll_interval, 1, 60),
  };
}
