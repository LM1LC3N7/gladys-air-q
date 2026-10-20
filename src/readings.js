// -----------------------------------------------------------------------------
// air-Q documents -> plain values, and the Gladys devices and states built
// from them. Pure: no clock, no network.
//
// The feature key of a value is its air-Q field name (`co2`, `pm2_5`...): it
// is part of the external id, so it never changes. aioairq's conventions are
// kept: `[value, uncertainty]` gives the value, the `_SPS30` suffix of the
// newer particle sensor is dropped, a negative concentration (seen during
// self-calibration) reads 0.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE } from './constants.js';

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** CO: the air-Q gives mg/m³, the core knows only ppm for `co-sensor` (25 °C, 1 atm). */
export const CO_PPM_PER_MG_M3 = 24.45 / 28.01;

const concentration = (category, unit, max, type = TYPES.SENSOR.DECIMAL) => ({
  category,
  type,
  unit,
  min: 0,
  max,
  clip: true,
  convert: (v) => round(v, 1),
});

// --- Kinds: Gladys category, type, unit and bounds ------------------------------
// Only the units the core lists for the category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js); the core
// gives `noise-sensor` no list, its own unit `decibel` is used.

const KINDS = {
  co2: {
    category: CAT.CO2_SENSOR,
    type: TYPES.SENSOR.INTEGER,
    unit: UNITS.PPM,
    min: 0,
    max: 40000,
    clip: true,
    convert: (v) => Math.round(v),
  },
  voc: concentration(CAT.VOC_SENSOR, UNITS.PPB, 100000, TYPES.VOC_SENSOR.DECIMAL),
  pm25: concentration(CAT.PM25_SENSOR, UNITS.MICROGRAM_PER_CUBIC_METER, 2000),
  pm10: concentration(CAT.PM10_SENSOR, UNITS.MICROGRAM_PER_CUBIC_METER, 2000),
  co: {
    ...concentration(CAT.CO_SENSOR, UNITS.PPM, 1000),
    convert: (v) => round(v * CO_PPM_PER_MG_M3, 1),
  },
  no2: concentration(CAT.NO2_SENSOR, UNITS.MICROGRAM_PER_CUBIC_METER, 50000),
  o3: concentration(CAT.O3_SENSOR, UNITS.MICROGRAM_PER_CUBIC_METER, 50000),
  so2: concentration(CAT.SO2_SENSOR, UNITS.MICROGRAM_PER_CUBIC_METER, 50000),
  ch2o: concentration(CAT.FORMALDEHYD_SENSOR, UNITS.MICROGRAM_PER_CUBIC_METER, 50000),
  temperature: {
    category: CAT.TEMPERATURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.CELSIUS,
    min: -40,
    max: 85,
    convert: (v) => round(v, 1),
  },
  humidity: {
    category: CAT.HUMIDITY_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    convert: (v) => round(v, 1),
  },
  pressure: {
    category: CAT.PRESSURE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.HECTO_PASCAL,
    min: 300,
    max: 1100,
    convert: (v) => round(v, 1),
  },
  noise: {
    category: CAT.NOISE_SENSOR,
    type: TYPES.SENSOR.DECIMAL,
    unit: UNITS.DECIBEL,
    min: 0,
    max: 140,
    clip: true,
    convert: (v) => round(v, 1),
  },
};

/** [air-Q field, kind, feature name]: the order of the features in Gladys. */
export const FIELDS = [
  ['co2', 'co2', 'CO2'],
  ['tvoc', 'voc', 'VOC'],
  ['tvoc_ionsc', 'voc', 'VOC (ion sensor)'],
  ['pm2_5', 'pm25', 'PM2.5'],
  ['pm10', 'pm10', 'PM10'],
  ['co', 'co', 'Carbon monoxide'],
  ['no2', 'no2', 'Nitrogen dioxide'],
  ['o3', 'o3', 'Ozone'],
  ['so2', 'so2', 'Sulphur dioxide'],
  ['ch2o_M10', 'ch2o', 'Formaldehyde'],
  ['temperature', 'temperature', 'Temperature'],
  ['humidity', 'humidity', 'Humidity'],
  ['pressure', 'pressure', 'Pressure'],
  ['sound', 'noise', 'Noise'],
  ['sound_max', 'noise', 'Noise (peak)'],
];

