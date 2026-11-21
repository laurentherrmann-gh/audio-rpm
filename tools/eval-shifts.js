// Are gear shifts found on real clips? The clips have no gear truth, so the shifts are taken from the
// offline reference rpm (tools/lib/reference.js): where it holds, steps by a gear's worth within
// 0.3 s and holds again, there was a shift. The live shifts (from the combined rpm, as the page makes
// them) are compared with those, and every other live shift is checked against the reference too.
//   npm run eval-shifts                  every car in samples/dr2/
//   npm run eval-shifts -- --only 1,20   just those cars
// A clean shift counts as found when a live shift of the same direction starts within 0.35 s of it.
// A live shift is only judged where the reference is sure around it; elsewhere nobody knows.
// Writes samples/dr2/results-shifts.md.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileFor, slug } from '../public/cars.js';
import { loadProfiles } from '../public/detectors/car-id.js';
import { readWav, replay } from './lib/audio.js';
import { mixIn } from './lib/mix.js';
import { referenceRpm, REF } from './lib/reference.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const dir = path.resolve(ROOT, opt('dir', 'samples/dr2'));
const manifest = JSON.parse(readFileSync(path.resolve(ROOT, opt('manifest', 'samples/dr2-cars.json')), 'utf8'));
const only = opt('only') ? new Set(opt('only').split(',').map(Number)) : null;
const trial = opt('cfg') ? JSON.parse(opt('cfg')) : null; // pipeline settings to try (writes results-shifts-some.md)
const mix = opt('mix'); // stage sounds added to what the detectors hear, e.g. --mix speech:0,road:-6 (see lib/mix.js)
// the cars' tone maps, as the page has them once npm run learn-cars has run
const profilesFile = path.join(dir, 'car-profiles.json');
const learned = existsSync(profilesFile) ? loadProfiles(JSON.parse(readFileSync(profilesFile, 'utf8'))) : null;
const NEAR = 0.35, REVS = { idle: 800, redline: 9000 };

// In gear the revs follow the car's speed: over a third of a second, a straight line (in log rpm).
// A shift is a break between two such lines. So: fit a line to the reference before a moment and one
// after it, carry both to the middle of the gap, and compare. STRICT says what is listed as a clean
// shift; LOOSE is what a live shift is checked against (a real step that is not clean enough to list).
const GAP = [0.03, 0.2], SPAN = 0.3, APART = 0.6;
// kink: the share of the step that the two lines' difference in slope could explain. A lift followed
// by throttle is a V, not a step: its "step" is all kink.
const STRICT = { step: 0.1, fit: 0.02, slope: 1.0, kink: 0.5 }, LOOSE = { step: 0.06, fit: 0.04, slope: 2.5, kink: 0.9 };
const CENTRE = (GAP[1] - GAP[0]) / 2; // s from the moment a break is measured at to the middle of its gap
const LEVER = (GAP[0] + GAP[1] + SPAN) / 2; // s from the middle of a line to the middle of the gap
const MAX_STEP = 0.66; // log: beyond ×1.93 it is not one gear (and ×2 is left to the octave rules)

/**
 * Shifts in the reference rpm of one clip, and a judge for live shifts.
 * @returns {{ shifts: {at:number, dir:'up'|'down', ratio:number}[], judge: (t:number, dir:string) => 'true'|'false'|null }}
 */
