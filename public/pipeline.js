// Detection pipeline shared by the browser worker (detect-worker.js), the benchmark and the tests.
// Feed it audio chunks as they arrive; each step() runs both detectors on the latest samples.
//
// Lag reductions compared with POC 1:
//  - step() runs on every audio chunk (5.3 ms by default) instead of a 20 ms timer
//  - readings are stamped at the centre of their analysis window (that is the moment they describe)
//    and the tracker's velocity predicts them forward to the newest sample ("predict")
//  - pitch-detection sizes its window to the current engine tone ("adaptive"): ~2.5 periods of
//    60% of the current firing frequency, so a gear-shift drop still fits; high revs → tiny window
import rfft from 'fourier-transform';
import { analyseSpectrum } from './detectors/gyroball-core.js';
import { detectPitch } from './detectors/pd-core.js';
import { Tracker } from './tracker.js';
import { firingHz, rpmFromFiringHz } from './engine-model.js';
import { Ring } from './ring.js';

const MAX_FFT = 32768;
const MAX_PD_WIN = 0.2; // s, decimated ring length

export const DEFAULTS = Object.freeze({
  cylinders: 4, idle: 900, redline: 7500,
  scale: { gyro: 1, pd: 1 },
  gyro: { enabled: true, fft: 8192, tuned: true, mode: 'auto' },
  pd: { enabled: true, algo: 'yin', maxWin: 0.085, adaptive: true, periods: 2.5, minWin: 0.012 },
  // confirm: a rejected new level is accepted after it persists confirmBaseMs + confirmWin × ½ window
  // (measured: the fastest rule gives the least error and the fewest glitches, once the detector
  // itself rejects smeared readings)
  tracker: { tau: 0.05, accel: 40000, reacq: 0.25, confirmBaseMs: 15, confirmWin: 0 },
  predict: true,
  timestamp: 'centre', // 'end' reproduces POC 1 (reading stamped when computed)
});

const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] || {}, v) : v;
  }
  return out;
};

export class Pipeline {
  /**
   * @param {number} fs  input sample rate
   * @param {number} D   decimation factor of the low-passed stream fed to pitch-detection
   */
  constructor(fs, D, cfg = {}) {
    this.fs = fs; this.D = D; this.fsDec = fs / D;
    this.raw = new Ring(MAX_FFT);
    this.dec = new Ring(Math.ceil(MAX_PD_WIN * this.fsDec));
    this.trackers = { gyro: new Tracker(), pd: new Tracker() };
    this.bufs = new Map();
    this.windows = new Map();
    this.cfg = merge(DEFAULTS, {});
    this.configure(cfg);
  }

  configure(cfg) {
    const prev = this.cfg;
    this.cfg = merge(this.cfg, cfg);
    const t = this.cfg.tracker;
    for (const tr of Object.values(this.trackers)) {
      tr.set({ tau: t.tau, maxAccel: t.accel, maxVel: t.accel, reacquire: t.reacq, lag: 0.01 });
    }
    const c = this.cfg;
    if (prev.cylinders !== c.cylinders || prev.scale.gyro !== c.scale.gyro || prev.scale.pd !== c.scale.pd) this.reset();
  }

  reset() { this.trackers.gyro.reset(); this.trackers.pd.reset(); }

  band() {
    const { idle, redline, cylinders } = this.cfg;
    return { fLo: firingHz(idle * 0.7, cylinders), fHi: firingHz(redline * 1.15, cylinders) };
  }

  /** @param {Float32Array} raw full-rate samples  @param {Float32Array} [dec] low-passed, decimated by D */
  push(raw, dec) {
    this.raw.push(raw);
    if (dec) this.dec.push(dec);
  }

  /** @param {number} tEnd time (s) of the newest sample pushed */
  step(tEnd) {
    return {
      gyro: this.cfg.gyro.enabled ? this.stepGyro(tEnd) : null,
      pd: this.cfg.pd.enabled ? this.stepPd(tEnd) : null,
    };
  }

  buf(key, n, Type = Float32Array) {
    const k = key + n;
    let b = this.bufs.get(k);
    if (!b) { b = new Type(n); this.bufs.set(k, b); }
    return b;
  }

