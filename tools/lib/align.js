// Where does the video start in a recording of it? The dataset is cut at fixed times (one car every
// 40 s), so an ad before the video, a late start or a pause shifts every clip, silently. But the
// sound changes when the car changes: this finds the start time for which the expected car changes
// fall where the sound actually changes, and says how sure it is.
import { BANDS, distance } from '../../public/detectors/car-id.js';

const CHANGE_TO_SILENCE = 100; // dB²: sound on one side, silence on the other

/**
 * How much the sound changes at each moment: distance between the mean snapshot of the `span` s
 * before and after it. Long spans average out the revving within one car's clip.
 * @param {(Float32Array|null)[]} frames snapshots every `hop` s (null = silent)
 * @returns {Float32Array} one value per frame
 */
export function noveltyCurve(frames, hop, span = 10) {
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

const LEAD = 12, RUN = 6;
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * The video's start time in the recording, from the car changes.
 * @param {Float32Array} novelty from noveltyCurve
 * @param {number[]} boundaries times of the car changes, in s from the video's start
 * @param {{ from:number, to:number }} range start times to try (s)
 * @returns {{ offset:number, hits:number, confirmed:boolean, shift:{ car:number, by:number }|null }}
 *   offset = the start, from the first car changes (LEAD of them: an ad later on must not move it).
 *   hits = car changes whose strongest change of sound (within half a clip either way) is within
 *   1 s of where the others put it. confirmed = most of the first car changes agree like that; when
 *   not, the sound doesn't confirm any start (the cars sound alike, or the timing is off).
 *   shift = the first place where the changes come later or earlier than expected (an ad or a
 *   pause): `car` is the last car before it that is surely in place, `by` the seconds.
 */
export function alignToBoundaries(novelty, hop, boundaries, { from, to }) {
  // 1. which stretch: every car change counts the same (capped, or one change to silence outweighs
  //    ten cars); the video's own start counts as a change too
  const sorted = Float32Array.from(novelty).sort(), cap = sorted[Math.floor(sorted.length * 0.9)] || 1;
  const at = t => { const i = Math.round(t / hop); return i >= 0 && i < novelty.length ? Math.min(novelty[i], cap) : 0; };
  const lead = [0, ...boundaries.slice(0, LEAD)];
  const tries = [];
  for (let o = from; o <= to + 1e-9; o += hop) tries.push({ o, v: lead.reduce((s, b) => s + at(o + b), 0) });
  const top = Math.max(...tries.map(t => t.v)), mean = tries.reduce((s, t) => s + t.v, 0) / tries.length;
  // starts one clip apart fit almost equally well (all but one change coincide): take the earliest
  // of the best, the video starting as soon as the sound does or right after what played before it
  const coarse = tries.find(t => t.v >= top - 0.03 * (top - mean)).o;

  // 2. exactly when: for each car change, where the sound changes most within half a clip of it
  const period = median(boundaries.slice(1).map((b, i) => b - boundaries[i])) || 40, reach = period / 2 - 1;
  const raw = t => { const i = Math.round(t / hop); return i >= 0 && i < novelty.length ? novelty[i] : 0; };
  const found = boundaries.map(b => {
    let best = -Infinity, when = 0;
    for (let d = -reach; d <= reach + 1e-9; d += hop) { const v = raw(coarse + b + d); if (v > best) { best = v; when = d; } }
    return when;
  });
  const first = found.slice(0, LEAD), d0 = median(first);
  const confirmed = first.filter(d => Math.abs(d - d0) <= 1).length >= 0.6 * first.length;
  const hits = found.filter(d => Math.abs(d - d0) <= 1).length;

  // 3. the first run of car changes that agree on another moment: an ad or a pause before them
  let shift = null;
  for (let k = 0; k + RUN <= found.length && !shift; k++) {
    const run = found.slice(k, k + RUN), m = median(run);
    if (Math.abs(m - d0) > 1.5 && run.filter(d => Math.abs(d - m) <= 1.5).length >= RUN - 1) shift = { car: k, by: Math.round((m - d0) * 10) / 10 };
  }
  return { offset: Math.round((coarse + d0) * 100) / 100, hits, confirmed, shift };
}
