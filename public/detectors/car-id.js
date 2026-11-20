// Car recognition from the tone of the engine sound.
//
// Shazam-style fingerprints match one exact recording; a car in a game never plays the same sound
// twice. What a car does keep is its tone colour at each engine speed and load. So a car's profile
// is a set of "snapshots" of its sound: the level of 20 third-octave bands (80 Hz – 8 kHz),
// independent of volume, clustered into at most K typical snapshots (vector quantisation, the
// classic speaker-identification method). Live sound is recognised by how close its snapshots stay
// to each car's, accumulated over a few seconds, against an "unknown" option that wins when the
// sound is far from every car.
//
// Nothing here depends on the rpm or cylinder detectors, so recognition can give them the
// cylinder count instead of the other way round. Pure functions and a small class: shared by the
// pipeline (live), tools/cars.js (learning, evaluation) and the tests.
import rfft from 'fourier-transform';

export const CAR_ID = Object.freeze({
  fLo: 80, fHi: 8000, perOctave: 3, // bands
  window: 0.17,     // s of sound per snapshot (8192 samples at 48 kHz)
  every: 0.1,       // s between snapshots
  rangeDb: 50,      // bands more than this below the loudest count as that floor
  silentDb: -60,    // snapshots quieter than this (dBFS rms, in the bands) are not used
  clipDb: 12,       // one band can't count for more than this difference (other sounds in the mix)
  K: 32,            // snapshots kept per car and per recording
  tau: 6,           // s: how long sound counts as evidence
  frameWeight: 0.5, // overlapping snapshots are not independent evidence
  unknown: 6,       // "none of these cars" = this many times the typical distance to the right car
  minHeard: 1.5,    // s of sound needed before saying anything
  share: 0.9,       // share of the evidence a cylinder count (or a car) needs
  hold: 1,          // s it must keep that share
  minSigma2: 1,     // dB², floor for the typical distance
});

export const BANDS = Math.round(Math.log2(CAR_ID.fHi / CAR_ID.fLo) * CAR_ID.perOctave);

/** FFT length for a sample rate: the power of two nearest CAR_ID.window. */
export const carFftSize = fs => 2 ** Math.round(Math.log2(CAR_ID.window * fs));

const layouts = new Map(); // band → bin ranges, per (binHz, bins)
function layout(binHz, bins) {
  const key = binHz + ':' + bins;
  let l = layouts.get(key);
  if (!l) {
    l = [];
    for (let b = 0; b <= BANDS; b++) l.push(Math.round((CAR_ID.fLo * 2 ** (b / CAR_ID.perOctave)) / binHz));
    if (l[BANDS] > bins || l.some((x, i) => i && x <= l[i - 1])) l = null; // sample rate too low, or bins too coarse
    layouts.set(key, l);
  }
  return l;
}

/**
 * Snapshot of a power spectrum: third-octave band levels in dB, minus their mean (so volume doesn't
 * matter). `power[i]` = squared amplitude of bin i of a Blackman-windowed frame, `binHz` its bin width.
 * @returns {Float32Array|null} null when the sound is too quiet to say anything
 */
export function snapshot(power, binHz) {
  const l = layout(binHz, power.length);
  if (!l) return null;
  const v = new Float32Array(BANDS);
  let total = 0, max = -Infinity;
  for (let b = 0; b < BANDS; b++) {
    let p = 0;
    for (let i = l[b]; i < l[b + 1]; i++) p += power[i];
    total += p;
    v[b] = 10 * Math.log10(Math.max(p, 1e-20));
    if (v[b] > max) max = v[b];
  }
  // amplitude² / 2 = a tone's mean square; 0.3046 = Blackman's power gain
  if (10 * Math.log10(Math.max(total / (2 * 0.3046), 1e-20)) < CAR_ID.silentDb) return null;
  let mean = 0;
  for (let b = 0; b < BANDS; b++) { v[b] = Math.max(v[b], max - CAR_ID.rangeDb); mean += v[b]; }
  mean /= BANDS;
  for (let b = 0; b < BANDS; b++) v[b] -= mean;
  return v;
}

const windows = new Map();
function blackman(n) {
  let w = windows.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; w[i] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a); }
    windows.set(n, w);
  }
  return w;
}

