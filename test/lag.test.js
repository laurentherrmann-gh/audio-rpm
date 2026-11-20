import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateLag } from '../public/lag.js';
import { makeSchedule, rpmAt } from '../public/engine-model.js';
import { Ring } from '../public/ring.js';

const schedule = makeSchedule({ idleRpm: 900, redline: 7500 });
const truth = t => rpmAt(schedule, t);
const outputs = (delay, { offsetAtIdle = 0, noise = 0 } = {}) => {
  const pts = [];
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let t = 0.5; t < 30; t += 0.005) {
    let y = truth(t - delay);
    if (y < 1000) y += offsetAtIdle; // a detector that misreads idle by a constant
    pts.push({ t, y: y + rand() * noise });
  }
  return pts;
};

for (const d of [0, 0.02, 0.05, 0.12]) {
  test(`recovers a ${d * 1000} ms delay`, () => {
    const r = estimateLag(outputs(d, { noise: 30 }), truth);
    assert.ok(r && Math.abs(r.lag - d) <= 0.006, `got ${r && r.lag}`);
  });
}

test('a constant error at idle does not bias the estimate', () => {
  const r = estimateLag(outputs(0.03, { offsetAtIdle: -230, noise: 30 }), truth);
  assert.ok(r && Math.abs(r.lag - 0.03) <= 0.006, `got ${r && r.lag}`);
});

test('steady revs give no estimate', () => {
  const pts = Array.from({ length: 200 }, (_, i) => ({ t: i * 0.01, y: 3000 }));
  assert.equal(estimateLag(pts, () => 3000), null);
});

test('ring buffer returns the newest samples in order', () => {
  const r = new Ring(8);
  r.push(Float32Array.from([1, 2, 3]));
  assert.deepEqual([...r.latest(5)], [0, 0, 1, 2, 3]);
  r.push(Float32Array.from([4, 5, 6, 7, 8, 9, 10]));
  assert.deepEqual([...r.latest(4)], [7, 8, 9, 10]);
  assert.deepEqual([...r.latest(8)], [3, 4, 5, 6, 7, 8, 9, 10]);
});
