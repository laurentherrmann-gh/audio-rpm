import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSchedule, makeNoIdleSchedule, synthesize, carVoice, rpmAt } from '../public/engine-model.js';
import { BANDS, CAR_ID, CarMatcher, carFftSize, learn, snapshotOf, snapshotsOf, typicalSpread } from '../public/detectors/car-id.js';
import { Pipeline } from '../public/pipeline.js';

const fs = 48000;
// Ten simulated cars with their own tone; g and h sound the same (games reuse sounds) and are both 4-cylinder.
const CARS = { a: [4, 1], b: [4, 2], c: [4, 3], d: [5, 4], e: [6, 5], f: [6, 6], g: [4, 7], h: [4, 7], i: [8, 8], j: [4, 9] };
const learnDrive = makeSchedule({ idleRpm: 900, redline: 7500 }), testDrive = makeNoIdleSchedule({ redline: 7500 });
const sound = (key, drive, seconds, seed) => synthesize(drive, { fs, seconds, cylinders: CARS[key][0], voice: carVoice(CARS[key][1]), seed });

const profiles = { cars: {} };
for (const key of Object.keys(CARS)) profiles.cars[key] = { ...learn(snapshotsOf(sound(key, learnDrive, 20, 1), fs)), cylinders: CARS[key][0] };
profiles.sigma2 = typicalSpread(profiles.cars);

function recognise(samples) {
  const m = new CarMatcher(profiles);
  let t = 0, known = null;
  for (const x of snapshotsOf(samples, fs)) { t += CAR_ID.every; m.push(t, x); if (known === null && m.cylinders) known = t; }
  return { m, known };
}

test('a snapshot does not depend on the volume, and silence gives none', () => {
  const N = carFftSize(fs), s = sound('a', learnDrive, 1, 1).subarray(fs / 2, fs / 2 + N);
  const a = snapshotOf(s, fs), b = snapshotOf(s.map(v => v * 0.1), fs);
  assert.equal(a.length, BANDS);
  for (let i = 0; i < BANDS; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.01);
  assert.ok(Math.abs(a.reduce((x, y) => x + y, 0)) < 0.01);
  assert.equal(snapshotOf(new Float32Array(N), fs), null);
  assert.equal(snapshotOf(s.map(v => v * 1e-4), fs), null);
});

test('each car is recognised on a drive it was not learned from, within 4 s', () => {
  for (const key of Object.keys(CARS)) {
    const { m, known } = recognise(sound(key, testDrive, 8, 50));
    assert.equal(m.cylinders, CARS[key][0], `${key}: cylinders`);
    assert.ok(known <= 4, `${key}: cylinder count known after ${known} s`);
    if (key !== 'g' && key !== 'h') assert.equal(m.car, key);
  }
});

test('two cars with the same sound: no car is named, but their shared cylinder count is known', () => {
  const { m } = recognise(sound('g', testDrive, 8, 50));
  assert.equal(m.car, null);
  assert.equal(m.cylinders, 4);
  assert.deepEqual(m.state().top.map(x => x.key).sort(), ['g', 'h']);
});

test('a sound unlike every known car is left unrecognised', () => {
  const far = { ...carVoice(77), resonances: [{ f: 5000, q: 1, db: 40 }, { f: 200, q: 3, db: -25 }, { f: 900, q: 2, db: -20 }] };
  const { m } = recognise(synthesize(testDrive, { fs, seconds: 8, cylinders: 12, voice: far, seed: 3 }));
  assert.equal(m.car, null);
  assert.equal(m.cylinders, null);
  assert.ok(m.state().unknown > 0.9);
});

test('silence is not evidence: nothing is said, and a recognised car is kept', () => {
  const m = new CarMatcher(profiles);
  let t = 0;
  for (let i = 0; i < 50; i++) { t += CAR_ID.every; m.push(t, null); }
  assert.ok(m.state().listening);
  for (const x of snapshotsOf(sound('d', testDrive, 6, 50), fs)) { t += CAR_ID.every; m.push(t, x); }
  assert.equal(m.car, 'd');
  for (let i = 0; i < 300; i++) { t += CAR_ID.every; m.push(t, null); }
  assert.equal(m.car, 'd');
  assert.equal(m.cylinders, 5);
});

function run(key, cfg, withProfiles = true) {
  const samples = sound(key, testDrive, 10, 50), hop = 256, pipe = new Pipeline(fs, 1, cfg);
  if (withProfiles) pipe.setCars(profiles);
  const errs = [];
  let tKnown = null, state = null;
  for (let end = hop; end <= samples.length; end += hop) {
    const chunk = samples.subarray(end - hop, end), t = end / fs;
    pipe.push(chunk, chunk);
    const r = pipe.step(t);
    state = r;
    if (tKnown === null && r.cyl.fromCar) tKnown = t;
    if (t > 5 && r.pd?.rpm != null && !r.pd.coast) errs.push(Math.abs(r.pd.rpm - rpmAt(testDrive, t)));
  }
  errs.sort((a, b) => a - b);
  return { pipe, state, tKnown, median: errs[errs.length >> 1] };
}

test('pipeline: the recognised car gives the cylinder count, and the rpm follows', () => {
  const { pipe, state, tKnown, median } = run('d', { cylinders: 'auto', car: 'auto', redline: 7500 });
  assert.equal(pipe.cylinders(), 5);
  assert.equal(state.car.car, 'd');
  assert.ok(state.cyl.fromCar);
  assert.ok(tKnown < 4, `count from the car after ${tKnown} s`);
  assert.ok(median < 150, `median rpm error ${median}`);
});

test('pipeline: a manual cylinder count is not overridden, and recognition off reports nothing', () => {
  const manual = run('d', { cylinders: 4, car: 'auto', redline: 7500 });
  assert.equal(manual.pipe.cylinders(), 4);
  assert.equal(manual.state.car.car, 'd'); // still shown
  assert.equal(manual.state.cyl.fromCar, false);
  const off = run('d', { cylinders: 'auto', redline: 7500 });
  assert.equal(off.state.car, null);
  assert.equal(off.state.cyl.fromCar, false);
  const noProfiles = run('d', { cylinders: 'auto', car: 'auto', redline: 7500 }, false);
  assert.equal(noProfiles.state.car, null);
});
