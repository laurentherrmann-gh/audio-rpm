// Where does the video start in a recording of it? The dataset is cut at fixed times (one car every
// 40 s), so an ad before the video, a late start or a pause shifts every clip, silently. But the
// sound changes when the car changes: this finds the start time for which the expected car changes
// fall where the sound actually changes, and says how sure it is.
import { BANDS, distance } from '../../public/detectors/car-id.js';

const CHANGE_TO_SILENCE = 100; // dB²: sound on one side, silence on the other

/**
 * How much the sound changes at each moment: distance between the mean snapshot of the `span` s
 * before and after it.
 * @param {(Float32Array|null)[]} frames snapshots every `hop` s (null = silent)
 * @returns {Float32Array} one value per frame
 */
export function noveltyCurve(frames, hop, span = 3) {
  const n = frames.length, w = Math.max(1, Math.round(span / hop));
  // prefix sums of the snapshots and of how many there are
  const sum = new Float64Array((n + 1) * BANDS), cnt = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const f = frames[i];
    cnt[i + 1] = cnt[i] + (f ? 1 : 0);
    for (let b = 0; b < BANDS; b++) sum[(i + 1) * BANDS + b] = sum[i * BANDS + b] + (f ? f[b] : 0);
  }
  const mean = (a, b) => {
    const c = cnt[b] - cnt[a];
    if (c < w / 4) return null; // mostly silent
    const m = new Float32Array(BANDS);
    for (let k = 0; k < BANDS; k++) m[k] = (sum[b * BANDS + k] - sum[a * BANDS + k]) / c;
    return m;
  };
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const before = mean(Math.max(0, i - w), i), after = mean(i, Math.min(n, i + w));
    out[i] = before && after ? distance(before, after) : before || after ? CHANGE_TO_SILENCE : 0;
  }
  return out;
}

const LEAD = 12, RUN = 6, NEAR = 1.5;
const CONTRAST = 1.4; // how much better the right start fits than a typical one (the real video: 1.7)

/**
 * The video's start time in the recording, from the car changes.
 * @param {Float32Array} novelty from noveltyCurve (short span: 3 s. A long span sees the change of
 *   driving inside every clip, at the same moment of each, as clearly as the change of car.)
 * @param {number[]} boundaries times of the car changes, in s from the video's start
 * @param {{ from:number, to:number }} range start times to try (s)
 * @returns {{ offset:number, hits:number, confirmed:boolean, shift:{ car:number, by:number }|null }}
 *   offset = the start for which the first car changes (LEAD of them: an ad later on must not move
 *   it) fall on the strongest changes of sound. hits = car changes with a clear change of sound
 *   within 1.5 s. confirmed = that start fits much better than a typical one. shift = the first
 *   run of car changes that fits much better some seconds later or earlier (an ad or a pause):
 *   `car` is the last car surely in place.
 */
export function alignToBoundaries(novelty, hop, boundaries, { from, to }) {
  // every car change counts the same: cap the curve, or one change to silence outweighs ten cars
  const sorted = Float32Array.from(novelty).sort();
  const cap = sorted[Math.floor(sorted.length * 0.95)] || 1, clear = sorted[Math.floor(sorted.length * 0.75)] || 0;
  const raw = t => { const i = Math.round(t / hop); return i >= 0 && i < novelty.length ? novelty[i] : 0; };
  const comb = (o, bs) => bs.reduce((s, b) => s + Math.min(raw(o + b), cap), 0) / bs.length;
  const lead = [0, ...boundaries.slice(0, LEAD)], tries = [];
  for (let o = from; o <= to + 1e-9; o += hop) tries.push({ o, v: comb(o, lead) });
  const top = Math.max(...tries.map(t => t.v)), mean = tries.reduce((s, t) => s + t.v, 0) / tries.length;
  // starts one clip apart fit almost equally well (all but one change coincide): the earliest of the
  // best, then the best within reach of it
  const coarse = tries.find(t => t.v >= top - 0.03 * (top - mean)).o;
  const offset = tries.filter(t => Math.abs(t.o - coarse) <= NEAR).reduce((a, t) => (t.v > a.v ? t : a)).o;

  // hits (for the report): car changes with a change of sound in the top quarter of the recording
  const hit = b => {
    let m = 0;
    for (let d = -NEAR; d <= NEAR + 1e-9; d += hop) m = Math.max(m, raw(offset + b + d));
    return m > 0 && m >= clear;
  };
  const hits = boundaries.filter(hit).length;
  // confirmed: the first car changes fit this start much better than they fit most other starts.
  // (With no such rhythm in the sound, every start fits about equally.)
  const typical = [...tries].map(t => t.v).sort((x, y) => x - y)[tries.length >> 1] || 1e-9;
  const confirmed = comb(offset, lead) >= CONTRAST * typical;

  // An ad or a pause shifts every car change after it. So: does the rest of the recording, from
  // some car on, fit clearly better some seconds later or earlier? (Six cars in a row can do that by
  // chance, when they sound alike; all the following ones don't.) Then find where it begins: the car
  // change from which "shifted" wins most often and before which "in place" does.
  let shift = null;
  for (let k = 0; k + RUN <= boundaries.length && !shift; k++) {
    const rest = boundaries.slice(k), here = comb(offset, rest);
    let best = here, by = 0;
    for (let d = -20; d <= 20 + 1e-9; d += hop) { const v = comb(offset + d, rest); if (v > best) { best = v; by = d; } }
    if (Math.abs(by) <= NEAR || best < CONTRAST * typical || best < CONTRAST * here) continue;
    const near = (b, o) => { let m = 0; for (let d = -NEAR; d <= NEAR + 1e-9; d += hop) m = Math.max(m, raw(o + b + d)); return m; };
    // …and in place they must mostly lack a clear change, which the shifted moments have (cars that
    // sound alike change faintly, and something inside each clip can then fit better: not a shift)
    const share = o => rest.filter(b => near(b, o) >= clear).length / rest.length;
    if (share(offset + by) - share(offset) < 0.3) continue;
    const shifted = boundaries.map(b => near(b, offset + by) > near(b, offset));
    let score = shifted.filter(Boolean).length, top = score, at = 0; // at = number of car changes still in place
    for (let j = 0; j < boundaries.length; j++) { score += shifted[j] ? -1 : 1; if (score > top) { top = score; at = j + 1; } }
    shift = { car: at, by: Math.round(by * 10) / 10 };
  }
  return { offset: Math.round(offset * 100) / 100, hits, confirmed, shift };
}
