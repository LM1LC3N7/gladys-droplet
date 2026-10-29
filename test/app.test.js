// -----------------------------------------------------------------------------
// The app end to end on the fake Gladys and a fake Droplet, virtual clock:
// connection and pace, identity, publication, freshness, the water index
// (never 0, never down, held reports), the pairing code refused, the
// certificate pinned, /data, getConfig retried, the buttons.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE,
  CONFIG,
  D,
  DEVICE_ID,
  FP,
  HOST,
  HOUR,
  MINUTE,
  NOW,
  OTHER_FP,
  SECOND,
  created,
  createDroplet,
  setup,
} from './helpers/app.js';
import { createMemoryStore } from '../src/store.js';

const text = (status) => status?.message?.en ?? '';
const said = (ack) => ack?.data?.message?.en ?? '';

test('connects, learns the device id, publishes the live values within 10 s and the index', async () => {
  const t = await setup({ devices: [created()] });
  await t.start();
  assert.equal(t.droplet.attempts, 1);
  assert.deepEqual(t.droplet.codesSent, [CODE]);
  assert.equal(t.status().connected, true);
  assert.match(text(t.status()), new RegExp(`Connected to Droplet ${DEVICE_ID} at ${HOST}`));
  assert.equal(t.gladys.fake.discoveredDevices.length, 1);
  assert.equal(t.gladys.fake.discoveredDevices[0].external_id, D());
  t.droplet.send({ flow: 2.5, volume: 500, server: 'Connected', signal: 'Strong Signal' });
  t.droplet.send({ low_leak: 'OFF', high_leak: 'ON' });
  await t.wait(10 * SECOND);
  assert.deepEqual(t.statesOf('flow'), [0.15]);
  assert.deepEqual(t.statesOf('server'), ['Connected']);
  assert.deepEqual(t.statesOf('signal'), ['Strong Signal']);
  assert.deepEqual(t.statesOf('leak'), [1]);
  assert.deepEqual(t.statesOf('unusual_flow'), [0]);
  assert.deepEqual(t.statesOf('water_index'), [0.5]);
  // /data holds the index before it went out.
  assert.equal(t.store.data.meters[DEVICE_ID].last.value, 0.5);
  assert.equal(t.store.data.pins[`${HOST}:443`], FP);
  // The code is never in /data, the status nor the logs.
  assert.ok(!JSON.stringify(t.store.data).includes(CODE));
  assert.ok(!JSON.stringify(t.gladys.fake.connectionStatuses).includes(CODE));
  assert.ok(!t.lines.join('\n').includes(CODE));
});

test('nothing is published before the device id; the volumes before it count for that Droplet', async () => {
  const droplet = createDroplet();
  droplet.sendInfo = false;
  const t = await setup({ droplet, devices: [created()] });
  await t.start();
  droplet.send({ flow: 1, volume: 300 });
  await t.wait(30 * SECOND);
  assert.equal(t.gladys.fake.states.length, 0);
  assert.equal(t.status().connected, false);
  assert.match(text(t.status()), /waiting for its device id/);
  await t.wait(MINUTE);
  assert.match(text(t.status()), /has not given its device id for a minute/);
  droplet.send(droplet.info);
  await t.wait(10 * SECOND);
  assert.deepEqual(t.statesOf('water_index'), [0.3]);
  assert.deepEqual(t.statesOf('flow'), [0.06]);
});

test('the index: never 0, never down; negative reports wait; once a minute', async () => {
  const t = await setup({ devices: [created()] });
  await t.start();
  t.droplet.send({ volume: 0 });
  await t.wait(10 * SECOND);
  assert.deepEqual(t.statesOf('water_index'), [], 'never 0');
  t.droplet.send({ volume: 1000 });
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [1]);
  t.droplet.send({ volume: -400 });
  await t.wait(MINUTE);
  t.droplet.send({ volume: 100 });
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [1], 'never below 1 L');
  t.droplet.send({ volume: 1500 });
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [1, 2.2]);
  // Many reports within a minute: one index.
  for (let i = 0; i < 20; i += 1) t.droplet.send({ volume: 10 });
  await t.wait(5 * SECOND);
  assert.deepEqual(t.statesOf('water_index'), [1, 2.2]);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [1, 2.2, 2.4]);
});

