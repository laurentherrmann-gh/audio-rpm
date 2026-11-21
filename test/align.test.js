import test from 'node:test';
import assert from 'node:assert/strict';
import { BANDS } from '../public/detectors/car-id.js';
import { alignToBoundaries, noveltyCurve } from '../tools/lib/align.js';

const hop = 0.25, CLIP = 40, CARS = 20;
const boundaries = Array.from({ length: CARS - 1 }, (_, i) => (i + 1) * CLIP);
let seed = 5;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
/** `seconds` of one car's sound: its own tone, which also varies with the revs (a slow wobble). */
function car(seconds) {
  const tone = Float32Array.from({ length: BANDS }, () => rand() * 8), revs = Float32Array.from({ length: BANDS }, () => rand() * 6);
  return Array.from({ length: Math.round(seconds / hop) }, (_, i) => tone.map((v, b) => v + revs[b] * Math.sin(i * hop * 1.3) + rand()));
}
const silence = seconds => Array.from({ length: Math.round(seconds / hop) }, () => null);
const video = () => Array.from({ length: CARS }, () => car(CLIP)).flat();
const align = (frames, range) => alignToBoundaries(noveltyCurve(frames, hop), hop, boundaries, range);

test('the video starts where the sound starts: found, and every car change lines up', () => {
  const r = align([...silence(3.5), ...video(), ...silence(20)], { from: 1.5, to: 120 });
  assert.ok(Math.abs(r.offset - 3.5) <= 0.5, `offset ${r.offset}`);
  assert.ok(r.confirmed);
  assert.ok(r.hits >= boundaries.length - 1, `hits ${r.hits}`);
  assert.equal(r.shift, null);
});

test('an ad before the video: the start is found after the ad', () => {
  const r = align([...silence(2), ...car(22), ...video(), ...silence(20)], { from: 0, to: 120 });
  assert.ok(Math.abs(r.offset - 24) <= 0.5, `offset ${r.offset}`);
  assert.ok(r.confirmed);
  assert.equal(r.shift, null);
});

test('an ad or a pause in the middle is reported, with where it starts', () => {
  const v = video(), cut = Math.round((8 * CLIP + 15) / hop);
  const r = align([...silence(3), ...v.slice(0, cut), ...car(12), ...v.slice(cut), ...silence(20)], { from: 1, to: 120 });
  assert.ok(Math.abs(r.offset - 3) <= 1.5, `offset ${r.offset}`);
  // the ad is inside car 9: cars 1–8 are in place, the rest 12 s late
  assert.ok(r.shift && r.shift.car >= 7 && r.shift.car <= 9 && Math.abs(r.shift.by - 12) <= 1, JSON.stringify(r.shift));
});

test('one unchanging sound: no start stands out', () => {
  const r = align([...silence(3), ...car(CARS * CLIP)], { from: 1, to: 120 });
  assert.equal(r.confirmed, false, `hits ${r.hits}`);
});
