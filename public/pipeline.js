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
//
// Car recognition (`car: 'auto'`, with profiles given to setCars): detectors/car-id.js recognises
// the car from its tone. In auto cylinder mode, a recognised car's cylinder count is used as soon
// as it is known, ahead of the count from the cycle tones (which carries on only until then).
import rfft from 'fourier-transform';
import { analyseSpectrum } from './detectors/gyroball-core.js';
import { detectPitch } from './detectors/pd-core.js';
import { detectCylinders } from './detectors/cylinders.js';
import { CarMatcher, snapshotOf, carFftSize, CAR_ID } from './detectors/car-id.js';
import { Tracker } from './tracker.js';
import { firingHz, rpmFromFiringHz, RALLY_CYLINDERS } from './engine-model.js';
import { Ring } from './ring.js';

const MAX_FFT = 32768;
const MAX_PD_WIN = 0.2;    // s, longest pitch window
const FULL_RATE_WIN = 0.025; // s: pitch windows this short read the full-rate stream
// Cylinder detection uses order tracking: the decimated audio is resampled on the tracked firing
// phase (ORD_S samples per firing cycle), so the engine looks like it runs at constant revs even
// while revving, and its cycle tones stay sharp. Up to ORD_CYCLES firing cycles, within ORD_SPAN s;
// at least 5 × the largest candidate count, so each candidate's tones are resolvable.
const ORD_S = 64, ORD_CYCLES = 64, ORD_SPAN = 1.4, ORD_GAP = 0.03;
const CYL_EVERY = 0.1;     // s between detection attempts
const CYL_TAU = 4;         // s, how long a vote counts
const CYL_LOCK = { votes: 3, share: 0.6 };
// RPM gating: a cylinder count is impossible if it makes the sustained revs exceed rpmMax (or
// idle fall below rpmMin). "Sustained" = held for REVS_HOLD s, so a brief octave slip can't veto the
// right count. Remembered revs fade over REVS_MEMORY s (another car can be driven next).
const REVS_HOLD = 0.5, REVS_MEMORY = 120;

