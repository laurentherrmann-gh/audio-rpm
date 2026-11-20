import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tracker } from '../public/tracker.js';

const TICK = 20;
const opts = { tau: 0.08, maxAccel: 40000, maxVel: 40000, reacquire: 0.25, lag: 0.04 };

function feed(tr, readings, t0 = 0) {
  return readings.map((z, i) => tr.step(z, t0 + i * TICK));
}

test('a single octave-error frame is rejected', () => {
  const tr = new Tracker(opts);
  feed(tr, Array(20).fill(5000));
  const out = tr.step(2500, 20 * TICK);
  assert.equal(out.coast, true);
  assert.ok(Math.abs(out.rpm - 5000) < 100, `held at ${out.rpm}`);
});

test('a gear shift is accepted once readings agree for confirmMs, without overshoot', () => {
  const tr = new Tracker({ ...opts, confirmMs: 40 });
  const ramp = Array.from({ length: 30 }, (_, i) => 5000 + i * 60); // climbing ~3000 rpm/s
  feed(tr, ramp);
  const after = feed(tr, [4800, 4810, 4820, 4830], 30 * TICK);
  assert.ok(after.every(o => o.rpm < 7400), 'no overshoot past the last reading');
  assert.equal(after[1].coast, true, 'not yet: 20 ms of agreement');
  assert.equal(after[2].coast, false, 'accepted after 40 ms of agreement');
  assert.ok(Math.abs(after[2].rpm - 4820) < 50);
});

test('with smoothing off, readings pass straight through', () => {
  const tr = new Tracker({ ...opts, tau: 0 });
  assert.equal(tr.step(3000, 0).rpm, 3000);
  assert.equal(tr.step(6000, 20).rpm, 6000);
  assert.equal(tr.step(null, 40), null);
});

test('loses lock after coasting with no signal', () => {
  const tr = new Tracker(opts);
  feed(tr, Array(10).fill(4000));
  const out = feed(tr, Array(40).fill(null), 10 * TICK);
  assert.equal(out[5].coast, true);
  assert.equal(out.at(-1), null);
});
