// Is a recording fit to analyse? Two defects ruin it without being audible at a glance:
//  - dropped audio: the recorder lost small blocks of sound and joined the rest. The recording
//    runs short, and every join is a click that breaks the engine's rhythm (what cylinder
//    detection reads) and colours the tone (what car recognition learns);
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