test('a report too large for the time is held, shown, never counted by time; accepted in two clicks, bounded to the list', async () => {
  const t = await setup({ devices: [created()] });
  await t.start();
  t.droplet.send({ volume: 1000 });
  await t.wait(MINUTE);
  // 200 L/min over ~1 min + 2 L: 500 L in one report is too much.
  t.droplet.send({ volume: 500_000 });
  await t.wait(HOUR);
  t.droplet.send({ volume: 1000 });
  await t.wait(2 * MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [1, 2], 'the held report never freezes the index');
  assert.match(text(t.status()), /Volume held back.*500 L/);
  assert.ok(t.gladys.fake.transports.some((b) => b.degraded));
  assert.ok(t.store.data.meters[DEVICE_ID].held.ml === 500_000);
  // First click: lists, accepts nothing.
  const first = await t.gladys.fake.action('accept_held');
  assert.match(said(first), /Click again/);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [1, 2]);
  // More held after the list: not taken by the second click.
  t.droplet.send({ volume: 900_000 });
  await t.wait(5 * SECOND);
  const second = await t.gladys.fake.action('accept_held');
  assert.match(said(second), /Added to the water index/);
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [1, 2, 502]);
  assert.equal(t.store.data.meters[DEVICE_ID].held.ml, 900_000);
});

test('the second click too soon or too late lists again', async () => {
  const t = await setup({ devices: [created()] });
  await t.start();
  t.droplet.send({ volume: 900_000 });
  await t.settle();
  assert.match(said(await t.gladys.fake.action('accept_held')), /Click again/);
  await t.wait(SECOND);
  assert.match(said(await t.gladys.fake.action('accept_held')), /Click again/);
  await t.wait(6 * MINUTE);
  assert.match(said(await t.gladys.fake.action('accept_held')), /Click again/);
  assert.equal(t.store.data.meters[DEVICE_ID].held.ml, 900_000);
});

test('Gladys holds a larger index than /data: the index goes on from it, never below', async () => {
  const store = createMemoryStore({
    meters: { [DEVICE_ID]: { net: 5000, last: { value: 5, at: NOW - HOUR } } },
  });
  const t = await setup({
    store,
    devices: [created({ index: { value: 80, at: NOW - MINUTE } })],
  });
  await t.start();
  t.droplet.send({ volume: 1000 });
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [80, 81], 'never below what Gladys holds');
});

test('the index goes on across a restart from /data', async () => {
  const store = createMemoryStore();
  const t = await setup({ store, devices: [created()] });
  await t.start();
  t.droplet.send({ volume: 4000 });
  await t.wait(MINUTE);
  t.droplet.send({ volume: 1000 });
  await t.app.stop();
  assert.equal(store.data.meters[DEVICE_ID].net, 5000);
  const u = await setup({ store, devices: [created()], now: t.clock.now() + MINUTE });
  await u.start();
  u.droplet.send({ volume: 1000 });
  await u.wait(MINUTE);
  assert.deepEqual(u.statesOf('water_index'), [5, 6]);
});

test('a live value older than 2 minutes is never sent again as new (Gladys reconnection, device created)', async () => {
  const t = await setup();
  await t.start();
  t.droplet.send({ flow: 3, server: 'Connected', volume: 2000 });
  await t.wait(10 * SECOND);
  assert.deepEqual(t.statesOf('flow'), [0.18]);
  await t.wait(5 * MINUTE);
  // The user creates the device: the SDK forgot its states; the index goes, the old flow does not.
  await t.gladys.fake.deviceCreated(created());
  await t.wait(10 * SECOND);
  assert.deepEqual(t.statesOf('flow'), [0.18]);
  assert.deepEqual(t.statesOf('water_index'), [2, 2]);
  // Gladys reconnects: same.
  await t.app.connected(async () => CONFIG);
  await t.wait(10 * SECOND);
  assert.deepEqual(t.statesOf('flow'), [0.18]);
  assert.equal(t.droplet.attempts, 1, 'the connection to the Droplet is kept');
  t.droplet.send({ flow: 3 });
  await t.wait(10 * SECOND);
  assert.deepEqual(t.statesOf('flow'), [0.18, 0.18]);
});

