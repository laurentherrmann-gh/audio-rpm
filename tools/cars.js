// Car recognition: learn each car's sound, and measure how well cars are recognised.
//   npm run learn-cars                        learn every car found in samples/dr2/ (cut by npm run fetch-dr2)
//   npm run learn-cars -- --file a.wav b.wav  add your own recordings of a car: made in the page with the
//                                             car picked (audio-rpm-carNN-….wav), or any WAV with --car n
//                                             Recordings with the game's telemetry (npm run record, in recordings/) are
//                                             learned too, one profile part per car and camera: their tone map comes from
//                                             the game's own rpm, and the game's idle, redline and gear count are kept.
//   npm run eval-cars                         learn from the first 60% of each clip, recognise the rest
//   npm run eval-cars -- --file rec.wav       recognise a recording with the learned profiles
// Profiles go to samples/dr2/car-profiles.json (git-ignored with the audio); the page loads them from
// there. They hold band levels only, no audio. eval-cars writes samples/dr2/results-cars.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAR_ID, CarMatcher, distanceTo, learn, loadProfiles, snapshotsOf } from '../public/detectors/car-id.js';
import { carNumberIn, fileFor, slug } from '../public/cars.js';
import { readWav, cylName } from './lib/audio.js';
import { TONES } from '../public/detectors/tones.js';
import { learnTones } from './lib/tone-learn.js';
import { readTelemetry } from './lib/recording.js';
import { scoreRecording } from './eval-recording.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...argv] = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const files = argv.filter(a => /\.wav$/i.test(a)).map(f => path.resolve(f));
const dir = path.resolve(ROOT, opt('dir', 'samples/dr2'));
const manifest = JSON.parse(readFileSync(path.resolve(ROOT, opt('manifest', 'samples/dr2-cars.json')), 'utf8'));
const profilesPath = path.join(dir, 'car-profiles.json');
const recDir = path.resolve(ROOT, opt('recordings', 'recordings'));
const MIN_SNAPSHOTS = 50; // 5 s of sound: less is not enough to learn a car from
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const name = n => (n ? cylName(n) : 'cyl ?');

const carOf = i => ({ ...manifest.cars[i], n: i + 1, key: slug(manifest.cars[i].car) });
const clips = () => manifest.cars.map((c, i) => ({ ...carOf(i), file: path.join(dir, fileFor(c, i)) })).filter(c => existsSync(c.file));
const snapshots = file => { const { fs, samples } = readWav(file); return snapshotsOf(samples, fs); };
const readProfiles = () => (existsSync(profilesPath) ? JSON.parse(readFileSync(profilesPath, 'utf8')) : { version: 1, cars: {} });
function writeProfiles(p) {
  mkdirSync(dir, { recursive: true });
  p.bands = { fLo: CAR_ID.fLo, fHi: CAR_ID.fHi, perOctave: CAR_ID.perOctave };
  p.made = new Date().toISOString();
  writeFileSync(profilesPath, JSON.stringify(p) + '\n');
}
/** Add (or replace) what one recording teaches about a car. */
function addPart(p, car, source, frames, tones = null, extra = null) {
  const entry = (p.cars[car.key] ??= { car: car.car, n: car.n, cylinders: car.cylinders, parts: [] });
  if (car.revs) entry.revs = car.revs; // the game's own idle, redline and gear count, from a recording with telemetry
  const { centroids, spread } = learn(frames);
  entry.parts = entry.parts.filter(x => x.source !== source);
  entry.parts.push({ source, ...extra, seconds: Math.round(frames.length * CAR_ID.every), spread, centroids, ...(tones ? { tones } : null) });
}
/**
 * The car's tone map from one recording (public/detectors/tones.js): how loud each of the engine's
 * tones is, by rpm. It needs the rpm, which the offline reference reads from the sound, so only
 * the stretches where that reference is sure count, and only cars whose cylinder count is known.
 */
