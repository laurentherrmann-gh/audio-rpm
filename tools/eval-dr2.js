// Evaluates cylinder auto-detection on the DiRT Rally 2.0 car sounds (samples/dr2/, from npm run fetch-dr2)
// against each car's known cylinder count, and reports how usable the rpm readings are.
//   npm run eval-dr2                          rally auto mode (4/5/6/8), all cars found
//   npm run eval-dr2 -- --cylinders auto-any
//   npm run eval-dr2 -- --only 11,20,53 --idle 800 --redline 9000
//   npm run eval-dr2 -- --file ~/Downloads/audio-rpm-….wav --car 20     one recording of car #20
// Writes samples/dr2/results.json (everything) and samples/dr2/results.md (summary to share).
// There is no rpm truth in these recordings: "agree" (pitch-detection and gyroball within 5% of each
// other) is the consistency check that stands in for it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CYLINDERS, RALLY_CYLINDERS } from '../public/engine-model.js';
import { readWav, replay, cylName } from './lib/audio.js';
import { fileFor } from './fetch-dr2.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const manifestPath = path.resolve(ROOT, opt('manifest', 'samples/dr2-cars.json'));
const dir = path.resolve(ROOT, opt('dir', 'samples/dr2'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const only = opt('only') ? new Set(opt('only').split(',').map(Number)) : null;
const cylArg = opt('cylinders', 'auto');
const cfg = {
  idle: Number(opt('idle', 800)), redline: Number(opt('redline', 9000)),
  cylinders: 'auto', autoCandidates: cylArg === 'auto-any' ? CYLINDERS : RALLY_CYLINDERS,
};
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const SILENT_DB = -60; // a file whose loudest sample is below this has no sound in it

const results = [];
const todo = opt('file')
  ? [{ car: manifest.cars[Number(opt('car')) - 1] ?? { car: path.basename(opt('file')), cylinders: null, layout: '?' }, i: Number(opt('car', 0)) - 1, file: path.resolve(opt('file')) }]
  : manifest.cars.map((car, i) => ({ car, i, file: path.join(dir, fileFor(car, i)) })).filter(x => (!only || only.has(x.i + 1)) && existsSync(x.file));
if (!todo.length) { console.error(`No car files in ${path.relative(ROOT, dir)}/. Run npm run fetch-dr2 first.`); process.exit(1); }
console.log(`Evaluating ${todo.length} car(s), cylinders ${cylArg}, idle ${cfg.idle}, redline ${cfg.redline}\n`);

for (const { car, i, file } of todo) {
  const { fs, samples } = readWav(file);
  let peak = 0;
  for (let k = 0; k < samples.length; k++) peak = Math.max(peak, Math.abs(samples[k]));
  const peakDb = Math.round(20 * Math.log10(Math.max(peak, 1e-9)));
  let steps = 0, lockedRight = 0, lockedWrong = 0, firstLock = null, firstLockN = null;
  let pdOk = 0, gyOk = 0, both = 0, agree = 0;
  const pdRpms = [];
  const pipe = replay(samples, fs, cfg, (t, r) => {
    steps++;
    const L = r.cyl.locked;
    if (L !== null && firstLock === null) { firstLock = t; firstLockN = L; }
    if (L !== null && car.cylinders) (L === car.cylinders ? lockedRight++ : lockedWrong++);
    const p = r.pd?.rpm != null && r.pd.valid, g = r.gyro?.rpm != null && r.gyro.valid;
    if (p) { pdOk++; pdRpms.push(r.pd.rpm); }
    if (g) gyOk++;
    if (p && g) { both++; if (Math.abs(r.pd.rpm - r.gyro.rpm) / r.pd.rpm < 0.05) agree++; }
  });
  pdRpms.sort((a, b) => a - b);
  const final = pipe.cyl.locked;
  const res = {
    n: i + 1, car: car.car, layout: car.layout, truth: car.cylinders, seconds: +(samples.length / fs).toFixed(1),
    peakDb, silent: peakDb < SILENT_DB,
    final, correct: car.cylinders ? final === car.cylinders : null,
    firstLock: firstLock === null ? null : +firstLock.toFixed(2), firstLockN,
    timeLockedRight: pct(lockedRight, steps), timeLockedWrong: pct(lockedWrong, steps),
    votes: Object.fromEntries(Object.entries(pipe.cyl.votes).map(([k, v]) => [k, +v.toFixed(2)])),
    pitchReadings: pct(pdOk, steps), gyroReadings: pct(gyOk, steps), agree: pct(agree, both),
    pitchRpmMedian: pdRpms.length ? Math.round(pdRpms[pdRpms.length >> 1]) : null,
  };
  results.push(res);
  const mark = res.correct === null ? '·' : res.correct ? '✓' : '✗';
  console.log(`${String(res.n).padStart(2)} ${mark} ${car.car.padEnd(36)} ${String(car.cylinders ?? '?').padStart(2)} cyl → ${final === null ? 'none' : cylName(final)}`.padEnd(66) +
    (res.silent ? ` SILENT (peak ${peakDb} dB)` :
    ` first lock ${res.firstLock ?? '—'} s · right ${res.timeLockedRight}% wrong ${res.timeLockedWrong}% · readings pitch ${res.pitchReadings}% gyro ${res.gyroReadings}% · agree ${res.agree}%`));
}

// summary
const scored = results.filter(r => r.truth);
const by = {};
for (const r of scored) {
  const k = r.truth, b = (by[k] ??= { cars: 0, right: 0, wrong: 0, none: 0 });
  b.cars++; if (r.final === null) b.none++; else if (r.correct) b.right++; else b.wrong++;
}
const lines = [
  `# DiRT Rally 2.0 car sounds: cylinder auto-detection (${cylArg}), ${new Date().toISOString().slice(0, 10)}`, '',
  `${scored.length} scored cars: **${scored.filter(r => r.correct).length} right**, ${scored.filter(r => r.final !== null && !r.correct).length} wrong, ${scored.filter(r => r.final === null).length} no count.`, '',
  ...(results.some(r => r.silent) ? [`**${results.filter(r => r.silent).length} file(s) are silent**: the recording had no sound (the Mac was not playing into BlackHole).`, ''] : []),
  '| cylinders | cars | right | wrong | no count |', '|---|---|---|---|---|',
  ...Object.entries(by).map(([k, b]) => `| ${k} | ${b.cars} | ${b.right} | ${b.wrong} | ${b.none} |`), '',
  '| # | car | layout | truth | final | first lock | time right / wrong | pitch / gyro readings | agree | peak |', '|---|---|---|---|---|---|---|---|---|---|',
  ...results.map(r => `| ${r.n} | ${r.car} | ${r.layout} | ${r.truth ?? '?'} | ${r.final ?? '—'} ${r.correct === null ? '' : r.correct ? '✓' : '✗'} | ${r.firstLock ?? '—'} s | ${r.timeLockedRight}% / ${r.timeLockedWrong}% | ${r.pitchReadings}% / ${r.gyroReadings}% | ${r.agree}% | ${r.silent ? `**silent** ` : ''}${r.peakDb} dB |`),
];
mkdirSync(dir, { recursive: true });
writeFileSync(path.join(dir, 'results.md'), lines.join('\n') + '\n');
writeFileSync(path.join(dir, 'results.json'), JSON.stringify({ cfg: { ...cfg, cylinders: cylArg }, results }, null, 1) + '\n');
console.log('\n' + lines.slice(2, 4 + Object.keys(by).length + 2).join('\n'));
console.log(`\nWrote ${path.relative(ROOT, path.join(dir, 'results.md'))} and results.json. Send results.md (small) to Claude.`);
