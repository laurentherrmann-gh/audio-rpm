// Shared by tools/analyze.js and tools/eval-dr2.js: read a WAV, and replay audio through the
// detection pipeline exactly as the page feeds it (same low-pass and decimation, 256-sample chunks).
import { readFileSync } from 'node:fs';
import { Pipeline } from '../../public/pipeline.js';

/** Minimal WAV reader: PCM 16/24/32-bit or float 32, any channel count (mixed to mono). */
export function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${path}: not a WAV file`);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), fs: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = b.readUInt16LE(p + 32); // WAVE_FORMAT_EXTENSIBLE: real format in the GUID
    }
    if (id === 'data') data = b.subarray(p + 8, Math.min(b.length, p + 8 + size));
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt or data chunk`);
  const { channels: ch, bits } = fmt, bytes = bits / 8, n = Math.floor(data.length / (bytes * ch));
  const isFloat = fmt.format === 3;
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

/** Same low-pass as the page (two cascaded 2nd-order Butterworth sections). */
export function lowpass(x, fs, fc) {
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

/**
 * Feed `samples` through a new Pipeline in `hop`-sample chunks, low-passed and decimated as the page
 * does; call onStep(t, result, pipe) after each.
 * @returns {Pipeline}
 */
export function replay(samples, fs, cfg, onStep, hop = 256) {
  const D = 2 ** Math.round(Math.log2(fs / 12000)) || 1;
  const low = lowpass(samples, fs, Math.min(2500, (0.4 * fs) / D));
  const pipe = new Pipeline(fs, D, cfg);
  for (let end = hop; end <= samples.length; end += hop) {
    const dec = new Float32Array(hop / D);
    for (let i = 0; i < dec.length; i++) dec[i] = low[end - hop + i * D];
    pipe.push(samples.subarray(end - hop, end), dec);
    const t = end / fs;
    onStep?.(t, pipe.step(t), pipe);
  }
  return pipe;
}

export const cylName = n => (n >= 8 ? `V${n}` : `${n}-cyl`);
