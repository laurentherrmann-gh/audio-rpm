import { test } from 'node:test';
import assert from 'node:assert/strict';
import rfft from 'fourier-transform';
import { detectCylinders } from '../public/detectors/cylinders.js';
import { Pipeline } from '../public/pipeline.js';
import { CYLINDERS, RALLY_CYLINDERS, firingHz, synthesize, constantSchedule, makeSchedule, makeNoIdleSchedule, rpmAt } from '../public/engine-model.js';
import { engineFrame } from './helpers.js';

// --- the detector on single steady spectra ---
const FS = 12000, N = 8192;
function hannDb(x) {
  const w = new Float64Array(N);
  for (let i = 0; i < N; i++) w[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const m = rfft(w), d = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) d[i] = 20 * Math.log10(Math.max(m[i] / N, 1e-12));
  return d;
}
const detectAt = (rpm, cylinders, cycleLevel, fEstimate = firingHz(rpm, cylinders)) =>
  detectCylinders(hannDb(engineFrame({ rpm, cylinders, fs: FS, n: N, cycleLevel })), FS / N, fEstimate).n;

for (const cyl of CYLINDERS) {
  test(`detector: ${cyl} cylinders at 3000 and 6500 rpm`, () => {
    for (const level of [0.06, 0.03]) {
      for (const rpm of [3000, 6500]) assert.equal(detectAt(rpm, cyl, level), cyl, `${rpm} rpm, level ${level}`);
    }
  });
}

test('detector: a perfectly regular engine is never given a count', () => {
  for (const cyl of CYLINDERS) for (const rpm of [900, 3000, 6500]) assert.equal(detectAt(rpm, cyl, 0), null, `${cyl} cyl ${rpm} rpm`);
});

test('detector: never a wrong count at idle (unknown is allowed)', () => {
  for (const cyl of CYLINDERS) {
    const n = detectAt(900, cyl, 0.06);
    assert.ok(n === null || n === cyl, `${cyl} cyl at idle → ${n}`);
  }
});

test('detector: a pitch locked an octave high still gives the right rpm', () => {
  const f = 2 * firingHz(3000, 4);
  const n = detectAt(3000, 4, 0.06, f);
  assert.equal((f * 120) / n, 3000);
});

// --- auto mode in the pipeline ---
function runAuto(schedule, seconds, cylinders, cycleLevel = 0.06, autoCandidates = CYLINDERS) {
  const fs = 48000, D = 4, hop = 256;
  const signal = synthesize(schedule, { fs, seconds, cylinders, cycleLevel });
  const pipe = new Pipeline(fs, D, { cylinders: 'auto', autoCandidates, idle: 900, redline: 7500 });
  let r = null, lockedAt = null;
  for (let end = hop; end <= signal.length; end += hop) {
    const raw = signal.subarray(end - hop, end);
    const dec = new Float32Array(hop / D);
    for (let i = 0; i < dec.length; i++) dec[i] = raw[i * D];
    pipe.push(raw, dec);
    r = pipe.step(end / fs);
    if (lockedAt === null && r.cyl.locked !== null) lockedAt = end / fs;
  }
  return { r, lockedAt };
}

for (const cyl of RALLY_CYLINDERS) {
  test(`auto mode (rally set, the default): steady 3000 rpm, ${cyl} cylinders → locks ${cyl}`, () => {
    const { r } = runAuto(constantSchedule(3000, 3), 3, cyl, 0.06, RALLY_CYLINDERS);
    assert.equal(r.cyl.locked, cyl);
  });
}

test('auto mode, rally set: the default pipeline uses it', () => {
  assert.deepEqual(new Pipeline(48000, 4, { cylinders: 'auto' }).cfg.autoCandidates, RALLY_CYLINDERS);
});

for (const cyl of CYLINDERS) {
  test(`auto mode (any): steady 3000 rpm, ${cyl} cylinders → locks ${cyl} and reads 3000`, () => {
    const { r, lockedAt } = runAuto(constantSchedule(3000, 3), 3, cyl);
    assert.equal(r.cyl.locked, cyl);
    assert.ok(lockedAt < 1.5, `locked after ${lockedAt} s`);
    assert.ok(Math.abs(r.pd.rpm - 3000) < 60, `pd ${r.pd.rpm}`);
  });
}

test('auto mode: shifting sweep (V8) locks during the idle and reads the revs', () => {
  const schedule = makeSchedule({ idleRpm: 900, redline: 7500 });
  const { r, lockedAt } = runAuto(schedule, 10, 8);
  assert.equal(r.cyl.locked, 8);
  assert.ok(lockedAt !== null && lockedAt < 3, `locked after ${lockedAt} s`);
  assert.ok(Math.abs(r.pd.rpm - rpmAt(schedule, 10)) < 400, `pd ${r.pd.rpm} vs ${rpmAt(schedule, 10)}`);
});

for (const cyl of RALLY_CYLINDERS) {
  test(`auto mode, no idle at all (pulls and shifts only): ${cyl} cylinders locks within 1.5 s`, () => {
    const { r, lockedAt } = runAuto(makeNoIdleSchedule(), 4, cyl, 0.06, RALLY_CYLINDERS);
    assert.equal(r.cyl.locked, cyl);
    assert.ok(lockedAt < 1.5, `locked after ${lockedAt} s`);
  });
}

test('rpm gating: a V12 in rally mode is not left locked as a 4-cylinder (3× the rpm)', () => {
  const schedule = makeSchedule({ idleRpm: 900, redline: 7500 });
  const { r } = runAuto(schedule, 9, 12, 0.06, RALLY_CYLINDERS);
  assert.notEqual(r.cyl.locked, 4);
  assert.ok(!r.cyl.possible.includes(4), `still possible: ${r.cyl.possible}`);
});

test('auto mode: a perfectly regular engine never locks a count', () => {
  const { r } = runAuto(constantSchedule(3000, 3), 3, 6, 0);
  assert.equal(r.cyl.locked, null);
});
