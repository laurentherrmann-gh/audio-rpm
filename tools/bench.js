// Offline benchmark of the detection pipeline (the same code the browser worker runs) on the
// simulated shifting sweep. Applies the lag optimizations one at a time, so each one's effect shows.
//   npm run bench
//   npm run bench -- --cylinders 6 --redline 8000
//
// lag     = measured end-to-end delay: the shift that best aligns output with the true rpm (median fit)
// err     = |output − true rpm at that same instant|, lag included: what the tach / SimHub shows
// glitches = share of time the output is more than 1,500 rpm off (wrong locks, dips at shifts)
// compute = time to run the detector once (this machine)
// Not included here: capture latency of the sound card / BlackHole, and worklet→worker→page
// messaging (a few ms). The page measures those live.
import { Pipeline } from '../public/pipeline.js';
import { estimateLag } from '../public/lag.js';
import { makeSchedule, synthesize, rpmAt, scheduleDuration } from '../public/engine-model.js';

const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => s.trim().split(/\s+/)));
const fs = 48000, D = 4;
const cylinders = Number(args.cylinders || 4), idle = Number(args.idle || 900), redline = Number(args.redline || 7500);
const schedule = makeSchedule({ idleRpm: idle, redline });
const seconds = scheduleDuration(schedule) * 2;
const signal = synthesize(schedule, { fs, seconds, cylinders });
const truth = t => rpmAt(schedule, t);

function run(hop, cfg) {
  const pipe = new Pipeline(fs, D, { cylinders, idle, redline, ...cfg });
  const pts = { gyro: [], pd: [] }, comp = { gyro: [], pd: [] };
  for (let end = hop; end <= signal.length; end += hop) {
    const raw = signal.subarray(end - hop, end);
    const dec = new Float32Array(hop / D);
    for (let i = 0; i < dec.length; i++) dec[i] = raw[i * D];
    pipe.push(raw, dec);
    const t = end / fs, r = pipe.step(t);
    for (const k of ['gyro', 'pd']) {
      if (!r[k]) continue;
      pts[k].push({ t, y: r[k].rpm });
      comp[k].push(r[k].computeMs);
    }
  }
  const out = {};
  for (const k of ['gyro', 'pd']) {
    if (!pts[k].length) continue;
    const errs = pts[k].filter(p => p.y != null && p.t > 1).map(p => Math.abs(p.y - truth(p.t))).sort((a, b) => a - b);
    const lag = estimateLag(pts[k].filter(p => p.t > 1), truth);
    const c = comp[k].slice(50).sort((a, b) => a - b);
    out[k] = {
      'lag (ms)': lag ? Math.round(lag.lag * 1000) : '—',
      'err mean': Math.round(errs.reduce((a, b) => a + b, 0) / errs.length),
      'err p90': Math.round(errs[Math.floor(errs.length * 0.9)]),
      'glitches': ((100 * errs.filter(e => e > 1500).length) / errs.length).toFixed(1) + '%',
      'compute avg (ms)': (c.reduce((a, b) => a + b, 0) / c.length).toFixed(2),
      'compute p99 (ms)': c[Math.floor(c.length * 0.99)].toFixed(2),
    };
  }
  return out;
}

const POC1 = { timestamp: 'end', predict: false, tracker: { tau: 0.08 }, pd: { adaptive: false } };
const steps = [
  ['POC 1 (20 ms timer, stamped at end)', 960, POC1],
  ['+ run on every 5.3 ms chunk', 256, POC1],
  ['+ stamp at window centre + predict', 256, { ...POC1, timestamp: 'centre', predict: true }],
  ['+ tracker τ 0.05', 256, { ...POC1, timestamp: 'centre', predict: true, tracker: { tau: 0.05 } }],
  ['+ adaptive pitch window (= new default)', 256, {}],
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
