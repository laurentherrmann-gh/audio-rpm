import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDr2Packet, parseDr2Packet, DR2_BYTES } from '../src/dr2-packet.js';

test('packet is 264 bytes with rpm/10 at the offsets DR2 decoders read', () => {
  const buf = buildDr2Packet({ time: 12.5, rpm: 6543, maxRpm: 7500, idleRpm: 900, gear: 3 });
  assert.equal(buf.length, DR2_BYTES);
  assert.equal(DR2_BYTES, 264);
  assert.ok(Math.abs(buf.readFloatLE(148) - 654.3) < 1e-3, 'rpm at bytes 148..152');
  assert.equal(buf.readFloatLE(132), 3, 'gear at bytes 132..136');
  assert.equal(buf.readFloatLE(0), 12.5, 'time at bytes 0..4');
  assert.equal(buf.readFloatLE(252), 750, 'max rpm / 10 at bytes 252..256');
  assert.equal(buf.readFloatLE(256), 90, 'idle rpm / 10 at bytes 256..260');
});

test('parse inverts build', () => {
  const p = parseDr2Packet(buildDr2Packet({ time: 1, rpm: 4321, maxRpm: 8000, idleRpm: 850 }));
  assert.ok(Math.abs(p.rpm - 4321) < 0.1);
  assert.ok(Math.abs(p.maxRpm - 8000) < 0.1);
  assert.ok(Math.abs(p.idleRpm - 850) < 0.1);
});

test('rpm divisor is configurable', () => {
  const buf = buildDr2Packet({ time: 0, rpm: 5000, maxRpm: 7000, idleRpm: 800 }, { rpmDivisor: 1 });
  assert.equal(buf.readFloatLE(148), 5000);
});

test('non-finite values are written as 0, never NaN', () => {
  const buf = buildDr2Packet({ time: NaN, rpm: Infinity, maxRpm: 7000, idleRpm: 800 });
  assert.equal(buf.readFloatLE(0), 0);
  assert.equal(buf.readFloatLE(148), 0);
});