/** Snapshot of a frame of audio (length carFftSize(fs)). The one function live and learning share. */
export function snapshotOf(frame, fs) {
  const N = frame.length, w = blackman(N), x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = frame[i] * w[i];
  const mag = rfft(x), power = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) power[i] = mag[i] * mag[i]; // rfft gives amplitudes (unit sine → 1)
  return snapshot(power, fs / N);
}

/** Every snapshot of a recording (one per CAR_ID.every), silent moments left out. */
export function snapshotsOf(samples, fs) {
  const N = carFftSize(fs), hop = Math.round(CAR_ID.every * fs), out = [];
  for (let end = N; end <= samples.length; end += hop) {
    const s = snapshotOf(samples.subarray(end - N, end), fs);
    if (s) out.push(s);
  }
  return out;
}

/** Distance between two snapshots: mean squared band difference (dB²), each band clipped. */
export function distance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) { const e = Math.min(Math.abs(a[i] - b[i]), CAR_ID.clipDb); d += e * e; }
  return d / a.length;
}

/** Distance from a snapshot to the closest of a car's snapshots. */
export function distanceTo(x, centroids) {
  let best = Infinity;
  for (const c of centroids) { const d = distance(x, c); if (d < best) best = d; }
  return best;
}

/** k-means (deterministic: farthest-point start). Returns at most K centroids. */
export function cluster(frames, K = CAR_ID.K, iterations = 12) {
  if (!frames.length) return [];
  K = Math.max(1, Math.min(K, Math.floor(frames.length / 4) || 1));
  const dims = frames[0].length;
  const cents = [Float64Array.from(frames[0])];
  const near = new Float64Array(frames.length).fill(Infinity);
  while (cents.length < K) {
    let far = 0;
    for (let i = 0; i < frames.length; i++) {
      near[i] = Math.min(near[i], distance(frames[i], cents[cents.length - 1]));
      if (near[i] > near[far]) far = i;
    }
    if (near[far] === 0) break; // fewer distinct snapshots than K
    cents.push(Float64Array.from(frames[far]));
  }
  const owner = new Int32Array(frames.length);
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < frames.length; i++) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < cents.length; k++) { const d = distance(frames[i], cents[k]); if (d < bd) { bd = d; best = k; } }
      owner[i] = best;
    }
    const sum = cents.map(() => new Float64Array(dims)), count = new Int32Array(cents.length);
    for (let i = 0; i < frames.length; i++) { count[owner[i]]++; for (let d = 0; d < dims; d++) sum[owner[i]][d] += frames[i][d]; }
    for (let k = 0; k < cents.length; k++) if (count[k]) for (let d = 0; d < dims; d++) cents[k][d] = sum[k][d] / count[k];
  }
  return cents.map(c => Array.from(c, v => Math.round(v * 10) / 10));
}

/**
 * Learn one recording of a car: its typical snapshots, and `spread`, the typical distance of the
 * car's own sound to them, measured on moments left out of the learning (every third second).
 */
export function learn(frames, K = CAR_ID.K) {
  const perBlock = Math.round(1 / CAR_ID.every), train = [], held = [];
  frames.forEach((f, i) => (Math.floor(i / perBlock) % 3 === 2 ? held : train).push(f));
  let spread = null;
  if (held.length >= 10 && train.length >= 20) {
    const c = cluster(train, K);
    spread = held.reduce((s, f) => s + distanceTo(f, c), 0) / held.length;
  }
  const centroids = cluster(frames, K);
  spread ??= frames.reduce((s, f) => s + distanceTo(f, centroids), 0) / Math.max(1, frames.length);
  return { centroids, spread: Math.round(spread * 100) / 100, snapshots: frames.length };
}

/** Typical distance of a car's sound to its own profile, over all cars: the scale of the evidence. */
export function typicalSpread(cars) {
  const s = Object.values(cars).map(c => c.spread).filter(Number.isFinite).sort((a, b) => a - b);
  return Math.max(CAR_ID.minSigma2, s.length ? s[s.length >> 1] : CAR_ID.minSigma2);
}

/**
 * Profiles file (tools/cars.js: { cars: { key: { car, n, cylinders, parts: [{ source, spread, centroids }] } } })
 * → what CarMatcher takes. A car learned from several recordings keeps the snapshots of each.
 */
