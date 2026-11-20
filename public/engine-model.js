// Shared engine-sound model: used by the in-browser simulator (engine-sim.js)
// and by the test WAV generator (tools/make-test-wav.js). Pure functions, no DOM.

// Supported cylinder counts (4-stroke engines).
export const CYLINDERS = [4, 5, 6, 8, 10, 12];
// Every car in DiRT Rally 2.0 has one of these: mostly 4, the Audi quattro S1 E2 5, the Metro 6R4,
// Stratos, 911s, M1/M2 and 240Z 6, the Rally GT V8s (Vantage, Camaro, Mustang) 8.
export const RALLY_CYLINDERS = [4, 5, 6, 8];

// Strong tones: the firing frequency and its harmonics, as [multiple of the firing frequency, amplitude].
const FIRING = [[1, 1], [2, 0.6], [3, 0.4], [4, 0.25], [5, 0.15], [6, 0.08]];

/**
 * Partials of an N-cylinder engine as [multiple of the firing frequency, amplitude].
 *
 * A real engine repeats exactly once per engine cycle (two crank turns), not once per firing:
 * every cylinder fires a little differently. So besides the firing harmonics there are faint
 * "cycle orders" at every multiple of the cycle frequency (rpm / 120), i.e. at k/N of the firing
 * frequency. Their spacing is what reveals the cylinder count. `cycleLevel` sets their strength
 * (0.06 ≈ −24 dB below the firing tone; 0 = a perfectly regular engine).
 * Even-cylinder engines also get a stronger half order (k = N/2, 3N/2), which is what makes
 * octave errors show up in testing.
 */
export function enginePartials(cylinders = 4, { cycleLevel = 0.06 } = {}) {
  const N = cylinders;
  const out = FIRING.map(([m, a]) => [m, a]);
  if (cycleLevel > 0) {
    for (let k = 1; k < 6 * N; k++) {
      if (k % N === 0) continue;
      // deterministic per-order amplitude in [0.4, 1] × level, slowly decaying with order
      const h = Math.sin(k * 12.9898 + N * 78.233) * 43758.5453;
      const w = 0.4 + 0.6 * (h - Math.floor(h));
      out.push([k / N, cycleLevel * w * Math.exp(-k / (8 * N))]);
    }
  }
  if (N % 2 === 0) {
    for (const [m, a] of [[0.5, 0.25], [1.5, 0.12]]) {
      const p = out.find(x => Math.abs(x[0] - m) < 1e-9);
      if (p) p[1] = Math.max(p[1], a); else out.push([m, a]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** Firing frequency of a 4-stroke engine: each cylinder fires once every 2 crank turns. */
export function firingHz(rpm, cylinders) {
  return (rpm / 60) * (cylinders / 2);
}

/** Inverse: detected firing frequency → rpm. */
export function rpmFromFiringHz(hz, cylinders) {
  return (hz * 60 * 2) / cylinders;
}

/**
 * Piecewise-linear rpm schedule (loops): idle, four pulls to redline with gear-shift drops,
 * lift off, back to idle. Returns [[seconds, rpm], ...].
 */
export function makeSchedule({ idleRpm = 900, redline = 7500 } = {}) {
  const top = redline * 0.97;
  const afterShift = redline * 0.62;
  const pts = [[0, idleRpm], [2, idleRpm], [2.3, redline * 0.4]];
  let t = 2.3;
  for (let gear = 0; gear < 4; gear++) {
    t += 1.6 + gear * 0.7;
    pts.push([t, top]);
    if (gear < 3) {
      t += 0.15;
      pts.push([t, afterShift]);
    }
  }
  t += 0.5; pts.push([t, redline * 0.5]);
  t += 1.5; pts.push([t, idleRpm]);
  t += 1.5; pts.push([t, idleRpm]);
  return pts;
}

/** Constant rpm schedule, for deterministic tests. */
export function constantSchedule(rpm, seconds = 10) {
  return [[0, rpm], [seconds, rpm]];
}

export function scheduleDuration(schedule) {
  return schedule[schedule.length - 1][0];
}

/**
 * Render the engine sound for a schedule (mono Float32Array). Deterministic noise.
 * Used by the WAV generator and the offline benchmark.
 */
export function synthesize(schedule, { fs = 48000, seconds, cylinders = 4, gain = 0.15, noise = 0.03, cycleLevel = 0.06 } = {}) {
  const n = Math.floor(seconds * fs);
  const out = new Float32Array(n);
  const PARTIALS = enginePartials(cylinders, { cycleLevel });
  const phases = new Float64Array(PARTIALS.length);
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const f = firingHz(rpmAt(schedule, i / fs), cylinders);
    let s = 0;
    for (let k = 0; k < PARTIALS.length; k++) {
      const fk = PARTIALS[k][0] * f;
      phases[k] += (2 * Math.PI * fk) / fs;
      if (fk < fs * 0.45) s += PARTIALS[k][1] * Math.sin(phases[k]);
    }
    out[i] = s * gain + rand() * noise;
  }
  return out;
}

/** rpm at time t (seconds), looping over the schedule. */
export function rpmAt(schedule, t) {
  const T = scheduleDuration(schedule);
  const u = ((t % T) + T) % T;
  for (let i = 1; i < schedule.length; i++) {
    const [t1, r1] = schedule[i];
    if (u <= t1) {
      const [t0, r0] = schedule[i - 1];
      return t1 === t0 ? r1 : r0 + ((r1 - r0) * (u - t0)) / (t1 - t0);
    }
  }
  return schedule[schedule.length - 1][1];
}
