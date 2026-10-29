// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local TLS WebSocket server playing the Droplet: the certificate pinned
// before the code goes, values published, and the attempts really paced at
// the interval when the Droplet closes each connection (measured on the
// method that decides). Time sped up 20 times (30 s are 1.5 s).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { DropletApp } from '../src/app.js';
import { CONNECT_INTERVAL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './helpers/clock.js';
import { dropletServer } from './helpers/server.js';
import { until } from './helpers/app.js';

const SPEED = 20;
const CODE = 'Pa1r-c0de';
const quiet = () => {};

test('real clock x20 over TLS: pinned, published, attempts paced at 30 s; timers bounded', async (t) => {
  const srv = await dropletServer({ code: CODE });
  t.after(() => srv.close());
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ selector: 'droplet', config: {} });
  await gladys.connect();
  const store = createMemoryStore();
  const lines = [];
  const log = (...a) => lines.push(a.join(' '));
  const app = new DropletApp({
    gladys,
    logger: { info: log, warn: log, error: log, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  const spy = spyOn(app, 'dial', clock);
  try {
    await app.start({ address: `127.0.0.1:${srv.port}`, pairing_code: CODE });
    await until(() => srv.clients.size === 1);
    srv.send({ flow: 6, volume: 2500, server: 'Connected', signal: 'Strong Signal' });
    await until(() =>
      gladys.fake.states.some((s) => s.device_feature_external_id.endsWith(':water_index')),
    );
    assert.equal(store.data.pins[`127.0.0.1:${srv.port}`], srv.fingerprint);
    // From now on the Droplet closes every connection after its first message.
    const drop = setInterval(() => {
      if (srv.clients.size > 0) srv.dropAll();
    }, 50 / SPEED);
    t.after(() => clearInterval(drop));
    await measurePeriod(spy, { count: 3, period: CONNECT_INTERVAL });
    // The third attempt reaches the Droplet (its TLS handshake takes real time).
    await until(() => srv.upgrades.length >= 3);
    clearInterval(drop);
    await app.stop();
  } finally {
    await app.stop().catch(() => {});
    clock.close();
  }
  const flow = gladys.fake.states.find((s) => s.device_feature_external_id.endsWith(':flow'));
  assert.equal(flow.state, 0.36);
  assert.ok(srv.upgrades.every((h) => h === CODE));
  assert.ok(srv.upgrades.length >= 3 && srv.upgrades.length <= 4, `${srv.upgrades.length}`);
  assert.ok(clock.timersSet <= 40, `${clock.timersSet} timers`);
  assert.ok(!JSON.stringify(store.data).includes(CODE));
  assert.ok(!lines.join('\n').includes(CODE));
});

test('over TLS: a typed fingerprint that is not the certificate met: not one byte of the code', async (t) => {
  const srv = await dropletServer({ code: CODE });
  t.after(() => srv.close());
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ selector: 'droplet', config: {} });
  await gladys.connect();
  const store = createMemoryStore();
  const app = new DropletApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  const other = `${'CD:'.repeat(31)}CD`;
  try {
    await app.start({
      address: `127.0.0.1:${srv.port}`,
      pairing_code: CODE,
      certificate_fingerprint: other,
    });
    await until(() =>
      /not the fingerprint typed/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    );
    // Two attempts (the second 30 s later): still nothing.
    await until(() => srv.upgrades.length > 0 || clock.monotonic() > 0, 100);
    await clock.sleep(35_000);
  } finally {
    await app.stop().catch(() => {});
    clock.close();
  }
  assert.deepEqual(srv.upgrades, [], 'no upgrade, no code');
  assert.equal(srv.connections, 0);
  assert.match(gladys.fake.connectionStatus.message.en, new RegExp(srv.fingerprint));
  assert.deepEqual(store.data.pins ?? {}, {});
});
