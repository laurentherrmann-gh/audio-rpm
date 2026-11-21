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
//
// One RPM: fusion.js combines the two detectors into `fused` (the higher octave when they are an
// octave apart, pitch-detection's timing).
// Gear: detectors/shifts.js finds gear shifts in the fused rpm and counts the gear from them
// (`maxGear` gears; unknown until the car has been standing).
import rfft from 'fourier-transform';
import { analyseSpectrum } from './detectors/gyroball-core.js';
import { detectPitch } from './detectors/pd-core.js';
import { detectCylinders } from './detectors/cylinders.js';
import { CarMatcher, snapshotOf, carFftSize, CAR_ID } from './detectors/car-id.js';
import { TONES, orderLevels, toneDistance } from './detectors/tones.js';
import { ShiftDetector } from './detectors/shifts.js';
import { Fusion } from './fusion.js';
import { PathTracker, PATH } from './path.js';
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
  cylinders: 4, car: 'off', maxGear: 6, autoGuess: 4,
  // lockedIsKnown: treat a count locked by auto-detection like one set by hand (firing-tone check and
  // second try on). Measured on the real clips: no gain in the combined rpm (72%), and 6 of the 73
  // right counts are lost again, so it is off. Picking the car, or recognising it, is the way.
  // firingMargin: dB by which a multiple of the detected pitch must beat it to be taken for the
  // firing tone (0 = off). Real engines: the pitch found is often the cycle or crank tone.
  // firingClear: dB by which it must also beat the pitch's multiples just above it: those are not
  // firing harmonics if the choice is right, and are if the pitch was the firing tone all along.
  // firingConfirm: s a correction must last before it is used, unless it lands where this detector
  // already was (firingKeep: for how long that counts). A short wrong one costs seconds: the
  // combined rpm takes the true reading that follows for a slip to half.
  // firingOver: dB by which a multiple that is twice an accepted one must beat it (fours and V8s: it
  // could be its second harmonic; on sixes the tone an octave below the firing tone is strong by
  // nature, so none is asked). firingSwitch: s a correction must last when the pitch as found
  // continues this detector's own track (then a louder multiple is more likely a harmonic).
  // combine: how the one rpm is made: 'path' (path.js: the smoothest path through both detectors'
  // readings) or 'rules' (fusion.js, the first way). look: s the combined rpm is read back from now
  // on that path: 0 = the best guess for this instant; a little later both detectors have spoken of
  // the moment and it is right more often (real cars: 89% at 0, 92% at 30 ms). shiftLook: the same
  // for the shift detector. gyroWeight: what gyroball's word counts for on the path, against 1 for
  // pitch-detection's.
  combine: 'path', look: 0.03, shiftLook: 0.05, gyroWeight: 0.8,
  tones: true, carKey: null, lockedIsKnown: false, firingMargin: 3, firingClear: 5, firingOver: 3, firingSwitch: 0.5, firingConfirm: 0.06, firingGap: 0.08, firingKeep: 2, firingNear: 0.25, autoCandidates: RALLY_CYLINDERS, rpmMin: 400, rpmMax: 10500, idle: 900, redline: 7500,
  scale: { gyro: 1, pd: 1 },
  // every: s between gyroball analyses. Its window is 171 ms: analysing it on every 5 ms chunk gave
  // the same lag and error as every 20 ms (measured), for four times the work
  gyro: { enabled: true, fft: 8192, tuned: true, mode: 'auto', every: 0.02 },
  // Second try, when the short window finds nothing (real engines: see stepPd). clarity: the least
  // YIN clarity it accepts (0 = no second try). cycles: its window, in engine cycles, when the
  // cylinder count is known (at most maxWinCycles s). follow: a second-try reading must lie within
  // these factors of the tracked rpm.
  pd: { enabled: true, algo: 'yin', maxWin: 0.085, adaptive: true, periods: 2.5, minWin: 0.012, cycles: 2.2, maxWinCycles: 0.13, clarity: 0.5, follow: [0.7, 1.4] },
  // confirm: a rejected new level is accepted after it persists confirmBaseMs + confirmWin × ½ window
  // (measured: the fastest rule gives the least error and the fewest glitches, once the detector
  // itself rejects smeared readings)
  // Measured on the real clips, and left as they are: tau 0.03 makes the rpm right 1 point more
  // often but costs 3 of the cylinder counts auto-detection gets right; carry (taking the rejected
  // readings' own rate of change along when re-acquiring) follows fast changes a little better but
  // overshoots after them, and shift detection loses 12 points.
  tracker: { tau: 0.05, accel: 40000, reacq: 0.25, confirmBaseMs: 15, confirmWin: 0, carry: false },
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
    this.shifts = new ShiftDetector();
    this.fusion = new Fusion();
    this.path = new PathTracker();
    this.shiftAt = -Infinity; // the last moment given to the shift detector
    this.gearCar = null;      // the recognised car the gear is being counted for
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
      tr.set({ tau: t.tau, maxAccel: t.accel, maxVel: t.accel, reacquire: t.reacq, lag: 0.01, carry: t.carry });
    }
    const c = this.cfg;
    this.shifts.set({ idle: c.idle, redline: c.redline, maxGear: c.maxGear, thresholds: c.shiftRule });
    this.path.set(c.pathRule);
    if (prev.cylinders !== c.cylinders || String(prev.autoCandidates) !== String(c.autoCandidates)) this.cyl = this.freshCyl();
    if (prev.car !== c.car) this.forgetCar();
    // another car picked (or the picker moved between a car and recognising): the gear counted so far was the other car's
    if (prev.car !== c.car || prev.carKey !== c.carKey) { this.shifts.forget(); this.gearCar = null; }
    if (prev.cylinders !== c.cylinders || prev.scale.gyro !== c.scale.gyro || prev.scale.pd !== c.scale.pd) this.reset();
  }

  /** The rpm scale changed: restart the trackers, and don't take the jump for a gear shift. */
  reset() {
    this.trackers.gyro.reset(); this.trackers.pd.reset(); this.fusion.reset(); this.path.reset(); this.shifts.clear(); this.shiftAt = -Infinity;
    this.gyroLast = null; this.gyroSpec = null; this.firing = {};
    this.scale = (this.scale || 0) + 1; // readings taken before and after are not comparable
  }

  /** Car profiles ({ sigma2, cars }, from tools/cars.js), or null for none. */
  setCars(profiles) {
    this.tones = {};
    for (const [key, c] of Object.entries(profiles?.cars || {})) if (c.tones?.length) this.tones[key] = c.tones; // a list: one map per recording
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
    // another car recognised than the one the gear was counted for: start again from "?"
    const named = this.cars.state().car;
    if (named && this.gearCar && named !== this.gearCar) this.shifts.forget();
    if (named) this.gearCar = named;
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

  /** Is the cylinder count settled: set by hand, taken from the car, or (per cfg.lockedIsKnown) locked by auto-detection? */
  countKnown() {
    return this.cfg.cylinders !== 'auto' || this.carCyl !== null || (this.cfg.lockedIsKnown && this.cyl.locked !== null);
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
    const scale = this.scale;
    this.stepCar(tEnd);
    const gyro = this.cfg.gyro.enabled ? this.stepGyro(tEnd) : null;
    const pd = this.cfg.pd.enabled ? this.stepPd(tEnd) : null;
    // if the rpm scale changed during this step (a cylinder count was just found), the two
    // readings are on different scales: nothing to combine this time
    if (this.cfg.combine !== 'path') { // the first way: rules, reading by reading (fusion.js)
      const fused = this.scale === scale ? this.fusion.step(tEnd, pd, gyro) : { rpm: null, source: '', coast: false };
      this.shifts.push(tEnd, fused.coast ? null : fused.rpm);
      return { gyro, pd, fused, cyl: this.cylState(), car: this.carState(), gear: this.shifts.state() };
    }
    // One rpm: the smoothest path through the readings (path.js). Each raw reading is filed under the
    // moment it describes (the middle of its window); gyroball's only when it is a new one, and
    // counting a little less: where the two disagree by anything but an octave, pitch-detection is
    // the one more often right (84% against 75% of the time on the real cars).
    if (this.scale === scale) {
      const made = [];
      if (pd?.raw > 0) made.push({ rpm: pd.raw, age: pd.windowDelayMs / 1000, key: 'pitch' });
      if (gyro?.raw > 0 && this.gyroLast?.t === tEnd) made.push({ rpm: gyro.raw, age: gyro.windowDelayMs / 1000, key: 'gyroball', lasts: this.cfg.gyro.every, weight: this.cfg.gyroWeight });
      this.path.push(tEnd, made);
    }
    const look = Math.max(0, Math.min(0.1, this.cfg.look)), now = this.scale === scale ? this.path.read(look) : null;
    // at: the moment the value describes (cfg.look back from now)
    const fused = now ? { rpm: now.rpm, source: now.source, coast: now.held && look > 0, at: tEnd - look } : { rpm: null, source: '', coast: false, at: tEnd - look };
    // Shifts are found on the path a little further back, where it is surer (they are reported a
    // third of a second after the fact anyway), and never ahead of the newest reading: at low revs
    // pitch-detection's reading is 65 ms old when it comes, and the detector must not go without
    // (it did, and never saw the car standing: no gear).
    if (this.scale === scale) {
      const back = Math.max(this.cfg.shiftLook, this.path.behind()), at = tEnd - back;
      if (back <= PATH.span && at > this.shiftAt) {
        const then = this.path.read(back);
        this.shiftAt = at;
        const shift = this.shifts.push(at, then && !then.held ? then.rpm : null);
        if (shift) shift.t = tEnd; // reported now
      }
    }
    return { gyro, pd, fused, cyl: this.cylState(), car: this.carState(), gear: this.shifts.state() };
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
    // between analyses: the last result, carried forward by the tracker's rate of change
    const prev = this.gyroLast;
    if (prev && tEnd - prev.t < this.cfg.gyro.every - 1e-6 && tEnd > prev.t) {
      const r = prev.res, tr = this.trackers.gyro;
      const rpm = r.rpm !== null && this.cfg.predict && !r.coast ? Math.max(0, r.rpm + tr.v * (tEnd - prev.t)) : r.rpm;
      return { ...r, rpm, computeMs: 0, ex: null };
    }
    const res = this.analyseGyro(tEnd);
    this.gyroLast = { t: tEnd, res };
    return res;
  }

  /**
   * The firing tone among the multiples of a detected pitch. On real engines the period a detector
   * finds is often the engine's cycle (two turns of the crank) or one turn, not the firing interval:
   * the pitch is then the firing tone divided by the cylinder count, or by a divisor of it. With the
   * count known, the candidates are few (pitch × a divisor of the count), and the firing tone is the
   * loudest of them in the latest spectrum, if it beats the pitch itself by `firingMargin` dB and
   * stays within the rev range.
   *
   * A pitch that already is the firing tone can have a louder second harmonic, which would pass that
   * test. What tells the two apart is the next multiple of the pitch: above a true firing tone it is
   * a weak in-between tone (`firingClear` dB down), above a second harmonic it is the third harmonic
   * and nearly as loud.
   */
  firingTone(key, f0, tEnd) {
    const N = this.cylinders(), { firingMargin: margin, firingClear: clear, firingConfirm, firingKeep } = this.cfg;
    const st = ((this.firing ??= {})[key] ??= { f: 0, at: -Infinity, pending: null });
    const known = tEnd - st.at <= firingKeep, close = (a, b) => Math.abs(a / b - 1) <= this.cfg.firingNear;
    if (!margin || !this.gyroSpec || tEnd - this.gyroSpec.t > 0.06) return f0;
    // not while the count is still being detected from the sound: that detection works on the
    // pitch as found
    if (!this.countKnown()) return f0;
    const { db, binHz } = this.gyroSpec, { fHi } = this.band();
    const level = f => {
      const a = Math.max(1, Math.floor((f * 0.985) / binHz)), b = Math.min(db.length - 1, Math.ceil((f * 1.015) / binHz));
      let m = -Infinity;
      for (let i = a; i <= b; i++) if (db[i] > m) m = db[i];
      return m;
    };
    let best = f0, top = level(f0), taken = 1;
    for (let m = 2; m <= N; m++) {
      if (N % m || f0 * m > fHi) continue;
      const l = level(f0 * m);
      // twice a multiple that was already taken could be its second harmonic: it must beat it by more
      if (l <= top + (taken === 1 ? margin : m === 2 * taken && N % 3 ? this.cfg.firingOver : 0)) continue;
      let between = -Infinity;
      for (let k = m + 1; k < 2 * m; k++) between = Math.max(between, level(f0 * k));
      if (l - between >= clear) { top = l; best = f0 * m; taken = m; }
    }
    // the car's own tone map may overrule the general rule; where it backs the answer (this rpm
    // fits the car, the pitch as found does not), there is nothing to wait for
    const mapped = this.byTones(key, f0, N, best);
    best = mapped.f;
    if (mapped.backed && best !== f0) { st.pending = null; st.f = best; st.at = tEnd; return best; }
    if (best === f0) {
      if (!known || close(f0, st.f)) { st.f = f0; st.at = tEnd; }
      return f0;
    }
    if (!(known && close(best, st.f))) {
      const p = st.pending;
      if (!p || tEnd - p.at > this.cfg.firingGap || !close(best, p.f)) st.pending = { since: tEnd, at: tEnd, f: best };
      else { p.f = best; p.at = tEnd; }
      // the pitch as found continues this detector's own track: then the louder multiple is more
      // likely a harmonic that got loud than a firing tone that was missed all along
      const onTrack = known && close(f0, st.f);
      if (tEnd - st.pending.since < (onTrack ? this.cfg.firingSwitch : firingConfirm)) {
        if (onTrack) { st.f = f0; st.at = tEnd; }
        return f0;
      }
    }
    st.pending = null; st.f = best; st.at = tEnd;
    return best;
  }

  /** The tone maps in use (one per recording of the car): the picked car's (cfg.carKey) or the recognised car's, if any were learned. */
  toneMap() {
    const key = this.cfg.car === 'auto' ? this.cars?.state().car : this.cfg.carKey;
    return (key && this.tones?.[key]) || null;
  }

  /**
   * The firing tone by the car's tone map (detectors/tones.js): each rpm the pitch could stand for
   * (the firing tone as found, a divisor of the cylinder count higher, or an octave lower) is
   * tested against what this car sounds like at that rpm. `chosen` is what the general rule made of
   * the pitch; it stands unless another rpm fits the car clearly better.
   * @returns {{ f: number, backed: boolean }} backed: the map itself says f, and not the pitch as found
   */
  byTones(key, f0, N, chosen) {
    const maps = this.toneMap();
    if (!maps || !this.cfg.tones) return { f: chosen, backed: false };
    const { db, binHz } = this.gyroSpec, scale = this.cfg.scale[key], top = this.cfg.redline * 1.15;
    const { margin, sure, fits } = { ...TONES, ...this.cfg.toneRule };
    let best = chosen, dBest = Infinity, dChosen = null, dFound = null;
    for (const m of [1, 0.5, 2, 3, 4, 5, 6, 8]) {
      if (m > 1 && (m > N || N % m)) continue;
      const rpm = rpmFromFiringHz(f0 * m, N) * scale;
      if (rpm > top || rpm < this.cfg.rpmMin) continue;
      const d = toneDistance(maps, rpm, orderLevels(db, binHz, rpm / 120, this.buf('tone', TONES.orders)));
      if (d === null) continue;
      if (m === 1) dFound = d;
      if (Math.abs((f0 * m) / chosen - 1) < 1e-6) dChosen = d;
      if (d < dBest) { dBest = d; best = f0 * m; }
    }
    // no map for the rpm the general rule chose (the car was never heard there): another rpm is
    // taken only if it fits the car as well as its own sound does
    const f = dChosen === null ? (dBest <= sure ? best : chosen) : dBest <= fits && dChosen - dBest >= margin ? best : chosen;
    const d = f === best ? dBest : dChosen;
    return { f, backed: d !== null && d <= fits && (dFound === null ? d <= sure : dFound - d >= margin) };
  }

  analyseGyro(tEnd) {
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
    this.gyroSpec = { db, binHz: fs / N, t: tEnd };
    if (r.valid) r.f0 = this.firingTone('gyro', r.f0, tEnd);
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
    let fs = full ? this.fs : this.fsDec;
    const ring = full ? this.raw : this.dec;
    let N = Math.round(winS * fs);
    if (p.algo === 'hps') N = 2 ** Math.round(Math.log2(p.maxWin * fs)); // HPS needs a power of 2
    N = Math.min(N, ring.size);
    const frame = ring.latest(N, this.buf(full ? 'pfr' : 'pf', N));
    const { fLo, fHi } = this.band();
    let r = detectPitch(frame, { fs, algo: p.algo, fLo, fHi });
    let second = false; // the reading comes from the second try below
    if (!r.valid && p.algo === 'yin' && p.clarity) {
      // Nothing in the short window. On many real engines one firing period does not repeat the last
      // one closely enough (the cylinders don't sound alike); what repeats is the whole cycle.
      const known = this.countKnown();
      if (known && p.cycles && fNow) {
        // count known: a window that holds the cycle twice, so that YIN can find the cycle itself
        // (firingTone then turns it into the firing tone). Slower, so only when the short one fails.
        const longS = Math.min(p.maxWinCycles, (p.cycles * cyl) / fNow);
        if (longS > winS) {
          const n = Math.min(Math.round(longS * this.fsDec), this.dec.size);
          const again = detectPitch(this.dec.latest(n, this.buf('pfl', n)), { fs: this.fsDec, algo: p.algo, fLo, fHi, clarity: p.clarity });
          if (again.valid) { r = again; N = n; fs = this.fsDec; second = true; }
        }
      } else if (!known) {
        // count being detected: the best period the short window has, if it is clear enough
        const again = detectPitch(frame, { fs, algo: p.algo, fLo, fHi, clarity: p.clarity });
        if (again.valid) r = again;
      }
    }
    this.detectCyl(tEnd);
    if (r.valid) r.f0 = this.firingTone('pd', r.f0, tEnd);
    let raw = r.valid ? rpmFromFiringHz(r.f0, this.cylinders()) * this.cfg.scale.pd : null;
    // A second-try reading may continue the track (through a shift too), not start a new level: in a
    // shift or a lift the firing tone fades, the cycle is all that is found, and it would read a quarter.
    if (raw !== null && second && r.clarity < 0.85 && tr.x !== null && (raw < p.follow[0] * tr.x || raw > p.follow[1] * tr.x)) { raw = null; r.valid = false; }
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
    const out = tr.step(raw, tStamp * 1000, tEnd * 1000);
    let rpm = out ? out.rpm : null;
    // the tracker's value is for the newest window centre it has seen, which is not always this
    // reading's (a long second-try window after a short one): predict from there
    const ahead = out ? Math.max(0, tEnd - tr.tLast / 1000) : tEnd - tStamp;
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
