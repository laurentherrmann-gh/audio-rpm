import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gearAt, makeStageSchedule, rpmAt, scheduleDuration, shiftsIn, synthesize } from '../public/engine-model.js';
import { buildDr2Packet } from '../src/dr2-packet.js';
import { ClockMap, readTelemetry, recordingName } from '../tools/lib/recording.js';
import { readWav } from '../tools/lib/audio.js';
import { scoreRecording, trueShifts } from '../tools/eval-recording.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a recording is named after its car and camera', () => {
  assert.equal(recordingName('Škoda Fabia R5', 'Bonnet cam', new Date(2026, 10, 22, 9, 5, 7)), 'skoda-fabia-r5--bonnet-cam--20261122-090507');
});

test('the clock: chunks arrive late by varying amounts, packets are placed in the sound to a few ms', () => {
  // the sound started at wall time 3.2 s; its clock runs 50 ppm fast; chunks arrive 8 to 40 ms late
  const fs = 48000, clock = new ClockMap(fs), start = 3.2, drift = 1 + 50e-6;
  let n = 0, seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0.02; t < 120; t += 0.02) { n = Math.round(t * fs); clock.add(start + t / drift + 0.008 + 0.032 * rand() ** 2, n); }
  for (const t of [1, 30, 60, 119]) {
    const w = start + t / drift + 0.008; // a packet stamped at that moment of the sound, plus the least delay of the capture
    assert.ok(Math.abs(clock.audioTime(w) - t) < 0.004, `at ${t} s: ${clock.audioTime(w)}`);
  }
});

test('a gear change through neutral is one shift; neutral for long is not', () => {
  const rows = [[0, 2], [1, 2], [1.02, 0], [1.1, 3], [3, 3], [3.02, 0], [5, 2], [6, 1]].map(([t, gear]) => ({ t, gear }));
  assert.deepEqual(trueShifts(rows).map(s => [s.t, s.dir]), [[1.1, 'up'], [6, 'down']]);
});

test('scoring against telemetry: the delay of the sound is found, then rpm, gear, shifts and standing are scored', () => {
  const fs = 48000, stage = makeStageSchedule(), T = scheduleDuration(stage), late = 0.05;
  const engine = synthesize(stage, { fs, seconds: T, cylinders: 4 }), samples = new Float32Array(engine.length + Math.round(late * fs));
  samples.set(engine, Math.round(late * fs)); // the sound of a moment comes 50 ms after its packet
  const rows = [];
  for (let t = 0; t < T; t += 1 / 60) rows.push({ t, rpm: rpmAt(stage, t), gear: gearAt(stage, t), speed: rpmAt(stage, t) > 1000 ? 20 : 0, throttle: 0, clutch: 0 });
  const s = scoreRecording({ fs, samples, rows, meta: { cylinders: 4, idleRpm: 900, maxRpm: 7500, maxGears: 5 } });
  assert.ok(Math.abs(s.delay - late) <= 0.02, `delay ${s.delay}`);
  assert.ok(s.rpm.combined.right > 0.93 * s.rpm.combined.n, `rpm right ${s.rpm.combined.right} of ${s.rpm.combined.n}`);
  assert.equal(s.shifts.real, shiftsIn(stage).length);
  assert.ok(s.shifts.found >= s.shifts.real - 1 && s.shifts.false === 0, JSON.stringify(s.shifts));
  assert.ok(s.gear.right > 0.85 * s.gear.n, `gear right ${s.gear.right} of ${s.gear.n}`);
  assert.ok(s.standing.game !== null && s.standing.seen !== null && Math.abs(s.standing.seen - s.standing.game) < 1, JSON.stringify(s.standing));
});

test('npm run record: sound from a command and packets from a socket end up in one recording, on one clock', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'audio-rpm-rec-'));
  const port = await new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  // a stand-in for ffmpeg: a 200 Hz tone as 32-bit float PCM, 10 ms at a time
  const tone = `node -e "let n=0;setInterval(()=>{const b=Buffer.alloc(480*4);for(let i=0;i<480;i++,n++)b.writeFloatLE(0.2*Math.sin(2*Math.PI*200*n/48000),i*4);process.stdout.write(b)},10)"`;
  const rec = spawn('node', ['tools/record.js', '--car', 'Ford Fiesta R5', '--camera', 'Bonnet', '--port', String(port), '--out', dir, '--seconds', '2', '--audio-cmd', tone], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  rec.stdout.on('data', d => { out += d; });
  rec.stderr.on('data', d => { out += d; });
  const sock = createSocket('udp4');
  let k = 0;
  const send = setInterval(() => { k++; sock.send(buildDr2Packet({ time: k / 60, rpm: 3000 + 10 * k, maxRpm: 7500, idleRpm: 900, gear: 2, speed: 15, maxGears: 5 }), port, '127.0.0.1'); }, 1000 / 60);
  const code = await new Promise(res => rec.on('exit', res));
  clearInterval(send); sock.close();
  try {
    assert.equal(code, 0, out);
    const name = out.match(/Wrote (\S+)\.wav/)?.[1];
    assert.ok(name, out);
    const base = path.resolve(ROOT, name), { fs, samples } = readWav(base + '.wav'), { meta, rows } = readTelemetry(base);
    assert.ok(path.basename(base).startsWith('ford-fiesta-r5--bonnet--'));
    assert.equal(fs, 48000);
    assert.ok(samples.length > 1.8 * fs && samples.length < 3.5 * fs, `${samples.length} samples`);
    let peak = 0;
    for (const v of samples) peak = Math.max(peak, Math.abs(v));
    assert.ok(Math.abs(peak - 0.2) < 0.01, 'the sound is kept as it came (32-bit float)');
    assert.deepEqual([meta.car, meta.camera, meta.cylinders, meta.maxGears, meta.idleRpm], ['Ford Fiesta R5', 'Bonnet', 4, 5, 900]);
    assert.ok(rows.length > 60, `${rows.length} packets`);
    assert.ok(rows.every((r, i) => r.t >= 0 && r.t <= samples.length / fs && (i === 0 || r.t >= rows[i - 1].t)), 'packets are timed inside the sound, in order');
    assert.ok(rows.every(r => r.gear === 2 && r.rpm >= 3000), 'and carry what the game said');
    assert.ok(readFileSync(base + '.telemetry.bin').length === rows.length * (10 + 264), 'the packets themselves are kept too');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
