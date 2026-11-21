// Time-domain / HPS detector built on the `pitch-detection` package (audiojs, MIT).
// In the browser the bare specifiers resolve through the import map in index.html;
// in Node (tests) they resolve from node_modules.
import mcleod from 'pitch-detection/mcleod.js';
import yin from 'pitch-detection/yin.js';
import hps from 'pitch-detection/hps.js';

export const ALGOS = ['mcleod', 'hps', 'yin'];

// Minimum clarity for a reading to count. Each algorithm reports clarity on its own scale.
// McLeod peak-picking constant k (paper: 0.8–1.0; package default 0.9). Engines have half-order
// tones, so the true waveform period is two firing periods; with k = 0.9 the picker often takes
// that longer period (an octave-low reading). 0.8 favours the firing period.
const MCLEOD_K = 0.8;

const MIN_CLARITY = { mcleod: 0.6, yin: 0.5, hps: 0.1 };

/** Keep every D-th sample. Input must already be low-passed below the new Nyquist. */
export function decimate(input, D, out) {
  const n = Math.floor(input.length / D);
  const o = out && out.length === n ? out : new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = input[i * D];
  return o;
}

export function rms(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return Math.sqrt(s / frame.length);
}

/** Normalized self-similarity of the frame at a (fractional) lag: 1 = repeats exactly. */
function nsdfAt(frame, lag) {
  const L = Math.floor(lag), t = lag - L, n = frame.length - L - 1;
  if (n < 8) return 0;
  let acf = 0, e = 0;
  for (let i = 0; i < n; i++) {
    const y = frame[i + L] * (1 - t) + frame[i + L + 1] * t;
    acf += frame[i] * y;
    e += frame[i] * frame[i] + y * y;
  }
  return e > 0 ? (2 * acf) / e : 0;
}

/**
 * YIN (de Cheveigné & Kawahara, 2002), as in the pitch-detection package: the first dip of the
 * normalized difference below `threshold`. The package gives up when there is none; the paper does
 * not, and neither does this: it then takes the deepest dip, and the caller decides from the
 * clarity (1 − depth) whether that is good enough. Real engines need it: their cylinders don't
 * sound alike, so one firing period never repeats the last one as exactly as a simulated one does.
 * @returns {{freq:number, clarity:number}|null}
 */
export function yinDip(data, fs, threshold = 0.15, minTau = 2) {
  const half = data.length >> 1;
  if (half < 8) return null;
  const c = new Float64Array(half);
  c[0] = 1;
  let running = 0;
  for (let tau = 1; tau < half; tau++) {
    let sum = 0;
    for (let i = 0; i < half; i++) { const diff = data[i] - data[i + tau]; sum += diff * diff; }
    running += sum;
    c[tau] = running > 0 ? (sum * tau) / running : 1;
  }
  let tau = 2;
  while (tau < half - 1) {
    if (c[tau] < threshold) { while (tau + 1 < half - 1 && c[tau + 1] < c[tau]) tau++; break; }
    tau++;
  }
  if (tau >= half - 1) { // no dip that deep: the deepest one
    tau = 0;
    for (let k = Math.max(2, Math.ceil(minTau)); k < half - 1; k++) if (c[k] <= c[k - 1] && c[k] < c[k + 1] && (!tau || c[k] < c[tau])) tau = k;
    if (!tau) return null;
  }
  const s0 = c[tau - 1], s1 = c[tau], s2 = c[tau + 1], denom = s0 - 2 * s1 + s2;
  return { freq: fs / (tau + (denom !== 0 ? (s0 - s2) / (2 * denom) : 0)), clarity: 1 - s1 };
}

// Octave check: engines have strong half orders, so the waveform's full period can be two firing
// periods and a period detector then reports half the firing frequency. If the frame repeats
// almost as well at half the detected period, the firing tone is the octave above.
const OCTAVE_RATIO = 0.8;

/**
 * @param {Float32Array} frame  mono samples at fs (power-of-2 length for hps)
 * @param {{fs:number, algo?:string, fLo:number, fHi:number, octaveCheck?:boolean}} opts
 * @returns {{f0:number, clarity:number, valid:boolean}}
 */
export function detectPitch(frame, { fs, algo = 'mcleod', fLo, fHi, octaveCheck = true, clarity }) {
  if (rms(frame) < 1e-4) return { f0: 0, clarity: 0, valid: false }; // silence
  let r = null;
  if (algo === 'hps') r = hps(frame, { fs, minFreq: fLo, maxFreq: fHi, harmonics: 5, threshold: MIN_CLARITY.hps });
  else if (algo === 'yin') r = clarity === undefined ? yin(frame, { fs }) : yinDip(frame, fs, 0.15, fs / (fHi * 1.2));
  else r = mcleod(frame, { fs, threshold: MCLEOD_K });
  if (!r || !Number.isFinite(r.freq)) return { f0: 0, clarity: 0, valid: false };
  let f0 = r.freq;
  if (octaveCheck && algo !== 'hps' && 2 * f0 <= fHi) {
    const full = nsdfAt(frame, fs / f0), half = nsdfAt(frame, fs / (2 * f0));
    if (full > 0 && half >= OCTAVE_RATIO * full) f0 *= 2;
  }
  const valid = f0 >= fLo && f0 <= fHi && r.clarity >= (clarity ?? MIN_CLARITY[algo] ?? 0.5);
  return { f0, clarity: r.clarity, valid };
}
