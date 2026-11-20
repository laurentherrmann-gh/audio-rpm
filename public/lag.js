// Measure end-to-end lag against a known truth (simulated engine or loopback test).
// Finds the delay L that best explains the outputs: y(t) ≈ truth(t − L).
// It only works while the revs are changing (a flat signal fits every L equally),
// so it returns null when the truth barely moves over the points given.

/**
 * @param {{t:number, y:number|null}[]} points  t in seconds on the truth's clock
 * @param {(t:number) => number} truthAt
 * @param {{minLag?:number, maxLag?:number, step?:number, minRange?:number}} [opts]
 * @returns {{lag:number|null, err:number, match:boolean}|null}  lag in seconds, err = median |y − truth|
 *   at that lag; null when the revs don't change enough. match = false (and lag null) when no delay
 *   explains the output: the error stays large, or the best fit sits at the edge of the search range.
 *   That happens when the rpm is on the wrong scale (wrong cylinder count), not when it is late.
 */
export function estimateLag(points, truthAt, { minLag = -0.1, maxLag = 0.4, step = 0.002, minRange = 800 } = {}) {
  // Only moments when the revs are ramping carry timing information. Steady revs fit every lag
  // equally (and a detector's constant error there would decide the result by noise), and the
  // instant of a gear shift is dominated by the tracker's re-acquire rule rather than by delay.
  const slope = t => (truthAt(t) - truthAt(t - 0.01)) / 0.01;
  const pts = points.filter(p => {
    if (p.y == null) return false;
    const s = Math.abs(slope(p.t - 0.05)), s2 = Math.abs(slope(p.t - 0.25));
    return s > 400 && s < 8000 && s2 > 400 && s2 < 8000;
  });
  if (pts.length < 20) return null;
  let lo = Infinity, hi = -Infinity;
  for (const p of pts) {
    const v = truthAt(p.t);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (hi - lo < minRange) return null;

  // the mean error is dominated by gear-shift instants; the median is not
  const errs = new Float64Array(pts.length);
  let best = null;
  for (let L = minLag; L <= maxLag + 1e-9; L += step) {
    for (let i = 0; i < pts.length; i++) errs[i] = Math.abs(pts[i].y - truthAt(pts[i].t - L));
    errs.sort();
    const med = errs[errs.length >> 1];
    if (!best || med < best.err) best = { lag: L, err: med };
  }
  const span = hi - lo;
  const atEdge = best.lag <= minLag + step / 2 || best.lag >= maxLag - step / 2;
  const match = !atEdge && best.err <= Math.max(150, 0.05 * span);
  return match ? { ...best, match } : { lag: null, err: best.err, match };
}
