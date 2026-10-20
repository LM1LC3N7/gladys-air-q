// -----------------------------------------------------------------------------
// Limits, pacing and the keys users store (manifest keys, device types): the
// keys are forever, never rename them.
// -----------------------------------------------------------------------------

export const USER_AGENT = 'gladys-air-q (+https://github.com/LM1LC3N7/gladys-air-q)';

/** One HTTP call to an air-Q (the device sits on the local network). */
export const HTTP_TIMEOUT = 10_000;

/** The most an answer may weigh (a few KB in practice for /data or /config). */
export const MAX_BODY = 256 * 1024;

/** The routes this integration reads: read-only, never /config in POST. */
export const ROUTES = {
  CONFIG: 'config',
  DATA: 'data',
  AVERAGE: 'average',
};

/** At most this many air-Q (one address and one password each). */
export const MAX_DEVICES = 3;

/** How often the integration checks what is due. */
export const TICK = 30_000;

/**
 * The device answers 429 or 5xx (busy, rebooting): a pause, from Retry-After
 * when given, else 5 minutes doubling; always between 1 minute and 6 hours.
 */
export const BUSY_MIN = 60_000;
export const BUSY_BASE = 5 * 60_000;
export const BUSY_MAX = 6 * 60 * 60_000;

/** A refused password: no call to that air-Q for 6 hours (or until it changes). */
export const REFUSED_BACKOFF = 6 * 60 * 60_000;

/** A value read longer ago than this is not published as current. */
export const STALE = 15 * 60_000;

/** An unchanged value is re-sent this often, so Gladys keeps it recent. */
export const HEARTBEAT = 30 * 60_000;

/** The test button answers within this, with the last values if needed. */
export const TEST_DEADLINE = 100_000;

/** Where the pauses and the refusals survive a restart. */
export const STATE_FILE = '/data/air-q-state.json';

/** Device type of the external ids (`ext:<selector>:airq:<device id>`). */
export const DEVICE_TYPE = 'airq';

/** Manifest `actions` keys. */
export const ACTIONS = {
  TEST: 'test_connection',
};
