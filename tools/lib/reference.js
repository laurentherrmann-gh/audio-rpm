// A reference rpm for a recording, computed offline (the whole clip is known, no hurry).
//
// Every tone an engine makes is a multiple of its cycle frequency (one cycle = two turns of the
// crank, so rpm = 120 × cycle frequency). Which multiple is loudest depends on the engine: the
// firing tone (cycle × cylinders) on most inline fours, another one on boxers, V8s and on the
// limiter. So:
//  1. follow the strongest tone through the clip (a ridge in the spectrogram; Viterbi, so that it
//     moves smoothly and only jumps when it must: a gear shift, or another tone taking over);
//  2. along each unbroken stretch of the ridge, look at the sound "in orders of the ridge":
//     resampled in step with the ridge, so that the ridge sits at order 1 however the revs move.
//     The engine's other tones then sit at fractions k/j of it, and j says which multiple of the
//     cycle frequency the ridge is;
//  3. rpm = 120 × ridge / j.
// Step 2 averages over seconds, which is what makes it sturdier than anything live.
import rfft from 'fourier-transform';
import { lowpass } from './audio.js';

export const REF = Object.freeze({
  fs: 6000,                 // Hz, after decimation
  win: 1024, pad: 4096,     // STFT: 171 ms window, 1.5 Hz bins
  hop: 0.02,                // s between frames
  fLo: 40, fHi: 620, perOctave: 96, // where the ridge is looked for
  silentDb: -55,
  step: 16, stepCost: 0.35, // ridge may move this many bins per frame, at this cost (dB) per bin…
  jumpCost: 14,             // …or jump anywhere at this cost (dB)
  P: 64, M: 64,             // order analysis: samples per ridge period, ridge periods per window
  peakDb: 8,                // a tone = this far above the floor around it
  tol: 1.5,                 // bins (1/M order) a tone may be off its place
  maxJ: 12, chanceCost: 0.5,
  minFractional: 0.12, minExplained: 0.8, // to call a stretch's order "sure"
  minSeconds: 1.2,          // a stretch shorter than this can't say which order it is
  rpmMin: 450, rpmMax: 10500,
});

function decimate(samples, fs) {
  const D = Math.round(fs / REF.fs), low = lowpass(samples, fs, 0.4 * REF.fs), out = new Float32Array(Math.floor(samples.length / D));
  for (let i = 0; i < out.length; i++) out[i] = low[i * D];
  return { x: out, fs: fs / D };
}

