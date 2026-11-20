// Alpha-beta tracker (rpm, rpm/s) with an acceleration limit and outlier rejection,
// adapted from gyroball-rpm's filterStep (MIT, (c) 2026 berkenbu — see THIRD_PARTY.md).
//
// Differences from the original, because an engine is not a gyro ball (a ball changes speed slowly;
// an engine drops thousands of rpm in a gear shift):
//  - parameters instead of DOM reads, engine-sized defaults
//  - while readings are rejected, velocity bleeds off instead of extrapolating (no overshoot past
//    redline during a shift)
//  - re-acquire as soon as `confirm` consecutive rejected readings agree with each other
//    (a real shift), not only after a fixed time; single-frame octave errors still get rejected

export class Tracker {
  constructor(opts = {}) {
    this.set(opts);
    this.reset();
  }

  set({ tau = 0.1, maxAccel = 40000, maxVel = 40000, margin = 300, lag = 0.05, coast = 0.7,
        reacquire = 0.25, confirm = 3, agree = 0.04 } = {}) {
    Object.assign(this, { tau, maxAccel, maxVel, margin, lag, coast, reacquire, confirm, agree });
  }

  reset() {
    this.x = null; this.v = 0; this.tLast = 0; this.tAccept = 0; this.rejectSince = 0;
    this.cand = null; this.candN = 0;
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

    const dt = Math.min(0.2, (now - this.tLast) / 1000);
    this.tLast = now;
    this.x += this.v * dt;
    const T = (now - this.tAccept) / 1000;

    if (z === null) {
      if (T > this.coast) { this.x = null; return null; }
      return { rpm: this.x, coast: true };
    }

    const gate = this.margin + 0.5 * this.maxAccel * (T + this.lag) ** 2;
    if (Math.abs(z - this.x) > gate) {
      this.v *= Math.exp(-dt / 0.05);
      if (this.cand !== null && Math.abs(z - this.cand) <= this.agree * this.cand) this.candN++;
      else this.candN = 1;
      this.cand = z;
      if (!this.rejectSince) this.rejectSince = now;
      if (this.candN >= this.confirm || now - this.rejectSince > this.reacquire * 1000) {
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
