// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { ACTIONS } from '../src/constants.js';
import { buildDevice } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');
const dockerfile = read('Dockerfile');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) yield* texts(item, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

const fakeGladys = {
  externalIds: (type, id) => ({
    device: `ext:x:${type}:${id}`,
    feature: (key) => `ext:x:${type}:${id}:${key}`,
  }),
};
const device = buildDevice(fakeGladys, 'Droplet-1a2b', { model: 'M' }, '1.2.3.4');

test('the store basics; one semver version in 4 places, never pinned here', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-droplet:${manifest.version}`);
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.name, 'gladys-droplet');
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.scripts.test, 'node --test --test-timeout=60000');
  assert.deepEqual(manifest.categories, ['energy', 'security']);
  assert.deepEqual(manifest.transports, ['local']);
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.ok(!('keywords' in manifest) && !('countries' in manifest), 'in TODO.md for later');
  assert.match(
    manifest.cover_image,
    /^https:\/\/raw\.githubusercontent\.com\/LM1LC3N7\/gladys-droplet\//,
  );
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    assert.ok(read(`docs/${lang}.md`).length >= 300, `docs/${lang}.md is too short for the store`);
  }
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /Non officiel/);
});

test('the cover is an 800 x 534 PNG', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('the docs say it was never tested with a real Droplet', () => {
  assert.match(read('docs/fr.md'), /[Jj]amais\s+testé\s+avec\s+un\s+vrai\s+Droplet/);
  assert.match(read('docs/en.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+Droplet/);
  assert.match(read('README.md'), /[Nn]ever\s+tested\s+with\s+a\s+real\s+Droplet/);
  assert.match(manifest.config_schema[0].description.en, /Never tested with a real Droplet/);
  assert.match(manifest.config_schema[0].description.fr, /Jamais testé avec un vrai Droplet/);
});

test('every text is in English and French; placeholders too', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
    }
  }
  for (const field of manifest.config_schema) {
    if ('placeholder' in field) {
      assert.equal(typeof field.placeholder, 'object', `${field.key}.placeholder`);
    }
  }
});

test('the configuration matches the code: address, pairing code (secret), optional fingerprint', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  assert.deepEqual(Object.keys(fields), [
    'intro',
    'address',
    'pairing_code',
    'certificate_fingerprint',
  ]);
  for (const key of Object.keys(fields)) {
    assert.ok(!key.startsWith('gladys_'), `${key}: never prefixed gladys_`);
  }
  assert.equal(fields.address.type, 'string');
  assert.equal(fields.address.required, true);
  assert.equal(fields.pairing_code.type, 'secret');
  assert.equal(fields.pairing_code.required, true);
  assert.equal(fields.certificate_fingerprint.required, false);
  for (const field of manifest.config_schema.filter((f) => f.type === 'secret')) {
    assert.ok(!('default' in field), `${field.key}: never a default on a secret`);
  }
  assert.match(
    fields.pairing_code.description.en,
    /Kept by Gladys in its database, never shown again, sent only to the Droplet/,
  );
  assert.match(
    fields.pairing_code.description.fr,
    /Gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement au Droplet/,
  );
  for (const link of fields.intro.links) assert.match(link.url, /^https:\/\//);
});

test('the actions of the manifest are the handlers of the code; read-only', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(index.includes('onAction(ACTIONS.ACCEPT_HELD'));
  assert.ok(index.includes('onDeviceCreated'));
  assert.ok(index.includes("on('connected'"));
  assert.match(
    index,
    /\.connected\(\(\) => gladys\.getConfig\(\)\)/,
    'getConfig retried by the app',
  );
  assert.ok(!index.includes('onSetValue'), 'no command: read-only');
  const strip = (code) => code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const client = strip(read('src/droplet/client.js'));
  assert.ok(!/\.send\(/.test(client), 'never a message sent to the Droplet');
  assert.ok(!client.includes('agent: false'), 'ws passes its own createConnection');
  assert.ok(!client.includes('logger'), 'the client never logs');
  assert.match(client, /perMessageDeflate: false/);
  assert.match(client, /followRedirects: false/);
});

test('the device: core units only, nothing writable, no switch', () => {
  const units = {
    'water-valve': ['cubic-meter-per-hour'],
    'volume-sensor': ['liter'],
    text: [undefined],
    'leak-sensor': [undefined],
  };
  for (const feature of device.features) {
    assert.ok(units[feature.category]?.includes(feature.unit), feature.external_id);
    assert.equal(feature.read_only, true);
    assert.notEqual(feature.category, 'switch');
  }
  assert.deepEqual(
    device.features.map((f) => f.external_id.split(':').pop()),
    ['flow', 'water_index', 'server', 'signal', 'leak', 'unusual_flow'],
  );
});

test('supported_options of every published feature pass the rules of the core', () => {
  const core = new URL(
    '../../../Gladys/server/utils/normalizeSupportedOptions.js',
    import.meta.url,
  );
  let normalize;
  if (existsSync(core)) {
    try {
      normalize = createRequire(core)(core.pathname);
    } catch {
      normalize = undefined;
    }
  }
  let count = 0;
  for (const feature of device.features) {
    const options = feature.supported_options;
    if (options === undefined) continue;
    count += 1;
    const values = options.map((o) => `${o.value}`);
    assert.equal(new Set(values).size, values.length, 'unique values');
    for (const o of options) {
      assert.equal(typeof o.label, 'string');
      assert.ok(o.label.trim() !== '' && o.label === o.label.trim(), 'plain label');
      assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
    }
    if (typeof normalize === 'function') normalize(feature);
  }
  // This integration publishes no select today: the rule holds for any added later.
  assert.equal(count, 0);
});

test('the licenses ship in the image; no name in LICENSE', () => {
  assert.match(dockerfile, /COPY LICENSE THIRD_PARTY_NOTICES\.md/);
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /pydroplet/);
  assert.match(notices, /MIT License/);
  assert.match(notices, /Hydrific/);
});

test('the code never feeds the energy consumption endpoint nor scene events', () => {
  for (const file of ['index.js', 'src/app.js', 'src/devices.js']) {
    assert.doesNotMatch(read(file), /publishEnergyConsumption\(/, file);
    assert.doesNotMatch(read(file), /publishSceneEvent\(/, file);
  }
});
