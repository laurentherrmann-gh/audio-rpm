// Record the game's sound and its telemetry together (PC version of DiRT Rally 2.0, e.g. under CrossOver).
//
//   npm run record -- --car "Ford Fiesta R5" --camera bonnet
//   (drive; Ctrl-C to stop)
//
// The sound is what the Mac plays (BlackHole, as for the page), read through ffmpeg; the telemetry is
// the game's UDP packets (hardware_settings_config.xml: <udp enabled="true" extradata="3"
// ip="127.0.0.1" port="20777" delay="1" />). Both are stamped on one clock, so that the telemetry's
// rpm and gear can be the truth for the sound: see lib/recording.js for the files, and
// `npm run eval-recording` to score the detectors against them. One recording per car and camera.
//
//   --car NAME        the car, as in the game (looked up in samples/dr2-cars.json for its cylinder count)
//   --camera NAME     bonnet, cockpit, chase… (free text: it names the file)
//   --port N          UDP port of the game's telemetry (20777)
//   --forward H:P     also pass every packet on (e.g. to SimHub on another port)
//   --device NAME     audio input to record (BlackHole 2ch)
//   --seconds N       stop by itself after N s
//   --out DIR         where to write (recordings/)
//   --list            print the audio inputs ffmpeg sees, and stop
//   --audio-cmd CMD   instead of ffmpeg on a device: a command that writes mono 32-bit float PCM at
//                     48 kHz to its standard output (other systems, and the tests)
import { spawn, spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDr2Packet } from '../src/dr2-packet.js';
import { ClockMap, TELEMETRY_COLUMNS, floatWavHeader, recordingName, slug, telemetryRow } from './lib/recording.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
const FS = 48000, PORT = Number(opt('port', 20777)), DEVICE = opt('device', 'BlackHole 2ch');
const RPM_DIVISOR = Number(process.env.RPM_DIVISOR || 10);

/** The audio inputs ffmpeg sees on a Mac: [{ index, name }]. */
function audioInputs() {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], { encoding: 'utf8' });
  if (r.error) return null;
  const out = [];
  let audio = false;
  for (const line of (r.stderr || '').split('\n')) {
    if (/AVFoundation audio devices/.test(line)) { audio = true; continue; }
    if (/AVFoundation video devices/.test(line)) { audio = false; continue; }
    const m = audio && line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) out.push({ index: Number(m[1]), name: m[2] });
  }
  return out;
}

if (argv.includes('--list')) {
  const list = audioInputs();
  if (!list) { console.error('ffmpeg not found: brew install ffmpeg'); process.exit(1); }
  console.log(list.length ? list.map(d => `[${d.index}] ${d.name}`).join('\n') : 'ffmpeg lists no audio input (not a Mac, or no permission to use the microphone).');
  process.exit(0);
}

const carName = opt('car'), camera = opt('camera');
if (!carName || !camera) {
  console.error('Say which car and which camera, they name the recording:\n  npm run record -- --car "Ford Fiesta R5" --camera bonnet');
  process.exit(1);
}
// the car's cylinder count, when the list knows the car
let known = null;
try {
  const cars = JSON.parse(readFileSync(path.join(ROOT, 'samples/dr2-cars.json'), 'utf8')).cars, key = slug(carName);
  known = cars.find(c => slug(c.car) === key) ?? cars.filter(c => slug(c.car).includes(key)).sort((a, b) => a.car.length - b.car.length)[0] ?? null;
} catch { /* no list: the count is detected */ }