export function loadProfiles(file) {
  const cars = {};
  for (const [key, c] of Object.entries(file?.cars || {})) {
    const centroids = (c.parts || []).flatMap(p => p.centroids);
    if (!centroids.length) continue;
    const spreads = c.parts.map(p => p.spread).filter(Number.isFinite);
    cars[key] = { car: c.car, n: c.n, cylinders: c.cylinders ?? null, centroids, spread: spreads.reduce((a, b) => a + b, 0) / Math.max(1, spreads.length) };
  }
  return { sigma2: typicalSpread(cars), cars };
}

/**
 * Recognises the car from a stream of snapshots.
 * @param {{ sigma2: number, cars: Object<string, { centroids: number[][], cylinders: number|null }> }} profiles
 */
export class CarMatcher {
  constructor(profiles) {
    this.keys = Object.keys(profiles.cars);
    this.cars = this.keys.map(k => profiles.cars[k]);
    this.sigma2 = Math.max(CAR_ID.minSigma2, profiles.sigma2 || 0);
    this.reset();
  }

  reset() {
    this.L = new Float64Array(this.keys.length + 1); // evidence per car; last = unknown
    this.heard = 0; this.t = null;
    this.car = null; this.cylinders = null;          // confirmed (held for CAR_ID.hold)
    this.pending = { car: null, carSince: 0, cyl: null, cylSince: 0 };
    this.p = null;
  }

  /** @param {number} t seconds  @param {Float32Array|null} x snapshot, or null when silent */
  push(t, x) {
    if (this.t !== null && t > this.t) {
      const k = Math.exp(-(t - this.t) / CAR_ID.tau);
      for (let i = 0; i < this.L.length; i++) this.L[i] *= k;
      this.heard *= k;
    }
    const dt = this.t === null ? CAR_ID.every : Math.min(t - this.t, 2 * CAR_ID.every);
    this.t = t;
    if (!x) return;
    const w = CAR_ID.frameWeight / (2 * this.sigma2);
    for (let i = 0; i < this.cars.length; i++) this.L[i] -= w * distanceTo(x, this.cars[i].centroids);
    this.L[this.cars.length] -= w * CAR_ID.unknown * this.sigma2;
    this.heard += dt;
    this.decide(t);
  }

  decide(t) {
    let max = -Infinity;
    for (const v of this.L) if (v > max) max = v;
    const p = Array.from(this.L, v => Math.exp(v - max)), sum = p.reduce((a, b) => a + b, 0);
    for (let i = 0; i < p.length; i++) p[i] /= sum;
    this.p = p;
    if (this.heard < CAR_ID.minHeard) return;
    // the car, and the cylinder count the evidence agrees on (cars that sound alike split the
    // evidence between them, but usually share the count)
    let best = 0;
    const byCyl = new Map();
    for (let i = 0; i < this.cars.length; i++) {
      if (p[i] > p[best]) best = i;
      const n = this.cars[i].cylinders;
      if (n) byCyl.set(n, (byCyl.get(n) || 0) + p[i]);
    }
    const car = p[best] >= CAR_ID.share ? this.keys[best] : null;
    let cyl = null;
    for (const [n, share] of byCyl) if (share >= CAR_ID.share) cyl = n;
    // a new answer replaces the confirmed one once it has held; no answer never erases one (the
    // car doesn't change because the sound did for a moment)
    const q = this.pending;
    if (car !== q.car) { q.car = car; q.carSince = t; }
    if (cyl !== q.cyl) { q.cyl = cyl; q.cylSince = t; }
    if (car && t - q.carSince >= CAR_ID.hold) this.car = car;
    if (cyl && t - q.cylSince >= CAR_ID.hold) {
      this.cylinders = cyl;
      if (this.car && this.cars[this.keys.indexOf(this.car)].cylinders !== cyl) this.car = null;
    }
  }

  /** For the page: what it hears right now. */
  state() {
    const p = this.p, n = this.cars.length;
    const listening = !p || this.heard < CAR_ID.minHeard;
    const top = listening ? [] : this.keys.map((key, i) => ({ key, p: p[i] })).sort((a, b) => b.p - a.p).slice(0, 3).filter(x => x.p >= 0.05);
    return { listening, unknown: listening ? 0 : p[n], car: this.car, cylinders: this.cylinders, top, heard: this.heard };
  }
}