function tonesOf(car) {
  if (!car.cylinders) return null;
  const { fs, samples } = readWav(car.file), { map, frames } = learnTones(samples, fs, car.cylinders, car.rpmAt ? { rpmAt: car.rpmAt } : {});
  return frames >= TONES.minFrames ? map : null;
}
const isRecording = file => existsSync(file.replace(/\.wav$/i, '.telemetry.csv'));
/** Recordings with telemetry in recordings/. */
const recordings = () => (existsSync(recDir) ? readdirSync(recDir).filter(f => /\.wav$/i.test(f)).map(f => path.join(recDir, f)).filter(isRecording) : []);
/**
 * A recording with the game's telemetry as a car to learn: which car and camera it says it is, the
 * game's rev limits, and the true rpm at each moment of the sound (the sound's delay behind the
 * packets is measured first, as eval-recording does).
 */
function carOfRecording(file) {
  const { meta, rows } = readTelemetry(file), key = meta.carKey ?? slug(meta.car ?? path.basename(file).split('--')[0]);
  const i = manifest.cars.findIndex(c => slug(c.car) === key), base = i >= 0 ? carOf(i) : { car: meta.car ?? key, n: null, key, cylinders: meta.cylinders ?? null };
  const car = { ...base, file, camera: meta.camera ?? null, recording: true };
  if (meta.idleRpm > 0 && meta.maxRpm > 0) car.revs = { idle: meta.idleRpm, redline: meta.maxRpm, gears: meta.maxGears || null, source: path.basename(file) };
  if (rows.length >= 100 && car.cylinders) {
    const { fs, samples } = readWav(file), score = scoreRecording({ fs, samples, rows, meta: { ...meta, cylinders: car.cylinders } });
    car.delay = score.delay;
    car.rpmAt = t => { // the telemetry's rpm at a moment of the sound, where the revs do not move too fast for a spectrum
      const u = t - score.delay;
      let lo = 0, hi = rows.length - 1;
      if (u < rows[0].t || u > rows[hi].t) return null;
      while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rows[m].t <= u) lo = m; else hi = m - 1; }
      const a = rows[lo], b = rows[Math.min(rows.length - 1, lo + 1)];
      if (!(a.rpm > 0) || b.t - a.t > 0.15) return null;
      const w = b.t > a.t ? (u - a.t) / (b.t - a.t) : 0, rpm = a.rpm + w * (b.rpm - a.rpm), far = rows[Math.min(rows.length - 1, lo + 6)];
      return far.t > a.t && Math.abs(Math.log(far.rpm / a.rpm)) / (far.t - a.t) > 1.5 ? null : rpm;
    };
  }
  return car;
}
function carForFile(file) {
  if (isRecording(file)) return carOfRecording(file);
  const n = Number(opt('car')) || carNumberIn(path.basename(file));
  if (!n || !manifest.cars[n - 1]) {
    console.error(`${path.basename(file)}: which car? Record in the page with the car picked (the name then has carNN), or add --car n (number in samples/dr2-cars.json).`);
    process.exit(1);
  }
  return carOf(n - 1);
}

