// Score the detectors on a recording that has the game's telemetry beside it (tools/record.js).
//
//   npm run eval-recording -- recordings/ford-fiesta-r5--bonnet--20261122-101500.wav
//
// Here the truth is the game's own rpm and gear, not a reference worked out from the sound: this is
// the measurement the 80 clips cannot give (other people's recordings, engine alone, no gear).
// The sound reaches the recorder later than the packets by a constant the recorder cannot know
// (buffers on the way); it is measured first, as the delay at which the combined rpm agrees best
// with the telemetry, and everything is then scored at that delay.
// Writes <recording>.report.md.   --cylinders auto   detect the count instead of using the car's
//                                 --cfg '{json}'     pipeline settings to try
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav, replay } from './lib/audio.js';
import { readTelemetry } from './lib/recording.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOL = 0.06;      // rpm right: within 6%, as everywhere
const NEAR = 0.35;     // s between a live shift and the true one for it to be that shift
const forward = g => g >= 1 && g <= 9;

/** The telemetry as functions of time in the sound. */
function truthOf(rows) {
  const at = t => { // index of the last row at or before t
    let lo = 0, hi = rows.length - 1;
    if (!rows.length || t < rows[0].t) return -1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rows[m].t <= t) lo = m; else hi = m - 1; }
    return lo;
  };
  return {
    rpm(t) {
      const i = at(t);
      if (i < 0 || i + 1 >= rows.length || rows[i + 1].t - rows[i].t > 0.15) return null;
      const a = rows[i], b = rows[i + 1], u = (t - a.t) / Math.max(1e-9, b.t - a.t);
      return a.rpm + u * (b.rpm - a.rpm);
    },
    row(t) { const i = at(t); return i < 0 || t - rows[i].t > 0.15 ? null : rows[i]; },
  };
}

/** Gear changes of the telemetry, a shift through neutral counted as one: [{ t, dir, from, to }]. */
export function trueShifts(rows) {
  const out = [];
  let gear = null, left = null;
  for (const r of rows) {
    if (!forward(r.gear)) { if (gear !== null && left === null) left = r.t; continue; }
    if (gear !== null && r.gear !== gear && Math.abs(r.gear - gear) === 1 && (left === null || r.t - left < 1)) out.push({ t: r.t, dir: r.gear > gear ? 'up' : 'down', from: gear, to: r.gear });
    gear = r.gear; left = null;
  }
  return out;
}

/**
 * @param {{ fs:number, samples:Float32Array, rows:object[], meta:object, cfg?:object, prepare?:Function }} rec
 * @returns {object} the scores (see the report below for what each is)
 */