/** The strongest tone through the clip: Hz per frame (null where silent), and where it jumps. */
export function ridge(x, fs) {
  const { win, pad, perOctave, fLo, fHi } = REF, hop = Math.round(REF.hop * fs);
  const S = Math.round(Math.log2(fHi / fLo) * perOctave) + 1, fOf = s => fLo * 2 ** (s / perOctave), binHz = fs / pad;
  const w = Float64Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win));
  const frames = [];
  for (let start = 0; start + win <= x.length; start += hop) {
    const buf = new Float64Array(pad);
    let e = 0;
    for (let i = 0; i < win; i++) { buf[i] = x[start + i] * w[i]; e += x[start + i] * x[start + i]; }
    if (10 * Math.log10(e / win + 1e-12) < REF.silentDb) { frames.push(null); continue; }
    const mag = rfft(buf), sal = new Float32Array(S), fine = new Float32Array(S);
    let top = -Infinity;
    for (let s = 0; s < S; s++) {
      const a = Math.max(1, Math.floor(fOf(s - 0.5) / binHz)), b = Math.max(a, Math.ceil(fOf(s + 0.5) / binHz));
      let m = 0, at = a;
      for (let k = a; k <= b; k++) if (mag[k] > m) { m = mag[k]; at = k; }
      // only real peaks count (a slope of a neighbouring tone is not a tone); refine its frequency
      const peak = mag[at] >= mag[at - 1] && mag[at] >= mag[at + 1];
      sal[s] = peak ? 20 * Math.log10(m + 1e-12) : -200;
      const den = mag[at - 1] - 2 * mag[at] + mag[at + 1];
      fine[s] = (at + (den ? (0.5 * (mag[at - 1] - mag[at + 1])) / den : 0)) * binHz;
      if (sal[s] > top) top = sal[s];
    }
    for (let s = 0; s < S; s++) sal[s] = Math.max(-40, sal[s] - top); // dB below the frame's loudest tone
    frames.push({ sal, fine });
  }
  // Viterbi: cost = dB below the loudest tone + cost of moving
  const n = frames.length, back = new Array(n), cost = new Float64Array(S);
  let prev = null;
  for (let t = 0; t < n; t++) {
    const f = frames[t];
    if (!f) { back[t] = null; continue; }
    const now = new Float64Array(S), from = new Int16Array(S);
    if (!prev) { for (let s = 0; s < S; s++) { now[s] = -f.sal[s]; from[s] = -1; } }
    else {
      let best = 0;
      for (let s = 1; s < S; s++) if (prev[s] < prev[best]) best = s;
      for (let s = 0; s < S; s++) {
        let c = prev[best] + REF.jumpCost, b = best;
        for (let d = -REF.step; d <= REF.step; d++) {
          const q = s + d;
          if (q < 0 || q >= S) continue;
          const v = prev[q] + REF.stepCost * Math.abs(d);
          if (v < c) { c = v; b = q; }
        }
        now[s] = c - f.sal[s]; from[s] = b;
      }
    }
    back[t] = from; prev = now; cost.set(now);
  }
  // trace back
  const hz = new Array(n).fill(null), jump = new Array(n).fill(false);
  let s = -1;
  for (let t = n - 1; t >= 0; t--) {
    if (!frames[t]) { s = -1; continue; }
    if (s < 0) {
      // end of a voiced run: its cheapest end state (recomputing the run's last costs is avoided by
      // taking the loudest tone there, which is where the cheapest path ends in practice)
      s = 0;
      for (let q = 1; q < S; q++) if (frames[t].sal[q] > frames[t].sal[s]) s = q;
    }
    hz[t] = frames[t].fine[s];
    const p = back[t][s];
    if (p < 0 || !frames[t - 1]) { jump[t] = true; s = -1; continue; }
    if (Math.abs(p - s) > REF.step) jump[t] = true;
    s = p;
  }
  return { hz, jump, hop: hop / fs, offset: win / 2 / fs };
}

/** Mean order spectrum (dB, bins of 1/M order) of x along a stretch of the ridge. */
function orderSpectrum(x, fs, times, hz) {
  const { P, M } = REF, N = P * M;
  // phase of the ridge (in periods) at each sample of the stretch, then samples at equal phase steps
  const i0 = Math.max(0, Math.ceil(times[0] * fs)), i1 = Math.min(x.length - 1, Math.floor(times[times.length - 1] * fs));
  const res = [];
  let k = 0, phase = 0, next = 0;
  for (let i = i0; i < i1; i++) {
    const t = i / fs;
    while (k < times.length - 2 && times[k + 1] < t) k++;
    const u = (t - times[k]) / (times[k + 1] - times[k]), f = hz[k] + (hz[k + 1] - hz[k]) * Math.min(1, Math.max(0, u));
    const dp = f / fs; // periods per sample
    while (next <= phase + dp) { const a = (next - phase) / dp; res.push(x[i] + (x[i + 1] - x[i]) * a); next += 1 / P; }
    phase += dp;
  }
  if (res.length < N) return null;
  const w = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const acc = new Float64Array(N / 2);
  let count = 0;
  for (let s = 0; s + N <= res.length; s += N / 4) {
    const buf = new Float64Array(N);
    for (let i = 0; i < N; i++) buf[i] = res[s + i] * w[i];
    const mag = rfft(buf);
    for (let i = 0; i < N / 2; i++) acc[i] += mag[i] * mag[i];
    count++;
  }
  return { db: Float32Array.from(acc, v => 10 * Math.log10(v / count + 1e-20)), windows: count };
}