const FIELD_NAMES = new Set(FIELDS.map(([field]) => field));

/** A finite number, or null (never NaN, never undefined). */
export const num = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;

/** The own value of a field, with or without the `_SPS30` suffix. */
function rawOf(document, field) {
  for (const key of [field, `${field}_SPS30`]) {
    if (Object.hasOwn(document, key)) {
      const value = document[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * A /data or /average document -> { field: value } for the known fields with
 * a usable value: converted, rounded, within the bounds of the feature (a
 * value out of them is left out, never clamped into a false reading).
 */
export function valuesOf(document) {
  const values = {};
  if (!document || typeof document !== 'object') {
    return values;
  }
  for (const [field, kindName] of FIELDS) {
    let value = num(rawOf(document, field));
    if (value === null) {
      continue;
    }
    const kind = KINDS[kindName];
    if (kind.clip && value < 0) {
      value = 0;
    }
    value = kind.convert(value);
    if (Number.isFinite(value) && value >= kind.min && value <= kind.max) {
      values[field] = value;
    }
  }
  return values;
}

/** The air-Q `Status`: the sensors still warming up (aioairq `identify_warming_up_sensors`). */
export function warmingUp(document) {
  const status = document?.Status;
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    return [];
  }
  return Object.keys(status)
    .filter((key) => typeof status[key] === 'string' && status[key].includes('warm up'))
    .slice(0, 20);
}

// --- Gladys devices and states ------------------------------------------------------

const idsOf = (gladys, deviceId) => gladys.externalIds(DEVICE_TYPE, deviceId);

const featureOf = (ids, field, kindName, name) => {
  const kind = KINDS[kindName];
  return {
    name,
    external_id: ids.feature(field),
    category: kind.category,
    type: kind.type,
    unit: kind.unit,
    min: kind.min,
    max: kind.max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
};

/** The features of the device as the user created it (gladys.devices). */
export function createdFeatures(gladys, deviceId) {
  const ids = idsOf(gladys, deviceId);
  const device = (gladys.devices ?? []).find((d) => d.external_id === ids.device);
  return device?.features ?? [];
}

/**
 * The Gladys device of an air-Q: every field it has ever given, plus every
 * feature of the device already created (so a sensor warming up, or a field
 * this version no longer knows, never removes a feature: the core would mark
 * the device as changed and "Update" would drop its history).
 */
export function deviceOf(gladys, { info, fields, name }) {
  const ids = idsOf(gladys, info.id);
  const created = createdFeatures(gladys, info.id);
  const createdIds = new Set(created.map((f) => f.external_id));
  const features = FIELDS.filter(
    ([field]) => fields.has(field) || createdIds.has(ids.feature(field)),
  ).map(([field, kindName, featureName]) => featureOf(ids, field, kindName, featureName));
  const prefix = `${ids.device}:`;
  for (const feature of created) {
    const field = String(feature.external_id ?? '').startsWith(prefix)
      ? feature.external_id.slice(prefix.length)
      : '';
    if (field && !FIELD_NAMES.has(field)) {
      features.push({
        name: feature.name,
        external_id: feature.external_id,
        category: feature.category,
        type: feature.type,
        ...(feature.unit ? { unit: feature.unit } : {}),
        min: feature.min,
        max: feature.max,
        read_only: true,
        has_feedback: false,
        keep_history: feature.keep_history !== false,
      });
    }
  }
  return {
    name,
    external_id: ids.device,
    // The integration reads the air-Q at its own pace: Gladys has nothing to poll.
    should_poll: false,
    features,
  };
}

/** The states of the values, for the publishStates format. */
export function statesOf(gladys, deviceId, values) {
  const ids = idsOf(gladys, deviceId);
  return FIELDS.filter(([field]) => num(values?.[field]) !== null).map(([field]) => ({
    device_feature_external_id: ids.feature(field),
    state: values[field],
  }));
}
