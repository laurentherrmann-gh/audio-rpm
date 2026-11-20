// Is a recording fit to analyse? Two defects ruin it without being audible at a glance:
//  - dropped audio: the recorder lost small blocks of sound and joined the rest. The recording
//    runs short, and every join is a click that breaks the engine's rhythm (what cylinder
//    detection reads) and colours the tone (what car recognition learns);
//  - a feedback loop: what is recorded is also played back into the recorder (a recorder that
//    "monitors" its input while the Mac's output is the recorded device). Every sound comes back
//    after a fixed delay, again and again: tones never die away and the level keeps climbing;
//  - clipping: the level was too high and the loudest moments are cut flat. (Sound over full scale
//    that is not cut flat is fine: it is scaled down when read.)

/**
 * Joins left by dropped blocks. A join is a jump in the waveform: a spike in its second difference
 * against the level around it. Engines make spikes too (pops, backfires), but recorders drop whole
 * buffers of 2^k samples, so dropped-block joins all fall on one grid: `share` is the fraction of
 * spikes on the most common position of the best-fitting grid `block` (by chance: 1 / block).
 * Joins are found one by one against a smooth waveform, so heavy hiss can hide them.
 * @param {Float32Array} x mono samples at the recording's own rate
 * @returns {{ perSecond:number, block:number, share:number, dropped:boolean }}
 */
export function findJoins(x, fs) {
  const n = x.length, W = 400, d = new Float32Array(n);
  for (let i = 2; i < n; i++) d[i] = Math.abs(x[i] - 2 * x[i - 1] + x[i - 2]);
  const events = [];
  let sum = 0;
  for (let i = 0; i < 2 * W && i < n; i++) sum += d[i];
  for (let i = W; i < n - W; i++) {
    if (d[i] > 0.01 && d[i] > (12 * (sum - d[i])) / (2 * W - 1) && (!events.length || i - events[events.length - 1] > 32)) events.push(i);
    sum += d[i + W] - d[i - W];
  }
  let block = 0, share = 0;
  for (const m of [128, 256, 512, 1024, 2048, 4096]) {
    const count = new Map();
    for (const e of events) count.set(e % m, (count.get(e % m) || 0) + 1);
    const top = Math.max(0, ...count.values()) / Math.max(1, events.length);
    if (top >= share - 0.02) { share = Math.max(share, top); block = m; } // the largest grid that holds them
  }
  const perSecond = events.length / (n / fs);
  return { perSecond, block, share, dropped: perSecond > 0.5 && share > 0.3 };
}

/** Loudest sample (1 = full scale; some formats keep sound that goes over it). */
export function peakOf(x) {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const v = Math.abs(x[i]); if (v > p) p = v; }
  return p;
}

/**
 * Share of samples cut flat: runs of 3 or more samples at the recording's own ceiling (its loudest
 * level). Sound that merely goes over full scale without a ceiling is not clipped, only loud.
 */
export function clippedShare(x) {
  const top = 0.999 * peakOf(x);
  if (top < 0.05) return 0;
  let c = 0, run = 0;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) >= top) run++;
    else { if (run >= 3) c += run; run = 0; }
  }
  return (c + (run >= 3 ? run : 0)) / Math.max(1, x.length);
}

/** Correlation of x with itself `lag` samples later, between -1 and 1. */
function selfSimilarity(x, lag, from = 0, to = x.length) {
  let ab = 0, aa = 0, bb = 0;
  for (let i = Math.max(from, lag); i < to; i++) { const a = x[i], b = x[i - lag]; ab += a * b; aa += a * a; bb += b * b; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * A feedback loop: the delay (in samples) after which the recording repeats itself, the loop's
 * gain, and how alike the recording and its delayed self are (engine sound: about 0.1; a loop:
 * close to 1). The delay is searched between 20 ms and 1 s. One excerpt can't tell a loop from a
 * sound that repeats by itself (a steady tone): callers should find the same delay in several.
 * @returns {{ delay:number, gain:number, similarity:number }}
 */
export function findLoop(x, fs) {
  // coarse: on the sound averaged over K samples, every lag; fine: at full rate around the best
  const K = Math.max(1, Math.round(fs / 6000)), n = Math.floor(x.length / K), low = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < K; k++) s += x[i * K + k]; low[i] = s / K; }
  let best = 0, coarse = 0;
  for (let lag = Math.round((0.02 * fs) / K); lag <= Math.round(fs / K) && lag < n / 2; lag++) {
    const r = selfSimilarity(low, lag);
    if (r > best) { best = r; coarse = lag * K; }
  }
  let delay = coarse, similarity = -1;
  const to = Math.min(x.length, 10 * fs);
  for (let lag = Math.max(1, coarse - 2 * K); lag <= coarse + 2 * K; lag++) {
    const r = selfSimilarity(x, lag, 0, to);
    if (r > similarity) { similarity = r; delay = lag; }
  }
  let ab = 0, bb = 0;
  for (let i = delay; i < x.length; i++) { ab += x[i] * x[i - delay]; bb += x[i - delay] * x[i - delay]; }
  return { delay, gain: bb ? ab / bb : 0, similarity };
}

/**
 * Undo a feedback loop: what came back after `delay` samples with `gain` is subtracted, which
 * leaves the sound that came in. Exact for a loop that only delays and scales.
 * `state` carries the last `delay` input samples from one call to the next (streaming).
 */
export function removeLoop(x, delay, gain, state = { tail: new Float32Array(delay) }) {
  const out = new Float32Array(x.length), tail = state.tail;
  for (let i = 0; i < x.length; i++) out[i] = x[i] - gain * (i >= delay ? x[i - delay] : tail[tail.length - delay + i]);
  const keep = new Float32Array(delay);
  if (x.length >= delay) keep.set(x.subarray(x.length - delay));
  else { keep.set(tail.subarray(x.length)); keep.set(x, delay - x.length); }
  state.tail = keep;
  return out;
}
