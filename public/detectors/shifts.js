// Gear shifts and gear, from the rpm alone.
//
// In gear, the revs follow the car's speed and change gradually. A shift is a step: the revs drop
// (upshift) or jump (downshift) by a gearbox ratio within a fraction of a second, then go back to
// changing gradually. So a shift is detected as a fast, short, bounded change of log(rpm) between
// two calm stretches. A lift or a launch is fast too, but lasts longer or changes the revs more.
//
// The rpm alone doesn't say which gear: the gear is counted from the shifts, starting from 1st
// whenever the car has clearly been standing (steady revs near idle). Until then it is unknown. The drop
// of each shift is reported (`ratio`), since every pair of gears has its own.
export const SHIFT = Object.freeze({
  slopeWin: 0.06,  // s over which the rate of change is measured
  fast: 1.2,       // per s (of log rpm): faster than this is not the car accelerating in gear
  slow: 0.6,       // per s: slower than this, the step is over
  maxStep: 0.3,    // s: a shift's change lasts at most this
  minChange: 0.1,  // log rpm: a shift changes the revs by at least 10%…
  maxChange: 0.66, // …and at most ×1.93 (÷1.93)
  octave: 0.04,    // changes within 4% of ×2 or ÷2 are the pitch detector slipping an octave
  calm: 0.12,      // s before the step in which the revs must not already be changing fast
  hold: 0.08,      // s the revs must then stop moving that way
  holdDrift: 0.05, // log rpm they may still move in that time
  standRevs: 1.6,  // standing = revs below this many times the idle setting…
  standBand: 0.06, // …steady within ±6%…
  standHold: 1,    // …for this long
  maxGear: 6,
  memory: 1,       // s of rpm history kept
});

export class ShiftDetector {
  constructor(cfg = {}) {
    this.idle = 900; this.redline = 7500; this.maxGear = SHIFT.maxGear;
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
  clear() { this.hist = []; this.move = null; this.pending = null; this.blocked = false; this.stand = null; }

  /**
   * @param {number} t seconds  @param {number|null} rpm tracked rpm, null when there is no reading
   * @returns {{ t:number, at:number, dir:'up'|'down', ratio:number, gear:number|null }|null} a shift, when one is confirmed
   */
  push(t, rpm) {
    if (!(rpm > 0)) return null;
    const x = Math.log(rpm), h = this.hist;
    h.push({ t, x });
    while (h.length && h[0].t < t - SHIFT.memory) h.shift();
    this.standing(t, rpm);

    // rate of change over the last slopeWin
    let ref = null;
    for (let i = h.length - 2; i >= 0; i--) if (h[i].t <= t - SHIFT.slopeWin) { ref = h[i]; break; }
    if (!ref || t - ref.t > SHIFT.maxStep) { this.move = null; return this.confirm(t, x); }
    const s = (x - ref.x) / (t - ref.t), dir = Math.sign(s);

    if (this.blocked && Math.abs(s) < SHIFT.slow) this.blocked = false;
    if (!this.move) {
      if (!this.blocked && Math.abs(s) >= SHIFT.fast) {
        // a shift starts from calm revs; a fast change already under way is a lift, a launch or a stop
        let before = null;
        for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= ref.t - SHIFT.calm) { before = h[i]; break; }
        if (before && Math.abs((ref.x - before.x) / (ref.t - before.t)) >= SHIFT.fast) this.blocked = true;
        else this.move = { dir, t0: ref.t, x0: ref.x };
      }
    } else if (dir === this.move.dir && Math.abs(s) >= SHIFT.slow) {
      if (t - this.move.t0 > SHIFT.maxStep + SHIFT.slopeWin) { this.move = null; this.blocked = true; } // a lift or a launch, not a shift
    } else {
      const m = this.move, change = x - m.x0, size = Math.abs(change);
      this.move = null;
      const octave = Math.abs(size - Math.LN2) < SHIFT.octave;
      if (size >= SHIFT.minChange && size <= SHIFT.maxChange && !octave) this.pending = { dir: m.dir, at: m.t0, tEnd: t, xEnd: x, ratio: Math.exp(change) };
    }
    return this.confirm(t, x);
  }

  confirm(t, x) {
    const p = this.pending;
    if (!p) return null;
    if (p.dir * (x - p.xEnd) > SHIFT.holdDrift) { this.pending = null; return null; } // still going: not a step
    if (t - p.tEnd < SHIFT.hold) return null;
    this.pending = null;
    const dir = p.dir < 0 ? 'up' : 'down'; // revs drop = gear up
    if (this.gear !== null) this.gear = Math.max(1, Math.min(this.maxGear, this.gear + (dir === 'up' ? 1 : -1)));
    this.count++;
    this.last = { t, at: p.at, dir, ratio: p.ratio, gear: this.gear };
    return this.last;
  }

  /** Steady revs near idle for a while: the car is standing, so the next gear is 1st. */
  standing(t, rpm) {
    const low = rpm < SHIFT.standRevs * this.idle;
    const st = this.stand;
    if (!low || (st && Math.abs(rpm / st.rpm - 1) > SHIFT.standBand)) { this.stand = low ? { t, rpm } : null; return; }
    if (!st) { this.stand = { t, rpm }; return; }
    if (t - st.t >= SHIFT.standHold) this.gear = 1;
  }

  state() { return { gear: this.gear, shifts: this.count, last: this.last }; }
}
