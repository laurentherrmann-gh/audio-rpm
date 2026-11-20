// Detection pipeline shared by the browser worker (detect-worker.js), the benchmark and the tests.
// Feed it audio chunks as they arrive; each step() runs both detectors on the latest samples.
//
// Lag reductions compared with POC 1:
//  - step() runs on every audio chunk (5.3 ms by default) instead of a 20 ms timer
//  - readings are stamped at the centre of their analysis window (that is the moment they describe)
//    and the tracker's velocity predicts them forward to the newest sample ("predict")
//  - pitch-detection sizes its window to the current engine tone ("adaptive"): ~2.5 periods of
//    60% of the current firing frequency, so a gear-shift drop still fits; high revs → tiny window.
//    Short windows (≤ 25 ms, i.e. high firing frequencies: V8–V12 at revs) read the full-rate
//    stream: at the decimated ~12 kHz a period is too few samples and YIN slips an octave. The
//    choice follows the window length, not the rpm estimate, so a wrong estimate can't lock it in.
//
// Cylinders: a number, or 'auto'. In auto mode the detectors search the band of every candidate
// engine (`autoCandidates`, default the rally set 4/5/6/8) until detectors/cylinders.js has counted the cylinders from the engine-cycle tones (it
// runs every 0.1 s while the revs are steady; votes decay over a few seconds). Until it locks,
// rpm is computed with `autoGuess` cylinders.
import rfft from 'fourier-transform';
import { analyseSpectrum } from './detectors/gyroball-core.js';
import { detectPitch } from './detectors/pd-core.js';
import { detectCylinders } from './detectors/cylinders.js';
import { Tracker } from './tracker.js';
import { firingHz, rpmFromFiringHz, RALLY_CYLINDERS } from './engine-model.js';
import { Ring } from './ring.js';

const MAX_FFT = 32768;
const MAX_PD_WIN = 0.2;    // s, longest pitch window
const FULL_RATE_WIN = 0.025; // s: pitch windows this short read the full-rate stream
// cylinder detection spectrum, at the decimated rate: 8192 (~0.68 s, ~1.5 Hz bins), or 16384 (~1.4 s,
// ~0.7 Hz bins) when the firing tone is low: a 4-cylinder idling at 900 rpm has its cycle tones
// only 7.5 Hz apart, and the coarser spectrum resolves too few of them.
const CYL_FFT = 8192, CYL_FFT_LOW = 16384, CYL_LOW_HZ = 60;
const CYL_EVERY = 0.1;     // s between detection attempts
const CYL_STEADY = 0.012;  // the firing frequency may vary at most ±1.2% over the spectrum window
const CYL_TAU = 4;         // s, how long a vote counts
const CYL_LOCK = { votes: 3, share: 0.6 };

