// -----------------------------------------------------------------------------
// The WebSocket client against a REAL local TLS server: the certificate
// checked before the code goes, the answers to the handshake (401, 503, 429),
// an answer before the request, a message too large cut, pings answered.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectDroplet, CODES, DropletError } from '../src/droplet/client.js';
import { MAX_MESSAGE_BYTES } from '../src/constants.js';
import { certs, dropletServer, fingerprintOf, impostorServer } from './helpers/server.js';
import { until } from './helpers/app.js';

const CODE = 'Pa1r-c0de';

function open(srv, extra = {}) {
  const got = { messages: [], closes: [], alive: 0, peers: [] };
  const handle = connectDroplet({
    host: '127.0.0.1',
    port: srv.port,
    code: CODE,
    checkPeer: async (fp) => {
      got.peers.push(fp);
      if (extra.checkPeer) await extra.checkPeer(fp);
    },
    onMessage: (text) => got.messages.push(text),
    onAlive: () => {
      got.alive += 1;
    },
    onClose: (end) => got.closes.push(end),
    ...(extra.handshakeTimeout ? { handshakeTimeout: extra.handshakeTimeout } : {}),
  });
  return { handle, got };
}

test('opens with the code in Authorization after the certificate check; messages and pings', async (t) => {
  const srv = await dropletServer();
  t.after(() => srv.close());
  const { handle, got } = open(srv);
  await handle.opened;
  assert.deepEqual(got.peers, [srv.fingerprint]);
  assert.deepEqual(srv.upgrades, [CODE]);
  await until(() => got.messages.length === 1);
  assert.deepEqual(JSON.parse(got.messages[0]).ids, 'Droplet-1a2b');
  srv.send({ flow: 1.5 });
  await until(() => got.messages.length === 2);
  const before = got.alive;
  handle.ping();
  await until(() => got.alive > before);
  srv.dropAll();
  await until(() => got.closes.length === 1);
  handle.close();
});

test('a certificate refused by checkPeer: the code never leaves', async (t) => {
  const srv = await dropletServer({ certificate: certs.impostor });
  t.after(() => srv.close());
  const { handle } = open(srv, {
    checkPeer: (fp) => {
      assert.equal(fp, fingerprintOf(certs.impostor));
      throw new DropletError(CODES.CERTIFICATE, 'Another certificate', { fingerprint: fp });
    },
  });
  await assert.rejects(handle.opened, (err) => err.code === CODES.CERTIFICATE && err.notSent);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(srv.upgrades, []);
});

test('a slow certificate check holds the request; the code goes after it', async (t) => {
  const srv = await dropletServer();
  t.after(() => srv.close());
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { handle } = open(srv, { checkPeer: () => gate });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(srv.upgrades, []);
  release();
  await handle.opened;
  assert.deepEqual(srv.upgrades, [CODE]);
  handle.close();
});

test('the answers to the handshake: 401 refused, 503 server, 429 rate limited', async (t) => {
  const srv = await dropletServer({ code: 'other' });
  t.after(() => srv.close());
  await assert.rejects(open(srv).handle.opened, (err) => err.code === CODES.REFUSED);
  srv.mode = 'status';
  srv.status = 503;
  await assert.rejects(
    open(srv).handle.opened,
    (err) => err.code === CODES.SERVER && err.status === 503,
  );
  srv.status = 429;
  await assert.rejects(open(srv).handle.opened, (err) => err.code === CODES.RATE_LIMITED);
  srv.status = 404;
  await assert.rejects(open(srv).handle.opened, (err) => err.code === CODES.HTTP);
});

test('an old firmware that accepts then closes at once: opened, then closed', async (t) => {
  const srv = await dropletServer();
  t.after(() => srv.close());
  srv.mode = 'closeAtOnce';
  const { handle, got } = open(srv);
  await handle.opened;
  await until(() => got.closes.length === 1);
  assert.equal(got.messages.length, 0);
});

test('an answer written before the request is never taken', async (t) => {
  const srv = await impostorServer();
  t.after(() => srv.close());
  const { handle } = open(srv, {
    checkPeer: () => new Promise((resolve) => setTimeout(resolve, 100)),
  });
  await assert.rejects(handle.opened, (err) => err.code === CODES.BAD_ANSWER);
  assert.equal(srv.received, 0, 'nothing sent');
});

test('bytes written before the request, even an answer not complete yet: nothing sent', async (t) => {
  const srv = await impostorServer({ answer: 'HTTP/1.1 101 Switch' });
  t.after(() => srv.close());
  const { handle } = open(srv, {
    checkPeer: () => new Promise((resolve) => setTimeout(resolve, 100)),
  });
  await assert.rejects(handle.opened, (err) => err.code === CODES.BAD_ANSWER && err.notSent);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(srv.received, 0, 'nothing sent');
});

test('a message above the limit is cut, the connection closed', async (t) => {
  const srv = await dropletServer();
  t.after(() => srv.close());
  const { handle, got } = open(srv);
  await handle.opened;
  await until(() => got.messages.length === 1);
  srv.send('x'.repeat(MAX_MESSAGE_BYTES + 1));
  await until(() => got.closes.length === 1);
  assert.equal(got.messages.length, 1);
  assert.equal(got.closes[0].error?.tooLarge, true);
});

test('unreachable and silent hosts fail with our own words', async () => {
  const { handle } = open({ port: 1 });
  await assert.rejects(handle.opened, (err) => {
    assert.equal(err.code, CODES.UNREACHABLE);
    assert.ok(!err.message.includes('127.0.0.1'));
    return true;
  });
  const net = await import('node:net');
  const sockets = new Set();
  const silent = net.createServer((s) => sockets.add(s));
  await new Promise((resolve) => silent.listen(0, '127.0.0.1', resolve));
  const slow = open({ port: silent.address().port }, { handshakeTimeout: 300 });
  await assert.rejects(slow.handle.opened, (err) => err.code === CODES.TIMEOUT);
  for (const s of sockets) s.destroy();
  await new Promise((resolve) => silent.close(resolve));
});
