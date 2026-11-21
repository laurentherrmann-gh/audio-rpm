// Gear shifts and gear, from the rpm alone.
//
// In gear, the revs follow the car's speed: over a third of a second they are a straight line (in
// log rpm). A shift is a break between two such lines: the revs drop (upshift) or jump (downshift)
// by a gearbox ratio. So the detector fits a line to the revs before a short gap and one after it,
// and reports a shift when the two, carried to the middle of the gap, differ by a gear's worth.
// A lift, a rev blip or a launch does not fit: its lines are too steep, or bend into a V.
//
// The first version looked for a fast, short change of the rpm itself. That works on the simulator;
// on real sound the rpm has glitches and holes that look just like that, and it reported some twenty
// shifts per 40 s clip, a third of the judged ones false. Measured on the 80 real cars (npm run
// eval-shifts), the line fit finds as many of the real shifts with a fifth of the false ones,
// 0.09 s later.
//
// The rpm alone doesn't say which gear: the gear is counted from the shifts, starting from 1st
// whenever the car has clearly been standing (steady revs near idle). Until then it is unknown. The drop
// of each shift is reported (`ratio`), since every pair of gears has its own.
export const SHIFT = Object.freeze({
  before: 0.3,     // s of revs before the shift that a line is fitted to
  gapBefore: 0.03, // s left out just before it
  gap: 0.18,       // s left out for the shift itself (its own time, and the detector catching up)
  after: 0.2,      // s of revs after it that a line is fitted to: the report comes gap + after later
  fit: 0.025,      // log rpm: the revs may stray this far (rms) from each line…
  slope: 1.2,      // per s (log rpm): …and each line may be this steep, no steeper (in gear, not a blip)
  lift: 0.4,       // per s: revs falling faster than this on both sides of a drop: a lift, not an upshift
  kink: 0.5,       // share of the step that the two lines' difference in slope may account for
                   //   (a lift followed by throttle is a V, not a step)
  minChange: 0.12, // log rpm: a shift changes the revs by at least 11%…
  maxChange: 0.66, // …and at most ×1.93 (÷1.93)
  octave: 0.04,    // changes within 4% of ×2 or ÷2 are the pitch detector slipping an octave
  cover: 0.7,      // share of each stretch that must have readings, with no hole longer than `hole`
  hole: 0.08,
  apart: 0.5,      // s between two shifts at least
  standRevs: 1.6,  // standing = revs below this many times the idle setting…
  standBand: 0.06, // …steady within ±6%…
  standHold: 1,    // …for this long
  maxGear: 6,
  memory: 1,       // s of rpm history kept
});

export class ShiftDetector {
  constructor(cfg = {}) {
    this.p = { ...SHIFT, ...cfg.thresholds }; // thresholds: for measuring other values (tools), not a setting
    this.idle = 900; this.redline = 7500; this.maxGear = this.p.maxGear;
    this.gear = null; this.count = 0; this.last = null;
    this.set(cfg);
    this.clear();
  }

  set({ idle, redline, maxGear } = {}) {
    if (idle) this.idle = idle;
    if (redline) this.redline = redline;
    if (maxGear) this.maxGear = maxGear;
  }

  /** Forget the rpm history (the rpm scale changed, or the sound stopped); the gear is kept. */
  clear() { this.hist = []; this.stand = null; this.lastAt = -Infinity; }

  /** Line through the history between a and b s: value at `at`, slope per s, rms misfit; null without enough readings. */
  line(a, b, at) {
    const h = this.hist, p = this.p;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, first = null, prev = null, hole = 0, i0 = -1;
    for (let i = h.length - 1; i >= 0 && h[i].t >= a; i--) {
      if (h[i].t > b) continue;
      const x = h[i].t - at, y = h[i].x;
      n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
      if (prev !== null) hole = Math.max(hole, prev - h[i].t);
      first ??= h[i].t; prev = h[i].t; i0 = i;
    }
    if (n < 5 || first - prev < p.cover * (b - a) || hole > p.hole) return null;
    const den = n * sxx - sx * sx, slope = den ? (n * sxy - sx * sy) / den : 0, y0 = (sy - slope * sx) / n;
    let e = 0;
    for (let i = i0; i < h.length && h[i].t <= b; i++) e += (h[i].x - y0 - slope * (h[i].t - at)) ** 2;
    return { y: y0, slope, fit: Math.sqrt(e / n) };
  }

  /**
   * @param {number} t seconds  @param {number|null} rpm tracked rpm, null when there is no reading
   * @returns {{ t:number, at:number, dir:'up'|'down', ratio:number, gear:number|null }|null} a shift, when one is confirmed
   */
  push(t, rpm) {
    if (!(rpm > 0)) return null;
    const p = this.p, h = this.hist;
    h.push({ t, x: Math.log(rpm) });
    while (h.length && h[0].t < t - p.memory) h.shift();
    this.standing(t, rpm);

    // Did the revs step, `gap + after` ago? In gear they follow the car's speed: a straight line over
    // a third of a second. A shift is a break between two such lines: fit one before the gap and
    // one after it, carry both to the middle of the gap and compare.
    const from = t - p.after - p.gap, mid = from + p.gap / 2;
    if (mid < this.lastAt + p.apart) return null;
    const b = this.line(from - p.gapBefore - p.before, from - p.gapBefore, mid), a = b && this.line(t - p.after, t, mid);
    if (!a) return null;
    const step = a.y - b.y, size = Math.abs(step);
    if (size < p.minChange || size > p.maxChange || Math.abs(size - Math.LN2) < p.octave) return null;
    if (Math.max(a.fit, b.fit) > p.fit || Math.max(Math.abs(a.slope), Math.abs(b.slope)) > p.slope) return null;
    if (Math.abs(a.slope - b.slope) * (p.gapBefore + p.gap + (p.before + p.after) / 2) / 2 > p.kink * size) return null;
    // the revs falling on both sides of a drop is a lift (off the throttle: fast at first, then
    // slower), not an upshift: after an upshift the car pulls again or at least holds
    if (step < 0 && b.slope < -p.lift && a.slope < -p.lift) return null;

    this.lastAt = mid;
    const dir = step < 0 ? 'up' : 'down'; // revs drop = gear up
    if (this.gear !== null) this.gear = Math.max(1, Math.min(this.maxGear, this.gear + (dir === 'up' ? 1 : -1)));
    this.count++;
    this.last = { t, at: mid, dir, ratio: Math.exp(step), gear: this.gear };
    return this.last;
  }

  /** Steady revs near idle for a while: the car is standing, so the next gear is 1st. */
  standing(t, rpm) {
    const low = rpm < this.p.standRevs * this.idle;
    const st = this.stand;
    if (!low || (st && Math.abs(rpm / st.rpm - 1) > this.p.standBand)) { this.stand = low ? { t, rpm } : null; return; }
    if (!st) { this.stand = { t, rpm }; return; }
    if (t - st.t >= this.p.standHold) this.gear = 1;
  }

  state() { return { gear: this.gear, shifts: this.count, last: this.last }; }
}
