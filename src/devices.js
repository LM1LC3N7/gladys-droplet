// -----------------------------------------------------------------------------
// The Gladys device of a Droplet and its states. Pure.
//
// External ids (forever): `ext:<selector>:droplet:<device id>`, the device id
// being the `ids` field of the Droplet's information message (pydroplet
// get_device_id; letters, digits, `_`, `-`). Nothing is published for a
// Droplet before its information message: there is no other id (a serial
// number is never used, the address may change). Another Droplet at the
// address (a replacement) is another device, with its own water index.
//
// Features (keys forever):
//   flow          water-valve / flow, m³/h (the Droplet gives L/min: × 0.06)
//   water_index   volume-sensor / decimal, L: the index built from the
//                 volumes the Droplet reports (src/volume.js), never 0, never
//                 lower than before
//   server        text: connectivity to the Hydrific servers, as the Droplet says it
//   signal        text: quality of the ultrasonic signal, as the Droplet says it
//   leak          leak-sensor / binary: the leak alert (flow above the
//                 threshold set in the Droplet app; known only while the
//                 Droplet reaches the Hydrific servers)
//   unusual_flow  leak-sensor / binary: unusual flow (a leaky flapper, a slow leak)
// Units: only the ones the core lists for the category
// (DEVICE_FEATURE_UNITS_BY_CATEGORY). A text is never published as a measure.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPE, FLOW_MAX_LPM, INDEX_MAX_L } from './constants.js';

/** The external ids of a Droplet. */
export const ids = (gladys, deviceId) => gladys.externalIds(EXTERNAL_ID_TYPE, deviceId);

/** Feature keys (forever). */
export const F = {
  FLOW: 'flow',
  WATER_INDEX: 'water_index',
  SERVER: 'server',
  SIGNAL: 'signal',
  LEAK: 'leak',
  UNUSUAL_FLOW: 'unusual_flow',
};

/** L/min -> m³/h. */
export const lpmToM3h = (lpm) => (lpm * 60) / 1000;
const FLOW_MAX_M3H = lpmToM3h(FLOW_MAX_LPM);

const text = { category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false };
const binary = { min: 0, max: 1 };

export const FEATURES = [
  {
    key: F.FLOW,
    name: 'Flow rate',
    category: C.WATER_VALVE,
    type: T.WATER_VALVE.FLOW,
    unit: U.CUBIC_METER_PER_HOUR,
    min: -FLOW_MAX_M3H,
    max: FLOW_MAX_M3H,
  },
  {
    key: F.WATER_INDEX,
    name: 'Water index',
    category: C.VOLUME_SENSOR,
    type: T.VOLUME_SENSOR.DECIMAL,
    unit: U.LITER,
    min: 0,
    max: INDEX_MAX_L,
  },
  { key: F.SERVER, name: 'Server connectivity', ...text },
  { key: F.SIGNAL, name: 'Signal quality', ...text },
  { key: F.LEAK, name: 'Leak', category: C.LEAK_SENSOR, type: T.SENSOR.BINARY, ...binary },
  {
    key: F.UNUSUAL_FLOW,
    name: 'Unusual flow',
    category: C.LEAK_SENSOR,
    type: T.SENSOR.BINARY,
    ...binary,
  },
];

/** The Gladys device of a Droplet: `info` `{ model, manufacturer, firmware }`, `address`. */
export function buildDevice(gladys, deviceId, info = {}, address = '') {
  const external = ids(gladys, deviceId);
  return {
    name: `Droplet ${deviceId.slice(-4)}`,
    external_id: external.device,
    features: FEATURES.map(({ key, ...spec }) => ({
      read_only: true,
      has_feedback: false,
      keep_history: true,
      ...spec,
      external_id: external.feature(key),
    })),
    params: [
      { name: 'device_id', value: deviceId },
      { name: 'address', value: address },
      { name: 'model', value: info.model ?? '' },
      { name: 'manufacturer', value: info.manufacturer ?? '' },
      { name: 'firmware_version', value: info.firmware ?? '' },
    ].filter((p) => typeof p.value === 'string' && p.value !== ''),
  };
}

export const round = (value, digits) => {
  const r = Math.round(value * 10 ** digits) / 10 ** digits;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * The states of the live values (never the index): `live` holds the last of
 * each, `{ flow, server, signal, lowLeak, highLeak }`, each `{ value, at }`;
 * `fresh(at)` says whether one may still be published.
 */
export function liveStates(gladys, deviceId, live, fresh) {
  const external = ids(gladys, deviceId);
  const states = [];
  const take = (entry) => entry !== undefined && fresh(entry.at);
  if (take(live.flow)) {
    states.push({
      device_feature_external_id: external.feature(F.FLOW),
      state: round(lpmToM3h(live.flow.value), 4),
    });
  }
  for (const [key, name] of [
    [F.SERVER, 'server'],
    [F.SIGNAL, 'signal'],
  ]) {
    if (take(live[name])) {
      states.push({ device_feature_external_id: external.feature(key), text: live[name].value });
    }
  }
  for (const [key, name] of [
    [F.LEAK, 'highLeak'],
    [F.UNUSUAL_FLOW, 'lowLeak'],
  ]) {
    if (take(live[name])) {
      states.push({
        device_feature_external_id: external.feature(key),
        state: live[name].value ? 1 : 0,
      });
    }
  }
  return states;
}

/** The state of the water index (L, rounded to the mL). */
export const indexState = (gladys, deviceId, litres) => ({
  device_feature_external_id: ids(gladys, deviceId).feature(F.WATER_INDEX),
  state: round(litres, 3),
});
