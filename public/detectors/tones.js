// A car's tone map: how loud each tone of its engine is, by rpm.
//
// Every tone an engine makes is a multiple (an "order") of its cycle frequency, rpm / 120. Which
// orders are loud is the car's own: the firing tone on most fours, half of it on a V6 that sounds
// like two threes, the crank tone on a boxer off the throttle. The detectors find a pitch and must
// decide which order it is; a generic rule (the loudest candidate is the firing tone) is wrong on
// just those cars. With the car known, each candidate rpm is tested instead against what this car
// sounds like at that rpm: the levels of the first ORDERS orders, read from the spectrum at the
// places that rpm puts them, compared with the levels learned for that rpm band.
//
// Learned by tools/cars.js from recordings whose rpm is known (the offline reference rpm), read
// from the same spectrum the pipeline has live, so that whatever that spectrum smears at low revs is
// smeared the same way in the map.
export const TONES = Object.freeze({
  orders: 16,      // cycle orders compared: up to 4× the firing tone of a four, 2× that of a V8
  tol: 0.03,       // a tone may sit this far (relative) from its place: the revs move within the window
  floorDb: 40,     // orders more than this below the loudest count as that floor
  edges: [1500, 2500, 3500, 4500, 5500, 6500, 7500, 8500], // rpm bands (below the first … above the last)
  minFrames: 40,   // a band learned from fewer spectra than this is not used
  sdFloor: 3,      // dB: an order's level is never taken to be steadier than this
  sure: 2,         // a fit this close (the car's own sound is at 1 to 2, a wrong rpm mostly above 4) stands by itself
  margin: 1.2,    // another rpm must fit this much better (in squared deviations per order) than the one chosen…
  fits: 3.5,       // …and fit the car at all
});

const bandOf = rpm => { let b = 0; while (b < TONES.edges.length && rpm >= TONES.edges[b]) b++; return b; };

/**
 * Levels of the first ORDERS orders of a cycle frequency in a dB spectrum, floored and with their
 * mean removed (so that loudness does not count). Null when the spectrum does not reach that far.
 * @param {Float32Array} db  @param {number} binHz  @param {number} fc cycle frequency, Hz
 */
export function orderLevels(db, binHz, fc, out = new Float32Array(TONES.orders)) {
  const K = TONES.orders;
  if (!(fc > 0) || (K * fc * (1 + TONES.tol)) / binHz >= db.length - 1) return null;
  let top = -Infinity;
  for (let k = 1; k <= K; k++) {
    const f = k * fc, a = Math.max(1, Math.round((f * (1 - TONES.tol)) / binHz)), b = Math.max(a, Math.round((f * (1 + TONES.tol)) / binHz));
    let m = -Infinity;
    for (let i = a; i <= b; i++) if (db[i] > m) m = db[i];
    out[k - 1] = m;
    if (m > top) top = m;
  }
  let mean = 0;
  for (let k = 0; k < K; k++) { if (out[k] < top - TONES.floorDb) out[k] = top - TONES.floorDb; mean += out[k]; }
  mean /= K;
  for (let k = 0; k < K; k++) out[k] -= mean;
  return out;
}

/** Collects order levels at known rpm; map() gives the tone map: per rpm band, mean and spread of each order. */
export class ToneLearner {
  constructor() {
    const B = TONES.edges.length + 2, K = TONES.orders; // the rpm bands, then one for all of them together
    this.n = new Array(B).fill(0);
    this.sum = Array.from({ length: B }, () => new Float64Array(K));
    this.sq = Array.from({ length: B }, () => new Float64Array(K));
  }

  add(rpm, levels) {
    if (!levels) return;
    for (const b of [bandOf(rpm), this.n.length - 1]) {
      this.n[b]++;
      for (let k = 0; k < levels.length; k++) { this.sum[b][k] += levels[k]; this.sq[b][k] += levels[k] * levels[k]; }
    }
  }

  map() {
    const r1 = v => Math.round(v * 10) / 10;
    return {
      n: this.n,
      mean: this.sum.map((s, b) => Array.from(s, v => (this.n[b] ? r1(v / this.n[b]) : 0))),
      sd: this.sq.map((q, b) => Array.from(q, (v, k) => (this.n[b] ? r1(Math.sqrt(Math.max(0, v / this.n[b] - (this.sum[b][k] / this.n[b]) ** 2))) : 0))),
    };
  }
}

/**
 * How far a set of order levels is from what the car sounds like at that rpm: per order, the squared
 * deviation in units of that order's own spread, plus a charge for a wide spread (as in a Gaussian
 * likelihood). Null when the map has no band for it.
 * A car can have several maps, one per recording (the engine sounds different from each camera):
 * given a list, the answer is that of the map that fits best.
 */
export function toneDistance(map, rpm, levels) {
  if (Array.isArray(map)) {
    let best = null;
    for (const m of map) { const d = toneDistance(m, rpm, levels); if (d !== null && (best === null || d < best)) best = d; }
    return best;
  }
  if (!levels || !map) return null;
  // the band for that rpm; if the car was hardly heard there, what it sounds like over all revs
  // (its orders keep their character; what changes with the revs is less than what tells cars and octaves apart)
  let b = bandOf(rpm);
  if (!(map.n[b] >= TONES.minFrames)) b = map.n.length - 1;
  if (!(map.n[b] >= TONES.minFrames)) return null;
  const mean = map.mean[b], sd = map.sd[b];
  let d = 0;
  for (let k = 0; k < levels.length; k++) {
    // a likelihood, not just a deviation: an order whose level is all over the place (a band heard
    // little, or all revs together) fits anything, and must not win for that
    const s = Math.max(sd[k], TONES.sdFloor), z = (levels[k] - mean[k]) / s;
    d += z * z + 2 * Math.log(s / TONES.sdFloor);
  }
  return d / levels.length;
}
