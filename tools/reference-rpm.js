// The reference rpm of a recording as files other tools can read (tools/lib/reference.js computes it:
// rpm from the sound alone, offline, by tacholess order tracking).
//   npm run reference-rpm                          every clip in samples/dr2/
//   npm run reference-rpm -- clip.wav other.wav    those recordings
//   npm run reference-rpm -- --tacho               also <clip>.tacho.wav
// Writes, next to each recording:
//   <clip>.rpm.csv    time_s, rpm, sure, engine_order, tone_hz every 20 ms; the analysis parameters
//                     are in its header lines (they start with #)
//   <clip>.tacho.wav  with --tacho: stereo, left = the sound, right = one pulse per turn of the crank
//                     where the reference is sure (what order-analysis tools take as a tacho channel)
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, writeWav } from './lib/audio.js';
import { referenceRpm, referenceCsv, tachoPulses } from './lib/reference.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), tacho = argv.includes('--tacho');
let files = argv.filter(a => !a.startsWith('--'));
if (!files.length) {
  const dir = path.join(ROOT, 'samples/dr2');
  files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.wav') && !f.endsWith('.tacho.wav')).sort().map(f => path.join(dir, f)) : [];
}
if (!files.length) { console.error('No recordings: give WAV files, or run npm run fetch-dr2 first.'); process.exit(1); }

for (const file of files) {
  const { fs, samples } = readWav(file), ref = referenceRpm(samples, fs), base = file.replace(/\.wav$/i, '');
  writeFileSync(`${base}.rpm.csv`, referenceCsv(ref, { source: path.basename(file), fs }));
  if (tacho) writeWav(`${base}.tacho.wav`, [samples, tachoPulses(ref, fs, samples.length)], fs);
  const sure = ref.sure.filter(Boolean).length / ref.sure.length, known = ref.rpm.filter((v, i) => v !== null && ref.sure[i]);
  const orders = [...new Set(ref.stretches.filter(s => s.sure).map(s => s.j / 2))].sort((a, b) => a - b);
  console.log(`${path.basename(file).padEnd(44)} sure ${String(Math.round(100 * sure)).padStart(3)}% of the clip` +
    (known.length ? ` · ${Math.round(Math.min(...known))}–${Math.round(Math.max(...known))} rpm · followed engine order ${orders.join(', ') || '?'}` : ' · no engine tone found') +
    ` → ${path.basename(base)}.rpm.csv${tacho ? ' + .tacho.wav' : ''}`);
}
