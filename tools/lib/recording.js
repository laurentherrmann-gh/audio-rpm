// A recording of the game with its telemetry: what the files are, and how sound and packets share a clock.
//
//   <car>--<camera>--<date>.wav             what the Mac played (mono, 32-bit float: the level is kept as it came)
//   <car>--<camera>--<date>.telemetry.csv   one row per packet of the game, timed on the sound's clock
//   <car>--<camera>--<date>.telemetry.bin   the packets as they came (everything the game sends, for later)
//   <car>--<camera>--<date>.json            car, camera, cylinders, the game's idle and max rpm, counts
//
// One pair per car and camera: the same car sounds different from the bonnet and from behind.
// tools/record.js writes them; tools/eval-recording.js scores the detectors against them.
import { existsSync, readFileSync } from 'node:fs';

export const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** Base name (no extension) of a recording made now. */
export function recordingName(car, camera, date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${slug(car) || 'car'}--${slug(camera) || 'camera'}--${stamp}`;
}

/**
 * Wall time ↔ time in the sound.
 *
 * The sound comes in chunks, each a little late (buffers on the way); a packet is stamped when it
 * arrives. A chunk that ends at sample n and arrives at wall time w says "the sound started at
 * w − n / fs, or earlier". The earliest such start is the least delayed one, so the start is the
 * minimum over the chunks; taken per stretch of `span` s, it also follows the drift between the
 * sound card's clock and the computer's. What stays unknown is the constant delay of the capture
 * itself: eval-recording measures it from the sound.
 */
export class ClockMap {
  constructor(fs, span = 20) { this.fs = fs; this.span = span; this.pts = []; this.cur = null; }

  /** A chunk has arrived at wall time w (s); `samples` is the count of all samples so far. */
  add(w, samples) {
    const start = w - samples / this.fs;
    if (!this.cur || w - this.cur.from >= this.span) { this.cur = { from: w, w, start }; this.pts.push(this.cur); }
    else if (start < this.cur.start) { this.cur.start = start; this.cur.w = w; }
  }

  /** Time in the sound (s) of wall time w. */
  audioTime(w) {
    const p = this.pts;
    if (!p.length) return NaN;
    if (p.length === 1 || w <= p[0].w) return w - p[0].start;
    for (let i = 1; i < p.length; i++) {
      if (w <= p[i].w || i === p.length - 1) {
        const a = p[i - 1], b = p[i], u = Math.max(0, Math.min(1, (w - a.w) / Math.max(1e-9, b.w - a.w)));
        return w - (a.start + u * (b.start - a.start));
      }
    }
    return w - p[p.length - 1].start;
  }
}

export const TELEMETRY_COLUMNS = ['t_audio_s', 't_wall_s', 'game_time_s', 'rpm', 'gear', 'speed_ms', 'throttle', 'brake', 'clutch', 'steer', 'distance_m'];

/** One CSV row of a parsed packet. */
export function telemetryRow(tAudio, tWall, p) {
  const f = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');
  return [f(tAudio, 4), f(tWall, 4), f(p.time, 3), f(p.rpm, 0), f(p.gear, 0), f(p.speed, 2), f(p.throttle, 2), f(p.brake, 2), f(p.clutch, 2), f(p.steer, 3), f(p.distance, 1)].join(',');
}

/** WAV header for mono 32-bit float; `samples` may be 0 and patched in later (bytes 4 and 40). */
export function floatWavHeader(fs, samples = 0) {
  const b = Buffer.alloc(44), bytes = samples * 4;
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(fs, 24); b.writeUInt32LE(fs * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40);
  return b;
}

/**
 * The telemetry of a recording.
 * @param {string} base path without extension (or with .wav)
 * @returns {{ meta: object, rows: { t:number, rpm:number, gear:number, speed:number, throttle:number, clutch:number }[] }}
 */
export function readTelemetry(base) {
  base = base.replace(/\.(wav|telemetry\.csv|json)$/i, '');
  const file = base + '.telemetry.csv';
  if (!existsSync(file)) throw new Error(`${file}: not found (a recording is a .wav with its .telemetry.csv beside it)`);
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith('#')), head = lines.shift().split(',');
  const col = name => head.indexOf(name), num = (c, i) => (c[i] === '' || c[i] === undefined ? NaN : Number(c[i]));
  const iT = col('t_audio_s'), iR = col('rpm'), iG = col('gear'), iS = col('speed_ms'), iTh = col('throttle'), iC = col('clutch');
  const rows = lines.map(l => { const c = l.split(','); return { t: num(c, iT), rpm: num(c, iR), gear: num(c, iG), speed: num(c, iS), throttle: num(c, iTh), clutch: num(c, iC) }; })
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.rpm));
  const meta = existsSync(base + '.json') ? JSON.parse(readFileSync(base + '.json', 'utf8')) : {};
  return { meta, rows };
}
