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

/**
 * @param {Float32Array} frame  mono samples at fs (power-of-2 length for hps)
 * @param {{fs:number, algo?:string, fLo:number, fHi:number}} opts
 * @returns {{f0:number, clarity:number, valid:boolean}}
 */
export function detectPitch(frame, { fs, algo = 'mcleod', fLo, fHi }) {
  if (rms(frame) < 1e-4) return { f0: 0, clarity: 0, valid: false }; // silence
  let r = null;
  if (algo === 'hps') r = hps(frame, { fs, minFreq: fLo, maxFreq: fHi, harmonics: 5, threshold: MIN_CLARITY.hps });
  else if (algo === 'yin') r = yin(frame, { fs });
  else r = mcleod(frame, { fs, threshold: MCLEOD_K });
  if (!r || !Number.isFinite(r.freq)) return { f0: 0, clarity: 0, valid: false };
  const valid = r.freq >= fLo && r.freq <= fHi && r.clarity >= (MIN_CLARITY[algo] ?? 0.5);
  return { f0: r.freq, clarity: r.clarity, valid };
}
