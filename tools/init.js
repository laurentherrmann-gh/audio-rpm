// Gets a fresh clone (or an updated one) ready to run. Safe to run again at any time: each step
// is skipped when it is already done.
//   npm run init                               dependencies, checks, car clips (it asks for your recording of
//                                              the car-sound video; Enter takes ~/Desktop/recording.m4a), car profiles
//   npm run init -- --source ~/Movies/rec.m4a  the same without the question
//   npm run init -- --tests                    also install what the browser test needs (Playwright + Chromium)
// Questions are only asked in a terminal; run from a script it asks nothing and skips the cutting.
// It installs nothing outside this folder: BlackHole and ffmpeg are only checked, with the command to
// install them. (Not `npm init`, which is npm's own command for creating a package.json.)
// No imports from node_modules here: this has to run before they exist.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), has = f => argv.includes(f);
let source = has('--source') ? argv[argv.indexOf('--source') + 1] : null;
const DEFAULT_SOURCE = '~/Desktop/recording.m4a';
const home = p => p.replace(/^~(?=\/|$)/, process.env.HOME ?? '~');
/** Ask in the terminal; null when there is no terminal to ask in. */
let rl = null;
async function ask(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  rl ??= createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(question)).trim(); } catch { console.log(); return null; } // Ctrl+D or Ctrl+C: no answer
}
const at = (...p) => path.join(ROOT, ...p), mtime = f => (existsSync(f) ? statSync(f).mtimeMs : 0);
const run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;
const quiet = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8' }); return r.status === 0 ? r.stdout : null; };

const done = [], todo = [];
const step = name => console.log(`\n— ${name}`);

// 1. Node
step('Node');
const major = Number(process.versions.node.split('.')[0]);
if (major < 18) { console.error(`Node ${process.versions.node}: this needs Node 18 or later.`); process.exit(1); }
console.log(`Node ${process.versions.node}: fine.`);

// 2. Dependencies
step('Dependencies');
const pkg = JSON.parse(readFileSync(at('package.json'), 'utf8'));
const missing = Object.keys(pkg.dependencies ?? {}).filter(d => !existsSync(at('node_modules', d)));
const stale = mtime(at('node_modules', '.package-lock.json')) < Math.max(mtime(at('package.json')), mtime(at('package-lock.json')));
if (missing.length || stale) {
  console.log(missing.length ? `Missing: ${missing.join(', ')}. Running npm install…` : 'package.json changed since the last install. Running npm install…');
  if (!run('npm', ['install'])) { console.error('npm install failed: fix that first, then run npm run init again.'); process.exit(1); }
  done.push('dependencies installed');
} else { console.log('Installed and up to date.'); done.push('dependencies up to date'); }

// 3. What the Mac needs (checked, not installed)
step('Sound capture and tools');
if (process.platform === 'darwin') {
  const audio = quiet('system_profiler', ['SPAudioDataType']);
  if (audio && /BlackHole/i.test(audio)) { console.log('BlackHole: found.'); done.push('BlackHole found'); }
  else { console.log('BlackHole: not found. The page needs it to hear the Mac\'s own sound.'); todo.push('brew install blackhole-2ch   (then the Multi-Output Device: docs/setup.md)'); }
} else console.log('Not a Mac: the page still runs with the simulated engine or a WAV file; live capture needs a loopback input.');
if (quiet('ffmpeg', ['-version'])) console.log('ffmpeg: found.');
else { console.log('ffmpeg: not found. Only needed to cut a recording of the car-sound video into clips.'); if (source) todo.push('brew install ffmpeg'); }

// 4. Car clips (need your own recording of the video: see docs/car-sounds.md)
step('Car clips (samples/dr2/)');
const cars = JSON.parse(readFileSync(at('samples', 'dr2-cars.json'), 'utf8')).cars;
const clips = () => (existsSync(at('samples', 'dr2')) ? readdirSync(at('samples', 'dr2')).filter(f => /^\d\d-.*\.wav$/.test(f) && !f.endsWith('.tacho.wav')) : []);
if (!source) {
  // ask for the recording: always when there are no clips, and only on request when there are
  const n = clips().length;
  let wanted = n === 0;
  if (n) {
    console.log(`${n} of ${cars.length} clips are there.`);
    wanted = /^y/i.test((await ask('Cut them again from a recording? (y/N) ')) ?? '');
  } else console.log('None yet. They are cut from your own recording of the "All Cars Sounds" video (docs/car-sounds.md).');
  if (wanted) {
    const answer = await ask(`Recording of the video (Enter = ${DEFAULT_SOURCE}, s = skip): `);
    if (answer !== null && !/^s(kip)?$/i.test(answer)) source = answer || DEFAULT_SOURCE;
  }
}
if (source) {
  const file = path.resolve(home(source.replace(/^(['"])(.*)\1$/, '$2').replace(/\\ /g, ' ')));
  if (!existsSync(file)) {
    console.log(`${file}: no such file.`);
    if (clips().length) done.push(`${clips().length} car clips (kept)`);
    todo.push(`put your recording at ${DEFAULT_SOURCE} (or give its path) and run npm run init again`);
  }
  else if (run('npm', ['run', '-s', 'fetch-dr2', '--', '--source', file, '--offset', 'auto'])) done.push(`${clips().length} car clips cut from ${path.basename(file)}`);
  else todo.push('the recording could not be cut: read the messages above (npm run fetch-dr2 -- --source … --check only checks it)');
} else if (clips().length) done.push(`${clips().length} car clips`);
else {
  console.log('Skipped. The clips are only needed for car recognition and for measuring on real cars\n(eval-dr2, eval-cars, eval-rpm); the page works without them.');
  todo.push('optional: npm run init again with your recording of the video');
}

// 5. Car profiles (what "Auto · recognise" in the page needs), learned from the clips
step('Car profiles (car recognition)');
const profiles = at('samples', 'dr2', 'car-profiles.json');
if (!clips().length) console.log('No clips, so nothing to learn from: the car picker works, recognition by sound stays off.');
else {
  const newest = Math.max(...clips().map(f => mtime(at('samples', 'dr2', f))), mtime(at('public', 'detectors', 'car-id.js')));
  if (mtime(profiles) >= newest) { console.log('Up to date.'); done.push('car profiles up to date'); }
  else {
    console.log(existsSync(profiles) ? 'Older than the clips or the recognition code. Learning again…' : 'Not learned yet. Learning from the clips…');
    if (run('npm', ['run', '-s', 'learn-cars'])) done.push('car profiles learned');
    else todo.push('npm run learn-cars   (it failed: read the messages above)');
  }
}

// 6. Browser test (only on request: Chromium is a large download)
if (has('--tests')) {
  step('Browser test');
  if (run('npm', ['install', '--no-save', 'playwright']) && run('npx', ['playwright', 'install', 'chromium'])) done.push('Playwright and Chromium installed (npm run test:ui)');
  else todo.push('npm install --no-save playwright && npx playwright install chromium');
}

console.log('\n— Summary');
for (const d of done) console.log(`  ✓ ${d}`);
for (const t of todo) console.log(`  → ${t}`);
rl?.close();
console.log('\nStart with:  npm start   then open http://localhost:8777 in Chrome.');
