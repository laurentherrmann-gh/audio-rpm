// Offline benchmark of the detection pipeline (the same code the browser worker runs) on the
// simulated shifting sweep. Applies the lag optimizations one at a time, so each one's effect shows.
//   npm run bench
//   npm run bench -- --cylinders 6 --redline 8000
//   npm run bench -- --auto          cylinder auto-detection on every supported engine
//   npm run bench -- --shifts        gear shifts and gear on the simulated stage drive
//
// lag     = measured end-to-end delay: the shift that best aligns output with the true rpm (median fit)
// err     = |output − true rpm at that same instant|, lag included: what the tach / SimHub shows
// glitches = share of time the output is more than 1,500 rpm off (wrong locks, dips at shifts)
// compute = time to run the detector once (this machine); gyroball analyses at most every 20 ms, so
//           its average per chunk is about a quarter of one analysis
// The audio goes through the same low-pass and decimation as in the page (tools/lib/audio.js).
// Not included here: capture latency of the sound card / BlackHole, and worklet→worker→page
// messaging (a few ms). The page measures those live.
import { estimateLag } from '../public/lag.js';
import { replay } from './lib/audio.js';
import { makeSchedule, makeNoIdleSchedule, makeStageSchedule, gearAt, shiftsIn, synthesize, rpmAt, scheduleDuration, CYLINDERS, RALLY_CYLINDERS } from '../public/engine-model.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => s.trim().split(/\s+/)));
const fs = 48000;

if ('shifts' in args) {
  // Gear shifts and gear on the simulated stage (standing start, gears 1–5 up and down, stop), 3 laps.
  // found = true shifts reported (same direction, starting within 0.1 s); delay = from the start of
  // the shift to its report; gear right = share of the time, shifts in progress (0.4 s) left out.
  const idle = 900, redline = 7500, hop = 256, laps = 3;
  const stage = makeStageSchedule({ idleRpm: idle, redline }), T = scheduleDuration(stage);
  const truth = [];
  for (let l = 0; l < laps; l++) for (const s of shiftsIn(stage)) truth.push({ ...s, t: s.t + l * T });
  const rows = {};
  for (const cyl of RALLY_CYLINDERS) {
    const signal = synthesize(stage, { fs, seconds: laps * T, cylinders: cyl });
    const found = [];
    let right = 0, n = 0;
    replay(signal, fs, { cylinders: cyl, idle, redline }, (t, r) => {
      if (r.gear.last && r.gear.last !== found.at(-1)) found.push(r.gear.last);
      if (t > 2 && !truth.some(s => t >= s.t && t < s.t + 0.4)) { n++; if (r.gear.gear === gearAt(stage, t)) right++; }
    }, hop);
    const pairs = truth.map(s => [s, found.find(e => e.dir === (s.to > s.from ? 'up' : 'down') && Math.abs(e.at - s.t) < 0.1)]).filter(p => p[1]);
    const med = a => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : NaN; };
    rows[`${cyl} cyl`] = {
      shifts: truth.length, found: pairs.length, 'false': found.length - pairs.length,
      'delay median (ms)': Math.round(med(pairs.map(([s, e]) => (e.t - s.t) * 1000))),
      'delay max (ms)': Math.round(Math.max(...pairs.map(([s, e]) => (e.t - s.t) * 1000))),
      'ratio error (median)': `${(100 * med(pairs.map(([s, e]) => Math.abs(e.ratio / s.ratio - 1)))).toFixed(1)}%`,
      'gear right': `${((100 * right) / n).toFixed(1)}%`,
    };
  }
  console.log(`\nGear shifts and gear, simulated stage drive, ${(laps * T).toFixed(0)} s per engine (shifts take 0.1 s up, 0.08 s down)`);
  console.table(rows);
  process.exit(0);
}

