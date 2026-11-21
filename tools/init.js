// Gets a fresh clone (or an updated one) ready to run. Safe to run again at any time: each step
// is skipped when it is already done.
//   npm run init                               dependencies, checks, car profiles if the clips are there
//   npm run init -- --source ~/Movies/rec.m4a  also cut your recording of the car-sound video into clips
//   npm run init -- --tests                    also install what the browser test needs (Playwright + Chromium)
// It installs nothing outside this folder: BlackHole and ffmpeg are only checked, with the command to
// install them. (Not `npm init`, which is npm's own command for creating a package.json.)
// No imports from node_modules here: this has to run before they exist.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), has = f => argv.includes(f);
const source = has('--source') ? argv[argv.indexOf('--source') + 1] : null;
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
if (source) {
  const file = path.resolve(source.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
  if (!existsSync(file)) { console.log(`${file}: no such file.`); todo.push('npm run init -- --source <your recording of the video>'); }
  else if (run('npm', ['run', '-s', 'fetch-dr2', '--', '--source', file, '--offset', 'auto'])) done.push(`${clips().length} car clips cut from ${path.basename(file)}`);
  else todo.push('the recording could not be cut: read the messages above (npm run fetch-dr2 -- --source … --check only checks it)');
} else if (clips().length) { console.log(`${clips().length} of ${cars.length} clips are there.`); done.push(`${clips().length} car clips`); }
else {
  console.log('None yet. They are cut from your own recording of the "All Cars Sounds" video and are only\nneeded for car recognition and for measuring on real cars (eval-dr2, eval-cars, eval-rpm).');
  todo.push('optional: npm run init -- --source <your recording of the video>');
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
console.log('\nStart with:  npm start   then open http://localhost:8777 in Chrome.');
