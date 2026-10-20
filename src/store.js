// -----------------------------------------------------------------------------
// What must survive a restart of the container (a file under /data): for each
// air-Q address, the instant of the last request, the end of a pause
// (429/5xx) and of a refusal of the password, so a container restarting in a
// loop never reads a device faster than the interval; and the id, the name
// and the fields of the device (not secret), so the Discovery list is not
// empty after a restart.
//
// The password is never written. Only while a password is refused, the file
// keeps a salted scrypt fingerprint (16 bytes, a random salt per file) of
// that refused, wrong password, to know after a restart whether the refusal
// still concerns the configured one; it is erased by the first successful
// read. Nothing in the file can confirm a password that works.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  return {
    load: () => value,
    save: (next) => {
      value = JSON.parse(JSON.stringify(next));
    },
  };
}

/**
 * A JSON file, written atomically (a .tmp file, then a rename). A missing or
 * unreadable file is a first start (warned once, without its content); a
 * write failure is warned once: memory only then.
 */
export function fileStorage(path, { logger } = {}) {
  const warned = new Set();
  const warnOnce = (kind, text) => {
    if (!warned.has(kind)) {
      warned.add(kind);
      logger?.warn?.(text);
    }
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnOnce('read', `State file unreadable (${err.code ?? 'error'}): starting afresh`);
        }
        return undefined;
      }
      if (text.length > 64 * 1024) {
        warnOnce('read', 'State file too large: starting afresh');
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        warnOnce('read', 'State file corrupt: starting afresh');
        return undefined;
      }
    },
    save(value) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch (err) {
        warnOnce('write', `State file not writable (${err.code ?? 'error'}): kept in memory`);
      }
    },
  };
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const cleanText = (value, max) =>
  typeof value === 'string'
    ? [...value]
        .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim()
        .slice(0, max)
    : '';

/** The device info read back from the file, or undefined when it does not look right. */
function infoOf(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.id !== 'string' ||
    !/^[a-z0-9]{5,64}$/.test(value.id)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    name: cleanText(value.name, 60),
    model: cleanText(value.model, 40),
    software: cleanText(value.software, 40),
  };
}

const fieldsOf = (value) =>
  Array.isArray(value)
    ? value.filter((f) => typeof f === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(f)).slice(0, 50)
    : [];

const EMPTY = Object.freeze({
  lastAttemptAt: 0,
  pausedUntil: 0,
  streak: 0,
  refusedUntil: 0,
  fp: '',
  info: undefined,
  fields: [],
});

/** The persisted state of each air-Q, by address. */
export class DeviceStore {
  constructor({ storage = memoryStorage(), now = Date.now, maxPause, maxRefusal }) {
    this.storage = storage;
    this.now = now;
    const saved = storage.load();
    const valid = saved && typeof saved === 'object' && !Array.isArray(saved);
    this.salt =
      valid && typeof saved.salt === 'string' && /^[0-9a-f]{32}$/.test(saved.salt)
        ? saved.salt
        : randomBytes(16).toString('hex');
    /** address -> { lastAttemptAt, pausedUntil, streak, refusedUntil, fp, info, fields } */
    this.entries = new Map();
    const devices =
      valid && saved.devices && typeof saved.devices === 'object' ? saved.devices : {};
    const at = now();
    for (const address of Object.keys(devices).slice(0, 20)) {
      const entry = devices[address];
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      // A time read back is capped (a request never "in the future", a pause
      // never longer than a fresh one): a clock that jumped, or a hand-edited
      // file, never stops a device for longer.
      this.entries.set(address, {
        lastAttemptAt: Math.min(finite(entry.lastAttemptAt), at),
        pausedUntil: Math.min(finite(entry.pausedUntil), at + maxPause),
        streak: Math.min(Math.max(0, Math.floor(finite(entry.streak))), 20),
        refusedUntil: Math.min(finite(entry.refusedUntil), at + maxRefusal),
        fp:
          typeof entry.fp === 'string' && finite(entry.refusedUntil) > at
            ? entry.fp.slice(0, 64)
            : '',
        info: infoOf(entry.info),
        fields: fieldsOf(entry.fields),
      });
    }
  }

  /** The salted fingerprint of a password for an address (never the password). */
  fingerprint(address, password) {
    return scryptSync(String(password), `${this.salt}:${address}`, 16).toString('hex');
  }

  get(address) {
    return this.entries.get(address) ?? EMPTY;
  }

  /**
   * The saved state of an address for the configured password. A new
   * password drops the refusal and the instant of the last request (tried at
   * once): told apart in memory while the process runs; after a restart,
   * only a refused password is known (its fingerprint), so a password
   * changed while the container was stopped waits at most one interval.
   * Returns `{ entry, passwordChanged }`.
   */
  restore(address, password) {
    const entry = { ...EMPTY, ...this.entries.get(address) };
    this.passwords = this.passwords ?? new Map();
    let passwordChanged = false;
    if (this.passwords.has(address)) {
      passwordChanged = this.passwords.get(address) !== password;
    } else if (entry.fp && entry.refusedUntil > this.now()) {
      passwordChanged = entry.fp !== this.fingerprint(address, password);
    }
    this.passwords.set(address, password);
    const before = JSON.stringify(entry);
    if (passwordChanged) {
      entry.refusedUntil = 0;
      entry.lastAttemptAt = 0;
    }
    if (entry.refusedUntil <= this.now()) {
      // The fingerprint only ever names a refused (wrong) password, and only
      // while the refusal lasts: never one that works.
      entry.fp = '';
    }
    this.entries.set(address, entry);
    if (JSON.stringify(entry) !== before) {
      this.save();
    }
    return { entry, passwordChanged };
  }

  /**
   * Update an address and write the file, only when something changed. A
   * refusal (`refusedUntil` > 0, with the refused `password`) keeps the
   * fingerprint of that password; anything else erases it.
   */
  update(address, changes, password) {
    const entry = { ...EMPTY, ...this.entries.get(address) };
    const next = { ...entry, ...changes };
    if (changes.refusedUntil > 0 && password !== undefined) {
      next.fp = this.fingerprint(address, password);
    } else if (!(next.refusedUntil > this.now())) {
      next.fp = '';
    }
    this.entries.set(address, next);
    if (JSON.stringify(next) !== JSON.stringify(entry)) {
      this.save();
    }
    return next;
  }

  /** Keep only the configured addresses. */
  keep(addresses) {
    let changed = false;
    for (const address of [...this.entries.keys()]) {
      if (!addresses.includes(address)) {
        this.entries.delete(address);
        changed = true;
      }
    }
    if (changed) {
      this.save();
    }
  }

  save() {
    this.storage.save({ salt: this.salt, devices: Object.fromEntries(this.entries) });
  }
}
