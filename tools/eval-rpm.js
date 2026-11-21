// How right is the rpm on real clips? Scores the live detectors against the offline reference
// (tools/lib/reference.js: rpm from the spacing of the engine's tones), on the cars in samples/dr2/.
//   npm run eval-rpm                     every car, with its real cylinder count set by hand
//   npm run eval-rpm -- --only 20,53     just those cars
//   npm run eval-rpm -- --cylinders auto with cylinder auto-detection instead
//   npm run eval-rpm -- --tones split    each car's tone map (public/detectors/tones.js) learned from
//                                        every other 4 s of its clip and used on the rest; scored on
//                                        that rest only, without and with the map (two tables)
//   npm run eval-rpm -- --tones off      without the tone maps (default: with those in car-profiles.json,
//                                        which were learned from these same clips: flattering)
//   npm run eval-rpm -- --cfg '{"tracker":{"tau":0.03}}'   try other pipeline settings
// Only moments where the reference is sure are scored, and only where it found the loudest tone to be
// one a car of that cylinder count is expected to have: the firing tone (cycle × N), half of it or
// twice it. (Elsewhere the reference itself is doubtful: stray tones such as turbo or gearbox whine
// can make it read cycle × 10 or × 12 on a four.) Writes samples/dr2/results-rpm.md.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileFor } from '../public/cars.js';
import { CYLINDERS } from '../public/engine-model.js';
import { readWav, replay } from './lib/audio.js';
import { referenceRpm, referenceCsv, REF } from './lib/reference.js';
import { loadProfiles } from '../public/detectors/car-id.js';
import { slug } from '../public/cars.js';
import { learnTones } from './lib/tone-learn.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const dir = path.resolve(ROOT, opt('dir', 'samples/dr2'));
const manifest = JSON.parse(readFileSync(path.resolve(ROOT, opt('manifest', 'samples/dr2-cars.json')), 'utf8'));
const only = opt('only') ? new Set(opt('only').split(',').map(Number)) : null;
const auto = opt('cylinders') === 'auto';
const trial = opt('cfg') ? JSON.parse(opt('cfg')) : null; // settings to try, e.g. --cfg '{"tracker":{"tau":0.03}}' (writes results-rpm-some.md)
const tonesMode = opt('tones', 'learned'), BLOCK = 4; // s: with --tones split, even blocks teach and odd ones are scored
const profilesFile = path.join(dir, 'car-profiles.json');
const learned = tonesMode === 'learned' && !auto && existsSync(profilesFile) ? loadProfiles(JSON.parse(readFileSync(profilesFile, 'utf8'))) : null;
const KEYS = ['fused', 'pd', 'gyro'], NAMES = { fused: 'combined', pd: 'pitch', gyro: 'gyroball' };
const TOL = 0.06, NEAR = 0.15, FAST = 0.75;

const todo = manifest.cars.map((car, i) => ({ car, n: i + 1, file: path.join(dir, fileFor(car, i)) }))
  .filter(x => (!only || only.has(x.n)) && existsSync(x.file) && (auto || x.car.cylinders));
if (!todo.length) { console.error('No car files: run npm run fetch-dr2 first.'); process.exit(1); }

/**
 * right / right but early or late (it matches the reference within NEAR s of now: lag, while the revs
 * jump) / a tone too low or too high (a simple ratio of the true revs) / elsewhere / no reading
 */
function grade(v, truth, around) {
  if (v == null) return 'none';
  const q = v / truth;
  if (Math.abs(q - 1) <= TOL) return 'right';
  if (around.some(x => x && Math.abs(v / x - 1) <= TOL)) return 'timing';
  for (const [name, r] of [['½', 0.5], ['¼', 0.25], ['¾', 0.75], ['⅔', 2 / 3], ['×1.5', 1.5], ['×2', 2]]) if (Math.abs(q / r - 1) <= TOL * 0.7) return name;
  return 'other';
}

