// One RPM from the detectors' readings: the smoothest path through them.
//
// The rules in fusion.js decide reading by reading. What the offline reference does better is to
// look at the readings as a whole and take the path that fits them with the fewest jumps. This is
// that idea made to run live:
//  - a reading describes the middle of its analysis window, a moment 10 to 85 ms in the past. It is
//    filed under that moment, not under "now", so pitch-detection's and gyroball's readings of the
//    same moment meet, however late each arrives;
//  - on a grid of rpm values (log scale), each moment has a cost per value: nothing at a reading, a
//    little at twice, four times or half a reading (a detector on a neighbouring tone of the
//    engine), capped far from all of them. The detectors' costs add up, so where one reads half of
//    the other the higher value is the cheaper (a slip is downward far more often than upward).
//    Moving from one moment to the next costs by how far the rpm moves; a jump anywhere costs a
//    fixed price, more than a stray reading or two can pay for;
//  - the cheapest path so far is kept up to date (Viterbi); the last tenth of a second is re-done at
//    every step, since readings for it are still arriving.
// read(look) gives the path `look` seconds back. At 0 it is the best guess for now, made from
// readings that are 10–85 ms old; a little further back it has both detectors' word and is right
// more often (measured on the 80 real cars: 89% at 0, 92% at 30 ms, against 86% for the rules).
export const PATH = Object.freeze({
  dt: 0.005,      // s between moments on the path
  perOctave: 48,  // rpm values per octave (1.45% apart)
  lo: 400, hi: 11000, // rpm range of the grid
  width: 1,       // grid steps: how close to a reading counts as on it
  cap: 5,         // cost of being far from every reading
  // A detector also stands for the tones it slips between, at a small cost per moment. The costs are
  // small against `jump` on purpose: the path then stays where it was through a slip of a tenth of a
  // second, and only moves to the other octave when the detectors stay there.
  twice: 0.1,     // sitting at twice a reading (the detector has slipped to half: the common slip)
  quarter: 0.2,   // …at four times a reading (to a quarter: pitch-detection on a rough engine at high revs)
  half: 0.3,      // …at half a reading (the detector sits on a harmonic: rarer)
  ease: 2.2,      // grid steps the rpm may move per moment at a cost of 1 (quadratic)
  reach: 8,       // …and at most this many without paying for a jump
  jump: 10,       // cost of a jump to anywhere (two moments of one detector reading something else do not pay for it)
  span: 0.11,     // s of path re-done as late readings arrive (the oldest reading: gyroball's, 85 ms)
  slopeSpan: 0.06, // s of path before the newest reading that its rate of change is measured over…
  carry: 0.5,     // …and the share of it carried on over the moments no reading speaks of yet
  coast: 0.3,     // s the last value is held when no reading comes
});

const BINS = Math.ceil(Math.log2(PATH.hi / PATH.lo) * PATH.perOctave) + 1;
const binOf = rpm => Math.log2(rpm / PATH.lo) * PATH.perOctave;
const rpmOf = bin => PATH.lo * 2 ** (bin / PATH.perOctave);

export class PathTracker {
  constructor(rule) {
    this.set(rule);
    this.M = Math.ceil(PATH.span / PATH.dt);
    // one slot per moment, reused in a ring: its readings, the cost of the best path to each value, where that path came from
    this.slots = Array.from({ length: this.M + 1 }, () => ({ k: -1, rpm: [], key: [], w: [], V: new Float32Array(BINS), back: new Int16Array(BINS) }));
    this.e = new Float32Array(BINS);
    this.one = new Float32Array(BINS);
    this.trail = new Int16Array(this.M + 1);
    this.zero = new Float32Array(BINS);
    this.reset();
  }

  /** Other costs than PATH's, for measuring (tools); the grid itself is fixed. */
  set(rule) {
    this.p = { ...PATH, ...rule };
    this.near = [[1, 0], [2, this.p.twice], [0.5, this.p.half]];
    if (this.p.quarter < this.p.cap) this.near.push([4, this.p.quarter]);
  }

  reset() {
    for (const s of this.slots) { s.k = -1; s.rpm.length = 0; s.key.length = 0; s.w.length = 0; }
    this.t = null;        // time of the last push
    this.k = null;        // newest moment
    this.informed = -Infinity; // newest moment a reading speaks of
  }

  slot(k) { return this.slots[((k % (this.M + 1)) + this.M + 1) % (this.M + 1)]; }

  /** Make the slot of moment k ready: empty if it held an older moment. */
  open(k) {
    const s = this.slot(k);
    if (s.k !== k) { s.k = k; s.rpm.length = 0; s.key.length = 0; s.w.length = 0; }
    return s;
  }

