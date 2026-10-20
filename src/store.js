// -----------------------------------------------------------------------------
// What must survive a restart of the container (a file under /data): for each
// air-Q address, the end of a pause (429/5xx) and of a refusal of the
// password, so a container restarting in a loop never hammers a device.
//
// The password is never written. To know, after a restart, whether a refusal
// still concerns the same password, the file keeps a salted scrypt
// fingerprint of it (16 bytes, a random salt per file), never the password.
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

/** The persisted pauses and refusals, by address. */
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
    /** address -> { pausedUntil, streak, refusedUntil, fp } */
    this.entries = new Map();
    const devices =
      valid && saved.devices && typeof saved.devices === 'object' ? saved.devices : {};
    const at = now();
    for (const address of Object.keys(devices).slice(0, 20)) {
      const entry = devices[address];
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      // A time read back is capped at a fresh pause: a clock that jumped, or
      // a hand-edited file, never stops a device for longer.
      this.entries.set(address, {
        pausedUntil: Math.min(finite(entry.pausedUntil), at + maxPause),
        streak: Math.min(Math.max(0, Math.floor(finite(entry.streak))), 20),
        refusedUntil: Math.min(finite(entry.refusedUntil), at + maxRefusal),
        fp: typeof entry.fp === 'string' ? entry.fp : '',
      });
    }
  }

  /** The salted fingerprint of a password for an address (never the password). */
  fingerprint(address, password) {
    return scryptSync(String(password), `${this.salt}:${address}`, 16).toString('hex');
  }

  get(address) {
    return this.entries.get(address);
  }

  /** The saved state of an address; a refusal of another password is dropped. */
  restore(address, password) {
    const entry = this.entries.get(address) ?? {
      pausedUntil: 0,
      streak: 0,
      refusedUntil: 0,
      fp: '',
    };
    if (entry.refusedUntil > this.now() && entry.fp !== this.fingerprint(address, password)) {
      entry.refusedUntil = 0;
      entry.fp = '';
    }
    this.entries.set(address, entry);
    return entry;
  }

  /** Update an address and write the file, only when something changed. */
  update(address, changes, password) {
    const entry = this.entries.get(address) ?? {
      pausedUntil: 0,
      streak: 0,
      refusedUntil: 0,
      fp: '',
    };
    const next = { ...entry, ...changes };
    if (changes.refusedUntil > 0 && password !== undefined) {
      next.fp = this.fingerprint(address, password);
    }
    if (changes.refusedUntil === 0) {
      next.fp = '';
    }
    const changed = Object.keys(next).some((key) => next[key] !== entry[key]);
    this.entries.set(address, next);
    if (changed) {
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
