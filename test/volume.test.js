// -----------------------------------------------------------------------------
// The water index built from the volume reports (src/volume.js), pure.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VOLUME_LIMITS } from '../src/constants.js';
import { WaterIndex } from '../src/volume.js';

const MINUTE = 60_000;
const make = (opts = {}) => new WaterIndex({ limits: VOLUME_LIMITS, ...opts });

test('needs its limits', () => {
  assert.throws(() => new WaterIndex({}), TypeError);
  assert.throws(() => new WaterIndex({ limits: { maxLpm: 0, slackL: 1, maxGapMs: 1 } }), TypeError);
});

test('reports add up in mL without drift; published in L rounded down; never 0', () => {
  const w = make();
  assert.equal(w.take(0), undefined);
  for (let i = 0; i < 1000; i += 1) assert.equal(w.add(0.1, 1000, i), 'counted');
  assert.equal(w.net, 100);
  assert.equal(w.take(1), 0.1);
  w.add(0.9, 1000, 2);
  assert.equal(w.take(3), 0.1, 'rounded down to the mL');
  const zero = make();
  zero.add(-5, 1000, 0);
  assert.equal(zero.take(0), undefined);
});

test('the bound: 200 L/min over the time since the previous report (capped to 10 min) plus 10 L', () => {
  const w = make();
  assert.equal(w.bound(0), 10_000);
  assert.equal(w.bound(MINUTE), 210_000);
  assert.equal(w.bound(60 * MINUTE), w.bound(10 * MINUTE));
  assert.equal(w.bound(-5), 10_000);
  assert.equal(w.add(210_000, MINUTE, 0), 'counted');
  assert.equal(w.add(210_001, MINUTE, 0), 'held');
  assert.equal(w.add(-210_001, MINUTE, 0), 'ignored');
  assert.equal(w.add(Number.NaN, MINUTE, 0), 'ignored');
  assert.equal(w.add('5', MINUTE, 0), 'ignored');
  assert.deepEqual(w.held, { ml: 210_001, count: 1, at: 0 });
  assert.deepEqual(w.ignored, { count: 1, ml: 210_001 });
  assert.equal(w.net, 210_000);
});

test('never down: a negative report lowers the net, the index waits until it climbs back', () => {
  const w = make();
  w.add(5000, MINUTE, 0);
  assert.equal(w.take(0), 5);
  w.add(-2000, MINUTE, 1);
  assert.equal(w.take(1), 5);
  assert.equal(w.shortfall(), 2);
  w.add(1500, MINUTE, 2);
  assert.equal(w.take(2), 5);
  w.add(1000, MINUTE, 3);
  assert.equal(w.take(3), 5.5);
  assert.equal(w.shortfall(), 0);
});

test('acceptance: exactly what was listed, only when at least that much is still held', () => {
  const w = make();
  w.add(500_000, 0, 0);
  w.add(400_000, 0, 1);
  assert.deepEqual(w.held, { ml: 900_000, count: 2, at: 0 });
  assert.equal(w.acceptHeld(1_000_000), 0, 'more than held');
  assert.equal(w.acceptHeld(0), 0);
  assert.equal(w.acceptHeld(-5), 0);
  assert.equal(w.acceptHeld(500_000), 500);
  assert.equal(w.held.ml, 400_000);
  assert.equal(w.take(2), 500);
  assert.equal(w.acceptHeld(400_000), 400);
  assert.equal(w.held, undefined);
  assert.equal(w.acceptHeld(1), 0, 'nothing held');
});

test('from /data and Gladys: the larger last value wins; Gladys above /data moves the net up', () => {
  const saved = { net: 5000, last: { value: 5, at: 1 }, held: { ml: 1, count: 1, at: 1 } };
  const a = make({ saved, gladysLast: { value: 3, at: 2 } });
  assert.equal(a.last.value, 5);
  assert.equal(a.net, 5000);
  const b = make({ saved, gladysLast: { value: 80, at: 2 } });
  assert.equal(b.last.value, 80);
  assert.equal(b.net, 80_000);
  b.add(1000, MINUTE, 3);
  assert.equal(b.take(3), 81);
  // A net below last after negative reports stays: never reset by a restart.
  const c = make({ saved: { net: 4000, last: { value: 5, at: 1 } } });
  assert.equal(c.net, 4000);
  assert.equal(c.take(1), 5);
  // Odd /data: dropped, never trusted.
  const d = make({
    saved: { net: 'x', last: { value: -1, at: 1 }, held: { ml: -3 }, ignored: { count: 0 } },
  });
  assert.equal(d.net, 0);
  assert.equal(d.last, undefined);
  assert.equal(d.held, undefined);
  assert.equal(d.ignored, undefined);
});

test('merge: an index built apart (no /data, no id yet) adds its net, held and ignored', () => {
  const w = make({ saved: { net: 1000 } });
  const apart = make();
  apart.add(2000, MINUTE, 0);
  apart.add(900_000, 0, 1);
  apart.add(-900_000, 0, 2);
  w.merge(apart);
  assert.equal(w.net, 3000);
  assert.deepEqual(w.held, { ml: 900_000, count: 1, at: 1 });
  assert.deepEqual(w.ignored, { count: 1, ml: 900_000 });
  assert.deepEqual(w.state(), {
    net: 3000,
    last: null,
    held: { ml: 900_000, count: 1, at: 1 },
    ignored: { count: 1, ml: 900_000 },
  });
});
