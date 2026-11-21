import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiftDetector } from '../public/detectors/shifts.js';
import { replay } from '../tools/lib/audio.js';
import { Pipeline } from '../public/pipeline.js';
import { gearAt, makeSchedule, makeStageSchedule, rpmAt, scheduleDuration, shiftsIn, synthesize, constantSchedule } from '../public/engine-model.js';

const dt = 256 / 48000;
/** Run rpm(t) through a detector; returns its shifts. */
function run(rpmFn, seconds, cfg = { idle: 900, redline: 7500 }, onStep) {
  const d = new ShiftDetector(cfg), out = [];
  for (let t = 0; t < seconds; t += dt) { const e = d.push(t, rpmFn(t)); if (e) out.push(e); onStep?.(t, d); }
  return { d, out };
}

test('stage drive, true rpm: every shift is found, in order, with its ratio, and the gear follows', () => {
  const stage = makeStageSchedule(), truth = shiftsIn(stage), T = scheduleDuration(stage);
  let right = 0, n = 0;
  const { out } = run(t => rpmAt(stage, t), T, undefined, (t, d) => {
    if (t < 1.2 || truth.some(s => t >= s.t && t < s.t + 0.35)) return; // before the standing start is seen, and while a shift is being confirmed
    n++; if (d.gear === gearAt(stage, t)) right++;
  });
  assert.equal(out.length, truth.length);
  out.forEach((e, i) => {
    const s = truth[i];
    assert.equal(e.dir, s.to > s.from ? 'up' : 'down');
    assert.ok(Math.abs(e.at - (s.t + 0.05)) < 0.12, `shift ${i} placed at ${e.at}, true ${s.t} to ${s.t + 0.1}`);
    assert.ok(e.t - s.t < 0.42, `shift ${i} confirmed ${e.t - s.t} s after it began`);
    assert.ok(Math.abs(e.ratio / s.ratio - 1) < 0.07, `shift ${i} ratio ${e.ratio}, true ${s.ratio}`);
    assert.equal(e.gear, s.to);
  });
  assert.ok(right / n > 0.99, `gear right ${right}/${n}`);
});

test('a lift, a launch and coming back to idle are not shifts', () => {
  const pulls = makeSchedule(), T = scheduleDuration(pulls); // idle, 4 pulls with 3 upshifts, lift, back to idle
  const { out } = run(t => rpmAt(pulls, t), 2 * T);
  assert.equal(out.length, 6);
  assert.ok(out.every(e => e.dir === 'up' && Math.abs(e.ratio - 0.64) < 0.05), out.map(e => e.ratio.toFixed(3)).join(' '));
});

test('steady and slowly changing revs: no shift', () => {
  assert.equal(run(() => 4000, 5).out.length, 0);
  assert.equal(run(t => 2000 + 1500 * t, 3).out.length, 0);          // hard acceleration
  assert.equal(run(t => 4000 + 150 * Math.sin(t * 9), 5).out.length, 0); // wobble
});

test('the pitch detector slipping an octave for a moment is not a shift', () => {
  assert.equal(run(t => (t > 2 && t < 2.15 ? 2500 : 5000), 4).out.length, 0);
  assert.equal(run(t => (t > 2 ? 2500 : 5000), 4).out.length, 0);
  assert.equal(run(t => (t > 2 ? 3500 : 5000), 4).out.length, 1); // a real drop of 30%
});

test('the gear is unknown until the car has been standing, then counted and kept within 1…max', () => {
  const step = (levels, each = 1) => t => levels[Math.min(levels.length - 1, Math.floor(t / each))];
  const moving = run(step([5000, 3500, 5000, 3500]), 4);
  assert.equal(moving.out.length, 3);
  assert.equal(moving.d.gear, null);
  // standing 2 s, then four upshifts with 3 gears: stays in 3rd; then four downshifts: stays in 1st
  const ups = [1000, 1000, 6000, 4300, 3100, 2300, 1700], downs = [2300, 3100, 4300, 6000];
  const { d, out } = run(step([...ups, ...downs]), 12, { idle: 900, redline: 9000, maxGear: 3 });
  assert.deepEqual(out.map(e => e.gear), [2, 3, 3, 3, 2, 1, 1, 1]);
  assert.equal(d.state().shifts, 8);
});

test('standing is seen through stray readings and short holes (a real idle), not through wandering or high revs', () => {
  // one reading in 15 is 10% off, and now and then 0.15 s go without a reading
  const real = t => (Math.floor(t / dt) % 15 === 7 ? 990 : Math.floor(t * 2) % 3 === 2 && t % 0.5 < 0.15 ? null : 900 + 15 * Math.sin(40 * t));
  assert.equal(run(real, 2.5).d.gear, 1);
  assert.equal(run(t => 900 * (1 + 0.15 * Math.sin(5 * t)), 4).d.gear, null, 'wandering revs are not standing');
  assert.equal(run(() => 3000, 4).d.gear, null, 'steady revs far above idle are not standing');
  assert.equal(run(t => (t % 0.6 < 0.3 ? null : 900), 4).d.gear, null, 'too many holes: not known');
});