// ---- the sound ----
let audio;
if (opt('audio-cmd')) audio = spawn(opt('audio-cmd'), { shell: true, stdio: ['ignore', 'pipe', 'inherit'] });
else {
  const list = audioInputs();
  if (!list) { console.error('ffmpeg not found: brew install ffmpeg'); process.exit(1); }
  const dev = list.find(d => d.name.toLowerCase().includes(DEVICE.toLowerCase()));
  if (!dev) {
    console.error(`No audio input named "${DEVICE}".` + (list.length ? ` ffmpeg sees:\n${list.map(d => `  [${d.index}] ${d.name}`).join('\n')}\nPick one with --device.`
      : ' ffmpeg lists none: this needs a Mac (or --audio-cmd), and the terminal needs the permission to use the microphone (System Settings → Privacy & Security → Microphone).'));
    process.exit(1);
  }
  audio = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-fflags', 'nobuffer', '-f', 'avfoundation', '-i', `:${dev.index}`, '-ac', '1', '-ar', String(FS), '-f', 'f32le', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
}

const outDir = path.resolve(ROOT, opt('out', 'recordings'));
mkdirSync(outDir, { recursive: true });
const started = new Date(), base = path.join(outDir, recordingName(known?.car ?? carName, camera, started));
const wav = openSync(base + '.wav', 'w');
writeSync(wav, floatWavHeader(FS, 0));

const t0 = performance.now(), wall = () => (performance.now() - t0) / 1000;
const clock = new ClockMap(FS), packets = [];
let silentFor = 0;
let samples = 0, rest = Buffer.alloc(0), sumSq = 0, sumN = 0, lastSound = null, last = null, perSecond = 0, bad = 0, stopping = false;

const LIMIT = Number(opt('seconds', 0));
audio.stdout.on('data', chunk => {
  if (stopping) return;
  const b = rest.length ? Buffer.concat([rest, chunk]) : chunk, n = Math.floor(b.length / 4);
  rest = b.subarray(n * 4);
  if (!n) return;
  writeSync(wav, b, 0, n * 4);
  for (let i = 0; i < n; i++) { const v = b.readFloatLE(i * 4); sumSq += v * v; }
  sumN += n; samples += n;
  lastSound = wall();
  clock.add(lastSound, samples);
  if (LIMIT > 0 && samples >= LIMIT * FS) stop(0);
});
audio.on('error', e => { console.error('The sound could not be read: ' + e.message); stop(1); });
audio.on('exit', code => { if (!stopping) { console.error(samples ? '\nThe sound stopped.' : `\nNo sound came (the audio command ended${code ? ` with code ${code}` : ''}).`); stop(samples ? 0 : 1); } });

// ---- the telemetry ----
const sock = createSocket('udp4'), fwd = opt('forward') ? opt('forward').split(':') : null, out = fwd ? createSocket('udp4') : null;
sock.on('message', msg => {
  const w = wall();
  if (fwd) out.send(msg, Number(fwd[1]), fwd[0]);
  if (!samples || stopping) return; // before the sound: nothing to time it against
  try { last = parseDr2Packet(msg, { rpmDivisor: RPM_DIVISOR }); packets.push({ w, p: last, raw: Buffer.from(msg) }); perSecond++; } catch { bad++; }
});
sock.on('error', e => { console.error(`UDP port ${PORT}: ${e.message}` + (e.code === 'EADDRINUSE' ? ' (something else is listening there: SimHub, or npm run listen. Stop it, or give SimHub another port and use --forward.)' : '')); stop(1); });
sock.bind(PORT);

console.log(`Recording ${known ? known.car + (known.cylinders ? ` (${known.cylinders} cylinders)` : '') : `"${carName}" (not in the car list: cylinders will be detected)`}, camera "${camera}".`);
console.log(`Sound: ${opt('audio-cmd') ? 'from --audio-cmd' : DEVICE} · telemetry: udp/${PORT}${fwd ? `, passed on to ${fwd.join(':')}` : ''} · Ctrl-C to stop.\n`);

