// Writes a synthetic engine WAV from the same model as the in-browser simulator.
// Play it on the Mac (through BlackHole) to test the full capture path without a game.
//   npm run make-wav                          → engine-sweep.wav, 60 s, 4 cylinders
//   npm run make-wav -- --rpm 4000 --seconds 20 --out engine-4000.wav
//   npm run make-wav -- --cylinders 6 --redline 8000
import { writeFileSync } from 'node:fs';
import { makeSchedule, constantSchedule, synthesize } from '../public/engine-model.js';

const args = Object.fromEntries(
  process.argv.slice(2).join(' ').split('--').filter(Boolean).map(s => s.trim().split(/\s+/)),
);
const fs = 48000;
const seconds = Number(args.seconds || 60);
const cylinders = Number(args.cylinders || 4);
const idleRpm = Number(args.idle || 900);
const redline = Number(args.redline || 7500);
const schedule = args.rpm ? constantSchedule(Number(args.rpm), seconds) : makeSchedule({ idleRpm, redline });
const out = args.out || (args.rpm ? `engine-${args.rpm}.wav` : 'engine-sweep.wav');

const samples = synthesize(schedule, { fs, seconds, cylinders });
const n = samples.length;
const wav = Buffer.alloc(44 + n * 2);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + n * 2, 4); wav.write('WAVE', 8);
wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(fs, 24); wav.writeUInt32LE(fs * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write('data', 36); wav.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);

writeFileSync(out, wav);
console.log(`wrote ${out}: ${seconds}s, ${cylinders} cyl, ${args.rpm ? `constant ${args.rpm} rpm` : `sweep ${idleRpm}–${redline} rpm`}`);
