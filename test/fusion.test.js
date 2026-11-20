import test from 'node:test';
import assert from 'node:assert/strict';
import { Fusion, FUSION } from '../public/fusion.js';

const dt = 256 / 48000;
const reading = rpm => (rpm == null ? { rpm: null, raw: null, coast: false } : { rpm, raw: rpm, coast: false });
/** Feed pd(t) and gyro(t) for `seconds`; returns [{ t, rpm, coast }]. */
function run(pd, gyro, seconds, f = new Fusion()) {
  const out = [];
  for (let t = 0; t < seconds; t += dt) out.push({ t, ...f.step(t, reading(pd(t)), reading(gyro(t))) });
  return out;
}
const at = (out, t) => out.find(o => o.t >= t);

test('both agree: the output is pitch-detection (the faster one)', () => {
  const out = run(t => 3000 + 500 * t, t => 2990 + 500 * t, 2);
  assert.ok(out.every(o => o.source === 'pitch' && Math.abs(o.rpm - (3000 + 500 * o.t)) < 1e-6));
});

test('one detector an octave or two below the other: the higher octave, with pitch-detection\'s value', () => {
  for (const m of [2, 4]) {
    const out = run(() => 7100 / m, () => 7100, 1);
    assert.ok(Math.abs(at(out, 0.5).rpm - 7100) < 1);
    const other = run(() => 7100, () => 7100 / m, 1); // gyroball low: pitch-detection is right as it is
    assert.ok(Math.abs(at(other, 0.5).rpm - 7100) < 1);
  }
});

test('both slip to half at once (the rev limiter): held at the true revs, for a while', () => {
  const slip = t => (t > 1 && t < 2.5 ? 3550 : 7100);
  const out = run(slip, slip, 3.5);
  assert.ok(out.filter(o => o.t > 0.1).every(o => Math.abs(o.rpm - 7100) < 80), 'never shows the half');
  // a drop to half that stays is believed in the end
  const stays = run(t => (t > 1 ? 3550 : 7100), t => (t > 1 ? 3550 : 7100), 5);
  assert.ok(Math.abs(at(stays, 1 + FUSION.slipHold - 0.2).rpm - 7100) < 80);
  assert.ok(Math.abs(at(stays, 1 + FUSION.slipHold + 0.3).rpm - 3550) < 40);
});

test('a gear shift (×0.7) is not a slip: followed at once, even while gyroball lags', () => {
  const out = run(t => (t > 1 ? 4900 : 7000), t => (t > 1.15 ? 4900 : 7000), 2);
  assert.ok(Math.abs(at(out, 1.02).rpm - 4900) < 1);
});

test('revs falling through "half of the other reading" are not raised', () => {
  // pitch-detection follows a fast fall; gyroball lags 150 ms behind it
  const fall = t => 7000 * Math.exp(-2.5 * Math.max(0, t - 1));
  const out = run(fall, t => fall(t - 0.15), 2.5);
  for (const o of out) if (o.rpm != null && o.t > 0.2) assert.ok(o.rpm <= fall(o.t - FUSION.confirm - 0.02) * 1.02, `raised at ${o.t}: ${o.rpm} vs ${fall(o.t)}`);
});

test('pitch-detection silent: gyroball takes over after a moment, and nothing at all goes blank', () => {
  const out = run(t => (t > 1 ? null : 5000), () => 5000, 2);
  assert.ok(at(out, 1.05).coast);
  assert.equal(at(out, 1.3).source, 'gyroball');
  const none = run(t => (t > 1 ? null : 5000), t => (t > 1 ? null : 5000), 2);
  assert.equal(at(none, 1.1).coast, true);
  assert.equal(at(none, 1.6).rpm, null);
});