const rows = [];
for (const { car, n, file } of todo) {
  const { fs, samples } = readWav(file), ref = referenceRpm(samples, fs, { cylinders: car.cylinders });
  writeFileSync(file.replace(/\.wav$/i, '.rpm.csv'), referenceCsv(ref, { source: path.basename(file), fs })); // the reference itself, to look at
  // trusted stretches of the reference (see the top of this file)
  const N = car.cylinders, trusted = new Array(ref.rpm.length).fill(false);
  for (const s of ref.stretches) {
    if (!s.sure || (N && ![N, N / 2, 2 * N].includes(s.j))) continue;
    for (let i = Math.round((s.from - ref.t[0]) / REF.hop); i <= Math.round((s.to - ref.t[0]) / REF.hop); i++) trusted[i] = true;
  }
  const index = t => Math.round((t - ref.t[0]) / REF.hop), span = Math.round(NEAR / REF.hop);
  const at = t => { const i = index(t); return i >= 0 && i < ref.rpm.length && trusted[i] ? ref.rpm[i] : null; };
  const around = t => ref.rpm.slice(Math.max(0, index(t) - span), index(t) + span + 1);
  /** Are the revs moving fast here (per s, log)? */
  const moving = t => { const i = index(t), a = ref.rpm[i - 3], b = ref.rpm[i + 3]; return a && b ? Math.abs(Math.log(b / a)) / (6 * REF.hop) > FAST : false; };
  const key = slug(car.car), split = tonesMode === 'split' && !auto && N;
  const odd = t => Math.floor(t / BLOCK) % 2 === 1;
  /** One pass of the detectors over the clip, with that tone map (or none), scored where `keep` says. */
  const score = (map, keep = () => true) => {
    const tally = Object.fromEntries(KEYS.map(k => [k, {}])), pace = { steady: [0, 0], moving: [0, 0] }; // pace: [steps, steps where the combined rpm is right]
    let scored = 0;
    const cfg = { cylinders: auto ? 'auto' : car.cylinders, autoCandidates: CYLINDERS.filter(c => c <= 8), idle: 800, redline: 9000, carKey: key, ...(car.scale && !auto ? { scale: { gyro: car.scale, pd: car.scale } } : null), ...trial };
    replay(samples, fs, cfg, (t, r) => {
      const truth = at(t);
      if (truth === null || !keep(t)) return;
      scored++;
      const near = around(t);
      for (const k of KEYS) { const g = grade(r[k]?.rpm, truth, near); tally[k][g] = (tally[k][g] || 0) + 1; }
      const p = pace[moving(t) ? 'moving' : 'steady'];
      p[0]++; if (grade(r.fused?.rpm, truth, []) === 'right') p[1]++;
    }, 256, pipe => { if (map) pipe.tones = { [key]: [map].flat() }; });
    return { tally, pace, scored };
  };
  // the tone map: none, the one learned by npm run learn-cars, or one learned here from the even blocks only
  const known = learned?.cars[key]?.tones;
  const map = split ? learnTones(samples, fs, N, { ref, keep: t => !odd(t) }).map : known?.length ? known : null;
  const plain = split ? score(null, odd) : null; // the same scored moments, without the map
  const { tally, pace, scored } = score(map, split ? odd : undefined);
  const sureShare = trusted.filter(Boolean).length / trusted.length;
  const orders = {};
  for (const s of ref.stretches) if (s.sure && (!N || [N, N / 2, 2 * N].includes(s.j))) orders[s.j] = (orders[s.j] || 0) + (s.to - s.from);
  const share = (k, g) => (scored ? Math.round((100 * (tally[k][g] || 0)) / scored) : 0);
  rows.push({ n, car: car.car, cylinders: car.cylinders, layout: car.layout, sure: Math.round(100 * sureShare), scored, tally, share, orders, pace, mapped: Boolean(map),
    plain: plain && { ...plain, cylinders: car.cylinders, share: (k, g) => (plain.scored ? Math.round((100 * (plain.tally[k][g] || 0)) / plain.scored) : 0) } });
  console.log(`${String(n).padStart(2)} ${car.car.padEnd(36)} ${String(car.cylinders ?? '?').padStart(2)} cyl · reference sure ${String(Math.round(100 * sureShare)).padStart(3)}% (loudest tone = cycle × ${Object.entries(orders).sort((a, b) => b[1] - a[1]).map(([j]) => j).join(', ') || '?'})` +
    ` · right: ${KEYS.map(k => `${NAMES[k]} ${plain ? `${rows.at(-1).plain.share(k, 'right')} → ` : ''}${share(k, 'right')}%`).join(', ')}${map ? '' : ' · no tone map'}`);
}

