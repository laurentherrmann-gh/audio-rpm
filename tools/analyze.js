// Replay a recording through the detection pipeline (the same code the page runs) and print what the
// detectors and the cylinder counter saw over time.
//   npm run analyze -- recording.wav
//   npm run analyze -- recording.wav --cylinders auto-any     (auto = rally 4/5/6/8, auto-any, or 4…12)
//   npm run analyze -- recording.wav --every 0.25 --idle 1000 --redline 8500
// Other formats (.m4a, .mp3): convert first, e.g. `ffmpeg -i clip.m4a -ac 1 -ar 48000 clip.wav`.
import { readFileSync } from 'node:fs';
import { Pipeline } from '../public/pipeline.js';
import { CYLINDERS, RALLY_CYLINDERS } from '../public/engine-model.js';

const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--') && /\.wav$/i.test(a));
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
if (!file) { console.error('usage: npm run analyze -- file.wav [--cylinders auto|auto-any|4…12] [--every s] [--idle rpm] [--redline rpm]'); process.exit(1); }

/** Minimal WAV reader: PCM 16/24/32-bit or float 32, any channel count (mixed to mono). */
function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), fs: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  const { channels: ch, bits } = fmt, bytes = bits / 8, n = Math.floor(data.length / (bytes * ch));
  const isFloat = fmt.format === 3 || (fmt.format === 0xfffe && bits === 32 && process.env.WAV_FLOAT);
  const read = o => (isFloat ? data.readFloatLE(o)
    : bits === 16 ? data.readInt16LE(o) / 32768 : bits === 24 ? data.readIntLE(o, 3) / 8388608 : data.readInt32LE(o) / 2147483648);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += read((i * ch + c) * bytes);
    out[i] = s / ch;
  }
  return { fs: fmt.fs, samples: out };
}

/** Same low-pass as the page (two cascaded 2nd-order Butterworth sections), for the decimated stream. */
function lowpass(x, fs, fc) {
  const w = (2 * Math.PI * fc) / fs, alpha = Math.sin(w) / (2 * Math.SQRT1_2), cw = Math.cos(w), a0 = 1 + alpha;
  const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0, a1 = (-2 * cw) / a0, a2 = (1 - alpha) / a0;
  let y = x;
  for (let pass = 0; pass < 2; pass++) {
    const o = new Float32Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const v = b0 * y[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = y[i]; y2 = y1; y1 = v; o[i] = v;
    }
    y = o;
  }
  return y;
}

const { fs, samples } = readWav(file);
const cylArg = opt('cylinders', 'auto');
const cfg = {
  idle: Number(opt('idle', 900)), redline: Number(opt('redline', 7500)),
  cylinders: cylArg.startsWith('auto') ? 'auto' : Number(cylArg),
  autoCandidates: cylArg === 'auto-any' ? CYLINDERS : RALLY_CYLINDERS,
};
const D = 2 ** Math.round(Math.log2(fs / 12000)) || 1, hop = 256, every = Number(opt('every', 0.5));
const low = lowpass(samples, fs, Math.min(2500, (0.4 * fs) / D));
const pipe = new Pipeline(fs, D, cfg);
const name = n => (n >= 8 ? `V${n}` : `${n}-cyl`);
console.log(`${file}: ${(samples.length / fs).toFixed(1)} s at ${fs} Hz · cylinders ${cylArg} · idle ${cfg.idle} · redline ${cfg.redline}\n`);
console.log('    t |  pitch rpm (Hz)       | gyroball rpm (Hz)     | cylinders            | last count scores (share of cycle tones found)');
let next = every, lockedAt = null;
for (let end = hop; end <= samples.length; end += hop) {
  const dec = new Float32Array(hop / D);
  for (let i = 0; i < dec.length; i++) dec[i] = low[end - hop + i * D];
  pipe.push(samples.subarray(end - hop, end), dec);
  const t = end / fs, r = pipe.step(t);
  if (r.cyl.locked !== null && lockedAt === null) lockedAt = t;
  if (t < next) continue;
  next += every;
  const v = x => (x?.rpm == null ? '—'.padStart(5) : String(Math.round(x.rpm)).padStart(5)) + ` (${x?.valid ? x.f0.toFixed(1) : '—'})`.padEnd(10);
  const c = r.cyl.mode === 'manual' ? `${name(r.cyl.n)} manual` : r.cyl.locked !== null ? `${name(r.cyl.locked)} ${Math.round(r.cyl.confidence * 100)}%` : `auto… using ${r.cyl.n}`;
  const sc = pipe.cyl.last?.scores ? Object.entries(pipe.cyl.last.scores).map(([n, s]) => `${n}:${Math.round(s.present * 100)}%`).join(' ') : '';
  console.log(`${t.toFixed(2).padStart(5)} | ${v(r.pd)}      | ${v(r.gyro)}      | ${c.padEnd(20)} | ${sc}`);
}
console.log(`\nfinal: ${pipe.cyl.locked !== null ? `${name(pipe.cyl.locked)} locked after ${lockedAt.toFixed(2)} s` : r0(pipe)}`);
function r0(p) { return p.cfg.cylinders === 'auto' ? `no cylinder count locked (votes ${JSON.stringify(Object.fromEntries(Object.entries(p.cyl.votes).map(([k, v]) => [k, +v.toFixed(2)])))})` : 'manual count'; }
