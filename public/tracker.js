// Alpha-beta tracker (rpm, rpm/s) with an acceleration limit and outlier rejection,
// adapted from gyroball-rpm's filterStep (MIT, (c) 2026 berkenbu — see THIRD_PARTY.md).
//
// Differences from the original, because an engine is not a gyro ball (a ball changes speed slowly;
// an engine drops thousands of rpm in a gear shift):
//  - parameters instead of DOM reads, engine-sized defaults
//  - while readings are rejected, velocity bleeds off instead of extrapolating (no overshoot past
//    redline during a shift)
//  - re-acquire as soon as rejected readings have agreed with each other for `confirmMs` (a real
//    shift), not only after a fixed time; single-frame octave errors still get rejected. This is a
//    time, not a count: readings taken every few ms from long overlapping windows agree with each
//    other trivially, so the caller should scale confirmMs with its window length.

export class Tracker {
  constructor(opts = {}) {
    this.set(opts);
    this.reset();
  }

  set({ tau = 0.1, maxAccel = 40000, maxVel = 40000, margin = 300, lag = 0.05, coast = 0.7,
        reacquire = 0.25, confirmMs = 40, agree = 0.04 } = {}) {
    Object.assign(this, { tau, maxAccel, maxVel, margin, lag, coast, reacquire, confirmMs, agree });
  }

  reset() {
    this.x = null; this.v = 0; this.tLast = 0; this.tAccept = 0; this.rejectSince = 0;
    this.cand = null; this.candN = 0; this.candSince = 0;
  }

  /**
   * @param {number|null} z  raw rpm reading, or null when the detector has no valid reading
   * @param {number} now     ms
   * @returns {{rpm:number, coast:boolean}|null}
   */
  step(z, now) {
    const start = zz => { this.x = zz; this.v = 0; this.tLast = this.tAccept = now; this.rejectSince = 0; };

    if (this.tau <= 0) { this.x = null; return z === null ? null : { rpm: z, coast: false }; }
    if (this.x === null) {
      if (z === null) return null;
      start(z);
      return { rpm: z, coast: false };
    }

    // readings are stamped at their window centre; with an adaptive window that time can step
    // backwards slightly, which must not run the prediction in reverse
    const dt = Math.max(0, Math.min(0.2, (now - this.tLast) / 1000));
    this.tLast = Math.max(this.tLast, now);
    this.x += this.v * dt;
    const T = (now - this.tAccept) / 1000;

    if (z === null) {
      this.v *= Math.exp(-dt / 0.05); // hold, don't extrapolate through a gap
      if (T > this.coast) { this.x = null; return null; }
      return { rpm: this.x, coast: true };
    }

    const gate = this.margin + 0.5 * this.maxAccel * (T + this.lag) ** 2;
    if (Math.abs(z - this.x) > gate) {
      this.v *= Math.exp(-dt / 0.05);
      if (this.cand !== null && Math.abs(z - this.cand) <= this.agree * this.cand) this.candN++;
      else { this.candN = 1; this.candSince = now; }
      this.cand = z;
      if (!this.rejectSince) this.rejectSince = now;
      const confirmed = this.candN >= 2 && now - this.candSince >= this.confirmMs;
      if (confirmed || now - this.rejectSince > this.reacquire * 1000) {
        start(z); return { rpm: z, coast: false };
      }
      return { rpm: this.x, coast: true };
    }

    this.rejectSince = 0; this.tAccept = now; this.cand = null; this.candN = 0;
    const a = 1 - Math.exp(-dt / this.tau), b = (a * a) / (2 - a);
    const res = z - this.x;
    this.x += a * res;
    const dv = (b * res) / Math.max(dt, 1e-3);
    this.v += Math.max(-this.maxAccel * dt, Math.min(this.maxAccel * dt, dv));
    this.v = Math.max(-this.maxVel, Math.min(this.maxVel, this.v));
    return { rpm: this.x, coast: false };
  }
}
