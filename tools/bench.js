// Offline benchmark: runs both detectors + trackers over the simulated shifting sweep, exactly as
// the page does (20 ms ticks, same windows, same tracker settings), and compares with the true rpm.
//   npm run bench
//   npm run bench -- --cylinders 6
// Differences from the browser: no AnalyserNode smoothing and no biquad before decimation
// (the synthetic signal has nothing above the decimated Nyquist except white noise).
import rfft from 'fourier-transform';
import { analyseSpectrum } from '../public/detectors/gyroball-core.js';
import { detectPitch, decimate } from '../public/detectors/pd-core.js';
import { Tracker } from '../public/tracker.js';
import { makeSchedule, synthesize, rpmAt, scheduleDuration, firingHz, rpmFromFiringHz } from '../public/engine-model.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => s.trim().split(/\s+/)));
const fs = 48000, D = 4, TICK = 0.02;
const cylinders = Number(args.cylinders || 4), idle = Number(args.idle || 900), redline = Number(args.redline || 7500);
const schedule = makeSchedule({ idleRpm: idle, redline });
const seconds = scheduleDuration(schedule) * 2;
const signal = synthesize(schedule, { fs, seconds, cylinders });
const fLo = firingHz(idle * 0.7, cylinders), fHi = firingHz(redline * 1.15, cylinders);

function analyserDb(frame) { // Blackman window, |X|/N, dB — like AnalyserNode
  const N = frame.length, w = new Float64Array(N);
  for (let i = 0; i < N; i++) { const a = (2 * Math.PI * i) / N; w[i] = (0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a)) * frame[i]; }
  const mag = rfft(w), db = new Float32Array(N / 2);
  for (let i = 0; i < N / 2; i++) db[i] = 20 * Math.log10(Math.max(mag[i] / N, 1e-12));
  return db;
}

function run(name, win, estimate) {
  const tr = new Tracker({ tau: 0.08, maxAccel: 40000, maxVel: 40000, reacquire: 0.25, lag: win / fs / 2 });
  const errs = []; let ticks = 0, locked = 0, rawOk = 0, octave = 0;
  for (let t = win / fs; t < seconds; t += TICK) {
    const end = Math.floor(t * fs), frame = signal.subarray(end - win, end);
    const raw = estimate(frame);
    const out = tr.step(raw, t * 1000);
    const now = rpmAt(schedule, t), centre = rpmAt(schedule, t - win / fs / 2);
    ticks++;
    if (raw !== null) {
      if (Math.abs(raw - centre) / centre < 0.03) rawOk++;
      else if (Math.abs(raw - centre / 2) / centre < 0.05 || Math.abs(raw - centre * 2) / centre < 0.1) octave++;
    }
    if (out) { locked++; errs.push(Math.abs(out.rpm - now)); }
  }
  errs.sort((a, b) => a - b);
  const mean = errs.reduce((a, b) => a + b, 0) / (errs.length || 1);
  const p90 = errs[Math.floor(errs.length * 0.9)] ?? NaN;
  return {
    name, window: `${Math.round((win / fs) * 1000)} ms`,
    'raw ok (±3%)': pct(rawOk, ticks), 'octave errs': pct(octave, ticks), locked: pct(locked, ticks),
    'SimHub err mean': Math.round(mean), 'SimHub err p90': Math.round(p90),
  };
}
const pct = (a, b) => `${Math.round((100 * a) / b)}%`;

const gyro = (fft, engineTuned) => frame => {
  const g = analyseSpectrum(analyserDb(frame), fs / fft, engineTuned
    ? { fLo, fHi, octaveCheck: true, maxHz: Math.min(fs * 0.45, Math.max(1500, fHi * 8)) }
    : { fLo, fHi });
  return g.valid ? rpmFromFiringHz(g.f0, cylinders) : null;
};
const pd = algo => frame => {
  const p = detectPitch(decimate(frame, D), { fs: fs / D, algo, fLo, fHi });
  return p.valid ? rpmFromFiringHz(p.f0, cylinders) : null;
};

console.log(`raw ok = detector within 3% of the true rpm at the window centre (accuracy, lag removed)\nSimHub err = |tracked rpm − true rpm now| in rpm (what SimHub actually gets, lag included)\n\nSimulated sweep, ${cylinders} cylinders, ${idle}–${redline} rpm, ${seconds.toFixed(0)} s, ticks every ${TICK * 1000} ms\n`);
console.table([
  run('gyroball 8192 (original)', 8192, gyro(8192, false)),
  run('gyroball 8192 engine-tuned', 8192, gyro(8192, true)),
  run('gyroball 16384 engine-tuned', 16384, gyro(16384, true)),
  run('pitch-detection mcleod', 4096, pd('mcleod')),
  run('pitch-detection yin', 4096, pd('yin')),
  run('pitch-detection hps', 4096, pd('hps')),
]);
