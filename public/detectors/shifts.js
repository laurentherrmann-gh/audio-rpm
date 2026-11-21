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
  gap: 0.28,       // s left out for the shift itself: its own time, and the readings around it, which
                   //   are a mess on real sound for longer than the shift lasts. A shift is reported
                   //   as soon as the two lines fit, so a longer gap does not make the report later; it
                   //   makes the place less exact. (Real cars: 0.18 found 79%, 0.28 86%, 0.34 more false ones.)
  after: 0.2,      // s of revs after it that a line is fitted to: the report comes gap + after later
  fit: 0.025,      // log rpm: the revs may stray this far (rms) from each line…
  slope: 1.2,      // per s (log rpm): …and each line may be this steep, no steeper (in gear, not a blip)
  lift: 0.4,       // per s: revs falling faster than this on both sides of a drop: a lift, not an upshift
  kink: 0.5,       // share of the step that the two lines' difference in slope may account for
                   //   (a lift followed by throttle is a V, not a step)
  quick: 0.1,      // s within which…
  quickShare: 0.5, // …this share of the step must happen, somewhere in the gap (or the readings have a hole there)
  minChange: 0.12, // log rpm: a shift changes the revs by at least 11%…
  maxChange: 0.66, // …and at most ×1.93 (÷1.93)
  octave: 0.04,    // changes within 4% of ×2 or ÷2 are the pitch detector slipping an octave
  cover: 0.7,      // share of each stretch that must have readings, with no hole longer than `hole`
  hole: 0.08,
  apart: 0.5,      // s between two shifts at least
  standRevs: 1.6,  // standing: revs below this × the idle setting…
  standRed: 0.3,   // …or below this share of the redline, whichever is higher: most cars of the game idle
                   //   at 1,300 to 2,000 rpm, far above the default idle setting (900), and nobody sets it…
  standBand: 0.06, // …steady within ±6% of their median…
  standHold: 1,    // …for this long…
  standShare: 0.8, // …for this share of the readings (the rest are strays)…
  standGap: 0.25,  // …with no hole in them longer than this (s)
  maxGear: 6,
  memory: 1,       // s of rpm history kept
});

export class ShiftDetector {
  constructor(cfg = {}) {
    this.p = { ...SHIFT, ...cfg.thresholds }; // thresholds: for measuring other values (tools), not a setting
    this.idle = 900; this.redline = 7500; this.maxGear = this.p.maxGear;
    // The gear is counted from 1st, with the highest gear it could be (`top`) beside it. The count is
    // the lowest gear the car can be in: right from the start when the page was started before the
    // car set off (a stage begins standing), and right after the car's next pass through 1st
    // otherwise. It is sure once the car has been seen standing, or once count and top have met
    // (the car went all the way up the gearbox). It used to be unknown until the car was seen
    // standing, and on real driving that often never came: no gear at all.
    this.gear = 1; this.top = this.maxGear; this.count = 0; this.last = null;
    this.set(cfg);
    this.clear();
  }

  set({ idle, redline, maxGear, thresholds } = {}) {
    if (thresholds) this.p = { ...SHIFT, ...thresholds };
    if (idle) this.idle = idle;
    if (redline) this.redline = redline;
    if (maxGear && maxGear !== this.maxGear) {
      const sure = this.gear === this.top;
      this.maxGear = maxGear;
      this.gear = Math.min(this.gear, maxGear);
      this.top = sure ? this.gear : maxGear;
    }
  }

  /** Another car: its gear is not known until it has been seen standing. */
  forget() { this.gear = 1; this.top = this.maxGear; this.clear(); }

  /** Forget the rpm history (the rpm scale changed, or the sound stopped); the gear is kept. */
  clear() { this.hist = []; this.standAt = -Infinity; this.lastAt = -Infinity; }

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
    this.standing(t);

