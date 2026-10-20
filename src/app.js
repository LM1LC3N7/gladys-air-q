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
    /** address -> { info, values, warming, readAt, fields, nextDue, error, password } */
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
    const previous = this.started ? this.config : undefined;
    this.config = normalizeConfig(raw);
    this.started = true;
    const routeChanged =
      previous &&
      (previous.values !== this.config.values || previous.pollMinutes !== this.config.pollMinutes);
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
      let entry = this.track.get(slot.address);
      if (!entry) {
        entry = { fields: new Set(), nextDue: 0 };
        this.track.set(slot.address, entry);
      }
      // A reconnection to Gladys gives the same configuration: the pauses,
      // the refusal and the due times stay. A new password is tried at once
      // (the store drops a refusal of another password, also after a
      // restart of the container).
      const saved = this.store.restore(slot.address, slot.password);
      if (entry.password !== undefined && entry.password !== slot.password) {
        this.store.update(slot.address, { refusedUntil: 0 });
        entry.nextDue = 0;
        entry.error = undefined;
      } else if (routeChanged) {
        entry.nextDue = Math.min(entry.nextDue, Math.max(this.now(), saved.pausedUntil));
      }
      entry.password = slot.password;
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
   * Read one air-Q now; never throws. `manual` (the test button) may try a
   * refused password again at once, never during a pause asked by the device.
   */
  async read(slot, { manual = false } = {}) {
    const generation = this.generation;
    const entry = this.track.get(slot.address);
    if (!entry) {
      return;
    }
    const saved = this.store.get(slot.address) ?? {};
    const now = this.now();
    if (now < (saved.pausedUntil ?? 0)) {
      entry.error = entry.error ?? new AirQError('busy');
      entry.nextDue = Math.max(entry.nextDue, saved.pausedUntil);
      return;
    }
    if (!manual && now < (saved.refusedUntil ?? 0)) {
      entry.error = new AirQError('refused');
      entry.nextDue = Math.max(entry.nextDue, saved.refusedUntil);
      return;
    }
    try {
      if (!entry.info) {
        const info = deviceInfo(await readRoute(slot.address, slot.cipher, ROUTES.CONFIG));
        if (generation !== this.generation) {
          return;
        }
        entry.info = info;
      }
      if (this.duplicateOf(slot, entry.info.id)) {
        throw new AirQError('duplicate');
      }
      const route = this.config.values === 'momentary' ? ROUTES.DATA : ROUTES.AVERAGE;
      const document = await readRoute(slot.address, slot.cipher, route);
      if (generation !== this.generation) {
        return;
      }
      entry.values = valuesOf(document);
      entry.warming = warmingUp(document);
      entry.readAt = this.now();
      for (const field of Object.keys(entry.values)) {
        entry.fields.add(field);
      }
      entry.error = undefined;
      this.store.update(slot.address, { pausedUntil: 0, streak: 0, refusedUntil: 0 });
      entry.nextDue = this.now() + this.intervalMs();
    } catch (err) {
      // The outcome of a read of a previous configuration (another password)
      // never touches the state of the current one.
      if (generation !== this.generation) {
        return;
      }
      const error = err instanceof AirQError ? err : new AirQError('failed');
      entry.error = error;
      const at = this.now();
      if (error.kind === 'refused') {
        this.store.update(slot.address, { refusedUntil: at + REFUSED_BACKOFF }, slot.password);
        entry.nextDue = at + REFUSED_BACKOFF;
      } else if (error.kind === 'busy') {
        const streak = (saved.streak ?? 0) + 1;
        const pause = clamp(
          error.retryAfterMs ?? BUSY_BASE * 2 ** Math.min(streak - 1, 10),
          BUSY_MIN,
          BUSY_MAX,
        );
        this.store.update(slot.address, { streak, pausedUntil: at + pause });
        entry.nextDue = at + Math.max(this.intervalMs(), pause);
      } else {
        // Never read faster than the interval, whatever the failure.
        entry.nextDue = at + this.intervalMs();
      }
      this.logger.warn(`air-Q ${slot.slot} (${slot.address}): ${this.scrub(error)}`);
    }
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
          ? 'pas encore lu'
          : 'not read yet';
      const saved = this.store.get(slot.address);
      const until =
        entry?.error?.kind === 'busy' && saved?.pausedUntil > this.now()
          ? `, ${T.pausedUntil(saved.pausedUntil)[lang]}`
          : '';
      return `- ${name}${colon} ${why}${until}`;
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
    return `- ${name}${colon} ${parts.join(', ')}`;
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