/** Which multiple of the cycle frequency the ridge is, from the tones at fractions of it. */
export function ridgeOrder(db) {
  const { M, peakDb, tol, maxJ } = REF, lo = 4, hi = Math.min(db.length - 3, Math.round(3.2 * M));
  const peaks = [];
  for (let i = lo; i <= hi; i++) {
    if (db[i] < db[i - 1] || db[i] < db[i + 1] || db[i] < db[i - 2] || db[i] < db[i + 2]) continue;
    const around = Array.from(db.subarray(Math.max(0, i - 24), Math.min(db.length, i + 25))).sort((a, b) => a - b);
    const prominence = db[i] - around[around.length >> 1];
    if (prominence >= peakDb) peaks.push({ order: i / M, w: Math.min(prominence, 20) });
  }
  const total = peaks.reduce((s, p) => s + p.w, 0);
  const fractional = peaks.filter(p => Math.abs(p.order - Math.round(p.order)) > tol / M);
  if (!total || !fractional.length) return { j: 1, peaks, explained: [1], fractional: 0 };
  const explained = [];
  for (let j = 1; j <= maxJ; j++) explained.push(peaks.reduce((s, p) => s + (Math.abs(p.order * j - Math.round(p.order * j)) <= (tol * j) / M ? p.w : 0), 0) / total);
  // the order that leaves the least unexplained, at the price of how much it would explain by chance:
  // a fine comb (j = 12) covers half of all places, so it "explains" stray tones (gearbox whine,
  // turbo) that a coarse one rightly leaves out
  const cost = explained.map((e, i) => 1 - e + REF.chanceCost * Math.min(1, (2 * tol * (i + 1)) / M));
  let j = 1;
  for (let i = 1; i < maxJ; i++) if (cost[i] < cost[j - 1] - 1e-9) j = i + 1;
  return { j, peaks, explained, fractional: fractional.reduce((s, p) => s + p.w, 0) / total };
}

/**
 * Reference rpm of a recording.
 * @returns {{ t:number[], rpm:(number|null)[], sure:boolean[], stretches:object[] }} one value per REF.hop;
 *   sure = the order of the ridge was read from the tones around it (not assumed from neighbours)
 */
export function referenceRpm(samples, fsIn) {
  const { x, fs } = decimate(samples, fsIn), r = ridge(x, fs), n = r.hz.length;
  const t = Array.from({ length: n }, (_, i) => r.offset + i * r.hop);
  // unbroken stretches of the ridge
  const stretches = [];
  let a = -1;
  for (let i = 0; i <= n; i++) {
    const on = i < n && r.hz[i] !== null;
    if (on && a < 0) a = i;
    if (a >= 0 && (!on || (r.jump[i] && i > a))) {
      stretches.push({ a, b: i - 1 });
      a = on ? i : -1;
    }
  }
  for (const s of stretches) {
    s.seconds = (s.b - s.a + 1) * r.hop;
    const med = r.hz.slice(s.a, s.b + 1).sort((p, q) => p - q);
    s.hz = med[med.length >> 1];
    s.j = null;
    if (s.seconds < REF.minSeconds) continue;
    const o = orderSpectrum(x, fs, t.slice(s.a, s.b + 1), r.hz.slice(s.a, s.b + 1));
    if (!o || o.windows < 2) continue;
    const q = ridgeOrder(o.db);
    const rpm = (120 * s.hz) / q.j;
    // sure = tones at fractions of the ridge are clearly there, and this order accounts for nearly all tones
    if (rpm >= REF.rpmMin && rpm <= REF.rpmMax && q.fractional >= REF.minFractional && q.explained[q.j - 1] >= REF.minExplained) { s.j = q.j; s.sure = true; }
    s.read = q.j; s.fractional = q.fractional;
  }
  // stretches that could not say: the order of the nearest sure stretch that keeps the rpm plausible
  const sure = stretches.filter(s => s.sure);
  for (const s of stretches) {
    if (s.j) continue;
    const near = [...sure].sort((p, q) => Math.abs((p.a + p.b) / 2 - (s.a + s.b) / 2) - Math.abs((q.a + q.b) / 2 - (s.a + s.b) / 2));
    for (const c of near) { const rpm = (120 * s.hz) / c.j; if (rpm >= REF.rpmMin && rpm <= REF.rpmMax) { s.j = c.j; break; } }
  }
  const rpm = new Array(n).fill(null), ok = new Array(n).fill(false);
  for (const s of stretches) if (s.j) for (let i = s.a; i <= s.b; i++) { rpm[i] = (120 * r.hz[i]) / s.j; ok[i] = Boolean(s.sure); }
  return { t, rpm, sure: ok, stretches: stretches.map(s => ({ from: +t[s.a].toFixed(2), to: +t[s.b].toFixed(2), hz: +s.hz.toFixed(1), j: s.j, sure: Boolean(s.sure), read: s.read ?? null })) };
}