export function scoreRecording({ fs, samples, rows, meta = {}, cfg = {}, prepare = null }) {
  const truth = truthOf(rows), steps = [], live = [];
  let seen = null;
  replay(samples, fs, { cylinders: meta.cylinders ?? 'auto', idle: meta.idleRpm || 900, redline: meta.maxRpm || 7500, maxGear: meta.maxGears || 6, carKey: meta.carKey ?? null, ...cfg }, (t, r) => {
    steps.push({ t, at: r.fused.at ?? t, f: r.fused.rpm || 0, pd: r.pd?.rpm || 0, gy: r.gyro?.rpm || 0, gear: r.gear.gear, sure: r.gear.sure, stood: r.gear.stoodAt != null, locked: r.cyl?.locked ?? null });
    const e = r.gear.last;
    if (e && e !== seen) { seen = e; live.push({ at: e.at, t: e.t, dir: e.dir, ratio: e.ratio }); }
  }, 256, prepare);

  // the capture's delay: where the combined rpm agrees best with the telemetry
  const ok = (v, tr) => v > 0 && tr > 0 && Math.abs(v / tr - 1) <= TOL;
  let delay = 0, best = -1;
  for (let L = -0.1; L <= 0.5001; L += 0.01) {
    let n = 0;
    for (let i = 0; i < steps.length; i += 3) if (ok(steps[i].f, truth.rpm(steps[i].at - L))) n++;
    if (n > best) { best = n; delay = L; }
  }
  delay = Math.round(delay * 100) / 100;

  const grade = (v, tr) => { if (!(v > 0)) return 'none'; const q = v / tr; return Math.abs(q - 1) <= TOL ? 'right' : Math.abs(q - 0.5) <= 0.04 ? 'half' : Math.abs(q - 2) <= 0.12 ? 'double' : 'other'; };
  const tally = () => ({ n: 0, right: 0, half: 0, double: 0, other: 0, none: 0 });
  const rpm = { combined: tally(), pitch: tally(), gyroball: tally(), steady: tally(), moving: tally() };
  const gear = { n: 0, right: 0, sureN: 0, sureRight: 0 };
  let stoodLive = null;
  for (const s of steps) {
    if (s.stood && stoodLive === null) stoodLive = s.t;
    const tr = truth.rpm(s.at - delay);
    if (tr > 0) {
      const a = truth.rpm(s.at - delay - 0.05), b = truth.rpm(s.at - delay + 0.05), moving = a > 0 && b > 0 && Math.abs(Math.log(b / a)) / 0.1 > 0.75;
      const g = grade(s.f, tr);
      rpm.combined.n++; rpm.combined[g]++;
      const part = moving ? rpm.moving : rpm.steady;
      part.n++; part[g]++;
    }
    const trNow = truth.rpm(s.t - delay);
    if (trNow > 0) { rpm.pitch.n++; rpm.pitch[grade(s.pd, trNow)]++; rpm.gyroball.n++; rpm.gyroball[grade(s.gy, trNow)]++; }
    const row = truth.row(s.t - delay);
    if (row && forward(row.gear) && row.speed > 1) {
      gear.n++; if (s.gear === row.gear) gear.right++;
      if (s.sure) { gear.sureN++; if (s.gear === row.gear) gear.sureRight++; }
    }
  }

  // shifts: the telemetry's gear changes, on the sound's clock
  const real = trueShifts(rows).map(s => ({ ...s, t: s.t + delay })), used = new Set(), delays = [];
  let found = 0;
  for (const s of real) {
    const k = live.findIndex((e, i) => !used.has(i) && e.dir === s.dir && Math.abs(e.at - s.t) <= NEAR);
    if (k >= 0) { used.add(k); found++; delays.push(live[k].t - s.t); }
  }
  const falseOnes = live.filter((e, i) => !used.has(i) && !real.some(s => Math.abs(e.at - s.t) <= 0.5));
  delays.sort((x, y) => x - y);

  // standing: the game says the car stood (no speed, engine running) for a second
  let stoodTrue = null, since = null;
  for (const r of rows) {
    if (r.speed < 0.5 && r.rpm > 0) { since ??= r.t; if (r.t - since >= 1) { stoodTrue = r.t + delay; break; } } else since = null;
  }
  const idleRows = rows.filter(r => r.speed < 0.5 && r.rpm > 0 && r.throttle < 0.05).map(r => r.rpm).sort((x, y) => x - y);
  return {
    seconds: samples.length / fs, packets: rows.length, delay, rpm, gear,
    shifts: { real: real.length, found, live: live.length, false: falseOnes.length, delay: delays.length ? delays[delays.length >> 1] : null },
    standing: { game: stoodTrue, seen: stoodLive },
    idleHeard: idleRows.length ? idleRows[idleRows.length >> 1] : null,
    cylinders: { set: meta.cylinders ?? null, locked: steps.at(-1)?.locked ?? null },
  };
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');

/** The scores as a short report (markdown lines). */
export function reportLines(name, meta, s) {
  const r = s.rpm, row = (label, t) => `| ${label} | ${pct(t.right, t.n)} | ${pct(t.half, t.n)} | ${pct(t.double, t.n)} | ${pct(t.other, t.n)} | ${pct(t.none, t.n)} |`;
  return [
    `# ${meta.car ?? name}${meta.camera ? `, camera "${meta.camera}"` : ''}: the detectors against the game's telemetry`, '',
    `${name}: ${s.seconds.toFixed(0)} s of sound, ${s.packets} packets. Cylinders: ${s.cylinders.set ?? `auto-detected (${s.cylinders.locked ?? 'no count found'})`}. The sound is ${Math.round(s.delay * 1000)} ms behind the telemetry in this recording (measured, and taken off below).`, '',
    '| rpm, share of the time the engine runs | right (within 6%) | on half | on double | wrong otherwise | no reading |', '|---|---|---|---|---|---|',
    row('**combined**', r.combined), row('combined, revs steady', r.steady), row('combined, revs moving fast', r.moving), row('pitch-detection', r.pitch), row('gyroball', r.gyroball), '',
    `**Gear** right ${pct(s.gear.right, s.gear.n)} of the time the car moves in a forward gear` + (s.gear.sureN ? ` (${pct(s.gear.sureRight, s.gear.sureN)} once it is shown as sure).` : ' (it was never shown as sure).'),
    `**Shifts**: ${s.shifts.found} of ${s.shifts.real} found; ${s.shifts.false} of the ${s.shifts.live} reported are false` + (s.shifts.delay !== null ? `; reported a median ${Math.round(s.shifts.delay * 1000)} ms after the shift.` : '.'),
    `**Standing**: ${s.standing.game === null ? 'the car never stood for a second in this recording' : `the car first stood for a second at ${s.standing.game.toFixed(1)} s`}; ${s.standing.seen === null ? 'it was never seen standing from the sound' : `seen from the sound at ${s.standing.seen.toFixed(1)} s`}.` +
      (s.idleHeard ? ` It idles at ${Math.round(s.idleHeard)} rpm.` : ''),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = (name, d) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : d; };
  const file = argv.find((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  if (!file) { console.error('Which recording?  npm run eval-recording -- recordings/<name>.wav'); process.exit(1); }
  const base = path.resolve(file).replace(/\.(wav|telemetry\.csv|json)$/i, '');
  if (!existsSync(base + '.wav')) { console.error(`${base}.wav: not found`); process.exit(1); }
  const { fs, samples } = readWav(base + '.wav'), { meta, rows } = readTelemetry(base);
  if (rows.length < 10) { console.error('This recording has no telemetry to score against.'); process.exit(1); }
  if (opt('cylinders') === 'auto') meta.cylinders = null;
  // the car's tone maps, if it was learned (npm run learn-cars)
  let maps = null;
  try { maps = JSON.parse(readFileSync(path.join(ROOT, 'samples/dr2/car-profiles.json'), 'utf8')).cars?.[meta.carKey]?.parts?.map(p => p.tones).filter(Boolean); } catch { /* none learned */ }
  const s = scoreRecording({ fs, samples, rows, meta, cfg: opt('cfg') ? JSON.parse(opt('cfg')) : {}, prepare: pipe => { if (maps?.length && meta.carKey) pipe.tones = { [meta.carKey]: maps }; } });
  const lines = reportLines(path.basename(base), meta, s);
  writeFileSync(base + '.report.md', lines.join('\n') + '\n');
  console.log(lines.join('\n') + `\n\nWrote ${path.relative(ROOT, base)}.report.md. Send it to Claude (and the recording, if it is to be learned from).`);
}
