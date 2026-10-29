// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake Droplet behind the `connect`
// injection (src/droplet/client.js contract) and a virtual clock that moves
// at every read (1 µs), so that a decision reading the clock twice is caught.
// The fake Droplet plays what pydroplet describes: the certificate checked
// first (checkPeer), then the code at the handshake (401 when refused), an
// information message with `ids`, state messages, pings answered.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DropletApp } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { CODES, DropletError } from '../../src/droplet/client.js';
import { createMemoryStore } from '../../src/store.js';
import { testClock } from './clock.js';

export const SELECTOR = 'droplet';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const NOW = Date.UTC(2026, 9, 28, 12, 0, 0);
export const HOST = '192.168.1.30';
export const CODE = 'Pa1r-c0de';
export const DEVICE_ID = 'Droplet-1a2b';
export const FP = `${'AB:'.repeat(31)}AB`;
export const OTHER_FP = `${'CD:'.repeat(31)}CD`;
export const CONFIG = { address: HOST, pairing_code: CODE };
export const D = (id = DEVICE_ID) => `ext:${SELECTOR}:droplet:${id}`;
export const FEATURE = (key, id = DEVICE_ID) => `${D(id)}:${key}`;
export const INFO = {
  ids: DEVICE_ID,
  mdl: 'Droplet 1.0',
  mf: 'Hydrific',
  sw: 'v1.4.2',
  sn: 'SN123',
};

/** Waits (real time, bounded) for `check()`: a regression fails within 5 s, never spins. */
export async function until(check, ms = 5000) {
  const end = performance.now() + ms;
  while (!check()) {
    if (performance.now() > end) assert.fail(`condition not met within ${ms} ms`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * A fake Droplet. `mode`: 'ok' (opens), 'refused' (401), 'closeAtOnce'
 * (opens then closes before any message: an old firmware refusing the code),
 * 'down' (unreachable), 'status' (answers `status`), 'hang' (never answers).
 * `fingerprint` is the certificate it shows; `code` the one it accepts.
 * `sendInfo`: the information message at once after the open.
 */
export function createDroplet() {
  const droplet = {
    mode: 'ok',
    status: 503,
    fingerprint: FP,
    code: CODE,
    sendInfo: true,
    info: INFO,
    answerPings: true,
    attempts: 0,
    /** Codes that left (after the certificate check). */
    codesSent: [],
    pings: 0,
    current: undefined,
    connections: [],
  };
  droplet.connect = (options) => {
    droplet.attempts += 1;
    const conn = { options, open: false, closed: false };
    let resolveOpened;
    let rejectOpened;
    conn.opened = new Promise((resolve, reject) => {
      resolveOpened = resolve;
      rejectOpened = reject;
    });
    conn.opened.catch(() => {});
    droplet.connections.push(conn);
    const handle = {
      opened: conn.opened,
      close() {
        if (conn.closed) return;
        conn.closed = true;
        if (!conn.open) rejectOpened(new DropletError(CODES.UNREACHABLE, 'Closed'));
        // ws emits close after a terminate: the app ignores its own.
        else queueMicrotask(() => options.onClose({ code: 1006 }));
      },
      ping() {
        droplet.pings += 1;
        if (droplet.answerPings) queueMicrotask(() => !conn.closed && options.onAlive());
      },
    };
    conn.handle = handle;
    (async () => {
      await Promise.resolve();
      if (droplet.mode === 'down') {
        rejectOpened(new DropletError(CODES.UNREACHABLE, 'ECONNREFUSED', { notSent: true }));
        return;
      }
      if (droplet.mode === 'hang') return;
      try {
        await options.checkPeer(droplet.fingerprint);
      } catch (err) {
        rejectOpened(Object.assign(err, { notSent: true }));
        return;
      }
      if (conn.closed) return;
      droplet.codesSent.push(options.code);
      if (droplet.mode === 'status') {
        const status = droplet.status;
        rejectOpened(
          status === 429
            ? new DropletError(CODES.RATE_LIMITED, 'x', { status })
            : new DropletError(CODES.SERVER, 'x', { status }),
        );
        return;
      }
      if (droplet.mode === 'refused' || options.code !== droplet.code) {
        if (droplet.mode !== 'closeAtOnce') {
          rejectOpened(new DropletError(CODES.REFUSED, 'Pairing code refused', { status: 401 }));
          return;
        }
      }
      conn.open = true;
      droplet.current = conn;
      resolveOpened();
      // As ws may: the first frame (or the close) in the same tick as the open.
      if (droplet.mode === 'closeAtOnce') {
        handle.closeFromDevice();
        return;
      }
      if (droplet.sendInfo) droplet.send(droplet.info);
    })();
    handle.closeFromDevice = () => {
      if (conn.closed) return;
      conn.closed = true;
      if (droplet.current === conn) droplet.current = undefined;
      options.onClose({ code: 1000 });
    };
    return handle;
  };
  /** A message of the Droplet on the open connection (object -> JSON). */
  droplet.send = (data) => {
    const conn = droplet.current;
    assert.ok(conn && !conn.closed, 'no open connection');
    conn.options.onAlive?.();
    conn.options.onMessage(typeof data === 'string' ? data : JSON.stringify(data));
  };
  droplet.close = () => droplet.current?.handle.closeFromDevice();
  return droplet;
}

/** The Droplet device as the user created it; `index`: the value Gladys holds `{ value, at }`. */
export function created({ id = DEVICE_ID, index } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(gladys, id, { model: 'Droplet 1.0' }, HOST);
  device.id = `device-${id}`;
  if (index) {
    const feature = device.features.find((f) => f.external_id === FEATURE('water_index', id));
    feature.last_value = index.value;
    feature.last_value_changed = new Date(index.at).toISOString();
  }
  return device;
}

export async function setup({
  devices: known = [],
  store,
  now = NOW,
  droplet,
  config = CONFIG,
  connect = true,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: known });
  if (connect) await gladys.connect();
  const clock = testClock({ start: now });
  const device = droplet ?? createDroplet();
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const kept = store ?? createMemoryStore();
  const wall = { offset: 0 };
  const app = new DropletApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now() + wall.offset,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: kept,
    connect: device.connect,
  });
  // The handlers of index.js.
  gladys.onAction('test_connection', () => app.testConnection());
  gladys.onAction('accept_held', () => app.acceptHeld());
  gladys.onDeviceCreated((d) => app.onDeviceCreated(d));
  gladys.onDeviceUpdated((d) => app.onDeviceUpdated(d));
  gladys.onDeviceDeleted((d) => app.onDeviceDeleted(d));
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await clock.advance(0);
      await app.idle();
    }
  };
  const start = async (cfg = config) => {
    await app.start(cfg);
    await settle();
  };
  const wait = async (ms) => {
    await clock.advance(ms);
    await settle();
  };
  /** The states published to one feature (values, or texts). */
  const statesOf = (key, id = DEVICE_ID) =>
    gladys.fake.states
      .filter((s) => s.device_feature_external_id === FEATURE(key, id))
      .map((s) => (s.text !== undefined ? s.text : s.state));
  const status = () => gladys.fake.connectionStatus;
  return {
    app,
    gladys,
    clock,
    wall,
    store: kept,
    droplet: device,
    start,
    wait,
    settle,
    lines,
    statesOf,
    status,
  };
}