test('a text is never a measure; bad values are counted, never 0', async () => {
  const t = await setup({ devices: [created()] });
  await t.start();
  t.droplet.send({ flow: '1.5', volume: 'abc', signal: 'Strong\nSignal' });
  t.droplet.send({ flow: null, volume: true, high_leak: 'MAYBE' });
  t.droplet.send('not json');
  t.droplet.send({ flow: 1e9 });
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('flow'), []);
  assert.deepEqual(t.statesOf('water_index'), []);
  assert.deepEqual(t.statesOf('signal'), []);
  assert.deepEqual(t.statesOf('leak'), []);
  assert.match(text(t.status()), /6 value\(s\) of the Droplet unreadable/);
  assert.match(text(t.status()), /1 message\(s\) that are not Droplet messages/);
});

test('pace: never two attempts less than 30 s apart; doubled while failing; the test button keeps the pace', async () => {
  const droplet = createDroplet();
  droplet.mode = 'down';
  const t = await setup({ droplet });
  await t.start();
  assert.equal(droplet.attempts, 1);
  assert.match(text(t.status()), /No connection.*unreachable.*next try in 30 s/);
  const early = await t.gladys.fake.action('test_connection');
  assert.match(said(early), /never two attempts less than 30 s apart|Never two attempts/i);
  assert.equal(droplet.attempts, 1);
  await t.wait(30 * SECOND);
  assert.equal(droplet.attempts, 2);
  await t.wait(30 * SECOND);
  assert.equal(droplet.attempts, 2, 'doubled: 60 s');
  await t.wait(30 * SECOND);
  assert.equal(droplet.attempts, 3);
  // Restarting the integration keeps the pace (the attempt is in /data before it goes).
  const u = await setup({ store: t.store, droplet, now: t.clock.now() });
  await u.start();
  assert.equal(droplet.attempts, 3);
  await u.wait(30 * SECOND);
  assert.equal(droplet.attempts, 4);
  // Saving the form again does not hurry it.
  await u.app.configUpdated(CONFIG);
  await u.settle();
  assert.equal(droplet.attempts, 4);
  await u.app.stop();
  await t.app.stop();
});

test('a connection that worked: the next one 30 s after the last attempt, without backoff', async () => {
  const t = await setup();
  await t.start();
  t.droplet.send({ flow: 1 });
  await t.wait(10 * MINUTE);
  t.droplet.close();
  await t.settle();
  assert.equal(t.droplet.attempts, 2, 'the last attempt was 10 min ago: at once');
  assert.equal(t.status().connected, true);
});

test('a dead connection (no answer to a ping within 15 s) is closed and opened again', async () => {
  const t = await setup();
  await t.start();
  await t.wait(2 * MINUTE);
  assert.ok(t.droplet.pings >= 3);
  assert.equal(t.droplet.attempts, 1);
  t.droplet.answerPings = false;
  // The next ping within 30 s, its answer awaited 15 s, the next attempt at once.
  await t.wait(50 * SECOND);
  assert.ok(t.droplet.connections[0].closed);
  assert.equal(t.droplet.attempts, 2);
});

