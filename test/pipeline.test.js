import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline } from '../public/pipeline.js';
import { constantSchedule, synthesize } from '../public/engine-model.js';

const fs = 48000, D = 4, hop = 256;

function runConstant(rpm, cfg = {}, seconds = 1.5) {
  const signal = synthesize(constantSchedule(rpm, seconds), { fs, seconds, cylinders: 4 });
  const pipe = new Pipeline(fs, D, cfg);
  let r = null;
  for (let end = hop; end <= signal.length; end += hop) {
    const raw = signal.subarray(end - hop, end);
    const dec = new Float32Array(hop / D);
    for (let i = 0; i < dec.length; i++) dec[i] = raw[i * D];
    pipe.push(raw, dec);
    r = pipe.step(end / fs);
  }
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