  /** Best path to every value at moment k, from moment k − 1. */
  forward(k) {
    const s = this.slot(k), prev = this.slot(k - 1), Vp = prev.k === k - 1 ? prev.V : this.zero, V = s.V, back = s.back, e = this.e;
    const { width, cap, ease, reach, jump } = this.p;
    // each detector that speaks of this moment has its say, and the costs add up: where pitch reads
    // half of what gyroball reads, the higher value costs little (pitch has slipped: `twice`) and the
    // lower one more (gyroball on a harmonic: `half`), so the higher octave wins, as the rules had it
    e.fill(0);
    for (let n = 0; n < s.rpm.length; n++) {
      if (s.key.indexOf(s.key[n]) !== n) continue; // this detector is done
      const one = this.one;
      one.fill(cap);
      for (let i = n; i < s.rpm.length; i++) {
        if (s.key[i] !== s.key[n]) continue;
        for (const [m, extra] of this.near) {
          const x = binOf(s.rpm[i] * m);
          if (x < 0 || x > BINS - 1) continue;
          for (let b = Math.max(0, Math.floor(x - 3)); b <= Math.min(BINS - 1, Math.ceil(x + 3)); b++) {
            const v = extra + Math.min(cap, ((b - x) / width) ** 2);
            if (v < one[b]) one[b] = v;
          }
        }
      }
      const w = s.w[n];
      for (let b = 0; b < BINS; b++) e[b] += w * one[b];
    }
    let low = Infinity, lowAt = 0;
    for (let b = 0; b < BINS; b++) if (Vp[b] < low) { low = Vp[b]; lowAt = b; }
    let min = Infinity;
    for (let b = 0; b < BINS; b++) {
      let best = low + jump, from = lowAt;
      const a = Math.max(0, b - reach), z = Math.min(BINS - 1, b + reach);
      for (let q = a; q <= z; q++) { const d = (b - q) / ease, v = Vp[q] + d * d; if (v < best) { best = v; from = q; } }
      V[b] = best + e[b]; back[b] = from;
      if (V[b] < min) min = V[b];
    }
    for (let b = 0; b < BINS; b++) V[b] -= min; // keep the numbers small
  }

  /**
   * @param {number} t now, s
   * @param {{ rpm:number, age:number, key:string, lasts?:number, weight?:number }[]} readings made
   *   now. age: how far back (s) the moment each describes. lasts: s between this detector's readings
   *   (default: the time since the last push); the reading speaks for all the moments in between, so
   *   that no moment goes without it and a detector that reads less often does not count for less.
   *   weight: how much this detector's word counts against the others' (default 1).
   */
  push(t, readings) {
    const k = Math.round(t / PATH.dt), M = this.M, since = this.t === null ? PATH.dt : Math.min(0.03, Math.max(PATH.dt, t - this.t));
    this.t = t;
    if (this.k === null || k - this.k > M || k < this.k) { this.reset(); this.t = t; this.k = k - 1; }
    let first = this.k + 1;
    for (let i = this.k + 1; i <= k; i++) this.open(i);
    for (const r of readings) {
      if (!(r.rpm > 0)) continue;
      const at = k - Math.round(r.age / PATH.dt), n = Math.max(1, Math.ceil((r.lasts ?? since) / PATH.dt - 0.01));
      for (let i = at; i > at - n; i--) {
        const s = this.slot(i);
        if (i < k - M + 1 || s.k !== i) break; // too old to re-do, or before this tracker's time
        s.rpm.push(r.rpm); s.key.push(r.key); s.w.push(r.weight ?? 1);
        if (i < first) first = i;
        if (i > this.informed) this.informed = i;
      }
    }
    for (let i = first; i <= k; i++) this.forward(i);
    this.k = k;
    // the best path so far, from now back
    const V = this.slot(k).V, trail = this.trail;
    let b = 0;
    for (let q = 1; q < BINS; q++) if (V[q] < V[b]) b = q;
    trail[0] = b;
    for (let j = 1; j <= M; j++) { const s = this.slot(k - j + 1); trail[j] = s.k === k - j + 1 ? s.back[trail[j - 1]] : trail[j - 1]; }
  }

  /** The value of the path j moments back: the reading it runs through there, else the grid value. */
  valueAt(j) {
    const s = this.slot(this.k - j), bin = this.trail[j];
    let rpm = rpmOf(bin), key = '', best = 1.3;
    if (s.k === this.k - j) {
      for (let i = 0; i < s.rpm.length; i++) {
        for (const [m] of this.near) { const d = Math.abs(binOf(s.rpm[i] * m) - bin); if (d < best) { best = d; rpm = s.rpm[i] * m; key = m === 1 ? s.key[i] : `${s.key[i]} ${m > 1 ? `×${m}` : '÷2'}`; } }
      }
    }
    return { rpm, key };
  }

  /**
   * The rpm `look` seconds ago (0 = now), on the best path so far.
   * @returns {{ rpm:number, source:string, held:boolean }|null} held: no reading speaks of that moment
   *   (yet, or any more); null once nothing has been heard for PATH.coast s.
   */
  read(look = 0) {
    if (this.k === null || !Number.isFinite(this.informed)) return null;
    const j = Math.min(this.M, Math.max(0, Math.round(look / PATH.dt))), newest = this.k - this.informed; // moments back
    if ((newest - j) * PATH.dt > PATH.coast) return null;
    if (j >= newest) {
      // held: no reading speaks of that moment or of the 20 ms either side (the path runs on by itself there)
      const v = this.valueAt(j);
      let heard = false;
      for (let i = Math.max(newest, j - 4); i <= Math.min(this.M, j + 4) && !heard; i++) { const s = this.slot(this.k - i); heard = s.k === this.k - i && s.rpm.length > 0; }
      return { rpm: v.rpm, source: v.key || 'path', held: !heard };
    }
    // no reading speaks of that moment yet: the newest one that does, carried on by part of the path's slope there
    if (newest > this.M) return { rpm: rpmOf(this.trail[j]), source: 'held', held: true };
    const v = this.valueAt(newest), far = Math.min(this.M, newest + Math.round(PATH.slopeSpan / PATH.dt));
    const slope = far > newest ? (this.trail[newest] - this.trail[far]) / (far - newest) : 0; // grid steps per moment
    return { rpm: v.rpm * 2 ** ((Math.max(-2.5, Math.min(2.5, slope)) * (newest - j) * PATH.carry) / PATH.perOctave), source: v.key || 'path', held: true };
  }
}