test('pairing code refused (401): kept, nothing tried by itself; lifted by another code saved', async () => {
  const droplet = createDroplet();
  droplet.code = 'right-code';
  const t = await setup({ droplet });
  await t.start();
  assert.match(text(t.status()), /refuses the pairing code/);
  assert.equal(t.clock.pending, 0, 'no timer while refused');
  await t.wait(6 * HOUR);
  assert.equal(droplet.attempts, 1);
  // Saved again with the same code: still refused, nothing tried.
  await t.app.configUpdated(CONFIG);
  await t.wait(HOUR);
  assert.equal(droplet.attempts, 1);
  // A restart: refused still, nothing tried.
  const u = await setup({ store: t.store, droplet, now: t.clock.now() });
  await u.start();
  await u.wait(HOUR);
  assert.equal(droplet.attempts, 1);
  assert.match(text(u.status()), /refuses the pairing code/);
  // Another code saved: tried at once (the pace allows it).
  await u.app.configUpdated({ ...CONFIG, pairing_code: 'right-code' });
  await u.settle();
  assert.equal(droplet.attempts, 2);
  assert.equal(u.status().connected, true);
  assert.equal(u.store.data.refused, null);
  await t.app.stop();
  await u.app.stop();
});

test('pairing code refused: the test button tries once per click, at the pace, and a success lifts it', async () => {
  const droplet = createDroplet();
  droplet.mode = 'refused';
  const t = await setup({ droplet });
  await t.start();
  await t.wait(MINUTE);
  let answer = await t.gladys.fake.action('test_connection');
  assert.match(said(answer), /refuses the pairing code/);
  assert.equal(droplet.attempts, 2);
  answer = await t.gladys.fake.action('test_connection');
  assert.match(said(answer), /Never two attempts/);
  assert.equal(droplet.attempts, 2, 'never twice within 30 s');
  await t.wait(MINUTE);
  droplet.mode = 'ok';
  answer = await t.gladys.fake.action('test_connection');
  assert.match(said(answer), /Connected to Droplet/);
  assert.equal(droplet.attempts, 3);
  assert.equal(t.status().connected, true);
  assert.equal(t.store.data.refused, null);
});

test('an old firmware closing at once, twice in a row: the code is taken as refused', async () => {
  const droplet = createDroplet();
  droplet.mode = 'closeAtOnce';
  const t = await setup({ droplet });
  await t.start();
  assert.match(text(t.status()), /closed by the Droplet at once/);
  await t.wait(30 * SECOND);
  assert.equal(droplet.attempts, 2);
  assert.match(text(t.status()), /refuses the pairing code/);
  await t.wait(HOUR);
  assert.equal(droplet.attempts, 2);
});

test('429 and 5xx: a pause kept in /data, doubled', async () => {
  const droplet = createDroplet();
  droplet.mode = 'status';
  droplet.status = 429;
  const t = await setup({ droplet });
  await t.start();
  assert.match(text(t.status()), /too many requests.*paused for 1 min/);
  assert.equal(t.store.data.pause.count, 1);
  await t.wait(MINUTE);
  assert.equal(droplet.attempts, 2);
  assert.match(text(t.status()), /paused for 2 min/);
  const u = await setup({ store: t.store, droplet, now: t.clock.now() });
  await u.start();
  assert.equal(droplet.attempts, 2, 'the pause holds across a restart');
  await u.wait(2 * MINUTE);
  assert.equal(droplet.attempts, 3);
  await t.app.stop();
  await u.app.stop();
});

test('the certificate is pinned before the code goes; another one: nothing sent, its fingerprint shown, a typed one lifts it', async () => {
  const droplet = createDroplet();
  const t = await setup({ droplet });
  await t.start();
  assert.equal(droplet.codesSent.length, 1);
  droplet.close();
  droplet.fingerprint = OTHER_FP;
  await t.wait(30 * SECOND);
  assert.equal(droplet.attempts, 2);
  assert.equal(droplet.codesSent.length, 1, 'the code never goes to another certificate');
  assert.match(
    text(t.status()),
    new RegExp(`not the one met at the first connection.*${OTHER_FP}`),
  );
  await t.wait(HOUR);
  assert.equal(droplet.codesSent.length, 1);
  await t.app.configUpdated({ ...CONFIG, certificate_fingerprint: OTHER_FP.replaceAll(':', '') });
  await t.wait(30 * MINUTE);
  assert.equal(droplet.codesSent.length, 2);
  assert.equal(t.status().connected, true);
  assert.equal(t.store.data.pins[`${HOST}:443`], OTHER_FP);
});