const status = setInterval(() => {
  const t = wall(), db = sumN ? 10 * Math.log10(Math.max(sumSq / sumN, 1e-20)) : null;
  const sound = !samples ? 'no sound yet' : t - lastSound > 2 ? 'sound STOPPED' : db < -100 ? 'sound: silence' : `sound ${db.toFixed(0)} dB`;
  const tele = !last ? `no packet yet on udp/${PORT} (is the game on a stage, with udp enabled in hardware_settings_config.xml?)`
    : `${perSecond} packets/s · ${last.rpm.toFixed(0).padStart(5)} rpm · gear ${last.gear >= 1 && last.gear < 10 ? last.gear.toFixed(0) : last.gear === 0 ? 'N' : 'R'} · ${(last.speed * 3.6).toFixed(0).padStart(3)} km/h`;
  console.log(`${String(Math.floor(t)).padStart(4)} s · ${sound} · ${tele}`);
  // Silence has two causes that look the same from here: nothing is playing (or the Mac's output is not
  // the Multi-Output Device), or macOS has not let this terminal use the microphone, in which case it
  // hands over silence without a word. Say so once.
  silentFor = sound === 'sound: silence' ? silentFor + 1 : 0;
  if (silentFor === 3) console.log('       The input is there but silent. Either nothing is playing through the Multi-Output Device (System Settings → Sound → Output),\n       or this terminal may not use the microphone (System Settings → Privacy & Security → Microphone): macOS then gives silence.');
  sumSq = 0; sumN = 0; perSecond = 0;
}, 1000);

function stop(code) {
  if (stopping) return;
  stopping = true;
  clearInterval(status);
  try { audio.kill('SIGINT'); } catch { /* gone */ }
  try { sock.close(); out?.close(); } catch { /* closed */ }
  writeSync(wav, floatWavHeader(FS, samples), 0, 44, 0);
  closeSync(wav);
  const seconds = samples / FS, rows = packets.map(k => ({ ...k, t: clock.audioTime(k.w) })).filter(k => k.t >= 0 && k.t <= seconds);
  writeFileSync(base + '.telemetry.csv', TELEMETRY_COLUMNS.join(',') + '\n' + rows.map(k => telemetryRow(k.t, k.w, k.p)).join('\n') + '\n');
  // the packets themselves: [time in the sound, float64][length, uint16][bytes]
  const bin = Buffer.alloc(rows.reduce((a, k) => a + 10 + k.raw.length, 0));
  let o = 0;
  for (const k of rows) { bin.writeDoubleLE(k.t, o); bin.writeUInt16LE(k.raw.length, o + 8); k.raw.copy(bin, o + 10); o += 10 + k.raw.length; }
  writeFileSync(base + '.telemetry.bin', bin);
  const lastP = rows.at(-1)?.p;
  writeFileSync(base + '.json', JSON.stringify({
    car: known?.car ?? carName, carKey: slug(known?.car ?? carName), camera, cylinders: known?.cylinders ?? null,
    started: started.toISOString(), fs: FS, seconds: Number(seconds.toFixed(2)), packets: rows.length,
    idleRpm: lastP ? Math.round(lastP.idleRpm) : null, maxRpm: lastP ? Math.round(lastP.maxRpm) : null, maxGears: lastP ? Math.round(lastP.maxGears) : null,
    port: PORT, clock: clock.pts.map(p => [Number(p.w.toFixed(3)), Number(p.start.toFixed(5))]),
  }, null, 1) + '\n');
  const rel = path.relative(ROOT, base);
  console.log(`\n${seconds.toFixed(0)} s of sound, ${rows.length} packets${bad ? ` (${bad} not understood)` : ''}.`);
  if (!rows.length) console.log('No telemetry was recorded: the sound alone cannot be scored. Check the udp line of hardware_settings_config.xml and that nothing else holds the port.');
  console.log(`Wrote ${rel}.wav, .telemetry.csv, .telemetry.bin and .json` + (rows.length && existsSync(base + '.wav') ? `\nNow: npm run eval-recording -- ${rel}.wav` : ''));
  setTimeout(() => process.exit(code), 100);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