test('pipeline: an engine with a rough idle (long pitch window, readings 65 ms old): the shift detector is fed', () => {
  // this is what real cars do, and what broke the gear once: the detector read the path 50 ms back,
  // where no reading had spoken yet at low revs, and was given nothing nine times out of ten
  const fs = 48000, hop = 256, signal = synthesize(constantSchedule(900), { fs, seconds: 3, cylinders: 4, cycleLevel: 0.3 });
  const pipe = new Pipeline(fs, 1, { cylinders: 4, idle: 900, redline: 7500 });
  let at = null, old = 0, n = 0;
  for (let end = hop; end <= signal.length; end += hop) {
    const c = signal.subarray(end - hop, end);
    pipe.push(c, c);
    const r = pipe.step(end / fs);
    if (r.pd?.raw > 0) { n++; if (r.pd.windowDelayMs > 50) old++; }
    if (r.gear.gear !== null && at === null) at = end / fs;
  }
  assert.ok(old > 0.5 * n, `the test is about readings older than the look-back: ${old} of ${n}`);
  const fed = pipe.shifts.hist.length; // readings of the last second (one step is 5.3 ms)
  assert.ok(fed > 150, `fed ${fed} readings in the last second`);
  assert.ok(at !== null && at < 2, `seen standing after ${at} s`);
});

test('pipeline: shifts and gear from the sound of the stage drive', () => {
  const fs = 48000, stage = makeStageSchedule(), truth = shiftsIn(stage), T = scheduleDuration(stage);
  const signal = synthesize(stage, { fs, seconds: T, cylinders: 4 });
  const found = [];
  let right = 0, n = 0;
  replay(signal, fs, { cylinders: 4, idle: 900, redline: 7500 }, (t, r) => {
    if (r.gear.last && r.gear.last !== found.at(-1)) found.push(r.gear.last);
    if (t > 2 && t < 26.5 && !truth.some(s => t >= s.t && t < s.t + 0.4)) { n++; if (r.gear.gear === gearAt(stage, t)) right++; }
  });
  const matched = truth.filter(s => found.some(e => e.dir === (s.to > s.from ? 'up' : 'down') && Math.abs(e.at - s.t) < 0.1));
  assert.equal(matched.length, truth.length, 'every shift found');
  assert.ok(found.length <= truth.length + 1, `${found.length} shifts reported for ${truth.length}`);
  assert.ok(right / n > 0.97, `gear right ${right}/${n}`);
});

test('pipeline: a change of cylinder count is not taken for a shift', () => {
  const fs = 48000, hop = 256, signal = synthesize([[0, 4000], [6, 4000]], { fs, seconds: 6, cylinders: 4 });
  const pipe = new Pipeline(fs, 1, { cylinders: 4 });
  let shifts = 0;
  for (let end = hop; end <= signal.length; end += hop) {
    const chunk = signal.subarray(end - hop, end);
    pipe.push(chunk, chunk);
    if (end === hop * 500) pipe.configure({ cylinders: 6 }); // rpm ×2/3
    shifts = pipe.step(end / fs).gear.shifts;
  }
  assert.equal(shifts, 0);
});

test('a shift that arrives in stairs (readings missing in the middle, as on real sound) is one shift', () => {
  // 6,600 rpm, down to 5,300 in 60 ms, a 60 ms pause there, then on to 4,650: the DS 21 at 20.8 s
  const rpm = t => (t < 2 ? 6600 : t < 2.06 ? 6600 - (1300 * (t - 2)) / 0.06 : t < 2.12 ? 5300 : t < 2.16 ? 5300 - (650 * (t - 2.12)) / 0.04 : 4650 + 300 * (t - 2.16));
  const { out } = run(rpm, 4);
  assert.equal(out.length, 1);
  assert.equal(out[0].dir, 'up');
  assert.ok(Math.abs(out[0].at - 2.08) < 0.09, `placed at ${out[0].at}`);
  assert.ok(Math.abs(out[0].ratio - 4650 / 6600) < 0.06, `ratio ${out[0].ratio}`);
});

test('revs that keep falling after a pause for longer than a shift takes are a lift, not a shift', () => {
  const rpm = t => (t < 2 ? 6600 : t < 2.06 ? 6600 - (1300 * (t - 2)) / 0.06 : t < 2.09 ? 5300 : Math.max(1500, 5300 * Math.exp(-2 * (t - 2.09))));
  assert.equal(run(rpm, 5).out.length, 0);
});
