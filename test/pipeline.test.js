import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constantSchedule, synthesize } from '../public/engine-model.js';
import { replay } from '../tools/lib/audio.js';

const fs = 48000;

function runConstant(rpm, cfg = {}, seconds = 1.5) {
  const signal = synthesize(constantSchedule(rpm, seconds), { fs, seconds, cylinders: 4 });
  let r = null;
  replay(signal, fs, cfg, (t, res) => { r = res; }); // the page's signal path: low-pass, then decimate
  return r;
}

for (const rpm of [1200, 4000, 7000]) {
  test(`pipeline reads a steady ${rpm} rpm with both detectors`, () => {
    const r = runConstant(rpm);
    assert.ok(Math.abs(r.pd.rpm - rpm) / rpm < 0.02, `pd ${r.pd.rpm}`);
    if (rpm >= 1500) assert.ok(Math.abs(r.gyro.rpm - rpm) / rpm < 0.02, `gyro ${r.gyro.rpm}`);
  });
}

test('adaptive pitch window shrinks as revs rise', () => {
  const low = runConstant(1500).pd.winMs, high = runConstant(7000).pd.winMs;
  assert.ok(high < 25 && low > high * 2, `1500 rpm: ${low} ms, 7000 rpm: ${high} ms`);
  assert.ok(Math.abs(runConstant(7000, { pd: { adaptive: false } }).pd.winMs - 85) < 0.5, 'fixed 85 ms window when adaptive is off');
});

test('prediction offsets exactly half a window', () => {
  const r = runConstant(4000);
  assert.ok(Math.abs(r.pd.predictedMs - r.pd.winMs / 2) < 0.01);
  assert.equal(runConstant(4000, { predict: false }).pd.predictedMs, 0);
});

test('calibration scale multiplies the reading', () => {
  const r = runConstant(4000, { scale: { gyro: 1, pd: 0.5 } });
  assert.ok(Math.abs(r.pd.rpm - 2000) < 40, `pd ${r.pd.rpm}`);
});

test('an engine whose cylinders do not sound alike: the short pitch window finds nothing, the second try does', async () => {
  const { synthesize, makeNoIdleSchedule, rpmAt } = await import('../public/engine-model.js');
  const { replay } = await import('../tools/lib/audio.js');
  const { DEFAULTS } = await import('../public/pipeline.js');
  const fs = 48000, seconds = 8, schedule = makeNoIdleSchedule({ redline: 7000 });
  const samples = synthesize(schedule, { fs, seconds, cylinders: 4, cycleLevel: 0.3 }); // strong engine-cycle tones, as most real cars
  const score = pd => {
    let n = 0, has = 0, right = 0, fused = 0;
    replay(samples, fs, { cylinders: 4, idle: 900, redline: 7000, pd }, (t, r) => {
      if (t < 1) return;
      n++;
      const truth = rpmAt(schedule, t);
      if (r.pd.raw) { has++; if (Math.abs(r.pd.raw / truth - 1) < 0.06) right++; }
      if (r.fused?.rpm && Math.abs(r.fused.rpm / truth - 1) < 0.06) fused++;
    });
    return { has: has / n, right: right / n, fused: fused / n };
  };
  const before = score({ ...DEFAULTS.pd, clarity: 0 }), now = score(DEFAULTS.pd);
  assert.ok(before.has < 0.4, `short window alone: a reading ${Math.round(100 * before.has)}% of the time`);
  assert.ok(now.right > 0.9, `with the second try: right ${Math.round(100 * now.right)}% of the time`);
  assert.ok(now.fused >= before.fused, `combined rpm right ${Math.round(100 * before.fused)}% → ${Math.round(100 * now.fused)}%`);
});
