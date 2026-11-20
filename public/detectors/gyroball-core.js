// Spectral harmonic-scoring detector, ported from gyroball-rpm
// (https://github.com/berkenbu/gyroball-rpm, MIT License, (c) 2026 berkenbu — see THIRD_PARTY.md).
//
// Changes from the original:
//  - pure function: takes the dB spectrum (as from AnalyserNode.getFloatFrequencyData) and returns
//    the fundamental in Hz; rpm conversion happens in the caller (engine order ≠ gyro rotation)
//  - search band given in Hz instead of rpm
//  - maxHz defaults to 1500 as in the original; engine use passes enough to cover nHarm harmonics
//    of the top of the band (a 6-cylinder at 7,500 rpm fires at 375 Hz: 1500 Hz holds only 4 harmonics,
//    while the half-frequency candidate gets 8, so the wrong candidate wins on count)
//  - optional octave check (off = original behaviour). Engines have half-order tones, so the
//    candidate at half the firing frequency explains nearly the same peaks and often wins by a
//    hair. With octaveCheck, if twice the winner scores at least OCTAVE_RATIO of it, take twice.

const MIN_SCORE = 8;
const OCTAVE_RATIO = 0.8;

// parabolic interpolation around bin i → fractional bin
function interp(a, i) {
  const y0 = a[i - 1], y1 = a[i], y2 = a[i + 1];
  const den = y0 - 2 * y1 + y2;
  return den === 0 ? i : i + (0.5 * (y0 - y2)) / den;
}

/**
 * @param {Float32Array} db  dB magnitude spectrum (bin i = i * binHz)
 * @param {number} binHz
 * @param {{fLo:number, fHi:number, mode?:'auto'|1|2|3|4, maxHz?:number, nHarm?:number, octaveCheck?:boolean}} opts
 * @returns {{f0:number, score:number, harmonics:number[], valid:boolean, ex:Float32Array, nb:number}}
 */
export function analyseSpectrum(db, binHz, { fLo, fHi, mode = 'auto', maxHz = 1500, nHarm = 8, octaveCheck = false }) {
  const nb = Math.min(db.length - 1, Math.floor(maxHz / binHz));
  const W = 40;
  const val = i => (Number.isFinite(db[i]) ? db[i] : -140);

  // excess over a moving-average noise floor
  const pre = new Float64Array(nb + 2);
  for (let i = 0; i <= nb; i++) pre[i + 1] = pre[i] + val(i);
  const ex = new Float32Array(nb + 1);
  for (let i = 0; i <= nb; i++) {
    const a = Math.max(0, i - W), b = Math.min(nb, i + W);
    ex[i] = val(i) - (pre[b + 1] - pre[a]) / (b - a + 1);
  }

  const maxExAt = (hz, tolBins) => {
    const c = Math.round(hz / binHz);
    let best = -99, bi = -1;
    for (let i = Math.max(2, c - tolBins); i <= Math.min(nb - 1, c + tolBins); i++) {
      if (ex[i] > best) { best = ex[i]; bi = i; }
    }
    return { ex: best, bin: bi };
  };

  let f0 = 0, score = 0;
  const harmonics = [];

  const scoreAt = f => {
    let s = 0;
    for (let k = 1; k <= nHarm && k * f < maxHz; k++) {
      const tol = Math.max(1, Math.round((k * f * 0.008) / binHz));
      const m = maxExAt(k * f, tol);
      s += Math.max(0, Math.min(m.ex, 30) - 5) / (1 + 0.08 * (k - 1));
    }
    return s;
  };

  if (mode === 'auto') {
    let bestF = 0, bestS = 0;
    for (let f = fLo; f <= fHi; f += 0.2) {
      const s = scoreAt(f);
      if (s > bestS) { bestS = s; bestF = f; }
    }
    if (octaveCheck && bestF > 0 && 2 * bestF <= fHi) {
      const s2 = scoreAt(2 * bestF);
      if (s2 >= OCTAVE_RATIO * bestS) { bestF *= 2; bestS = s2; }
    }
    f0 = bestF; score = bestS;
  } else {
    const N = Number(mode);
    const m = { ex: -99, bin: -1 };
    for (let i = Math.floor((fLo * N) / binHz); i <= Math.ceil((fHi * N) / binHz) && i < nb; i++) {
      if (i > 2 && ex[i] > m.ex) { m.ex = ex[i]; m.bin = i; }
    }
    if (m.bin > 0) { f0 = (interp(db, m.bin) * binHz) / N; score = Math.max(0, m.ex - 5) * 1.5; }
  }

  // refine f0 using each matched harmonic's interpolated peak
  if (f0 > 0 && score > 0) {
    let num = 0, den = 0;
    for (let k = 1; k <= nHarm && k * f0 < maxHz; k++) {
      const tol = Math.max(1, Math.round((k * f0 * 0.008) / binHz));
      const m = maxExAt(k * f0, tol);
      if (m.ex > 6 && m.bin > 1) {
        const fk = interp(db, m.bin) * binHz;
        num += (fk / k) * m.ex; den += m.ex;
        harmonics.push(k);
      }
    }
    if (den > 0 && mode === 'auto') f0 = num / den;
  }

  const valid = f0 > 0 && score >= MIN_SCORE && harmonics.length > 0;
  return { f0, score, harmonics, valid, ex, nb };
}
