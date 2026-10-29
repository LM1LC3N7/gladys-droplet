// -----------------------------------------------------------------------------
// /data: no file is an empty state; a file that cannot be read is NOT (the
// app then never overwrites it); saves go one after the other.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore } from '../src/store.js';
import { CONFIG, FP, created, setup } from './helpers/app.js';

const dirOf = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'droplet-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

test('no file yet: an empty state; a save then a load give it back', async (t) => {
  const file = join(await dirOf(t), 'state.json');
  const store = createFileStore(file);
  assert.deepEqual(store.load(), { ok: true, data: {} });
  await Promise.all([store.save({ a: 1 }), store.save({ a: 2 })]);
  assert.deepEqual(store.load(), { ok: true, data: { a: 2 } });
});

test('a file that cannot be read is not an empty state', async (t) => {
  const dir = await dirOf(t);
  for (const [name, content] of [
    ['broken.json', '{"meters":'],
    ['array.json', '[1,2]'],
    ['big.json', `{"x":"${'a'.repeat(1100 * 1024)}"}`],
  ]) {
    const file = join(dir, name);
    await writeFile(file, content);
    assert.equal(createFileStore(file).load().ok, false, name);
  }
  // A directory in place of the file (EISDIR).
  assert.equal(createFileStore(dir).load().ok, false);
});

test('the app never overwrites a /data file it could not read', async (t) => {
  const file = join(await dirOf(t), 'state.json');
  await writeFile(file, '{"meters":{"Droplet-1a2b":{"net":');
  const cfg = { ...CONFIG, certificate_fingerprint: FP };
  const { start, wait, gladys, droplet } = await setup({
    store: createFileStore(file),
    devices: [created()],
    config: cfg,
  });
  await start(cfg);
  droplet.send({ volume: 1000 });
  await wait(5 * 60_000);
  assert.equal(await readFile(file, 'utf8'), '{"meters":{"Droplet-1a2b":{"net":');
  assert.ok(!gladys.fake.states.some((s) => s.device_feature_external_id.endsWith(':water_index')));
});
