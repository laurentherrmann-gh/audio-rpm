// How right is the rpm on real clips? Scores the live detectors against the offline reference
// (tools/lib/reference.js: rpm from the spacing of the engine's tones), on the cars in samples/dr2/.
//   npm run eval-rpm                     every car, with its real cylinder count set by hand
//   npm run eval-rpm -- --only 20,53     just those cars
//   npm run eval-rpm -- --cylinders auto with cylinder auto-detection instead
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
import { referenceRpm, REF } from './lib/reference.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const dir = path.resolve(ROOT, opt('dir', 'samples/dr2'));
const manifest = JSON.parse(readFileSync(path.resolve(ROOT, opt('manifest', 'samples/dr2-cars.json')), 'utf8'));
const only = opt('only') ? new Set(opt('only').split(',').map(Number)) : null;
const auto = opt('cylinders') === 'auto';
const KEYS = ['fused', 'pd', 'gyro'], NAMES = { fused: 'combined', pd: 'pitch', gyro: 'gyroball' };
const TOL = 0.06;

const todo = manifest.cars.map((car, i) => ({ car, n: i + 1, file: path.join(dir, fileFor(car, i)) }))
  .filter(x => (!only || only.has(x.n)) && existsSync(x.file) && (auto || x.car.cylinders));
if (!todo.length) { console.error('No car files: run npm run fetch-dr2 first.'); process.exit(1); }

/** right / a tone too low or too high (a simple ratio of the true revs) / elsewhere / no reading */
function grade(v, truth) {
  if (v == null) return 'none';
  const q = v / truth;
  if (Math.abs(q - 1) <= TOL) return 'right';
  for (const [name, r] of [['½', 0.5], ['¼', 0.25], ['¾', 0.75], ['⅔', 2 / 3], ['×1.5', 1.5], ['×2', 2]]) if (Math.abs(q / r - 1) <= TOL * 0.7) return name;
  return 'other';
}

const rows = [];
for (const { car, n, file } of todo) {
  const { fs, samples } = readWav(file), ref = referenceRpm(samples, fs);
  // trusted stretches of the reference (see the top of this file)
  const N = car.cylinders, trusted = new Array(ref.rpm.length).fill(false);
  for (const s of ref.stretches) {
    if (!s.sure || (N && ![N, N / 2, 2 * N].includes(s.j))) continue;
    for (let i = Math.round((s.from - ref.t[0]) / REF.hop); i <= Math.round((s.to - ref.t[0]) / REF.hop); i++) trusted[i] = true;
  }
  const at = t => { const i = Math.round((t - ref.t[0]) / REF.hop); return i >= 0 && i < ref.rpm.length && trusted[i] ? ref.rpm[i] : null; };
  const tally = Object.fromEntries(KEYS.map(k => [k, {}]));
  let scored = 0;
  replay(samples, fs, { cylinders: auto ? 'auto' : car.cylinders, autoCandidates: CYLINDERS.filter(c => c <= 8), idle: 800, redline: 9000, ...(car.scale && !auto ? { scale: { gyro: car.scale, pd: car.scale } } : null) }, (t, r) => {
    const truth = at(t);
    if (truth === null) return;
    scored++;
    for (const k of KEYS) { const g = grade(r[k]?.rpm, truth); tally[k][g] = (tally[k][g] || 0) + 1; }
  });
  const sureShare = trusted.filter(Boolean).length / trusted.length;
  const orders = {};
  for (const s of ref.stretches) if (s.sure && (!N || [N, N / 2, 2 * N].includes(s.j))) orders[s.j] = (orders[s.j] || 0) + (s.to - s.from);
  const share = (k, g) => (scored ? Math.round((100 * (tally[k][g] || 0)) / scored) : 0);
  rows.push({ n, car: car.car, cylinders: car.cylinders, layout: car.layout, sure: Math.round(100 * sureShare), scored, tally, share, orders });
  console.log(`${String(n).padStart(2)} ${car.car.padEnd(36)} ${String(car.cylinders ?? '?').padStart(2)} cyl · reference sure ${String(Math.round(100 * sureShare)).padStart(3)}% (loudest tone = cycle × ${Object.entries(orders).sort((a, b) => b[1] - a[1]).map(([j]) => j).join(', ') || '?'})` +
    ` · right: ${KEYS.map(k => `${NAMES[k]} ${share(k, 'right')}%`).join(', ')}`);
}

const GRADES = ['right', '½', '¼', '¾', '⅔', '×1.5', '×2', 'other', 'none'];
const total = (list, k, g) => { const s = list.reduce((a, r) => a + r.scored, 0); return s ? Math.round((100 * list.reduce((a, r) => a + (r.tally[k][g] || 0), 0)) / s) : 0; };
const groups = [['all cars', rows], ...[4, 5, 6, 8].map(c => [`${c}-cylinder`, rows.filter(r => r.cylinders === c)])].filter(([, l]) => l.length);
const lines = [
  `# DiRT Rally 2.0 cars: is the rpm right? ${new Date().toISOString().slice(0, 10)}`, '',
  `${rows.length} cars, cylinder count ${auto ? 'auto-detected' : 'set by hand'}. Each rpm is compared with a reference computed offline from the spacing of the engine's tones, at the moments where that reference is sure and plausible for the car (share of the clip in the per-car table). "Right" = within ${TOL * 100}%; ½, ¼, ¾… = locked on a lower or higher tone of the engine.`, '',
  ...groups.flatMap(([name, list]) => [
    `**${name}** (${list.length} cars)`, '',
    `| | ${GRADES.join(' | ')} |`, `|---|${GRADES.map(() => '---').join('|')}|`,
    ...KEYS.map(k => `| ${NAMES[k]} | ${GRADES.map(g => (g === 'right' ? `**${total(list, k, g)}%**` : `${total(list, k, g)}%`)).join(' | ')} |`), '']),
  '| # | car | cyl | reference sure | loudest tone (× cycle) | combined right | pitch right | gyroball right | combined: most common error |', '|---|---|---|---|---|---|---|---|---|',
  ...rows.map(r => {
    const worst = GRADES.slice(1).map(g => [g, r.share('fused', g)]).sort((a, b) => b[1] - a[1])[0];
    return `| ${r.n} | ${r.car} | ${r.cylinders ?? '?'} | ${r.sure}% | ${Object.entries(r.orders).sort((a, b) => b[1] - a[1]).map(([j, s]) => `${j} (${Math.round(s)} s)`).join(', ') || '—'} | ${r.share('fused', 'right')}% | ${r.share('pd', 'right')}% | ${r.share('gyro', 'right')}% | ${worst[1] ? `${worst[0]} ${worst[1]}%` : '—'} |`;
  }),
];
writeFileSync(path.join(dir, auto ? 'results-rpm-auto.md' : 'results-rpm.md'), lines.join('\n') + '\n');
console.log('\n' + lines.slice(4, 4 + groups.length * 7).join('\n'));
console.log(`Wrote ${path.relative(ROOT, path.join(dir, auto ? 'results-rpm-auto.md' : 'results-rpm.md'))}`);
