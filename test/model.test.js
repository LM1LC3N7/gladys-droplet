// -----------------------------------------------------------------------------
// The messages of the Droplet (src/droplet/model.js), the configuration
// (src/config.js) and the devices (src/devices.js), pure.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { normalizeConfig, parseCode, parseFingerprint, parseHost } from '../src/config.js';
import { buildDevice, liveStates, lpmToM3h } from '../src/devices.js';
import { cleanText, parseMessage } from '../src/droplet/model.js';

test('the information message: the device id, strictly', () => {
  assert.deepEqual(
    parseMessage(JSON.stringify({ ids: 'Droplet-1a2b', mdl: 'M', mf: 'H', sw: 'v1', sn: 'S' })),
    {
      kind: 'info',
      id: 'Droplet-1a2b',
      model: 'M',
      manufacturer: 'H',
      firmware: 'v1',
    },
  );
  for (const ids of ['a.b', '../x', 'a:b', 'x'.repeat(65), 5, ['a']]) {
    assert.deepEqual(
      parseMessage(JSON.stringify({ ids })),
      { kind: 'info', invalidId: true },
      String(ids),
    );
  }
  // An empty ids is not an information message (pydroplet: a truthy ids).
  assert.equal(parseMessage(JSON.stringify({ ids: '' })), undefined);
});

test('the state message: numbers as JSON numbers within bounds, texts bounded, leaks ON/OFF', () => {
  assert.deepEqual(
    parseMessage(
      JSON.stringify({
        flow: 0.5,
        volume: -2.5,
        server: ' Connected ',
        signal: 'Strong Signal',
        low_leak: 'OFF',
        high_leak: 'ON',
      }),
    ),
    {
      kind: 'state',
      rejected: 0,
      flow: 0.5,
      volume: -2.5,
      server: 'Connected',
      signal: 'Strong Signal',
      lowLeak: false,
      highLeak: true,
    },
  );
  const bad = parseMessage(
    JSON.stringify({
      flow: '0.5',
      volume: 1e12,
      server: 'a\nb',
      signal: 'x'.repeat(65),
      low_leak: 'on',
      high_leak: 1,
    }),
  );
  assert.deepEqual(bad, { kind: 'state', rejected: 6 });
  assert.deepEqual(parseMessage(JSON.stringify({ flow: null, server: '' })), undefined);
  assert.deepEqual(parseMessage(JSON.stringify({ high_leak: true })), {
    kind: 'state',
    rejected: 0,
    highLeak: true,
  });
});

test('not a message of the Droplet: undefined, never a crash, no prototype pollution', () => {
  for (const text of ['', 'x', '[1]', '5', 'null', '{"other":1}', undefined, 5]) {
    assert.equal(parseMessage(text), undefined, String(text));
  }
  const msg = parseMessage('{"__proto__":{"polluted":1},"flow":1}');
  assert.equal(msg.flow, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(cleanText('a\u2028b'), undefined);
  assert.equal(cleanText('ok'), 'ok');
});

test('the address: IP, host, IPv6, a pasted wss/https URL; refused: http, ws, broadcast, credentials, a path', () => {
  assert.deepEqual(parseHost('192.168.1.30'), { host: '192.168.1.30', port: null });
  assert.deepEqual(parseHost('wss://192.168.1.30/ws'), { host: '192.168.1.30', port: null });
  assert.deepEqual(parseHost('https://192.168.1.30:8443'), { host: '192.168.1.30', port: 8443 });
  assert.deepEqual(parseHost('Droplet-1234.local'), { host: 'droplet-1234.local', port: null });
  assert.deepEqual(parseHost('[fe80::1]:443'), { host: 'fe80::1', port: 443 });
  assert.deepEqual(parseHost(''), { error: 'missing' });
  for (const bad of ['http://1.2.3.4', 'ws://1.2.3.4']) assert.equal(parseHost(bad).error, 'http');
  for (const bad of [
    '1.2.3.255',
    '0.0.0.0',
    '224.0.0.1',
    'https://u:p@1.2.3.4',
    'wss://1.2.3.4/x',
    '::',
    'ff02::1',
    'a b',
    '1.2.3.4:0',
  ]) {
    assert.equal(parseHost(bad).error, 'invalid', bad);
  }
});

test('the pairing code: printable ASCII without space, 64 at most; surrounding spaces of a paste dropped', () => {
  assert.deepEqual(parseCode(' 123456 '), { code: '123456' });
  assert.deepEqual(parseCode(''), { error: 'missing' });
  assert.deepEqual(parseCode(undefined), { error: 'missing' });
  for (const bad of ['12 34', '12\r\n34', 'é123', 'x'.repeat(65), '12\u0000']) {
    assert.deepEqual(parseCode(bad), { error: 'invalid' }, JSON.stringify(bad));
  }
  assert.equal(parseFingerprint('ab'.repeat(32)), `${'AB:'.repeat(31)}AB`);
  assert.equal(parseFingerprint('zz'), null);
  assert.equal(parseFingerprint(''), '');
  const config = normalizeConfig({ address: '1.2.3.4', pairing_code: 'abc' });
  assert.deepEqual(config, {
    host: '1.2.3.4',
    hostError: null,
    port: 443,
    code: 'abc',
    codeError: null,
    fingerprint: '',
  });
});

test('the device: read-only, core units, flow in m³/h, texts as text', () => {
  const gladys = createFakeGladys({ selector: 'droplet' });
  const device = buildDevice(gladys, 'Droplet-1a2b', { model: 'Droplet' }, '1.2.3.4');
  assert.equal(device.external_id, 'ext:droplet:droplet:Droplet-1a2b');
  assert.equal(device.name, 'Droplet 1a2b');
  assert.equal(lpmToM3h(10), 0.6);
  for (const f of device.features) assert.equal(f.read_only, true);
  const fresh = () => true;
  const states = liveStates(
    gladys,
    'Droplet-1a2b',
    {
      flow: { value: -1, at: 0 },
      server: { value: 'Connected', at: 0 },
      highLeak: { value: false, at: 0 },
    },
    fresh,
  );
  assert.deepEqual(states, [
    { device_feature_external_id: 'ext:droplet:droplet:Droplet-1a2b:flow', state: -0.06 },
    { device_feature_external_id: 'ext:droplet:droplet:Droplet-1a2b:server', text: 'Connected' },
    { device_feature_external_id: 'ext:droplet:droplet:Droplet-1a2b:leak', state: 0 },
  ]);
  assert.deepEqual(
    liveStates(gladys, 'Droplet-1a2b', { flow: { value: 1, at: 0 } }, () => false),
    [],
  );
});
