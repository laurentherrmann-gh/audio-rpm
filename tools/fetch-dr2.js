// Builds the DiRT Rally 2.0 car-sound set: one WAV per car, cut from the "DiRT Rally 2.0 All Cars Sounds"
// video using the chapter times in samples/dr2-cars.json. Runs on your Mac (needs yt-dlp and ffmpeg:
// `brew install yt-dlp ffmpeg`). The video's audio is downloaded ONCE, then cut locally.
//   npm run fetch-dr2                       download (if needed) + cut every car into samples/dr2/
//   npm run fetch-dr2 -- --source my.m4a    cut from an audio file you already have, no download
//   npm run fetch-dr2 -- --only 20,53       just those cars (numbers as in the manifest, from 1)
//   npm run fetch-dr2 -- --source rec.m4a --offset auto
//        cut from your own recording of the video's playback (e.g. QuickTime recording BlackHole):
//        --offset auto finds the video's 0:00 in the recording (where the sound starts, then
//        refined so that the car changes fall where the sound changes); or give seconds
// Every run checks the cut points against the sound: an ad before the video moves the start, and an
// ad or a pause in the middle is reported (only the cars before it are then cut; --all cuts them all).
// A recording that lost sound (the recorder dropped blocks: it runs short and clicks) is refused.
// Clips are always cut afresh, so files from an earlier recording never stay behind.
//   npm run fetch-dr2 -- --source test.m4a --check     only check a recording (any length), cut nothing
// YouTube's terms only allow downloading through YouTube's own features: using yt-dlp is your call.
// The audio files stay local (samples/dr2/ is git-ignored).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slug, fileFor } from '../public/cars.js';
import { snapshotOf, carFftSize } from '../public/detectors/car-id.js';
import { alignToBoundaries, noveltyCurve } from './lib/align.js';
import { clippedShare, findJoins, peakOf } from './lib/quality.js';

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
export { slug, fileFor };

const SILENT_DB = -60; // a recording whose loudest moment is below this has no sound in it
const SEARCH_S = 120;  // --offset auto looks for the start of the sound in the first 2 minutes

/** Time (s) at which the sound starts: end of the leading silence, via ffmpeg silencedetect.
 *  null when the first SEARCH_S seconds are all silence. */
function soundStart(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-t', String(SEARCH_S), '-i', file, '-af', 'silencedetect=noise=-50dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8' });
  const log = r.stderr || '';
  const first = log.match(/silence_start: ([\d.]+)/), end = log.match(/silence_end: ([\d.]+)/);
  if (!first || Number(first[1]) > 0.05) return 0; // no leading silence
  if (!end || Number(end[1]) >= SEARCH_S - 0.5) return null; // silent until the end of the search window
  return Number(end[1]);
}

/** Loudest and mean level of a whole file, in dB (ffmpeg volumedetect). */
function loudness(file) {
  const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr || '';
  const num = re => { const m = log.match(re); return m ? Number(m[1]) : -Infinity; };
  return { max: num(/max_volume: (-?[\d.]+|-inf) dB/), mean: num(/mean_volume: (-?[\d.]+|-inf) dB/) };
}

const SILENT_HELP = `The recording has no sound in it. ffmpeg recorded BlackHole, but the Mac was not playing into
BlackHole. In System Settings > Sound > Output, choose BlackHole 2ch (you won't hear it), or a
Multi-Output Device that includes BlackHole 2ch and your speakers (Audio MIDI Setup), then record again.`;

/** Length (s) and sample rate of an audio file (0 if unknown). */
function info(file) {
  const log = spawnSync('ffmpeg', ['-hide_banner', '-i', file], { encoding: 'utf8' }).stderr || '';
  const m = log.match(/Duration: (\d+):(\d+):([\d.]+)/), r = log.match(/(\d+) Hz/);
  return { seconds: m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0, fs: r ? Number(r[1]) : 0 };
}
const duration = file => info(file).seconds;

