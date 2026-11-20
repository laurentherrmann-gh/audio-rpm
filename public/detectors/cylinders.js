// Cylinder-count detection from the engine's "cycle orders".
//
// An N-cylinder 4-stroke engine fires N times per engine cycle (two crank turns). Its loudest tone
// is the firing frequency, but because no two cylinders fire exactly alike, the sound really
// repeats once per cycle: faint tones also sit at every multiple of the cycle frequency
// (firing / N). Counting how finely the spectrum between two firing harmonics is divided gives N.
//
// For each candidate N we look for lines at k × firing / N (k = 1 … 2N−1, skipping multiples of N)
// and count how many stand out against the spectrum halfway to their neighbours, at (k ± ½) × firing / N.
// Using the halfway points (not a global noise floor) is what separates 4 from 8: for a true V8, the
// 4-cylinder comb's halfway points land on real lines, so that comb fails; for a true 4-cylinder, the
// odd lines of the 8-cylinder comb are empty, so that comb fails. The answer is the LARGEST N whose
// lines are mostly present.
//
// The RPM then follows from the cycle frequency (rpm = 120 × firing / N) whatever harmonic the
// pitch detector locked onto, as long as the lines are consistent with it.
import { CYLINDERS } from '../engine-model.js';

/** Running median of `x` over ±w bins. */
function medianFloor(x, w) {
  const n = x.length, out = new Float32Array(n), buf = [];
  for (let i = 0; i < n; i++) {
    buf.length = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) buf.push(x[j]);
    buf.sort((a, b) => a - b);
    out[i] = buf[buf.length >> 1];
  }
  return out;
}

/**
 * @param {Float32Array} db    dB spectrum, bin i = i × binHz (high resolution: ≲ 2 Hz bins)
 * @param {number} binHz
 * @param {number} fFire       the engine's firing frequency (Hz), from the pitch detector
 * @param {{candidates?:number[], minHz?:number, threshDb?:number, minPresent?:number}} [opts]
 * @returns {{n:number|null, scores:Object<number,{present:number, lines:number}>}}
 */
export function detectCylinders(db, binHz, fFire, { candidates = CYLINDERS, minHz = 12, threshDb = 6, minPresent = 0.7 } = {}) {
  const maxHz = Math.min(2 * fFire * 1.02, (db.length - 3) * binHz);
  const nb = Math.min(db.length - 1, Math.ceil(maxHz / binHz) + 8);
  const spec = new Float32Array(nb + 1);
  for (let i = 0; i <= nb; i++) spec[i] = Number.isFinite(db[i]) ? db[i] : -140;

  const at = f => { // linear interpolation between bins
    const b = f / binHz, i = Math.floor(b), t = b - i;
    return i + 1 <= nb ? spec[i] * (1 - t) + spec[i + 1] * t : spec[nb];
  };
  const peak = f => { // strongest bin near f (allows for small frequency errors)
    const c = Math.round(f / binHz), tol = Math.max(1, Math.round((0.004 * f) / binHz));
    let best = -Infinity;
    for (let i = Math.max(1, c - tol); i <= Math.min(nb, c + tol); i++) best = Math.max(best, spec[i]);
    return best;
  };

  const scores = {};
  // the firing tone itself must stand out, or there is nothing to measure against
  const floor = medianFloor(spec, Math.max(8, Math.round(fFire / binHz)));
  const fb = Math.round(fFire / binHz);
  if (!(fFire > minHz) || fb > nb || peak(fFire) - floor[fb] < threshDb) return { n: null, scores };

  for (const N of candidates) {
    const step = fFire / N;
    let lines = 0, present = 0;
    for (let k = 1; k < 2 * N; k++) {
      if (k % N === 0) continue;
      const f = k * step;
      if (f - step / 2 < minHz || f + step / 2 > maxHz) continue;
      lines++;
      if (peak(f) - Math.max(at(f - step / 2), at(f + step / 2)) >= threshDb) present++;
    }
    scores[N] = { present: lines ? present / lines : 0, lines };
  }
  const n = [...candidates].sort((a, b) => b - a)
    .find(N => scores[N].lines >= 3 && scores[N].present >= minPresent) ?? null;
  return { n, scores };
}