if ('auto' in args) {
  // Cylinders = auto on two simulated drives: with idle, and rally-like (pulls and shifts, never idle).
  // Time to lock, share of time locked to a wrong count, and rpm error once locked.
  const idle = 900, redline = 7500, hop = 256;
  for (const [drive, schedule] of [['idle, then four pulls', makeSchedule({ idleRpm: idle, redline })], ['rally: never idle', makeNoIdleSchedule({ redline })]]) {
    const seconds = scheduleDuration(schedule) * 2;
    console.log(`\nCylinder auto-detection, simulated drive "${drive}", ${seconds.toFixed(0)} s per engine`);
    const rows = {};
    const runs = [...RALLY_CYLINDERS.map(c => [c, 'rally', RALLY_CYLINDERS]), [12, 'rally', RALLY_CYLINDERS],
      [10, 'any', CYLINDERS], [12, 'any', CYLINDERS]];
    for (const [cyl, setName, autoCandidates] of runs) {
      const signal = synthesize(schedule, { fs, seconds, cylinders: cyl });
      let lockedAt = null, wrong = 0, steps = 0;
      const err = { pd: [], gyro: [], fused: [] };
      const pipe = replay(signal, fs, { cylinders: 'auto', autoCandidates, idle, redline }, (t, r) => {
        steps++;
        if (r.cyl.locked !== null && lockedAt === null) lockedAt = t;
        if (r.cyl.locked !== null && r.cyl.locked !== cyl) wrong++;
        if (lockedAt === null) return;
        for (const k of ['pd', 'gyro', 'fused']) if (r[k].rpm != null) err[k].push(Math.abs(r[k].rpm - rpmAt(schedule, t)));
      }, hop);
      const m = a => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : '—');
      rows[`${cyl} cyl, auto ${setName}`] = {
        locked: pipe.cyl.locked, 'after (s)': lockedAt?.toFixed(2) ?? 'never', 'wrong lock': `${((100 * wrong) / steps).toFixed(1)}%`,
        'pitch err mean': m(err.pd), 'gyroball err mean': m(err.gyro), 'combined err mean': m(err.fused),
      };
    }
    console.table(rows);
  }
  process.exit(0);
}
const cylinders = Number(args.cylinders || 4), idle = Number(args.idle || 900), redline = Number(args.redline || 7500);
const schedule = makeSchedule({ idleRpm: idle, redline });
const seconds = scheduleDuration(schedule) * 2;
const signal = synthesize(schedule, { fs, seconds, cylinders });
const truth = t => rpmAt(schedule, t);

function run(hop, cfg, sound = signal) {
  const pts = { gyro: [], pd: [], fused: [] }, comp = { gyro: [], pd: [], fused: [] };
  replay(sound, fs, { cylinders, idle, redline, ...cfg }, (t, r) => {
    for (const k of ['gyro', 'pd', 'fused']) {
      if (!r[k]) continue;
      pts[k].push({ t, y: r[k].rpm });
      comp[k].push(k === 'fused' ? r.pd.computeMs + r.gyro.computeMs : r[k].computeMs);
    }
  }, hop);
  const out = {};
  for (const k of ['gyro', 'pd', 'fused']) {
    if (!pts[k].length) continue;
    const errs = pts[k].filter(p => p.y != null && p.t > 1).map(p => Math.abs(p.y - truth(p.t))).sort((a, b) => a - b);
    const lag = estimateLag(pts[k].filter(p => p.t > 1), truth);
    const c = comp[k].slice(50).sort((a, b) => a - b);
    out[k] = {
      'lag (ms)': lag?.match ? Math.round(lag.lag * 1000) : lag ? 'no match' : '—',
      'err mean': Math.round(errs.reduce((a, b) => a + b, 0) / errs.length),
      'err p90': Math.round(errs[Math.floor(errs.length * 0.9)]),
      'glitches': ((100 * errs.filter(e => e > 1500).length) / errs.length).toFixed(1) + '%',
      'compute avg (ms)': (c.reduce((a, b) => a + b, 0) / c.length).toFixed(2),
      'compute p99 (ms)': c[Math.floor(c.length * 0.99)].toFixed(2),
    };
  }
  return out;
}

const POC1 = { timestamp: 'end', predict: false, tracker: { tau: 0.08, carry: false }, pd: { adaptive: false } };
const steps = [
  ['POC 1 (20 ms timer, stamped at end)', 960, POC1],
  ['+ run on every 5.3 ms chunk', 256, POC1],
  ['+ stamp at window centre + predict', 256, { ...POC1, timestamp: 'centre', predict: true }],
  ['+ tracker τ 0.05', 256, { ...POC1, timestamp: 'centre', predict: true, tracker: { tau: 0.05, carry: false } }],
  ['+ adaptive pitch window (= default)', 256, {}],
];

console.log(`Simulated sweep, ${cylinders} cyl, ${idle}–${redline} rpm, ${seconds.toFixed(0)} s. gyroball: engine-tuned FFT 8192. pitch-detection: YIN.\n`);
for (const k of ['pd', 'gyro']) {
  console.log(k === 'pd' ? 'pitch-detection (YIN)' : 'gyroball (engine-tuned, FFT 8192)');
  const rows = {};
  for (const [name, hop, cfg] of steps) {
    if (k === 'gyro' && name.startsWith('+ adaptive')) continue; // pitch-detection only
    rows[name] = run(hop, cfg)[k];
  }
  console.table(rows);
}
console.log('combined (both detectors, default settings; compute = both detectors, per chunk)');
console.table({ 'combined': run(256, {}).fused });

// The engine above is cleaner than a real one: its cylinders sound alike. Most real cars' don't (the
// tones of the engine cycle are strong), which is what the first versions could not read.
const uneven = synthesize(schedule, { fs, seconds, cylinders, cycleLevel: 0.3 });
const now = run(256, {}, uneven), before = run(256, { pd: { clarity: 0 }, firingMargin: 0 }, uneven);
console.log('the same drive, cylinders that do not sound alike (engine-cycle tones at 0.3, as on most real cars)');
console.table({
  'pitch-detection': now.pd, 'gyroball': now.gyro, 'combined': now.fused,
  'combined, without the second try and the firing-tone check': before.fused,
});