test('/data unreadable: no certificate learned, nothing sent, never overwritten', async () => {
  const store = createMemoryStore({ some: 'state' });
  store.broken = true;
  const t = await setup({ store });
  await t.start();
  assert.equal(t.droplet.codesSent.length, 0);
  assert.match(text(t.status()), /\/data cannot be read: no certificate learned, nothing sent/);
  assert.equal(store.saves, 0);
});

test('/data not writable at the first connection: no certificate learned, nothing sent', async () => {
  const store = createMemoryStore();
  store.failSave = true;
  const t = await setup({ store });
  await t.start();
  assert.equal(t.droplet.attempts, 1);
  assert.equal(t.droplet.codesSent.length, 0);
  assert.match(text(t.status()), /\/data cannot be written: the certificate cannot be pinned/);
  store.failSave = false;
  await t.wait(30 * SECOND);
  assert.equal(t.droplet.codesSent.length, 1);
  assert.equal(store.data.pins[`${HOST}:443`], FP);
});

test('a restart during a handshake that hangs never tries again sooner than 30 s', async () => {
  const droplet = createDroplet();
  droplet.mode = 'hang';
  const t = await setup({ droplet });
  await t.app.start(CONFIG);
  await t.clock.advance(0);
  assert.equal(droplet.attempts, 1);
  // The container is killed during the handshake; it starts again 5 s later.
  const u = await setup({ store: t.store, droplet, now: t.clock.now() + 5 * SECOND });
  // (The fake never ends a hanging handshake; ws does, after 15 s.)
  droplet.mode = 'down';
  await u.start();
  assert.equal(droplet.attempts, 1);
  await u.wait(25 * SECOND);
  assert.equal(droplet.attempts, 2);
  await u.app.stop();
});

test('/data unreadable after the pin: volumes kept in memory, index held, added once /data reads', async () => {
  const store = createMemoryStore({ pins: { [`${HOST}:443`]: FP } });
  store.broken = true;
  const t = await setup({ store, devices: [created()] });
  await t.app.start({ ...CONFIG, certificate_fingerprint: FP });
  await t.settle();
  t.droplet.send({ volume: 3000, flow: 1 });
  await t.wait(2 * MINUTE);
  assert.deepEqual(t.statesOf('water_index'), []);
  assert.deepEqual(t.statesOf('flow'), [0.06]);
  assert.equal(store.saves, 0);
  store.broken = false;
  t.droplet.send({ volume: 1000 });
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [4]);
  assert.equal(store.data.meters[DEVICE_ID].net, 4000);
});

test('/data not writable: the index is held back, the live values go on', async () => {
  const store = createMemoryStore();
  const t = await setup({ store, devices: [created()] });
  await t.start();
  store.failSave = true;
  t.droplet.send({ volume: 3000, flow: 1 });
  await t.wait(2 * MINUTE);
  assert.deepEqual(t.statesOf('water_index'), []);
  assert.deepEqual(t.statesOf('flow'), [0.06]);
  assert.match(text(t.status()), /cannot be written/);
  store.failSave = false;
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [3]);
});

test('getConfig failing in connected: tried again, spaced, without end, the status says so', async () => {
  const t = await setup();
  let calls = 0;
  const getConfig = async () => {
    calls += 1;
    if (calls <= 3) throw new Error('down');
    return CONFIG;
  };
  await t.app.connected(getConfig);
  await t.settle();
  assert.equal(calls, 1);
  assert.equal(t.status().connected, false);
  assert.match(text(t.status()), /configuration could not be read.*5 s/);
  await t.wait(5 * SECOND);
  assert.equal(calls, 2);
  assert.match(text(t.status()), /10 s/);
  await t.wait(10 * SECOND);
  assert.equal(calls, 3);
  await t.wait(20 * SECOND);
  assert.equal(calls, 4);
  assert.equal(t.status().connected, true);
  assert.equal(t.droplet.attempts, 1);
});

