import test from 'node:test';
import assert from 'node:assert/strict';
import { PathTracker, PATH } from '../public/path.js';

const dt = 256 / 48000;
/**
 * Feed a tracker for `seconds`: pitch readings describe the moment 20 ms back, gyroball's (every
 * fourth step) the moment 85 ms back; each is truth(of that moment) × what the detector does to it.
 * @returns {{ t:number, now:object|null, back:object|null }[]} what it read at 0 and at 30 ms back
 */
function run(truth, seconds, { pd = () => 1, gyro = () => 1 } = {}, p = new PathTracker()) {
  const out = [];
  let k = 0;
  for (let t = 0; t < seconds; t += dt, k++) {
    const made = [], a = pd(t), b = gyro(t);
    if (a) made.push({ rpm: truth(t - 0.02) * a, age: 0.02, key: 'pitch' });
    if (b && k % 4 === 0) made.push({ rpm: truth(t - 0.085) * b, age: 0.085, key: 'gyroball', lasts: 0.02 });
    p.push(t, made);
    out.push({ t, now: p.read(0), back: p.read(0.03) });
  }
  return out;
}
const off = (o, truth, look) => Math.abs((look ? o.back : o.now).rpm / truth(o.t - look) - 1);

test('readings are filed under the moment they describe: on a pull, the path read 30 ms back is on the truth', () => {
  const truth = t => 3000 + 2500 * t; // a hard pull
  const out = run(truth, 2).filter(o => o.t > 0.3);
  assert.ok(out.every(o => off(o, truth, 0.03) < 0.02), 'within 2% at 30 ms back');
  assert.ok(out.every(o => off(o, truth, 0) < 0.04), 'within 4% at now (carried on from readings 20 ms old)');
});

test('one detector on half the revs for a while, the other right: the path stays', () => {
  const truth = () => 6000;
  for (const who of ['pd', 'gyro']) {
    const out = run(truth, 3, { [who]: t => (t > 1 && t < 2 ? 0.5 : 1) });
    assert.ok(out.filter(o => o.t > 0.3).every(o => off(o, truth, 0.03) < 0.02), `${who} at half`);
  }
});

test('both detectors slip to half for a moment: the path holds its line, by the octave', () => {
  const truth = t => 5000 + 300 * t, slip = t => (t > 1 && t < 1.08 ? 0.5 : 1);
  const out = run(truth, 2.5, { pd: slip, gyro: slip });
  assert.ok(out.filter(o => o.t > 0.3).every(o => off(o, truth, 0.03) < 0.03));
  assert.ok(out.find(o => o.t > 1.06).back.source.includes('×2'), 'it says where the value came from');
  // …and when they stay there, it follows: half a second later it is on what they read
  const stay = run(truth, 2.5, { pd: t => (t > 1 ? 0.5 : 1), gyro: t => (t > 1 ? 0.5 : 1) });
  assert.ok(Math.abs(stay.find(o => o.t > 1.6).back.rpm / (truth(1.57) / 2) - 1) < 0.03);
});

test('pitch-detection on a quarter of the revs, gyroball right or on half (a real engine on the limiter): the top value', () => {
  const truth = () => 7100;
  const out = run(truth, 3, { pd: t => (t > 1 ? 0.25 : 1), gyro: t => (t > 1.5 && t < 1.6 ? 0.5 : 1) });
  assert.ok(out.filter(o => o.t > 0.3).every(o => off(o, truth, 0.03) < 0.02));
  // …also when the path starts there, with nothing before to hold on to
  const cold = run(truth, 2, { pd: () => 0.25 });
  assert.ok(cold.filter(o => o.t > 0.5).every(o => off(o, truth, 0.03) < 0.02));
});

test('a gear shift is followed, not smoothed away', () => {
  const truth = t => (t < 1 ? 6500 : 4600); // the revs drop by 30% at once
  const out = run(truth, 2);
  const late = out.filter(o => o.t > 1.08 && o.t < 1.9);
  assert.ok(late.every(o => off(o, truth, 0.03) < 0.02), 'on the new revs 50 ms after the shift, read 30 ms back');
  assert.ok(out.filter(o => o.t > 0.3 && o.t < 0.99).every(o => off(o, truth, 0.03) < 0.02));
});

test('pitch-detection jumping to twice the revs for a tenth of a second is not followed', () => {
  const truth = () => 4500;
  const out = run(truth, 2, { pd: t => (t > 1 && t < 1.1 ? 2 : 1) });
  assert.ok(out.filter(o => o.t > 0.3).every(o => off(o, truth, 0.03) < 0.02));
});

test('nothing heard: the last value is held for a while, then there is none', () => {
  const p = new PathTracker(), truth = () => 4000;
  assert.equal(p.read(0), null, 'nothing yet');
  const out = run(truth, 2, { pd: t => (t < 1 ? 1 : 0), gyro: t => (t < 1 ? 1 : 0) }, p);
  const during = out.find(o => o.t > 1.15), after = out.find(o => o.t > 1 + PATH.coast + 0.15);
  assert.ok(during.now && during.now.held && Math.abs(during.now.rpm / 4000 - 1) < 0.02, 'held');
  assert.equal(after.now, null);
  assert.equal(after.back, null);
  p.reset();
  assert.equal(p.read(0), null);
});
