// Test helpers: synthesize engine audio from the shared model, and compute a dB spectrum
// the way Web Audio's AnalyserNode does (Blackman window, |X|/N, 20·log10).
import rfft from 'fourier-transform';
import { enginePartials, firingHz } from '../public/engine-model.js';

export function engineFrame({ rpm, cylinders = 4, fs = 48000, n = 8192, noise = 0.03, seed = 7, offset = 0, cycleLevel = 0.06 }) {
  const f = firingHz(rpm, cylinders);
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const out = new Float32Array(n);
  const partials = enginePartials(cylinders, { cycleLevel });
  for (let i = 0; i < n; i++) {
    const t = (i + offset) / fs;
    let v = 0;
    for (const [mult, amp] of partials) if (mult * f < fs * 0.45) v += amp * Math.sin(2 * Math.PI * mult * f * t + mult);
    out[i] = v * 0.15 + rand() * noise;
  }
  return out;
}

export function analyserDb(frame) {
  const N = frame.length, w = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    w[i] = (0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a)) * frame[i];
  }
  const mag = rfft(w);
  const db = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) db[i] = 20 * Math.log10(Math.max(mag[i] / N, 1e-12));
  return db;
}