export function referenceShifts(ref, cylinders) {
  const trusted = new Array(ref.rpm.length).fill(false);
  for (const s of ref.stretches) {
    if (!s.sure || (cylinders && ![cylinders, cylinders / 2, 2 * cylinders].includes(s.j))) continue;
    for (let i = Math.round((s.from - ref.t[0]) / REF.hop); i <= Math.round((s.to - ref.t[0]) / REF.hop); i++) trusted[i] = true;
  }
  const index = t => Math.round((t - ref.t[0]) / REF.hop);
  /** Line through log rpm of the trusted reference between a and b s: value at `at`, slope per s, rms misfit. */
  const line = (a, b, at) => {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    const pts = [];
    for (let i = Math.max(0, index(a)); i <= Math.min(ref.rpm.length - 1, index(b)); i++) {
      if (!trusted[i]) continue;
      const x = ref.t[i] - at, y = Math.log(ref.rpm[i]);
      pts.push([x, y]); n++; sx += x; sy += y; sxx += x * x; sxy += x * y;
    }
    if (n < 0.7 * ((b - a) / REF.hop)) return null;
    const den = n * sxx - sx * sx, slope = den ? (n * sxy - sx * sy) / den : 0, y0 = (sy - slope * sx) / n;
    let e = 0;
    for (const [x, y] of pts) e += (y - y0 - slope * x) ** 2;
    return { y: y0, slope, fit: Math.sqrt(e / n) };
  };
  /** The break at t: log ratio after / before at the middle of the gap, with the two lines' quality. */
  const breakAt = t => {
    const mid = t + (GAP[1] - GAP[0]) / 2, b = line(t - GAP[0] - SPAN, t - GAP[0], mid), a = line(t + GAP[1], t + GAP[1] + SPAN, mid);
    return b && a ? { step: a.y - b.y, fit: Math.max(a.fit, b.fit), slope: Math.max(Math.abs(a.slope), Math.abs(b.slope)), kink: Math.abs(a.slope - b.slope) * LEVER } : null;
  };
  const passes = (k, lim) => k && Math.abs(k.step) >= lim.step && Math.abs(k.step) <= MAX_STEP && k.fit <= lim.fit && k.slope <= lim.slope && k.kink <= lim.kink * Math.abs(k.step);
  const shifts = [];
  let run = null;
  const close = () => {
    if (!run) return;
    const e = { at: run.at + CENTRE, dir: run.step < 0 ? 'up' : 'down', ratio: Math.exp(run.step) }, prev = shifts.at(-1);
    if (prev && e.at - prev.at < APART) { if (Math.abs(Math.log(e.ratio)) > Math.abs(Math.log(prev.ratio))) shifts[shifts.length - 1] = e; }
    else shifts.push(e);
    run = null;
  };
  for (let i = 0; i < ref.t.length; i++) {
    const k = breakAt(ref.t[i]);
    if (!passes(k, STRICT)) { close(); continue; }
    if (run && Math.sign(k.step) !== Math.sign(run.step)) close();
    if (!run || Math.abs(k.step) > Math.abs(run.step)) run = { at: ref.t[i], step: k.step };
  }
  close();
  const judge = (t, dir) => {
    let any = false;
    for (let dt = -0.15; dt <= 0.2001; dt += 0.05) {
      const k = breakAt(t - CENTRE + dt);
      if (!k) continue;
      any = true;
      if (passes(k, LOOSE) && (k.step < 0 ? 'up' : 'down') === dir) return 'true';
    }
    return any ? 'false' : null;
  };
  return { shifts, judge };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const todo = manifest.cars.map((car, i) => ({ car, n: i + 1, file: path.join(dir, fileFor(car, i)) }))
    .filter(x => (!only || only.has(x.n)) && existsSync(x.file) && x.car.cylinders);
  if (!todo.length) { console.error('No car files: run npm run init (or npm run fetch-dr2) first.'); process.exit(1); }
  const rows = [];
  for (const { car, n, file } of todo) {
    const { fs, samples } = readWav(file), ref = referenceRpm(samples, fs, { cylinders: car.cylinders }), truth = referenceShifts(ref, car.cylinders);
    const live = [], heard = mix ? mixIn(samples, fs, mix, n) : samples;
    let last = null, stoodAt = null;
    const key = slug(car.car), maps = learned?.cars[key]?.tones;
    replay(heard, fs, { cylinders: car.cylinders, carKey: key, ...REVS, ...(car.scale ? { scale: { gyro: car.scale, pd: car.scale } } : null), ...trial }, (t, r) => {
      const e = r.gear?.last;
      if (r.gear?.sure && stoodAt === null) stoodAt = t;
      if (e && e !== last) { last = e; live.push({ at: e.at, t: e.t, dir: e.dir, ratio: e.ratio }); }
    }, 256, pipe => { if (maps?.length) pipe.tones = { [key]: maps }; });
    const used = new Set(), found = [], missed = [];
    for (const s of truth.shifts) {
      const k = live.findIndex((e, i) => !used.has(i) && e.dir === s.dir && Math.abs(e.at - s.at) <= NEAR);
      if (k < 0) missed.push(s); else { used.add(k); found.push({ ref: s, live: live[k] }); }
    }
    // the other live shifts: the reference stepped there too (just not cleanly enough to be listed), did not, or cannot say
    const extra = live.filter((e, i) => !used.has(i)).map(e => ({ ...e, verdict: truth.judge(e.at, e.dir) }));
    const falseOnes = extra.filter(e => e.verdict === 'false'), alsoTrue = extra.filter(e => e.verdict === 'true').length;
    rows.push({ n, car: car.car, cylinders: car.cylinders, truth: truth.shifts.length, found, missed, falseOnes, alsoTrue, unjudged: extra.length - falseOnes.length - alsoTrue, stoodAt });
    console.log(`${String(n).padStart(2)} ${car.car.padEnd(36)} clean shifts ${String(truth.shifts.length).padStart(2)} · found ${String(found.length).padStart(2)} · missed ${String(missed.length).padStart(2)} · other live shifts: real ${alsoTrue}, false ${falseOnes.length}, not judged ${extra.length - falseOnes.length - alsoTrue}` +
      (missed.length ? ` · missed at ${missed.map(s => s.at.toFixed(1)).join(', ')}` : '') + (falseOnes.length ? ` · false at ${falseOnes.map(s => s.at.toFixed(1)).join(', ')}` : ''));
  }
  const sum = f => rows.reduce((a, r) => a + f(r), 0), med = a => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : null);
  const all = rows.flatMap(r => r.found);
  const T = sum(r => r.truth), F = sum(r => r.found.length), X = sum(r => r.falseOnes.length), A = sum(r => r.alsoTrue), U = sum(r => r.unjudged);
  const delay = med(all.map(f => f.live.t - f.ref.at)), ratioErr = med(all.map(f => Math.abs(f.live.ratio / f.ref.ratio - 1)));
  const lines = [
    `# DiRT Rally 2.0 cars: are gear shifts found? ${new Date().toISOString().slice(0, 10)}${mix ? ` · with stage sound mixed in (${mix})` : ''}`, '',
    `${rows.length} cars, cylinder count set by hand. "Clean shifts" are taken from the offline reference rpm: the revs hold, step by a gear's worth within 0.3 s, and hold again. Every other live shift is checked against the reference at that moment: real (the revs did step that way), false (they did not), or not judged (the reference is unsure there).`, '',
    `**${F} of ${T} clean shifts found (${T ? Math.round((100 * F) / T) : 0}%). Live shifts: ${F + A} real, ${X} false (${F + A + X ? Math.round((100 * X) / (F + A + X)) : 0}%), ${U} not judged**${delay !== null ? `; reported a median ${Math.round(delay * 1000)} ms after the shift; ratio off by a median ${(100 * ratioErr).toFixed(1)}%` : ''}. The car is seen standing (the gear is sure from there) on ${rows.filter(r => r.stoodAt !== null).length} of the ${rows.length} clips, on ${rows.filter(r => r.stoodAt !== null && r.stoodAt < 3).length} within 3 s.`, '',
    '| # | car | cyl | clean shifts | found | missed | other live: real | false | not judged |', '|---|---|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.n} | ${r.car} | ${r.cylinders} | ${r.truth} | ${r.found.length} | ${r.missed.length} | ${r.alsoTrue} | ${r.falseOnes.length} | ${r.unjudged} |`),
  ];
  const outFile = path.join(dir, `results-shifts${mix ? '-mix' : ''}${only || trial ? '-some' : ''}.md`);
  writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(`\n${lines[4]}\nWrote ${path.relative(ROOT, outFile)}`);
}
