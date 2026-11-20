import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseSpectrum } from '../public/detectors/gyroball-core.js';
import { detectPitch, decimate } from '../public/detectors/pd-core.js';
import { firingHz, rpmFromFiringHz } from '../public/engine-model.js';
import { engineFrame, analyserDb } from './helpers.js';

const IDLE = 900, REDLINE = 7500;
const bandFor = cyl => ({ fLo: firingHz(IDLE * 0.7, cyl), fHi: firingHz(REDLINE * 1.15, cyl) });
const within = (got, want, tol) => Math.abs(got - want) / want <= tol;

function gyroRpm(rpm, cyl, fft, tuned = true) {
  const { fLo, fHi } = bandFor(cyl);
  const opts = tuned ? { fLo, fHi, octaveCheck: true, maxHz: Math.max(1500, fHi * 8) } : { fLo, fHi };
  const g = analyseSpectrum(analyserDb(engineFrame({ rpm, cylinders: cyl, n: fft })), 48000 / fft, opts);
  return g.valid ? rpmFromFiringHz(g.f0, cyl) : null;
}

function pdRpm(rpm, cyl, algo) {
  const { fLo, fHi } = bandFor(cyl);
  // like the pipeline: decimated ~12 kHz stream, but full rate (short window) above 250 Hz
  const high = algo !== 'hps' && firingHz(rpm, cyl) > 250;
  const frame = high ? engineFrame({ rpm, cylinders: cyl, n: 1024 }) : decimate(engineFrame({ rpm, cylinders: cyl, n: 4096 }), 4);
  const p = detectPitch(frame, { fs: high ? 48000 : 12000, algo, fLo, fHi });
  return p.valid ? rpmFromFiringHz(p.f0, cyl) : null;
}

for (const cyl of [4, 5, 6, 8, 10, 12]) {
  for (const algo of ['yin', 'mcleod']) {
    test(`pitch-detection ${algo}: ${cyl} cyl, idle to redline within 2%`, () => {
      for (const rpm of [900, 1500, 3000, 4500, 6000, 7200]) {
        const got = pdRpm(rpm, cyl, algo);
        assert.ok(got !== null && within(got, rpm, 0.02), `${rpm} rpm → ${got}`);
      }
    });
  }
  test(`pitch-detection hps: ${cyl} cyl, 3000 rpm and up within 2%`, () => {
    for (const rpm of [3000, 4500, 6000, 7200]) {
      const got = pdRpm(rpm, cyl, 'hps');
      assert.ok(got !== null && within(got, rpm, 0.02), `${rpm} rpm → ${got}`);
    }
  });
  test(`gyroball engine-tuned FFT 8192: ${cyl} cyl, 1500 rpm and up within 2%`, () => {
    for (const rpm of [1500, 3000, 4500, 6000, 7200]) {
      const got = gyroRpm(rpm, cyl, 8192);
      assert.ok(got !== null && within(got, rpm, 0.02), `${rpm} rpm → ${got}`);
    }
  });
  test(`gyroball engine-tuned FFT 16384: ${cyl} cyl, idle within 2%`, () => {
    const got = gyroRpm(900, cyl, 16384);
    assert.ok(got !== null && within(got, 900, 0.02), `900 rpm → ${got}`);
  });
}

test('silence gives no reading', () => {
  const { fLo, fHi } = bandFor(4);
  assert.equal(detectPitch(new Float32Array(1024), { fs: 12000, fLo, fHi }).valid, false);
  const db = new Float32Array(4096).fill(-Infinity);
  assert.equal(analyseSpectrum(db, 48000 / 8192, { fLo, fHi }).valid, false);
});
