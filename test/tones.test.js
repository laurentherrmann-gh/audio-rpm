import test from 'node:test';
import assert from 'node:assert/strict';
import { TONES, ToneLearner, orderLevels, toneDistance } from '../public/detectors/tones.js';
import { Pipeline } from '../public/pipeline.js';

// A spectrum of an engine at `rpm` whose orders have the given levels (dB), over a −90 dB floor.
const binHz = 48000 / 8192;
function spectrum(rpm, orders, jitter = 0, seed = 1) {
  const db = new Float32Array(4096).fill(-90), fc = rpm / 120;
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (const [k, level] of Object.entries(orders)) db[Math.round((k * fc) / binHz)] = level + jitter * rand();
  return db;
}
// a boxer-like four: the crank tone (order 2) is louder than the firing tone (order 4)
const BOXER = { 1: -50, 2: -18, 3: -52, 4: -24, 5: -55, 6: -34, 7: -56, 8: -36, 10: -44, 12: -46, 14: -50, 16: -50 };
function learnBoxer() {
  const learner = new ToneLearner();
  for (let i = 0; i < 400; i++) { const rpm = 3000 + 10 * i; learner.add(rpm, orderLevels(spectrum(rpm, BOXER, 3, i + 1), binHz, rpm / 120)); }
  return learner.map();
}

test('order levels: read at the places the rpm puts them, loudness removed, quiet orders floored', () => {
  const a = orderLevels(spectrum(4800, BOXER), binHz, 40), b = orderLevels(spectrum(4800, Object.fromEntries(Object.entries(BOXER).map(([k, v]) => [k, v + 12]))), binHz, 40);
  assert.equal(a.length, TONES.orders);
  assert.ok(a[1] > a[3] && a[3] > a[0], 'order 2 above order 4 above order 1');
  for (let k = 0; k < a.length; k++) assert.ok(Math.abs(a[k] - b[k]) < 1e-3, 'louder sound, same levels');
  assert.ok(Math.max(...a) - Math.min(...a) <= TONES.floorDb + 1e-6);
  assert.equal(orderLevels(spectrum(4800, BOXER), binHz, 2000), null, 'beyond the spectrum');
});

test('a tone map tells the car\'s true rpm from half and from double', () => {
  const map = learnBoxer();
  for (const rpm of [3500, 5000, 6500]) {
    const db = spectrum(rpm, BOXER, 3, 999), d = r => toneDistance(map, r, orderLevels(db, binHz, r / 120));
    assert.ok(d(rpm) < TONES.sure, `at ${rpm} rpm the car fits its own map (${d(rpm).toFixed(2)})`);
    assert.ok(d(rpm / 2) > d(rpm) + 1 && d(rpm * 2) > d(rpm) + 1, `half ${d(rpm / 2).toFixed(2)}, double ${d(rpm * 2).toFixed(2)}`);
  }
});

test('where a band was hardly heard, the map of all revs together answers; with nothing learned, nothing does', () => {
  const map = learnBoxer(); // 3,000–7,000 rpm only
  assert.ok(map.n[0] === 0 && map.n.at(-1) === 400);
  assert.ok(toneDistance(map, 1200, orderLevels(spectrum(1200, BOXER), binHz, 10)) !== null);
  assert.equal(toneDistance(new ToneLearner().map(), 5000, orderLevels(spectrum(5000, BOXER), binHz, 5000 / 120)), null);
});

test('a car with several maps (one per camera): the one that fits best answers', () => {
  // the same engine heard from inside: the firing tone and its harmonics dominate
  const INSIDE = { 1: -55, 2: -40, 3: -56, 4: -18, 5: -55, 6: -45, 7: -56, 8: -26, 10: -50, 12: -34, 14: -52, 16: -40 };
  const inside = new ToneLearner();
  for (let i = 0; i < 400; i++) { const rpm = 3000 + 10 * i; inside.add(rpm, orderLevels(spectrum(rpm, INSIDE, 3, i + 7), binHz, rpm / 120)); }
  const outside = learnBoxer(), both = [outside, inside.map()];
  const heard = orderLevels(spectrum(5000, INSIDE, 3, 4242), binHz, 5000 / 120);
  assert.ok(toneDistance(outside, 5000, heard) > 2, 'the outside map does not fit the inside sound');
  assert.equal(toneDistance(both, 5000, heard), toneDistance(inside.map(), 5000, heard));
  assert.ok(toneDistance(both, 5000, heard) < TONES.sure);
  assert.equal(toneDistance([], 5000, heard), null);
});

test('pipeline: with the car\'s tone map, a pitch on its loud crank tone is read as half the firing tone', () => {
  const tones = { boxer: [learnBoxer()] }, rpm = 4800, crank = (rpm / 60); // 80 Hz; firing tone 160 Hz
  const listen = (pipe, seconds) => {
    let out = crank;
    for (let t = 0; t < seconds; t += 256 / 48000) { pipe.gyroSpec = { db: spectrum(rpm, BOXER, 2, Math.round(t * 1000) + 1), binHz, t }; out = pipe.firingTone('pd', crank, t); }
    return out;
  };
  const general = new Pipeline(48000, 1, { cylinders: 4, idle: 800, redline: 9000 });
  assert.equal(listen(general, 0.4), crank, 'the general rule: the loudest candidate is the pitch itself, so it stays (half the revs)');
  const mapped = new Pipeline(48000, 1, { cylinders: 4, idle: 800, redline: 9000, carKey: 'boxer' });
  mapped.tones = tones;
  assert.equal(listen(mapped, 0.4), 2 * crank, 'with the map: 4,800 rpm fits this car, 2,400 does not');
  const other = new Pipeline(48000, 1, { cylinders: 4, idle: 800, redline: 9000, carKey: 'another-car' });
  other.tones = tones;
  assert.equal(listen(other, 0.4), crank, 'another car\'s map is not used');
});