    // Did the revs step, `gap + after` ago? In gear they follow the car's speed: a straight line over
    // a third of a second. A shift is a break between two such lines: fit one before the gap and
    // one after it, carry both to the middle of the gap and compare.
    const from = t - p.after - p.gap, mid = from + p.gap / 2;
    if (mid < this.lastAt + p.apart) return null;
    const b = this.line(from - p.gapBefore - p.before, from - p.gapBefore, mid), a = b && this.line(t - p.after, t, mid);
    if (!a) return null;
    // Where in the gap do the revs step? A shift is quick: most of the change happens within `quick`
    // s, or the readings have a hole there. Revs that swing slowly from one line to the other (a
    // wobble on the throttle, a lift) are not a shift, however well two lines fit around them.
    const down = a.y < b.y ? -1 : 1, lo = from - p.gapBefore, hi = t - p.after;
    let at = mid, most = 0, hole = 0, holeAt = mid, i = h.length - 1;
    while (i > 0 && h[i - 1].t >= lo) i--;
    for (; i < h.length && h[i].t <= hi; i++) {
      if (i + 1 < h.length && h[i + 1].t - h[i].t > hole) { hole = h[i + 1].t - h[i].t; holeAt = (h[i + 1].t + h[i].t) / 2; }
      for (let j = i + 1; j < h.length && h[j].t <= hi && h[j].t - h[i].t <= p.quick; j++) {
        const d = down * (h[j].x - h[i].x);
        if (d > most) { most = d; at = (h[i].t + h[j].t) / 2; }
      }
    }
    if (hole > p.hole && most < p.quickShare * Math.abs(a.y - b.y)) at = holeAt;
    // both lines carried to that place
    const step = a.y - b.y + (a.slope - b.slope) * (at - mid), size = Math.abs(step);
    if (size < p.minChange || size > p.maxChange || Math.abs(size - Math.LN2) < p.octave) return null;
    if (hole <= p.hole && most < p.quickShare * size) return null;
    if (Math.max(a.fit, b.fit) > p.fit || Math.max(Math.abs(a.slope), Math.abs(b.slope)) > p.slope) return null;
    if (Math.abs(a.slope - b.slope) * (p.gapBefore + p.gap + (p.before + p.after) / 2) / 2 > p.kink * size) return null;
    // the revs falling on both sides of a drop is a lift (off the throttle: fast at first, then
    // slower), not an upshift: after an upshift the car pulls again or at least holds
    if (step < 0 && b.slope < -p.lift && a.slope < -p.lift) return null;

    this.lastAt = at;
    const dir = step < 0 ? 'up' : 'down'; // revs drop = gear up
    const by = dir === 'up' ? 1 : -1;
    this.gear = Math.max(1, Math.min(this.maxGear, this.gear + by));
    this.top = Math.max(this.gear, Math.min(this.maxGear, this.top + by));
    this.count++;
    this.last = { t, at, dir, ratio: Math.exp(step), gear: this.gear, sure: this.gear === this.top };
    return this.last;
  }

  /**
   * Steady revs near idle for a while: the car is standing, so the next gear is 1st. Judged on all
   * the readings of the last `standHold` s together (their median, and how many are near it), not
   * reading by reading: the rpm is made of raw readings, and at a real idle a stray one or a short
   * hole comes every second or so. One stray used to start the wait again, and the gear never came.
   */
  standing(t) {
    const p = this.p, h = this.hist;
    if (t - this.standAt < 0.1) return; // ten times a second is plenty
    this.standAt = t;
    const from = t - p.standHold;
    let i0 = 0;
    while (i0 < h.length && h[i0].t < from) i0++;
    const n = h.length - i0;
    if (n < 10 || h[i0].t > from + p.standGap) return; // the readings don't go back that far
    const xs = [];
    for (let i = i0; i < h.length; i++) {
      if (i > i0 && h[i].t - h[i - 1].t > p.standGap) return; // a hole: not known to be standing
      xs.push(h[i].x);
    }
    xs.sort((x, y) => x - y);
    const mid = xs[n >> 1], band = Math.log(1 + p.standBand);
    if (mid >= Math.log(Math.max(p.standRevs * this.idle, p.standRed * this.redline))) return;
    let near = 0;
    for (const x of xs) if (Math.abs(x - mid) <= band) near++;
    if (near >= p.standShare * n) this.gear = this.top = 1;
  }

  /** gear: counted from 1st; sure: false while the car could be in a higher gear than counted. */
  state() { return { gear: this.gear, sure: this.gear === this.top, shifts: this.count, last: this.last }; }
}