export const DEFAULTS = Object.freeze({
  cylinders: 4, autoGuess: 4, autoCandidates: RALLY_CYLINDERS, idle: 900, redline: 7500,
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
    this.dec = new Ring(Math.max(Math.ceil(MAX_PD_WIN * this.fsDec), CYL_FFT_LOW + 256));
    this.cyl = this.freshCyl();
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
    if (prev.cylinders !== c.cylinders || String(prev.autoCandidates) !== String(c.autoCandidates)) this.cyl = this.freshCyl();
    if (prev.cylinders !== c.cylinders || prev.scale.gyro !== c.scale.gyro || prev.scale.pd !== c.scale.pd) this.reset();
  }

  reset() { this.trackers.gyro.reset(); this.trackers.pd.reset(); }

  freshCyl() { return { votes: {}, locked: null, lastEval: -Infinity, lastDecay: null, history: [], last: null }; }

  /** Cylinder count used for the rpm conversion right now. */
  cylinders() {
    const c = this.cfg.cylinders;
    return c === 'auto' ? (this.cyl.locked ?? this.cfg.autoGuess) : c;
  }

  band() {
    const { idle, redline, cylinders } = this.cfg;
    if (cylinders === 'auto' && this.cyl.locked === null) { // not counted yet: every candidate engine
      const cands = this.cfg.autoCandidates;
      return { fLo: firingHz(idle * 0.7, Math.min(...cands)), fHi: firingHz(redline * 1.15, Math.max(...cands)) };
    }
    const n = this.cylinders();
    return { fLo: firingHz(idle * 0.7, n), fHi: firingHz(redline * 1.15, n) };
  }

  /** Cylinder state for the page. */
  cylState() {
    const c = this.cyl, total = Object.values(c.votes).reduce((a, b) => a + b, 0);
    const best = Object.entries(c.votes).sort((a, b) => b[1] - a[1])[0];
    return {
      mode: this.cfg.cylinders === 'auto' ? 'auto' : 'manual', n: this.cylinders(), locked: c.locked,
      candidate: best ? Number(best[0]) : null, confidence: best && total ? best[1] / total : 0,
    };
  }

  /** Auto mode: count cylinders when the revs have been steady for a whole spectrum window. */
  detectCyl(t) {
    const c = this.cyl;
    if (this.cfg.cylinders !== 'auto' || t - c.lastEval < CYL_EVERY) return;
    c.lastEval = t;
    if (c.lastDecay !== null) {
      const k = Math.exp(-(t - c.lastDecay) / CYL_TAU);
      for (const n in c.votes) c.votes[n] *= k;
    }
    c.lastDecay = t;
    // window length depends on the tone: decide with the latest reading, then check steadiness over it
    const lastF = c.history.length ? c.history[c.history.length - 1].f : 0;
    const nfft = lastF && lastF < CYL_LOW_HZ ? CYL_FFT_LOW : CYL_FFT;
    const span = nfft / this.fsDec;
    c.history = c.history.filter(x => x.t >= t - (CYL_FFT_LOW / this.fsDec) - 0.2);
    const h = c.history.filter(x => x.t >= t - span);
    if (h.length < 20 || h[0].t > t - span + 0.15) return; // not enough readings across the window
    // Steady = most readings agree with their median, up to an octave: pitch detectors slip to
    // half or double the firing tone now and then (engines have strong half orders); that is not
    // a change in revs. The reference is the octave most readings are in.
    const fs = h.map(x => x.f).sort((a, b) => a - b);
    const med = fs[fs.length >> 1];
    const byOctave = new Map();
    let agree = 0;
    for (const f of fs) {
      const oct = Math.round(Math.log2(f / med));
      if (Math.abs(oct) > 1 || Math.abs((f / 2 ** oct) / med - 1) > 2 * CYL_STEADY) continue;
      agree++;
      if (!byOctave.has(oct)) byOctave.set(oct, []);
      byOctave.get(oct).push(f);
    }
    if (agree < 0.8 * fs.length) return; // revs changing: lines would smear
    const main = [...byOctave.values()].sort((a, b) => b.length - a.length)[0];
    const fRef = main[main.length >> 1];

    const frame = this.dec.latest(nfft, this.buf('cf', nfft));
    const w = this.hann(nfft), x = this.buf('cx', nfft, Float64Array);
    for (let i = 0; i < nfft; i++) x[i] = frame[i] * w[i];
    const mag = rfft(x), db = this.buf('cdb', nfft / 2);
    for (let i = 0; i < nfft / 2; i++) db[i] = 20 * Math.log10(Math.max(mag[i] / nfft, 1e-12));
    const r = detectCylinders(db, this.fsDec / nfft, fRef, { candidates: this.cfg.autoCandidates });
    c.last = r;
    if (!r.n) return;
    c.votes[r.n] = (c.votes[r.n] || 0) + 1;
    const total = Object.values(c.votes).reduce((a, b) => a + b, 0);
    const [best, weight] = Object.entries(c.votes).sort((a, b) => b[1] - a[1])[0];
    const n = Number(best);
    if (n !== c.locked && weight >= CYL_LOCK.votes && weight / total >= CYL_LOCK.share) {
      c.locked = n;
      this.reset(); // rpm scale changed
    }
  }

  /** @param {Float32Array} raw full-rate samples  @param {Float32Array} [dec] low-passed, decimated by D */
  push(raw, dec) {
    this.raw.push(raw);
    if (dec) this.dec.push(dec);
  }

  /** @param {number} tEnd time (s) of the newest sample pushed */
  step(tEnd) {
    const gyro = this.cfg.gyro.enabled ? this.stepGyro(tEnd) : null;
    const pd = this.cfg.pd.enabled ? this.stepPd(tEnd) : null;
    return { gyro, pd, cyl: this.cylState() };
  }

  buf(key, n, Type = Float32Array) {
    const k = key + n;
    let b = this.bufs.get(k);
    if (!b) { b = new Type(n); this.bufs.set(k, b); }
    return b;
  }

  hann(n) {
    const key = 'hann' + n;
    let w = this.windows.get(key);
    if (!w) {
      w = new Float64Array(n);
      for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
      this.windows.set(key, w);
    }
    return w;
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
    const raw = r.valid ? rpmFromFiringHz(r.f0, this.cylinders()) * this.cfg.scale.gyro : null;
    return this.finish('gyro', raw, tEnd, N / fs / 2, t0, {
      f0: r.f0, valid: r.valid, info: r.valid ? `score ${r.score.toFixed(0)} · harmonics ${r.harmonics.join(',')}×` : '',
      ex: r.ex, binHz: fs / N, winMs: (N / fs) * 1000,
    });
  }

  stepPd(tEnd) {
    const t0 = performance.now();
    const p = this.cfg.pd, cyl = this.cylinders();
    let winS = p.maxWin, fNow = null;
    const tr = this.trackers.pd;
    if (p.adaptive && p.algo !== 'hps' && tr.x !== null) {
      fNow = firingHz(Math.max(tr.x / this.cfg.scale.pd, this.cfg.idle * 0.7), cyl);
      winS = Math.min(p.maxWin, Math.max(p.minWin, p.periods / (0.6 * fNow)));
    }
    // short windows: full-rate stream (cheap at that length, and exact for high tones)
    const full = p.algo !== 'hps' && winS <= FULL_RATE_WIN;
    const fs = full ? this.fs : this.fsDec, ring = full ? this.raw : this.dec;
    let N = Math.round(winS * fs);
    if (p.algo === 'hps') N = 2 ** Math.round(Math.log2(p.maxWin * fs)); // HPS needs a power of 2
    N = Math.min(N, ring.size);
    const frame = ring.latest(N, this.buf(full ? 'pfr' : 'pf', N));
    const { fLo, fHi } = this.band();
    const r = detectPitch(frame, { fs, algo: p.algo, fLo, fHi });
    if (r.valid) this.cyl.history.push({ t: tEnd - N / fs / 2, f: r.f0 });
    this.detectCyl(tEnd);
    const raw = r.valid ? rpmFromFiringHz(r.f0, this.cylinders()) * this.cfg.scale.pd : null;
    return this.finish('pd', raw, tEnd, N / fs / 2, t0, {
      f0: r.f0, valid: r.valid, info: r.valid ? `clarity ${r.clarity.toFixed(2)}` : '', winMs: (N / fs) * 1000,
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
