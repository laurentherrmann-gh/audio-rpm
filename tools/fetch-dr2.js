// Builds the DiRT Rally 2.0 car-sound set: one WAV per car, cut from the "DiRT Rally 2.0 All Cars Sounds"
// video using the chapter times in samples/dr2-cars.json. Runs on your Mac (needs yt-dlp and ffmpeg:
// `brew install yt-dlp ffmpeg`). The video's audio is downloaded ONCE, then cut locally.
//   npm run fetch-dr2                       download (if needed) + cut every car into samples/dr2/
//   npm run fetch-dr2 -- --source my.m4a    cut from an audio file you already have, no download
//   npm run fetch-dr2 -- --only 20,53       just those cars (numbers as in the manifest, from 1)
//   npm run fetch-dr2 -- --source rec.m4a --offset auto
//        cut from your own recording of the video's playback (e.g. QuickTime recording BlackHole):
//        --offset auto finds where the sound starts (= the video's 0:00); or give seconds
// YouTube's terms only allow downloading through YouTube's own features: using yt-dlp is your call.
// The audio files stay local (samples/dr2/ is git-ignored).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = name => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : null; };
const manifest = JSON.parse(readFileSync(path.resolve(ROOT, opt('manifest') || 'samples/dr2-cars.json'), 'utf8'));
const OUT = path.resolve(ROOT, opt('dir') || 'samples/dr2');
const only = opt('only') ? new Set(opt('only').split(',').map(Number)) : null;

// ffmpeg takes -version, yt-dlp --version
const has = (cmd, flag = '--version') => spawnSync(cmd, [flag], { stdio: 'ignore' }).status === 0;
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`${cmd} failed (exit ${r.status})`);
};
export const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const fileFor = (car, i) => `${String(i + 1).padStart(2, '0')}-${slug(car.car)}.wav`;

/** Time (s) at which the sound starts: end of the leading silence, via ffmpeg silencedetect. */
function soundStart(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-t', '120', '-i', file, '-af', 'silencedetect=noise=-50dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8' });
  const log = r.stderr || '';
  const first = log.match(/silence_start: ([\d.]+)/), end = log.match(/silence_end: ([\d.]+)/);
  if (!first || Number(first[1]) > 0.05 || !end) return 0; // no leading silence
  return Number(end[1]);
}

function main() {
  if (!has('ffmpeg', '-version')) { console.error('ffmpeg not found: brew install ffmpeg'); process.exit(1); }
  mkdirSync(OUT, { recursive: true });

  let source = opt('source');
  if (!source) {
    source = readdirSync(OUT).filter(f => f.startsWith('full.')).map(f => path.join(OUT, f))[0];
    if (!source) {
      if (!has('yt-dlp')) { console.error('yt-dlp not found: brew install yt-dlp   (or pass --source <audio file>)'); process.exit(1); }
      console.log(`Downloading the audio of ${manifest.source} (once) …`);
      run('yt-dlp', ['-f', 'bestaudio', '--no-playlist', '-o', path.join(OUT, 'full.%(ext)s'), manifest.source]);
      source = readdirSync(OUT).filter(f => f.startsWith('full.')).map(f => path.join(OUT, f))[0];
      if (!source) throw new Error('download finished but no samples/dr2/full.* file was found');
    } else console.log(`Using the audio already downloaded: ${path.relative(ROOT, source)}`);
  }

  let offset = 0;
  if (opt('offset') === 'auto') {
    offset = soundStart(source);
    console.log(`Sound starts at ${offset.toFixed(2)} s in ${path.basename(source)}: taken as the video's 0:00.`);
  } else if (opt('offset')) offset = Number(opt('offset'));

  let made = 0, kept = 0;
  manifest.cars.forEach((car, i) => {
    if (only && !only.has(i + 1)) return;
    const out = path.join(OUT, fileFor(car, i));
    if (existsSync(out)) { kept++; return; }
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(car.start + offset), '-to', String(car.end + offset), '-i', source,
      '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-y', out]);
    console.log(`  ${path.basename(out)}  (${car.end - car.start} s, ${car.cylinders ?? '?'} cyl, ${car.layout})`);
    made++;
  });
  console.log(`\n${made} file(s) cut, ${kept} already there → ${path.relative(ROOT, OUT)}/. Next: npm run eval-dr2`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
