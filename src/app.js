// -----------------------------------------------------------------------------
// The integration itself: the air-Q to read, when each is due, the pauses and
// refusals, the Gladys devices and states built from the readings, the
// connection status and the test button. index.js only wires the SDK
// handlers to it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { AirQError, deviceInfo, readRoute } from './airq.js';
import { createCipher } from './cipher.js';
import { normalizeConfig } from './config.js';
import {
  BUSY_BASE,
  BUSY_MAX,
  BUSY_MIN,
  HEARTBEAT,
  REFUSED_BACKOFF,
  ROUTES,
  STALE,
  TEST_DEADLINE,
  TICK,
} from './constants.js';
import { T, reason } from './i18n.js';
import { createdFeatures, deviceOf, statesOf, valuesOf, warmingUp } from './readings.js';
import { DeviceStore, memoryStorage } from './store.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };

/** 12.54 -> "12.5", "12,5" in French. */
const numberText = (value, lang) => {
  const text = String(Math.round(value * 10) / 10);
  return lang === 'fr' ? text.replace('.', ',') : text;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class AirQApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'air-q' }),
    now = Date.now,
    timers = defaultTimers,
    storage = memoryStorage(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.config = normalizeConfig();
    // The pauses and refusals live as long as the process, across restarts
    // of the app and reconnections to Gladys, and in /data across restarts
    // of the container.
    this.store = new DeviceStore({
      storage,
      now,
      maxPause: BUSY_MAX,
      maxRefusal: REFUSED_BACKOFF,
    });
    /** The configured air-Q: [{ slot, address, password, cipher }]. */
    this.slots = [];
    /** address -> { info, confirmed, values, warming, readAt, fields, nextDue, error } */
    this.track = new Map();
    this.interval = undefined;
    this.ticking = undefined;
    this.chain = Promise.resolve();
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(raw = {}) {
    this.stop();
    const generation = ++this.generation;
    this.config = normalizeConfig(raw);
    this.started = true;
    this.slots = this.config.devices.map((device) => ({
      ...device,
      cipher: createCipher(device.password),
    }));
    const addresses = this.slots.map((s) => s.address);
    for (const address of [...this.track.keys()]) {
      if (!addresses.includes(address)) {
        this.track.delete(address);
      }
    }
    this.store.keep(addresses);
    for (const slot of this.slots) {
      // The store drops the refusal and the last request of another password
      // (in this process or before a restart): a new password, like a new
      // address, is tried at once. Anything else (a reconnection to Gladys,
      // a restart of the container, a new interval) keeps the pace: the next
      // read is never before the last request + the interval.
      const { entry: saved, passwordChanged } = this.store.restore(slot.address, slot.password);
      let entry = this.track.get(slot.address);
      if (!entry) {
        // After a restart: the device known before (id, name, fields, not
        // secret) keeps the Discovery list filled until the next read.
        entry = { fields: new Set(saved.fields), info: saved.info, confirmed: false, nextDue: 0 };
        this.track.set(slot.address, entry);
      }
      if (passwordChanged) {
        // Another password may reach another device: /config is read again.
        entry.confirmed = false;
        entry.error = undefined;
      }
      // After a restart, the status says at once that an air-Q is refused or
      // paused, without asking it.
      if (!entry.error && saved.refusedUntil > this.now()) {
        entry.error = new AirQError('refused');
      } else if (!entry.error && saved.pausedUntil > this.now()) {
        entry.error = new AirQError('busy');
      }
      entry.nextDue = this.earliestRead(slot.address);
    }
    // Gladys keeps the status and the Discovery list in memory only: a
    // (re)connection may follow a restart of the core, so both are published
    // again even when nothing changed.
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    await this.tick();
    if (generation !== this.generation) {
      return;
    }
    this.interval = this.timers.setInterval(
      () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${this.scrub(err)}`)),
      TICK,
    );
    await this.publishDiscovered();
    await this.refreshStatus();
  }

  stop() {
    this.generation += 1;
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** An error message without any password. */
  scrub(err) {
    let message = String(err?.message ?? err);
    for (const { password } of this.slots) {
      if (password && password.length >= 4) {
        const pattern = new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        message = message.replace(pattern, '***');
      }
    }
    return message;
  }

  /** Run `fn` after every read already queued: never two reads of an air-Q at once. */
  exclusive(fn) {
    const run = this.chain.catch(() => {}).then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // --- Reading -----------------------------------------------------------------------

  /** Read what is due (a tick never overlaps another). */
  tick() {
    if (this.ticking && this.tickGeneration === this.generation) {
      return this.ticking;
    }
    const generation = this.generation;
    const run = this.exclusive(() => this.readDue()).finally(() => {
      if (this.ticking === run) {
        this.ticking = undefined;
      }
    });
    this.ticking = run;
    this.tickGeneration = generation;
    return run;
  }

  async readDue() {
    const generation = this.generation;
    let changed = false;
    for (const slot of this.slots) {
      if (generation !== this.generation) {
        return;
      }
      const entry = this.track.get(slot.address);
      if (entry && this.now() >= entry.nextDue) {
        await this.read(slot);
        changed = true;
      }
    }
    if (changed && generation === this.generation) {
      await this.publish();
      await this.refreshStatus();
    }
  }

  intervalMs() {
    return this.config.pollMinutes * 60_000;
  }

  /** The earliest periodic read of an address: interval, pause and refusal kept. */
  earliestRead(address) {
    const saved = this.store.get(address);
    return Math.max(saved.lastAttemptAt + this.intervalMs(), saved.pausedUntil, saved.refusedUntil);
  }

  /** Values read recently enough to be published as current. */
  isFresh(entry, now) {
    return Boolean(entry?.values) && now - entry.readAt <= Math.max(STALE, 2 * this.intervalMs());
  }

  /** Another configured air-Q, earlier in the list, already gives this device id. */
  duplicateOf(slot, id) {
    return this.slots.some(
      (other) =>
        other.slot < slot.slot && this.track.get(other.address)?.info?.id === id && other !== slot,
    );
  }

  /**
   * Read one air-Q if its interval has passed; never throws. Nothing, not
   * even the test button (`manual`), reads an air-Q before its last request
   * + the interval, nor during a pause asked by the device; `manual` may try
   * a refused password again once the interval has passed. Returns whether a
   * request was sent.
   */
  async read(slot, { manual = false } = {}) {
    const generation = this.generation;
    const entry = this.track.get(slot.address);
    if (!entry) {
      return false;
    }
    const saved = this.store.get(slot.address);
    const now = this.now();
    const earliest = Math.max(saved.lastAttemptAt + this.intervalMs(), saved.pausedUntil);
    if (now < earliest) {
      if (now < saved.pausedUntil) {
        entry.error = entry.error ?? new AirQError('busy');
      }
      entry.nextDue = Math.max(entry.nextDue, this.earliestRead(slot.address));
      return false;
    }
    if (!manual && now < saved.refusedUntil) {
      entry.error = new AirQError('refused');
      entry.nextDue = Math.max(entry.nextDue, saved.refusedUntil);
      return false;
    }
    // The request may leave now: recorded first (and persisted), so neither a
    // reconnection, a saved configuration nor a restart reads again sooner.
    this.store.update(slot.address, { lastAttemptAt: now });
    entry.nextDue = now + this.intervalMs();
    const current = () => generation === this.generation;
    try {
      if (!entry.confirmed || !entry.info) {
        const info = deviceInfo(await readRoute(slot.address, slot.cipher, ROUTES.CONFIG));
        if (!current()) {
          return true;
        }
        if (entry.info && entry.info.id !== info.id) {
          // Another air-Q answers at this address (addresses swapped by the
          // router): it is its own device, never the first one.
          entry.fields = new Set();
          entry.values = undefined;
        }
        entry.info = info;
        entry.confirmed = true;
        this.store.update(slot.address, { info, fields: [...entry.fields] });
      }
      if (this.duplicateOf(slot, entry.info.id)) {
        throw new AirQError('duplicate');
      }
      const route = this.config.values === 'momentary' ? ROUTES.DATA : ROUTES.AVERAGE;
      const document = await readRoute(slot.address, slot.cipher, route);
      if (!current()) {
        return true;
      }
      // The values carry the id of the device that measured them: a mismatch
      // (another air-Q took the address since /config) publishes nothing.
      const deviceId =
        typeof document.DeviceID === 'string' ? document.DeviceID.trim().toLowerCase() : '';
      if (deviceId && deviceId !== entry.info.id) {
        throw new AirQError('invalid', 'another air-Q at this address');
      }
      entry.values = valuesOf(document);
      entry.warming = warmingUp(document);
      entry.readAt = this.now();
      for (const field of Object.keys(entry.values)) {
        entry.fields.add(field);
      }
      entry.error = undefined;
      this.store.update(slot.address, {
        pausedUntil: 0,
        streak: 0,
        refusedUntil: 0,
        fields: [...entry.fields],
      });
    } catch (err) {
      const error = err instanceof AirQError ? err : new AirQError('failed');
      const at = this.now();
      if (!current()) {
        // Disconnected (or reconfigured) meanwhile: the values and a refusal
        // are dropped, but a pause asked by the same device, with the same
        // password, is kept.
        const same = this.slots.some(
          (s) => s.address === slot.address && s.password === slot.password,
        );
        if (error.kind === 'busy' && same) {
          this.recordBusy(slot, entry, error, at);
        }
        return true;
      }
      entry.error = error;
      // Whatever failed, /config is read again at the next attempt: the
      // address may now lead to another air-Q.
      entry.confirmed = false;
      if (error.kind === 'invalid') {
        entry.values = undefined;
      }
      if (error.kind === 'refused') {
        this.store.update(slot.address, { refusedUntil: at + REFUSED_BACKOFF });
        entry.nextDue = at + REFUSED_BACKOFF;
      } else if (error.kind === 'busy') {
        this.recordBusy(slot, entry, error, at);
      }
      this.logger.warn(`air-Q ${slot.slot} (${slot.address}): ${this.scrub(error)}`);
    }
    return true;
  }

  /** A 429 / 5xx: Retry-After, else 5 minutes doubling; 1 minute to 6 hours. */
  recordBusy(slot, entry, error, at) {
    const streak = this.store.get(slot.address).streak + 1;
    const pause = clamp(
      error.retryAfterMs ?? BUSY_BASE * 2 ** Math.min(streak - 1, 10),
      BUSY_MIN,
      BUSY_MAX,
    );
    this.store.update(slot.address, { streak, pausedUntil: at + pause });
    entry.nextDue = at + Math.max(this.intervalMs(), pause);
  }

  // --- Gladys devices and states --------------------------------------------------

  nameOf(slot) {
    const info = this.track.get(slot.address)?.info;
    if (info?.name) {
      return `${info.name} (air-Q)`;
    }
    return info ? `air-Q ${info.id.slice(0, 5)}` : `air-Q ${slot.slot} (${slot.address})`;
  }

  /** The air-Q known by their id, without duplicates: [{ slot, entry }]. */
  known() {
    return this.slots
      .map((slot) => ({ slot, entry: this.track.get(slot.address) }))
      .filter(({ slot, entry }) => entry?.info && !this.duplicateOf(slot, entry.info.id));
  }

  devices() {
    return this.known()
      .map(({ slot, entry }) =>
        deviceOf(this.gladys, { info: entry.info, fields: entry.fields, name: this.nameOf(slot) }),
      )
      .filter((device) => device.features.length > 0);
  }

  async publish() {
    await this.publishDiscovered();
    await this.publishStates();
  }

  /** The Discovery tab, published again only when it changed. */
  async publishDiscovered({ force = false } = {}) {
    const devices = this.devices();
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  /** The fresh values of the created features, only what changed (plus a heartbeat). */
  async publishStates() {
    const now = this.now();
    const states = [];
    for (const { entry } of this.known()) {
      if (!this.isFresh(entry, now)) {
        continue;
      }
      const created = new Set(
        createdFeatures(this.gladys, entry.info.id).map((f) => f.external_id),
      );
      states.push(
        ...statesOf(this.gladys, entry.info.id, entry.values).filter((s) =>
          created.has(s.device_feature_external_id),
        ),
      );
    }
    if (states.length === 0) {
      return;
    }
    try {
      await this.gladys.publishChangedStates(states, { heartbeat: HEARTBEAT });
    } catch (err) {
      this.logger.warn(`Publishing the states failed: ${err.message}`);
    }
  }

  // --- Status ------------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  withNotes(text) {
    const notes = [];
    if (this.config.invalid.length > 0) {
      notes.push(T.invalidSlots(this.config.invalid));
    }
    const refused = this.slots.some(
      (slot) => this.track.get(slot.address)?.error?.kind === 'refused',
    );
    if (refused) {
      notes.push(T.refusedHelp);
    }
    if (notes.length === 0) {
      return text;
    }
    return {
      en: `${text.en} ${notes.map((n) => `${n.en.replace(/\.$/, '')}.`).join(' ')}`,
      fr: `${text.fr} ${notes.map((n) => `${n.fr.replace(/\.$/, '')}.`).join(' ')}`,
    };
  }

  async refreshStatus() {
    if (this.slots.length === 0) {
      return this.setStatus(false, this.withNotes(T.notConfigured));
    }
    const now = this.now();
    const failing = this.slots
      .map((slot) => ({ slot, entry: this.track.get(slot.address) }))
      .filter(({ entry }) => entry?.error)
      .map(({ slot, entry }) => ({ name: this.nameOf(slot), kind: entry.error.kind }));
    const anyValue = this.known().some(({ entry }) => this.isFresh(entry, now));
    const text = T.ok({
      devices: this.slots.length,
      interval: this.config.pollMinutes,
      failing,
    });
    return this.setStatus(anyValue || failing.length === 0, this.withNotes(text));
  }

  // --- Configuration screen button -------------------------------------------------

  line(slot, lang) {
    const entry = this.track.get(slot.address);
    const colon = lang === 'fr' ? ' :' : ':';
    const name = this.nameOf(slot);
    const v = entry?.values;
    if (!v || entry.error) {
      const why = entry?.error
        ? reason(entry.error.kind)[lang]
        : lang === 'fr'
          ? 'pas encore lu depuis le démarrage'
          : 'not read since the start';
      const saved = this.store.get(slot.address);
      const until =
        entry?.error?.kind === 'busy' && saved?.pausedUntil > this.now()
          ? `, ${T.pausedUntil(saved.pausedUntil)[lang]}`
          : '';
      return `- ${name}${colon} ${why}${until}${this.nextRead(slot, lang)}`;
    }
    const parts = [];
    const add = (field, label, unit) => {
      if (typeof v[field] === 'number') {
        parts.push(`${label} ${numberText(v[field], lang)}${unit}`);
      }
    };
    add('co2', 'CO2', ' ppm');
    add('tvoc', 'VOC', ' ppb');
    add('pm2_5', 'PM2.5', ' µg/m³');
    add('temperature', lang === 'fr' ? 'température' : 'temperature', ' °C');
    add('humidity', lang === 'fr' ? 'humidité' : 'humidity', ' %');
    add('sound', lang === 'fr' ? 'bruit' : 'noise', ' dB');
    const count = Object.keys(v).length;
    parts.push(lang === 'fr' ? `${count} valeur(s) en tout` : `${count} value(s) in all`);
    if (entry.warming?.length > 0) {
      parts.push(
        lang === 'fr'
          ? `en chauffe : ${entry.warming.join(', ')}`
          : `warming up: ${entry.warming.join(', ')}`,
      );
    }
    return `- ${name}${colon} ${parts.join(', ')}${this.nextRead(slot, lang)}`;
  }

  /**
   * ", next read possible at 18:02 UTC": the button never reads sooner (the
   * periodic reads of a refused password wait longer, see the status).
   */
  nextRead(slot, lang) {
    const saved = this.store.get(slot.address);
    const at = Math.max(saved.lastAttemptAt + this.intervalMs(), saved.pausedUntil, this.now());
    return `, ${T.nextRead(at)[lang]}`;
  }

  async testConnection() {
    if (this.slots.length === 0) {
      return this.withNotes(T.notConfigured);
    }
    // Gladys waits 120 s for the answer: past ~100 s, the last values are
    // shown (a read still running finishes in the background).
    const generation = this.generation;
    const reads = this.exclusive(async () => {
      for (const slot of this.slots) {
        if (generation !== this.generation) {
          return;
        }
        await this.read(slot, { manual: true });
      }
    });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TEST_DEADLINE);
    });
    try {
      await Promise.race([reads, timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
    const en = [`air-Q, read every ${this.config.pollMinutes} min:`];
    const fr = [`air-Q, lus toutes les ${this.config.pollMinutes} min :`];
    for (const slot of this.slots) {
      en.push(this.line(slot, 'en'));
      fr.push(this.line(slot, 'fr'));
    }
    await this.publish();
    await this.refreshStatus();
    return this.withNotes({ en: en.join('\n'), fr: fr.join('\n') });
  }
}