/** Lost sound and clipping, from three 30 s excerpts at the recording's own sample rate. */
function checkQuality(file) {
  const { seconds, fs } = info(file);
  if (!seconds || !fs) return null;
  const parts = [0.1, 0.5, 0.9].map(p => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, seconds * p - 15)), '-t', '30', '-i', file, '-ac', '1', '-f', 'f32le', '-'], { maxBuffer: 2 ** 28 });
    const b = r.stdout || Buffer.alloc(0), x = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4)));
    return x.length > fs ? { ...findJoins(x, fs), clipped: clippedShare(x), peak: peakOf(x) } : null;
  }).filter(Boolean);
  if (!parts.length) return null;
  const worst = parts.reduce((a, b) => (b.dropped && (!a.dropped || b.perSecond > a.perSecond) ? b : a));
  return { dropped: parts.some(p => p.dropped), perSecond: worst.perSecond, block: worst.block, fs,
    clipped: Math.max(...parts.map(p => p.clipped)), peak: Math.max(...parts.map(p => p.peak)) };
}

const DROPPED_HELP = `The recorder lost small blocks of sound and joined the rest: the recording runs short, and each join
is a click that breaks the engine's rhythm and colours its tone. It can't be used. ffmpeg's live capture
on macOS does this; record with QuickTime Player instead (File > New Audio Recording, microphone
BlackHole 2ch), then check one minute with --check before recording the whole video.`;

