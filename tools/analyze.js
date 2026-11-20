// Replay a recording through the detection pipeline (the same code the page runs) and print what the
// detectors and the cylinder counter saw over time.
//   npm run analyze -- recording.wav
//   npm run analyze -- recording.wav --cylinders auto-any     (auto = rally 4/5/6/8, auto-any, or 4…12)
//   npm run analyze -- recording.wav --every 0.25 --idle 1000 --redline 8500
// Other formats (.m4a, .mp3): convert first, e.g. `ffmpeg -i clip.m4a -ac 1 -ar 48000 clip.wav`.
import { CYLINDERS, RALLY_CYLINDERS } from '../public/engine-model.js';
import { readWav, replay, cylName } from './lib/audio.js';

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--') && /\.wav$/i.test(a));
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
if (!file) { console.error('usage: npm run analyze -- file.wav [--cylinders auto|auto-any|4…12] [--every s] [--idle rpm] [--redline rpm]'); process.exit(1); }

const { fs, samples } = readWav(file);
const cylArg = opt('cylinders', 'auto');
const cfg = {
  idle: Number(opt('idle', 900)), redline: Number(opt('redline', 7500)),
  cylinders: cylArg.startsWith('auto') ? 'auto' : Number(cylArg),
  autoCandidates: cylArg === 'auto-any' ? CYLINDERS : RALLY_CYLINDERS,
};
const every = Number(opt('every', 0.5));
console.log(`${file}: ${(samples.length / fs).toFixed(1)} s at ${fs} Hz · cylinders ${cylArg} · idle ${cfg.idle} · redline ${cfg.redline}\n`);
console.log('    t |  pitch rpm (Hz)       | gyroball rpm (Hz)     | cylinders            | last count scores (share of cycle tones found)');
let next = every, lockedAt = null;
const shifts = [];
const pipe = replay(samples, fs, cfg, (t, r, p) => {
  if (r.cyl.locked !== null && lockedAt === null) lockedAt = t;
  if (r.gear.last && r.gear.last !== shifts.at(-1)) shifts.push(r.gear.last);
  if (t < next) return;
  next += every;
  const v = x => (x?.rpm == null ? '—'.padStart(5) : String(Math.round(x.rpm)).padStart(5)) + ` (${x?.valid ? x.f0.toFixed(1) : '—'})`.padEnd(10);
  const c = r.cyl.mode === 'manual' ? `${cylName(r.cyl.n)} manual` : r.cyl.locked !== null ? `${cylName(r.cyl.locked)} ${Math.round(r.cyl.confidence * 100)}%` : `auto… using ${r.cyl.n}`;
  const sc = p.cyl.last?.scores ? Object.entries(p.cyl.last.scores).map(([n, s]) => `${n}:${Math.round(s.present * 100)}%`).join(' ') : '';
  console.log(`${t.toFixed(2).padStart(5)} | ${v(r.pd)}      | ${v(r.gyro)}      | ${c.padEnd(20)} | ${sc}`);
});
console.log(`\ngear shifts: ${shifts.length}${shifts.length ? '' : ' (none found)'}`);
for (const s of shifts) console.log(`  ${s.at.toFixed(2).padStart(6)} s  ${s.dir === 'up' ? '▲ up  ' : '▼ down'}  rpm ×${s.ratio.toFixed(2)}${s.gear ? `  → gear ${s.gear}` : ''}`);
const votes = JSON.stringify(Object.fromEntries(Object.entries(pipe.cyl.votes).map(([k, v]) => [k, +v.toFixed(2)])));
console.log(`\nfinal: ${pipe.cyl.locked !== null ? `${cylName(pipe.cyl.locked)} locked after ${lockedAt.toFixed(2)} s`
  : cfg.cylinders === 'auto' ? `no cylinder count locked (votes ${votes})` : 'manual count'}`);