function learnCommand() {
  const p = readProfiles();
  let learned = 0, mapped = 0;
  const todo = files.length ? files.map(file => ({ ...carForFile(file), file })) : [...clips(), ...recordings().map(carOfRecording)];
  if (!todo.length) { console.error(`No car files in ${path.relative(ROOT, dir)}/. Run npm run fetch-dr2 first, or give --file <recording.wav>.`); process.exit(1); }
  for (const car of todo) {
    const frames = snapshots(car.file);
    if (frames.length < MIN_SNAPSHOTS) {
      console.log(`  skipped ${path.basename(car.file)}: ${frames.length ? `only ${(frames.length * CAR_ID.every).toFixed(0)} s of sound` : 'silent'}`);
      continue;
    }
    const tones = tonesOf(car);
    if (tones) mapped++;
    addPart(p, car, path.basename(car.file), frames, tones, car.recording ? { camera: car.camera, truth: car.rpmAt ? 'telemetry' : 'reference' } : null);
    if (car.recording && !files.length) console.log(`\r  ${car.car}, camera "${car.camera}": learned from ${path.basename(car.file)}${tones ? ` (tone map from the game's rpm, the sound ${Math.round((car.delay ?? 0) * 1000)} ms behind it)` : ''}${car.revs ? ` · idle ${car.revs.idle}, redline ${car.revs.redline}, ${car.revs.gears ?? '?'} gears` : ''}${car.n ? '' : ' · not in the car list: the page cannot pick it'}`);
    learned++;
    if (files.length) console.log(`  ${car.car} (${name(car.cylinders)}): learned from ${path.basename(car.file)}, ${(frames.length * CAR_ID.every).toFixed(0)} s of sound${tones ? `, tone map from ${Math.round(tones.n.at(-1) * 0.05)} s of it` : ', no tone map (the rpm could not be read from it)'}`);
    else process.stdout.write(`\r  ${learned} of ${todo.length} cars…`);
  }
  if (!learned) { console.error('Nothing learned.'); process.exit(1); }
  writeProfiles(p);
  const loaded = loadProfiles(p);
  if (!files.length) process.stdout.write('\r');
  console.log(`Learned ${learned} recording(s), a tone map from ${mapped} of them. ${Object.keys(loaded.cars).length} car(s) known, ${Object.values(loaded.cars).filter(c => c.tones).length} with a tone map → ${path.relative(ROOT, profilesPath)}`);
  const alike = soundAlike(loaded);
  if (alike.length) console.log(`Cars that sound alike (recognition can't tell them apart): ${alike.map(a => a.join(' = ')).join('; ')}`);
  console.log('Reload the page and choose car "Auto · recognise".');
}

/** Groups of cars whose profiles are as close to each other as a car is to itself. */
function soundAlike(loaded) {
  const keys = Object.keys(loaded.cars), group = new Map(keys.map(k => [k, k]));
  const find = k => { while (group.get(k) !== k) k = group.get(k); return k; };
  const d = (a, b) => a.centroids.reduce((s, c) => s + distanceTo(c, b.centroids), 0) / a.centroids.length;
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = loaded.cars[keys[i]], b = loaded.cars[keys[j]];
    if (Math.max(d(a, b), d(b, a)) < loaded.sigma2) group.set(find(keys[j]), find(keys[i]));
  }
  const groups = new Map();
  for (const k of keys) { const g = find(k); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(loaded.cars[k].car); }
  return [...groups.values()].filter(g => g.length > 1);
}

/** Run a recording's snapshots through the matcher. */
function recognise(loaded, frames, onSecond) {
  const m = new CarMatcher(loaded);
  let t = 0, known = null, next = 1;
  for (const x of frames) {
    t += CAR_ID.every;
    m.push(t, x);
    if (known === null && m.cylinders) known = t;
    if (onSecond && t >= next - 1e-9) { onSecond(t, m); next += 1; }
  }
  return { m, known, state: m.state() };
}
const candidates = (loaded, st) => st.top.map(x => `${loaded.cars[x.key].car} ${Math.round(x.p * 100)}%`).join(', ') || (st.listening ? 'listening' : 'unknown sound');

function evalFiles() {
  if (!existsSync(profilesPath)) { console.error('No profiles yet: run npm run learn-cars first.'); process.exit(1); }
  const loaded = loadProfiles(readProfiles());
  for (const file of files) {
    const n = Number(opt('car')) || carNumberIn(path.basename(file)), truth = n && manifest.cars[n - 1] ? carOf(n - 1) : null;
    const frames = snapshots(file);
    console.log(`\n${path.basename(file)}: ${(frames.length * CAR_ID.every).toFixed(0)} s of sound${truth ? ` · it is ${truth.car} (${name(truth.cylinders)})` : ''}`);
    if (!frames.length) { console.log('  silent'); continue; }
    const { m, known, state } = recognise(loaded, frames, (t, mm) => {
      const st = mm.state();
      if (t <= 10 || Math.round(t) % 5 === 0) console.log(`  ${String(Math.round(t)).padStart(3)} s  ${candidates(loaded, st)}${st.top.length ? ` · unknown ${Math.round(st.unknown * 100)}%` : ''}`);
    });
    console.log(`  → car: ${m.car ? loaded.cars[m.car].car : 'not named'} · cylinders: ${m.cylinders ? `${name(m.cylinders)}, known after ${known.toFixed(1)} s` : 'not known'}` +
      (truth ? ` · ${m.car === truth.key ? 'right car' : m.car ? 'WRONG car' : 'no car'}${truth.cylinders && m.cylinders ? (m.cylinders === truth.cylinders ? ', right count' : ', WRONG count') : ''}` : ''));
    if (state.unknown > 0.5) console.log('  The sound is unlike every learned car (another camera, another car, or not an engine).');
  }
}

function evalClips() {
  const all = clips().map(c => ({ ...c, frames: snapshots(c.file) })).filter(c => c.frames.length >= 2 * MIN_SNAPSHOTS);
  if (all.length < 2) { console.error(`Need at least two car files with sound in ${path.relative(ROOT, dir)}/ (npm run fetch-dr2).`); process.exit(1); }
  const p = { cars: {} };
  for (const c of all) addPart(p, c, 'first 60%', c.frames.slice(0, Math.floor(c.frames.length * 0.6)));
  const loaded = loadProfiles(p);
  const rows = [], tally = { right: 0, among: 0, none: 0, wrong: 0, cylRight: 0, cylWrong: 0, cylNone: 0, scored: 0 }, times = [];
  for (const c of all) {
    const { m, known, state } = recognise(loaded, c.frames.slice(Math.floor(c.frames.length * 0.6)));
    const among = state.top.some(x => x.key === c.key);
    const car = m.car === c.key ? 'right' : m.car ? 'wrong' : among ? 'among' : 'none';
    tally[car]++;
    let cyl = '·';
    if (c.cylinders) {
      tally.scored++;
      if (m.cylinders === c.cylinders) { cyl = '✓'; tally.cylRight++; times.push(known); } else if (m.cylinders) { cyl = '✗'; tally.cylWrong++; } else { cyl = '—'; tally.cylNone++; }
    }
    rows.push({ c, car, cyl, m, known, heard: candidates(loaded, state) });
    console.log(`${String(c.n).padStart(2)} ${car === 'right' ? '✓' : car === 'wrong' ? '✗' : '~'} ${c.car.padEnd(36)} ${name(c.cylinders).padEnd(6)} → ${(m.car ? loaded.cars[m.car].car : car === 'among' ? 'not sure' : 'no car').padEnd(36)} count ${cyl} ${m.cylinders ? name(m.cylinders) : ''}  [${rows.at(-1).heard}]`);
  }
  times.sort((a, b) => a - b);
  const alike = soundAlike(loaded);
  const lines = [
    `# DiRT Rally 2.0 car recognition, ${new Date().toISOString().slice(0, 10)}`, '',
    `${all.length} cars, each learned from the first 60% of its clip and recognised on the rest (the same camera and the same kind of driving: recordings of your own driving are the harder test).`, '',
    `- Car named and right: **${tally.right}** (${pct(tally.right, all.length)}%) · wrong: **${tally.wrong}** · not sure, right car among the candidates: ${tally.among} · nothing: ${tally.none}`,
    `- Cylinder count (${tally.scored} cars with a known count): **${tally.cylRight} right**, **${tally.cylWrong} wrong**, ${tally.cylNone} not known` +
      (times.length ? ` · known after ${times[times.length >> 1].toFixed(1)} s (median), ${times.at(-1).toFixed(1)} s (slowest)` : ''),
    `- Typical distance of a car to its own profile: ${loaded.sigma2.toFixed(1)} dB²`,
    ...(alike.length ? ['', 'Cars that sound alike:', ...alike.map(g => `- ${g.join(' = ')}`)] : []), '',
    '| # | car | cylinders | car heard | count | known after | candidates at the end |', '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${r.c.n} | ${r.c.car} | ${r.c.cylinders ?? '?'} | ${r.m.car ? `${loaded.cars[r.m.car].car} ${r.car === 'right' ? '✓' : '✗'}` : r.car === 'among' ? 'not sure' : '—'} | ${r.m.cylinders ?? '—'} ${r.cyl} | ${r.known ? r.known.toFixed(1) + ' s' : '—'} | ${r.heard} |`),
  ];
  writeFileSync(path.join(dir, 'results-cars.md'), lines.join('\n') + '\n');
  console.log('\n' + lines.slice(4, 7).join('\n'));
  if (alike.length) console.log(`Cars that sound alike: ${alike.map(a => a.join(' = ')).join('; ')}`);
  console.log(`\nWrote ${path.relative(ROOT, path.join(dir, 'results-cars.md'))}. Send it to Claude.`);
}

if (command === 'learn') learnCommand();
else if (command === 'eval') (files.length ? evalFiles() : evalClips());
else { console.error('usage: node tools/cars.js learn|eval [--file a.wav …] [--car n] [--dir samples/dr2]'); process.exit(1); }
