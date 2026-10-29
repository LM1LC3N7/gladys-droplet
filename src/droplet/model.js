// -----------------------------------------------------------------------------
// The messages of the Droplet, read strictly. Pure. Ported from pydroplet
// 2.5.0 (Hydrific, MIT), `Droplet._parse_message`:
// - a message with `ids` is the device information: `ids` (the device id),
//   `mdl` (model), `mf` (manufacturer), `sw` (firmware), `sn` (serial number,
//   never kept here);
// - any other is a state message, each field optional: `flow` (L/min),
//   `volume` (mL since the previous report, may be negative), `server`
//   (connectivity to the Hydrific servers, a text such as "Connected"),
//   `signal` (quality of the ultrasonic signal, a text such as "Strong
//   Signal"), `low_leak` / `high_leak` ("ON" / "OFF": unusual flow, leak;
//   only known while the Droplet reaches the Hydrific servers).
// Changed here: a number must be a JSON number (a string, `null`, `true` is
// not 0), within bounds; a text is bounded, printable, never published as a
// measure; a leak is "ON"/"OFF" (or a JSON boolean), anything else unknown;
// keys are read as own properties only (no prototype pollution).
// -----------------------------------------------------------------------------

import { FLOW_MAX_LPM, TEXT_MAX_LENGTH, VOLUME_REPORT_MAX_ML } from '../constants.js';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isPlain = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** A device id usable in an external id: letters, digits, `_` and `-` (never `.`, `:`). */
export const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** A text of the Droplet: trimmed, 1-64 printable characters (no control, no line feed), or undefined. */
export function cleanText(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text === '' || text.length > TEXT_MAX_LENGTH) return undefined;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(text)) return undefined;
  return text;
}

function leakOf(value) {
  if (value === 'ON' || value === true) return true;
  if (value === 'OFF' || value === false) return false;
  return undefined;
}

/**
 * One text frame -> `{ kind: 'info', id, model, manufacturer, firmware }`,
 * `{ kind: 'info', invalidId: true }` (an `ids` that cannot be an id),
 * `{ kind: 'state', ...fields, rejected }` (only the fields read; `rejected`
 * counts the fields present but unreadable), or undefined (not JSON, not an
 * object: not a message of the Droplet).
 */
export function parseMessage(text) {
  if (typeof text !== 'string') return undefined;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isPlain(data)) return undefined;
  // pydroplet: `if msg.get("ids")` (a truthy value) makes it an info message.
  if (own(data, 'ids') && data.ids) {
    if (typeof data.ids !== 'string' || !DEVICE_ID.test(data.ids)) {
      return { kind: 'info', invalidId: true };
    }
    return {
      kind: 'info',
      id: data.ids,
      model: own(data, 'mdl') ? cleanText(data.mdl) : undefined,
      manufacturer: own(data, 'mf') ? cleanText(data.mf) : undefined,
      firmware: own(data, 'sw') ? cleanText(data.sw) : undefined,
    };
  }
  const state = { kind: 'state', rejected: 0 };
  let fields = 0;
  if (own(data, 'flow') && data.flow !== null) {
    fields += 1;
    if (finite(data.flow) && Math.abs(data.flow) <= FLOW_MAX_LPM) state.flow = data.flow;
    else state.rejected += 1;
  }
  if (own(data, 'volume') && data.volume !== null) {
    fields += 1;
    if (finite(data.volume) && Math.abs(data.volume) <= VOLUME_REPORT_MAX_ML) {
      state.volume = data.volume;
    } else {
      state.rejected += 1;
    }
  }
  for (const [key, name] of [
    ['server', 'server'],
    ['signal', 'signal'],
  ]) {
    if (own(data, key) && data[key] !== null && data[key] !== '') {
      fields += 1;
      const value = cleanText(data[key]);
      if (value !== undefined) state[name] = value;
      else state.rejected += 1;
    }
  }
  for (const [key, name] of [
    ['low_leak', 'lowLeak'],
    ['high_leak', 'highLeak'],
  ]) {
    if (own(data, key) && data[key] !== null) {
      fields += 1;
      const value = leakOf(data[key]);
      if (value !== undefined) state[name] = value;
      else state.rejected += 1;
    }
  }
  // An object with none of these fields: not a message of the Droplet.
  if (fields === 0) return undefined;
  return state;
}

/** Whether a parsed state message carries at least one value read. */
export const hasValues = (state) =>
  state?.kind === 'state' &&
  ['flow', 'volume', 'server', 'signal', 'lowLeak', 'highLeak'].some((k) => k in state);
