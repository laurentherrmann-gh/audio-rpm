// Shared engine-sound model: used by the in-browser simulator (engine-sim.js)
// and by the test WAV generator (tools/make-test-wav.js). Pure functions, no DOM.

// Partials as [multiple of the firing frequency, amplitude].
// Real engines also have half orders; including one makes octave errors show up in testing.
export const PARTIALS = [
  [0.5, 0.25], [1, 1], [1.5, 0.12], [2, 0.6], [3, 0.4], [4, 0.25], [5, 0.15], [6, 0.08],
];

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
export function synthesize(schedule, { fs = 48000, seconds, cylinders = 4, gain = 0.15, noise = 0.03 } = {}) {
  const n = Math.floor(seconds * fs);
  const out = new Float32Array(n);
  const phases = new Float64Array(PARTIALS.length);
  let seed = 1;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const f = firingHz(rpmAt(schedule, i / fs), cylinders);
    let s = 0;
    for (let k = 0; k < PARTIALS.length; k++) {
      phases[k] += (2 * Math.PI * PARTIALS[k][0] * f) / fs;
      s += PARTIALS[k][1] * Math.sin(phases[k]);
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