const GRADES = ['right', 'timing', '½', '¼', '¾', '⅔', '×1.5', '×2', 'other', 'none'];
const total = (list, k, g) => { const s = list.reduce((a, r) => a + r.scored, 0); return s ? Math.round((100 * list.reduce((a, r) => a + (r.tally[k][g] || 0), 0)) / s) : 0; };
const paceLine = list => {
  const sum = (k, i) => list.reduce((a, r) => a + r.pace[k][i], 0), all = sum('steady', 0) + sum('moving', 0), pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
  return `Combined rpm right ${pct(sum('steady', 1), sum('steady', 0))}% of the time while the revs are steady, ${pct(sum('moving', 1), sum('moving', 0))}% while they change faster than ${FAST * 100}% per second (${pct(sum('moving', 0), all)}% of the scored time).`;
};
const groupsOf = list => [['all cars', list], ...[4, 5, 6, 8].map(c => [`${c}-cylinder`, list.filter(r => r.cylinders === c)])].filter(([, l]) => l.length);
const tables = (list, label = '') => groupsOf(list).flatMap(([name, l]) => [
  `**${name}${label}** (${l.length} cars)`, '',
  `| | ${GRADES.join(' | ')} |`, `|---|${GRADES.map(() => '---').join('|')}|`,
  ...KEYS.map(k => `| ${NAMES[k]} | ${GRADES.map(g => (g === 'right' ? `**${total(l, k, g)}%**` : `${total(l, k, g)}%`)).join(' | ')} |`), '',
  paceLine(l), '']);
const splitRun = rows.some(r => r.plain), mapped = rows.filter(r => r.mapped).length;
const groups = groupsOf(rows);
const mapNote = auto ? '' : splitRun
  ? ` Tone maps: each car's was learned from every other ${BLOCK} s of its clip; only the rest is scored, first without the maps, then with them.`
  : mapped ? ` With the tone maps of ${mapped} cars from car-profiles.json, which were learned from these same clips (flattering: --tones split is the fair test, --tones off is without).` : ' Without tone maps.';
const lines = [
  `# DiRT Rally 2.0 cars: is the rpm right? ${new Date().toISOString().slice(0, 10)}`, '',
  `${rows.length} cars, cylinder count ${auto ? 'auto-detected' : 'set by hand'}. Each rpm is compared with a reference computed offline from the spacing of the engine's tones, at the moments where that reference is sure and plausible for the car (share of the clip in the per-car table). "Right" = within ${TOL * 100}%; "timing" = it matches the reference of up to ${NEAR} s earlier or later (lag while the revs jump); ½, ¼, ¾… = locked on a lower or higher tone of the engine.${mapNote}`, '',
  ...(splitRun ? tables(rows.map(r => r.plain), ', without the tone maps') : []),
  ...tables(rows, splitRun ? ', with the tone maps' : ''),
  `| # | car | cyl | reference sure | loudest tone (× cycle) | ${splitRun ? 'combined right, no map | ' : ''}combined right | pitch right | gyroball right | combined: most common error |`, `|---|---|---|---|---|---|---|---|---|${splitRun ? '---|' : ''}`,
  ...rows.map(r => {
    const worst = GRADES.slice(1).map(g => [g, r.share('fused', g)]).sort((a, b) => b[1] - a[1])[0];
    return `| ${r.n} | ${r.car} | ${r.cylinders ?? '?'} | ${r.sure}% | ${Object.entries(r.orders).sort((a, b) => b[1] - a[1]).map(([j, s]) => `${j} (${Math.round(s)} s)`).join(', ') || '—'} | ${r.plain ? `${r.plain.share('fused', 'right')}% | ` : ''}${r.share('fused', 'right')}% | ${r.share('pd', 'right')}% | ${r.share('gyro', 'right')}% | ${worst[1] ? `${worst[0]} ${worst[1]}%` : '—'} |`;
  }),
];
// a run on a few cars (--only) must not replace the table of all of them
const outFile = path.join(dir, `results-rpm${auto ? '-auto' : ''}${splitRun ? '-split' : tonesMode === 'off' && !auto ? '-plain' : ''}${only || trial ? '-some' : ''}.md`);
writeFileSync(outFile, lines.join('\n') + '\n');
console.log('\n' + lines.slice(4, 4 + 9 * (splitRun ? 2 : 1) * groups.length).filter(l => /all cars|^\| (combined|pitch|gyroball|\|)|^Combined/.test(l)).slice(0, splitRun ? 12 : 6).join('\n'));
console.log(`Wrote ${path.relative(ROOT, outFile)}`);
