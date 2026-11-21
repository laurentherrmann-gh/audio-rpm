// One RPM from the two detectors: the first way, by rules, reading by reading. The pipeline now uses
// path.js (92% right on the real cars against 86% for these rules); this is kept for comparison
// (`combine: 'rules'`), and because its rules say what was learned about how the detectors fail.
//
// Real game sound (the first clean DiRT Rally 2.0 clip) showed how they fail: never at random, but
// by reading a half or a quarter of the true revs, when the engine's slower rhythms (crank and
// cycle tones) get as loud as the firing tone: on the rev limiter and when revving in neutral.
// Pitch-detection is the faster of the two; gyroball slips less often. And a slip is always
// downward. So:
//  - when they agree, pitch-detection's value (least lag);
//  - when one reads 2× or 4× the other, the higher octave, with pitch-detection's timing;
//  - when they disagree otherwise (one of them is still catching up with a gear shift),
//    pitch-detection;
//  - and whatever the source, a sudden drop to exactly ½ or ¼ of the output is taken for a slip
//    and corrected for up to `slipHold` s (long enough for a stay on the limiter). A real shift that
//    halves the revs exactly would be shown late by that time; gearboxes rarely have one.
// The 80 real cars added one case: pitch-detection also slips UP an octave, onto the second harmonic
// of the firing tone, for a moment. Followed, that would make the true readings after it look like a
// slip to half. So:
//  - a jump up by exactly an octave or two that only pitch-detection shows is not followed until
//    gyroball shows it too, or it has lasted `upHold` s.
export const FUSION = Object.freeze({
  octave: 0.06,   // readings this close to ×2 or ×4 are an octave apart
  confirm: 0.08,  // s an octave relation must last before it is acted on (a falling rev count crosses
                  //   "half of the other reading" for an instant; a slip stays there)
  slipHold: 2.5,  // s a drop to ½ or ¼ is corrected before it is believed
  slipFloor: 0.94, // …and only while the corrected revs stay at or above where they were (a stay on
                  //   the limiter, a pull); falling revs end the correction at once
  pairMemory: 0.3, // s gyroball's higher reading keeps counting after it was last seen
  fastGap: 0.15,  // s without pitch-detection before gyroball is used alone (it lags at a shift)
  coast: 0.3,     // s the last value is held when there is nothing to go on
  memory: 3,      // s the last value still counts as "where the revs were" after the output went blank
  upHold: 0.5,    // s a jump up by exactly an octave or two is not believed from pitch-detection alone
});

const near = (a, b, tol) => Math.abs(a / b - 1) <= tol;
const octaveBelow = (low, high) => [2, 4].find(m => near(low * m, high, FUSION.octave)) ?? 0;

export class Fusion {
  constructor() { this.reset(); }

  reset() { this.x = null; this.seen = -Infinity; this.fastSeen = -Infinity; this.raise = null; this.upSince = null; }

  /** Nothing new to show: hold the last value for a moment, then show nothing (it is remembered). */
  hold(t) {
    const shown = this.x !== null && t - this.seen <= FUSION.coast;
    return { rpm: shown ? this.x : null, source: '', coast: shown };
  }

  /** Where the revs were, if that is recent enough to compare with. */
  was(t) { return this.x !== null && t - this.seen <= FUSION.memory ? this.x : null; }

  /**
   * @param {number} t seconds
   * @param {{rpm:number|null, raw:number|null, coast:boolean}|null} fast  pitch-detection's result
   * @param {{rpm:number|null, raw:number|null, coast:boolean}|null} sure  gyroball's result
   * @returns {{ rpm:number|null, source:string, coast:boolean }}
   */
  step(t, fast, sure) {
    const was = this.was(t);
    // What a detector has to offer. Its raw reading comes first when it sits exactly an octave or
    // two below where the revs were: its tracker is then gliding towards the slip, or holding out.
    const offer = d => {
      if (!d) return null;
      const raw = d.raw > 0 ? d.raw : null;
      if (raw !== null && was !== null && octaveBelow(raw, was)) return { v: raw, m: octaveBelow(raw, was) };
      if (d.rpm > 0 && !d.coast) return { v: d.rpm, m: 0 };
      if (raw !== null && was !== null && near(raw, was, FUSION.octave)) return { v: raw, m: 0 }; // tracker holding out, raw agrees
      return null;
    };
    const a = offer(fast), b = offer(sure);
    let c, source;
    if (a) { c = a; source = 'pitch'; this.fastSeen = t; }
    else if (b && (b.m || t - this.fastSeen >= FUSION.fastGap)) { c = b; source = 'gyroball'; }
    else return this.hold(t);
    let v = c.v;
    const high = sure ? (sure.raw > 0 ? sure.raw : sure.rpm > 0 && !sure.coast ? sure.rpm : null) : null;
    // A jump up by exactly an octave or two that gyroball does not share: pitch-detection has
    // slipped onto a harmonic (the second harmonic of the firing tone is the louder one on some real
    // engines). Revs cannot double between two readings, so the output stays where it was heading
    // until gyroball reads the higher value too, or the jump has lasted `upHold`.
    const up = c === a && was !== null ? octaveBelow(was, v) : 0;
    if (!up) this.upSince = null;
    else {
      this.upSince ??= t;
      const shared = high !== null && near(high, v, 2 * FUSION.octave);
      if (!shared && t - this.upSince < FUSION.upHold) { v /= up; source += ` ÷${up}`; }
    }
    // gyroball an octave or two above pitch-detection counts when the revs were up there too, or when
    // there is no history; alone it doesn't (in a wide search band gyroball can also lock too high)
    let pair = c === a && high !== null ? octaveBelow(v, high) : 0;
    if (pair && was !== null && !near(v * pair, was, 2 * FUSION.octave)) pair = 0;

    // should it be an octave (or two) higher? gyroball says so now, or the output was there a moment ago
    const m = pair || c.m;
    if (!m) this.raise = null;
    else {
      // one episode, even if the slip moves between a half and a quarter (it does, on the limiter)
      this.raise ??= { since: t, ref: was ?? v * m, pairAt: -Infinity };
      const r = this.raise;
      if (pair) r.pairAt = t;
      if (was !== null && t - r.since < FUSION.confirm) return this.hold(t); // not decided yet
      const bySure = t - r.pairAt <= FUSION.pairMemory;
      const bySlip = t - r.since <= FUSION.slipHold && v * m >= FUSION.slipFloor * r.ref;
      if (bySure || bySlip) { v *= m; source += ` ×${m}`; } else this.raise = null; // a real drop after all
    }
    this.x = v; this.seen = t;
    return { rpm: v, source, coast: false };
  }
}