  blackman(n) {
    let w = this.windows.get(n);
    if (!w) {
      w = new Float64Array(n);
      for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; w[i] = 0.42 - 0.5 * Math.cos(a) + 0.08 * Math.cos(2 * a); }
      this.windows.set(n, w);
    }
    return w;
  }

  stepGyro(tEnd) {
    const t0 = performance.now();
    const g = this.cfg.gyro, N = g.fft, fs = this.fs;
    const frame = this.raw.latest(N, this.buf('gf', N));
    const w = this.blackman(N), x = this.buf('gx', N, Float64Array);
    for (let i = 0; i < N; i++) x[i] = frame[i] * w[i];
    const mag = rfft(x);
    const db = this.buf('gdb', N / 2);
    for (let i = 0; i < N / 2; i++) db[i] = 20 * Math.log10(Math.max(mag[i] / N, 1e-12));
    const { fLo, fHi } = this.band();
    const r = analyseSpectrum(db, fs / N, g.tuned
      ? { fLo, fHi, mode: g.mode, octaveCheck: true, requireFundamental: true, maxHz: Math.min(fs * 0.45, Math.max(1500, fHi * 8)) }
      : { fLo, fHi, mode: g.mode });
    const raw = r.valid ? rpmFromFiringHz(r.f0, this.cfg.cylinders) * this.cfg.scale.gyro : null;
    return this.finish('gyro', raw, tEnd, N / fs / 2, t0, {
      f0: r.f0, valid: r.valid, info: r.valid ? `score ${r.score.toFixed(0)} · harmonics ${r.harmonics.join(',')}×` : '',
      ex: r.ex, binHz: fs / N, winMs: (N / fs) * 1000,
    });
  }

  stepPd(tEnd) {
    const t0 = performance.now();
    const p = this.cfg.pd, fsd = this.fsDec;
    let winS = p.maxWin;
    const tr = this.trackers.pd;
    if (p.adaptive && p.algo !== 'hps' && tr.x !== null) {
      const f = firingHz(Math.max(tr.x, this.cfg.idle * 0.7), this.cfg.cylinders);
      winS = Math.min(p.maxWin, Math.max(p.minWin, p.periods / (0.6 * f)));
    }
    let N = Math.round(winS * fsd);
    if (p.algo === 'hps') N = 2 ** Math.round(Math.log2(p.maxWin * fsd)); // HPS needs a power of 2
    N = Math.min(N, this.dec.size);
    const frame = this.dec.latest(N, this.buf('pf', N));
    const { fLo, fHi } = this.band();
    const r = detectPitch(frame, { fs: fsd, algo: p.algo, fLo, fHi });
    const raw = r.valid ? rpmFromFiringHz(r.f0, this.cfg.cylinders) * this.cfg.scale.pd : null;
    return this.finish('pd', raw, tEnd, N / fsd / 2, t0, {
      f0: r.f0, valid: r.valid, info: r.valid ? `clarity ${r.clarity.toFixed(2)}` : '', winMs: (N / fsd) * 1000,
    });
  }

  finish(key, raw, tEnd, halfWin, t0, extra) {
    const tStamp = this.cfg.timestamp === 'end' ? tEnd : tEnd - halfWin;
    const tr = this.trackers[key];
    const t = this.cfg.tracker; // a new level must persist beyond the window's own overlap
    tr.confirmMs = t.confirmBaseMs + t.confirmWin * halfWin * 1000;
    const out = tr.step(raw, tStamp * 1000);
    let rpm = out ? out.rpm : null;
    const ahead = tEnd - tStamp;
    if (out && this.cfg.predict && ahead > 0) rpm = Math.max(0, out.rpm + tr.v * ahead);
    return {
      raw, rpm, coast: out ? out.coast : false,
      windowDelayMs: halfWin * 1000,              // the reading describes the window centre
      predictedMs: this.cfg.predict && out ? ahead * 1000 : 0,
      computeMs: performance.now() - t0,
      ...extra,
    };
  }
}