test('a save during getConfig retries wins; the last of two saves wins', async () => {
  const t = await setup();
  await t.app.connected(async () => {
    throw new Error('down');
  });
  await t.settle();
  const a = t.app.configUpdated({ ...CONFIG, address: '192.168.1.31' });
  const b = t.app.configUpdated(CONFIG);
  await Promise.all([a, b]);
  await t.wait(HOUR);
  assert.match(text(t.status()), new RegExp(`at ${HOST}\\.`));
  assert.equal(t.droplet.connections.at(-1).options.host, HOST);
  assert.ok(t.droplet.connections.filter((c) => !c.closed).length <= 1, 'one connection');
});

test('a new configuration closes the connection before the next one; never two at once', async () => {
  const t = await setup();
  await t.start();
  await t.app.configUpdated({ ...CONFIG, address: '192.168.1.31' });
  await t.wait(30 * SECOND);
  assert.ok(t.droplet.connections[0].closed);
  assert.equal(t.droplet.connections.filter((c) => !c.closed).length, 1);
});

test('another Droplet at the address is another device, with its own index', async () => {
  const t = await setup({ devices: [created()] });
  await t.start();
  t.droplet.send({ volume: 2000 });
  await t.wait(MINUTE);
  t.droplet.close();
  t.droplet.info = { ...t.droplet.info, ids: 'Droplet-9z9z' };
  await t.wait(MINUTE);
  t.droplet.send({ volume: 1000 });
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [2]);
  assert.deepEqual(t.statesOf('water_index', 'Droplet-9z9z'), [1]);
  assert.equal(t.gladys.fake.discoveredDevices.length, 2);
});

test('incomplete or invalid configuration: said, nothing tried', async () => {
  for (const [config, pattern] of [
    [{}, /Enter the address/],
    [{ address: HOST }, /Enter the address/],
    [{ address: 'http://1.2.3.4', pairing_code: CODE }, /without "http:\/\/"/],
    [{ address: '1.2.3.255', pairing_code: CODE }, /not valid/],
    [{ address: HOST, pairing_code: 'a b' }, /pairing code holds a space/],
    [{ address: HOST, pairing_code: 'ab\r\nX: y' }, /pairing code holds/],
    [{ ...CONFIG, certificate_fingerprint: 'zz' }, /fingerprint is not valid/],
  ]) {
    const t = await setup({ config });
    await t.start();
    assert.match(text(t.status()), pattern, JSON.stringify(config));
    assert.equal(t.droplet.attempts, 0);
  }
});

test('stop: the connection closed, /data written with the volumes', async () => {
  const t = await setup();
  await t.start();
  t.droplet.send({ volume: 1234 });
  await t.app.stop();
  assert.ok(t.droplet.connections[0].closed);
  assert.equal(t.store.data.meters[DEVICE_ID].net, 1234);
  await t.wait(HOUR);
  assert.equal(t.droplet.attempts, 1);
});

test('the test button while connected tells the flow and the index', async () => {
  const t = await setup({ devices: [created()] });
  await t.start();
  t.droplet.send({ flow: 4.2, volume: 7000 });
  await t.wait(MINUTE);
  const answer = await t.gladys.fake.action('test_connection');
  assert.match(said(answer), /flow 4\.2 L\/min, water index 7 L/);
  assert.equal(t.droplet.attempts, 1);
});

test('the wall clock moved by NTP changes nothing to the pace nor the index', async () => {
  const t = await setup({ devices: [created()] });
  await t.start();
  t.droplet.send({ volume: 1000 });
  await t.wait(MINUTE);
  t.wall.offset = -2 * HOUR;
  t.droplet.send({ volume: 1000 });
  await t.wait(MINUTE);
  t.wall.offset = 3 * HOUR;
  t.droplet.send({ volume: 1000 });
  await t.wait(MINUTE);
  assert.deepEqual(t.statesOf('water_index'), [1, 2, 3]);
});