const ALIGN_FS = 22050, ALIGN_HOP = 0.25;
const NEAR = 4; // s: the sound's start is trusted over the car changes when they agree this closely
/** Where the car changes fall in the recording (see lib/align.js); null if the audio can't be read. */
function checkAlignment(file, from, to) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(ALIGN_FS), '-f', 'f32le', '-'], { maxBuffer: 2 ** 31 - 1 });
  if (r.status !== 0 || !r.stdout?.length) return null;
  const b = r.stdout, samples = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length - (b.length % 4)));
  const peak = peakOf(samples);
  const N = carFftSize(ALIGN_FS), frames = [];
  for (let i = 0; ; i++) {
    const end = Math.round(i * ALIGN_HOP * ALIGN_FS);
    if (end > samples.length) break;
    frames.push(end >= N ? snapshotOf(samples.subarray(end - N, end), ALIGN_FS) : null);
  }
  const boundaries = manifest.cars.slice(0, -1).map(c => c.end);
  return { ...alignToBoundaries(noveltyCurve(frames, ALIGN_HOP), ALIGN_HOP, boundaries, { from, to }), boundaries: boundaries.length, peak };
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

  const level = loudness(source);
  if (level.max < SILENT_DB) {
    console.error(`${path.basename(source)}: loudest moment ${level.max} dB.\n${SILENT_HELP}`);
    process.exit(1);
  }

  const q = checkQuality(source);
  if (q?.dropped) {
    console.error(`${path.basename(source)}: sound was lost during the recording, about ${q.perSecond.toFixed(0)} joins per second, on blocks of ${q.block} samples.\n${DROPPED_HELP}`);
    if (!argv.includes('--force')) process.exit(1);
  } else if (q) console.log(`No lost sound found in ${path.basename(source)}.`);
  if (q && q.clipped > 0.001) {
    console.log(`WARNING: ${(100 * q.clipped).toFixed(1)}% of the samples are clipped (the level was too high): lower the player's volume a little and record again for clean sound.`);
  }
  let peak = q?.peak ?? 1; // sound over full scale (some formats keep it) is scaled down when cut
  if (peak > 1) console.log(`The level goes over full scale (×${peak.toFixed(1)}) without being cut off: it is scaled down in the clips.`);
  const length0 = duration(source), clip = manifest.cars[0].end - manifest.cars[0].start;
  if (argv.includes('--check') && length0 < 3 * clip) { // a short test recording: nothing to align
    console.log(q?.dropped ? 'NOT usable.' : q?.clipped > 0.001 ? 'Usable once the level is lowered.' : 'This recorder and these settings are fine for the whole video.');
    return;
  }

  const auto = opt('offset') === 'auto' || argv.includes('--check');
  let offset = 0;
  if (auto) {
    offset = soundStart(source);
    if (offset === null) {
      console.error(`No sound in the first ${SEARCH_S / 60} minutes of ${path.basename(source)}: start the video sooner after ffmpeg, or give --offset <seconds>.`);
      process.exit(1);
    }
    console.log(`Sound starts at ${offset.toFixed(2)} s in ${path.basename(source)}.`);
  } else if (opt('offset')) offset = Number(opt('offset'));

  // do the car changes fall where the sound changes?
  let lastCar = manifest.cars.length;
  console.log('Checking the cut points against the sound …');
  const a = checkAlignment(source, Math.max(0, offset - (auto ? 2 : 20)), offset + (auto ? 180 : 20));
  if (a) peak = Math.max(peak, a.peak);
  if (!a) console.log('  could not read the audio for the check: cutting at the given times.');
  else if (!a.confirmed) {
    console.log(`  The sound does not change clearly at the expected car changes (${a.hits} of ${a.boundaries}), so the cut points` +
      ` can't be confirmed: cutting from ${offset.toFixed(2)} s. Listen to a few clips: each should hold one car, from its start.`);
  } else {
    const late = a.offset - offset;
    if (Math.abs(late) <= NEAR) console.log(`  The car changes confirm a start at ${offset.toFixed(2)} s.`);
    else if (auto) {
      console.log(`  The video starts at ${a.offset.toFixed(2)} s, ${late.toFixed(1)} s after the sound does: something else played first (an ad?).` +
        ` If it lasted more than one clip, every car may be off by one: check that ${fileFor(manifest.cars[0], 0)} is the ${manifest.cars[0].car}.`);
      offset = a.offset;
    } else {
      console.log(`  WARNING: the car changes fit a start at ${a.offset.toFixed(2)} s, not ${offset.toFixed(2)} s. Use --offset auto, or --offset ${a.offset.toFixed(2)}.`);
    }
    console.log(`  Car changes found where expected: ${a.hits} of ${a.boundaries}.`);
    if (a.shift && !argv.includes('--all')) {
      lastCar = a.shift.car;
      console.log(`  WARNING: after car ${a.shift.car}, the car changes come ${Math.abs(a.shift.by)} s ${a.shift.by > 0 ? 'later' : 'earlier'} than expected:` +
        ` an ad or a pause during the recording. Only cars 1–${lastCar} are cut; the others would hold the wrong car or two cars` +
        ` (--all cuts them anyway). Record again without the interruption for the rest.`);
    }
  }

  if (argv.includes('--check')) { console.log('Checked only: nothing was cut.'); return; }

  // cars past the end of the recording are not in it
  const length = duration(source), cut = manifest.cars.filter(c => !length || c.end + offset <= length + 0.5).length;
  if (cut < manifest.cars.length) {
    const video = manifest.cars.at(-1).end;
    console.log(`  The recording is ${(length / 60).toFixed(1)} min long and the video ${(video / 60).toFixed(1)} min: it ends before car ${cut + 1}` +
      ` (${manifest.cars[cut].car}). Cars ${cut + 1}–${manifest.cars.length} are not cut.`);
    lastCar = Math.min(lastCar, cut);
  }

  let made = 0;
  manifest.cars.forEach((car, i) => {
    if ((only && !only.has(i + 1)) || i + 1 > lastCar) return;
    const out = path.join(OUT, fileFor(car, i));
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(car.start + offset), '-to', String(car.end + offset), '-i', source,
      ...(peak > 0.9 ? ['-af', `volume=${(0.7 / peak).toFixed(4)}`] : []), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', '-y', out]);
    console.log(`  ${path.basename(out)}  (${car.end - car.start} s, ${car.cylinders ?? '?'} cyl, ${car.layout})`);
    made++;
  });
  console.log(`\n${made} file(s) cut → ${path.relative(ROOT, OUT)}/. Next: npm run eval-dr2`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