export const DEFAULTS = Object.freeze({
  cylinders: 4, car: 'off', autoGuess: 4, autoCandidates: RALLY_CYLINDERS, rpmMin: 400, rpmMax: 10500, idle: 900, redline: 7500,
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
    this.dec = new Ring(Math.ceil(Math.max(MAX_PD_WIN, ORD_SPAN + 0.3) * this.fsDec));
    this.cyl = this.freshCyl();
    this.cars = null;   // CarMatcher, once profiles are given
    this.carCyl = null; // cylinder count of the recognised car
    this.carEval = -Infinity;
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
    if (prev.car !== c.car) this.forgetCar();
    if (prev.cylinders !== c.cylinders || prev.scale.gyro !== c.scale.gyro || prev.scale.pd !== c.scale.pd) this.reset();
  }

  reset() { this.trackers.gyro.reset(); this.trackers.pd.reset(); }

  /** Car profiles ({ sigma2, cars }, from tools/cars.js), or null for none. */
  setCars(profiles) {
    this.cars = profiles && Object.keys(profiles.cars || {}).length ? new CarMatcher(profiles) : null;
    this.forgetCar();
  }

  forgetCar() {
    this.cars?.reset();
    if (this.carCyl !== null) { this.carCyl = null; if (this.cfg.cylinders === 'auto') this.reset(); }
  }

  /** Recognise the car from the latest sound (every CAR_ID.every s). */
  stepCar(tEnd) {
    if (!this.cars || this.cfg.car !== 'auto' || tEnd - this.carEval < CAR_ID.every) return;
    this.carEval = tEnd;
    const N = carFftSize(this.fs);
    this.cars.push(tEnd, snapshotOf(this.raw.latest(N, this.buf('cf', N)), this.fs));
    const n = this.cars.cylinders;
    if (n !== this.carCyl) {
      this.carCyl = n;
      if (this.cfg.cylinders === 'auto') { this.cyl = this.freshCyl(); this.reset(); } // rpm scale changed
    }
  }

  /** For the page: recognition off / no profiles (null), or what it hears. */
  carState() {
    if (!this.cars || this.cfg.car !== 'auto') return null;
    return this.cars.state();
  }

  freshCyl() {
    return { votes: {}, locked: null, lastEval: -Infinity, lastDecay: null, last: null,
      revs: { win: [], fHigh: 0, fLow: 0, t: null, track: [] }, provisional: null, excluded: new Set() };
  }

  /**
   * Is N cylinders compatible with the sustained revs seen so far (rpmMin … rpmMax)?
   * With hysteresis: a ruled-out count only returns once the revs fall 10% inside the limit,
   * so a remembered peak hovering at the limit can't flip the count back and forth.
   */
  plausible(N) {
    const { fHigh, fLow } = this.cyl.revs, ex = this.cyl.excluded;
    const high = fHigh ? (120 * fHigh) / N : 0, low = fLow ? (120 * fLow) / N : Infinity;
    const out = high > this.cfg.rpmMax || low < this.cfg.rpmMin;
    const backIn = high < 0.9 * this.cfg.rpmMax && low > 1.1 * this.cfg.rpmMin;
    if (out) ex.add(N); else if (backIn) ex.delete(N);
    return !ex.has(N);
  }

  /** Auto mode: candidates still possible given the revs. */
  candidates() {
    const all = this.cfg.autoCandidates, ok = all.filter(N => this.plausible(N));
    return ok.length ? ok : [all[all.length - 1]];
  }

  /** Cylinder count used for the rpm conversion right now. */
  cylinders() {
    const c = this.cfg.cylinders;
    if (c !== 'auto') return c;
    if (this.carCyl !== null) return this.carCyl; // the recognised car's count
    if (this.cyl.locked !== null) return this.cyl.locked;
    return Math.max(this.cfg.autoGuess, this.candidates()[0]); // smallest still-plausible count
  }

  /** Record the tracked firing frequency; update the sustained high / low used by the gating. */
  noteRevs(t, f) {
    const r = this.cyl.revs;
    if (r.t !== null) {
      const k = Math.exp(-(t - r.t) / REVS_MEMORY);
      r.fHigh *= k;
      if (r.fLow) r.fLow /= k;
    }
    r.t = t;
    r.track.push({ t, f });
    while (r.track.length && r.track[0].t < t - ORD_SPAN - 0.2) r.track.shift();
    r.win.push({ t, f });
    while (r.win.length && r.win[0].t < t - REVS_HOLD) r.win.shift();
    if (r.win.length < 10 || r.win[0].t > t - REVS_HOLD * 0.9) return;
    let lo = Infinity, hi = 0;
    for (const x of r.win) { lo = Math.min(lo, x.f); hi = Math.max(hi, x.f); }
    r.fHigh = Math.max(r.fHigh, lo);             // held at least this high for REVS_HOLD
    r.fLow = r.fLow ? Math.min(r.fLow, hi) : hi; // held at most this low for REVS_HOLD
  }

  band() {
    const { idle, redline, cylinders } = this.cfg;
    if (cylinders === 'auto' && this.carCyl === null) {
      // every still-plausible engine, even once a count is locked: a wrong lock must not narrow the
      // search so far that the tone proving it wrong (via the rpm gating) is never heard
      const cands = this.candidates();
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
      fromCar: this.cfg.cylinders === 'auto' && this.carCyl !== null,
      candidate: best ? Number(best[0]) : null, confidence: best && total ? best[1] / total : 0,
      possible: this.cfg.cylinders === 'auto' ? this.candidates() : null,
    };
  }

  /**
   * Order spectrum of the latest stretch of audio: resample it on the tracked firing phase, so the
   * firing tone sits at order 1 and an N-cylinder engine's cycle tones at k/N, whatever the revs did.
   * Returns detectCylinders' result, or null when the tracking doesn't cover enough cycles.
   */
  orderSpectrumCylinders(tNow) {
    const track = this.cyl.revs.track;
    if (track.length < 20) return null;
    // contiguous stretch of tracked firing frequency ending now (no gaps: a gap means a rejected
    // reading or a gear shift, where the phase can't be followed)
    let i0 = track.length - 1;
    const tLast = track[i0].t;
    while (i0 > 0 && track[i0].t - track[i0 - 1].t < ORD_GAP && tLast - track[i0 - 1].t <= ORD_SPAN) i0--;
    const seg = track.slice(i0);
    if (seg.length < 20 || tLast > tNow) return null;
    // firing phase (in cycles) at each tracked point
    const P = new Float64Array(seg.length);
    for (let j = 1; j < seg.length; j++) P[j] = P[j - 1] + (seg[j].t - seg[j - 1].t) * (seg[j].f + seg[j - 1].f) / 2;
    const cands = this.candidates();
    const M = Math.min(ORD_CYCLES, Math.floor(P[P.length - 1]));
    if (M < 5 * Math.max(...cands)) return null;
    // audio covering the stretch; sample i of `frame` is at time tNow − (len − 1 − i) / fsDec
    const fsd = this.fsDec, len = Math.ceil((tNow - seg[0].t) * fsd) + 2;
    if (len > this.dec.size) return null;
    const frame = this.dec.latest(len, this.buf('of', len));
    const n = M * ORD_S, L = 2 ** Math.ceil(Math.log2(n));
    const x = this.buf('ox', L, Float64Array);
    x.fill(0);
    const w = this.hann(n), phi0 = P[P.length - 1] - M;
    let j = 0;
    for (let k = 0; k < n; k++) {
      const phi = phi0 + (k + 0.5) / ORD_S;
      while (j < P.length - 2 && P[j + 1] < phi) j++;
      const t = seg[j].t + ((phi - P[j]) / (P[j + 1] - P[j])) * (seg[j + 1].t - seg[j].t);
      const pos = len - 1 - (tNow - t) * fsd, i = Math.floor(pos), u = pos - i;
      const v = i >= 0 && i + 1 < len ? frame[i] * (1 - u) + frame[i + 1] * u : 0;
      x[k] = v * w[k];
    }
    const mag = rfft(x), db = this.buf('odb', L / 2);
    for (let i = 0; i < L / 2; i++) db[i] = 20 * Math.log10(Math.max(mag[i] / n, 1e-12));
    // in this spectrum the unit is "orders of the firing frequency": firing = 1, bin = ORD_S / L
    return detectCylinders(db, ORD_S / L, 1, { candidates: cands, minHz: 0.08 });
  }

  /** Auto mode: count cylinders from the order spectrum (works while revving, not only at idle). */
  detectCyl(t) {
    const c = this.cyl;
    if (this.cfg.cylinders !== 'auto' || this.carCyl !== null) return;
    // gating veto: a locked count that implies impossible revs is dropped
    if (c.locked !== null && !this.plausible(c.locked)) {
      delete c.votes[c.locked];
      c.locked = null;
      this.reset();
    }
    // the provisional count follows the gating; its rpm scale changes, so restart the trackers
    const prov = c.locked === null ? this.cylinders() : null;
    if (prov !== c.provisional) { if (c.provisional !== null && prov !== null) this.reset(); c.provisional = prov; }
    if (t - c.lastEval < CYL_EVERY) return;
    c.lastEval = t;
    if (c.lastDecay !== null) {
      const k = Math.exp(-(t - c.lastDecay) / CYL_TAU);
      for (const n in c.votes) c.votes[n] *= k;
    }
    c.lastDecay = t;
    const r = this.orderSpectrumCylinders(t);
    if (!r) return;
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
    this.stepCar(tEnd);
    const gyro = this.cfg.gyro.enabled ? this.stepGyro(tEnd) : null;
    const pd = this.cfg.pd.enabled ? this.stepPd(tEnd) : null;
    return { gyro, pd, cyl: this.cylState(), car: this.carState() };
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
    this.detectCyl(tEnd);
    const raw = r.valid ? rpmFromFiringHz(r.f0, this.cylinders()) * this.cfg.scale.pd : null;
    const res = this.finish('pd', raw, tEnd, N / fs / 2, t0, {
      f0: r.f0, valid: r.valid, info: r.valid ? `clarity ${r.clarity.toFixed(2)}` : '', winMs: (N / fs) * 1000,
    });
    if (this.cfg.cylinders === 'auto' && tr.x !== null && !res.coast) {
      this.noteRevs(tEnd - N / fs / 2, firingHz(tr.x / this.cfg.scale.pd, this.cylinders()));
    }
    return res;
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
