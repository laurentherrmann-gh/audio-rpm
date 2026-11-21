import test from 'node:test';
import assert from 'node:assert/strict';
import { Pipeline, DEFAULTS } from '../public/pipeline.js';

// A spectrum with given tones (Hz → dB) over a −90 dB floor, as gyroball leaves it for firingTone.
const binHz = 48000 / 8192;
function spectrum(pipe, tones, t) {
  const db = new Float32Array(4096).fill(-90);
  for (const [hz, level] of Object.entries(tones)) db[Math.round(hz / binHz)] = level;
  pipe.gyroSpec = { db, binHz, t };
}
const dt = 256 / 48000;
/** The same pitch and spectrum for `seconds`; returns the last answer. */
function listen(pipe, f0, tones, seconds, from = 0) {
  let out = f0;
  for (let t = from; t < from + seconds; t += dt) { spectrum(pipe, tones, t); out = pipe.firingTone('pd', f0, t); }
  return out;
}
const four = () => new Pipeline(48000, 1, { cylinders: 4, idle: 800, redline: 9000 });

test('pitch on the engine cycle, firing tone the loudest: the firing tone, once it has lasted', () => {
  const pipe = four(), fc = 40; // 4,800 rpm: cycle 40 Hz, firing 160 Hz
  const tones = { 40: -40, 80: -38, 120: -42, 160: -20, 200: -45, 240: -44, 280: -46, 320: -28 };
  spectrum(pipe, tones, 0);
  assert.equal(pipe.firingTone('pd', fc, 0), fc, 'not on the first frame');
  assert.equal(listen(pipe, fc, tones, DEFAULTS.firingConfirm + 0.05), 4 * fc);
});

test('pitch on the crank tone (half the firing tone) of a four: doubled', () => {
  const pipe = four();
  assert.equal(listen(pipe, 80, { 80: -35, 160: -20, 240: -40, 320: -30 }, 0.3), 160);
});

test('a correction that lands where the detector already was is used at once', () => {
  const pipe = four();
  const firing = { 160: -20, 320: -30, 480: -38 };
  assert.equal(listen(pipe, 160, firing, 0.2), 160); // reads the firing tone as it is
  spectrum(pipe, { 40: -40, 160: -20, 200: -45, 240: -44, 280: -46 }, 0.2);
  assert.equal(pipe.firingTone('pd', 40, 0.2), 160); // the pitch slips to the cycle for a frame
});

test('the firing tone with a louder second harmonic is left alone (its third harmonic gives it away)', () => {
  const pipe = four();
  // 160 Hz is the firing tone; 320 is louder, and 480 is nearly as loud as 320
  assert.equal(listen(pipe, 160, { 160: -30, 320: -20, 480: -23, 640: -27 }, 0.5), 160);
});

test('a short wrong correction never shows', () => {
  const pipe = four();
  const firing = { 160: -20, 320: -30, 480: -38 }, odd = { 160: -30, 320: -20, 480: -40 };
  listen(pipe, 160, firing, 0.3);
  assert.equal(listen(pipe, 160, odd, DEFAULTS.firingConfirm * 0.6, 0.3), 160);
  assert.equal(listen(pipe, 160, firing, 0.3, 0.4), 160);
});

test('never above the rev range, never by a factor the cylinder count does not allow', () => {
  const pipe = four();
  // redline 9,000 rpm ×1.15: firing tone at most 345 Hz
  assert.equal(listen(pipe, 200, { 200: -35, 400: -20, 600: -40 }, 0.3), 200);
  // a four has no tone relation of 3 between pitch and firing
  assert.equal(listen(pipe, 50, { 50: -35, 150: -20, 100: -50, 200: -50 }, 0.3), 50);
  const six = new Pipeline(48000, 1, { cylinders: 6, idle: 800, redline: 9000 });
  assert.equal(listen(six, 50, { 50: -35, 150: -20, 200: -45, 250: -45 }, 0.3), 150);
});

test('left alone while the cylinder count is being detected, without a spectrum, and when switched off', () => {
  const tones = { 80: -35, 160: -20, 240: -40 };
  assert.equal(listen(new Pipeline(48000, 1, { cylinders: 'auto' }), 80, tones, 0.3), 80);
  assert.equal(listen(new Pipeline(48000, 1, { cylinders: 4, firingMargin: 0 }), 80, tones, 0.3), 80);
  const pipe = four();
  spectrum(pipe, tones, 0);
  assert.equal(pipe.firingTone('pd', 80, 1), 80, 'spectrum too old');
});
