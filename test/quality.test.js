import test from 'node:test';
import assert from 'node:assert/strict';
import { clippedShare, findJoins, findLoop, peakOf, removeLoop } from '../tools/lib/quality.js';
import { makeNoIdleSchedule, synthesize } from '../public/engine-model.js';

const fs = 48000;
// game audio has little hiss; a join only stands out against a smooth waveform
const engine = () => synthesize(makeNoIdleSchedule(), { fs, seconds: 10, cylinders: 4, noise: 0.001 });
/** What a recorder that loses buffers produces: every `every`-th block of `block` samples is missing. */
function dropBlocks(x, block, every) {
  const out = [];
  for (let b = 0; (b + 1) * block <= x.length; b++) if (b % every !== every - 1) out.push(x.subarray(b * block, (b + 1) * block));
  const y = new Float32Array(out.length * block);
  out.forEach((c, i) => y.set(c, i * block));
  return y;
}

test('a clean recording has no joins', () => {
  const j = findJoins(engine(), fs);
  assert.equal(j.dropped, false);
  assert.ok(j.perSecond < 0.5, `${j.perSecond} per second`);
});

test('dropped blocks are found, with their size', () => {
  for (const block of [256, 512, 1024]) {
    const j = findJoins(dropBlocks(engine(), block, 8), fs);
    assert.ok(j.dropped, `block ${block}: ${JSON.stringify(j)}`);
    assert.equal(j.block % block, 0);
    assert.ok(j.share > 0.5);
  }
});

test('pops that are not on a grid are not dropped blocks', () => {
  const x = engine();
  let seed = 3;
  for (let k = 0; k < 40; k++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; x[1000 + (seed % (x.length - 2000))] += 0.5; }
  const j = findJoins(x, fs);
  assert.ok(j.perSecond > 2);
  assert.equal(j.dropped, false);
});

test('clipping is flat tops at the ceiling, not just a level over full scale', () => {
  const x = engine();
  assert.ok(clippedShare(x) < 0.001);
  const loud = x.map(v => v * 20);                                  // far over full scale, nothing cut
  assert.ok(peakOf(loud) > 4);
  assert.ok(clippedShare(loud) < 0.001);
  const cut = loud.map(v => Math.max(-1, Math.min(1, v)));           // the same, cut at full scale
  assert.ok(clippedShare(cut) > 0.2);
});

/** What a recorder that plays its input back into itself records: y[n] = x[n] + g·y[n − D]. */
function loop(x, D, g) {
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] + (i >= D ? g * y[i - D] : 0);
  return y;
}

test('a feedback loop is found (delay and gain) and undone; engine sound alone is not a loop', () => {
  const x = synthesize(makeNoIdleSchedule(), { fs, seconds: 12, cylinders: 4 }).map(v => v * 0.05);
  assert.ok(findLoop(x, fs).similarity < 0.4);
  for (const [D, g] of [[6656, 0.9995], [1999, 0.9], [20000, 0.97]]) {
    const y = loop(x, D, g), l = findLoop(y, fs);
    assert.equal(l.delay, D);
    assert.ok(Math.abs(l.gain - g) < 0.02, `gain ${l.gain} for ${g}`);
    assert.ok(l.similarity > 0.8);
    // undone with the true loop: the original, to rounding; in pieces (streaming) the same as at once
    const clean = removeLoop(y, D, g);
    let err = 0;
    for (let i = 0; i < x.length; i++) err = Math.max(err, Math.abs(clean[i] - x[i]));
    assert.ok(err < 1e-3, `error ${err}`);
    const state = { tail: new Float32Array(D) }, pieces = [];
    for (let i = 0; i < y.length; i += 5000) pieces.push(removeLoop(y.subarray(i, i + 5000), D, g, state));
    let k = 0;
    for (const p of pieces) for (const v of p) { assert.ok(Math.abs(v - clean[k]) < 1e-6); k++; }
    // undone with the estimated loop: no longer repeats itself
    assert.ok(findLoop(removeLoop(y, l.delay, l.gain), fs).similarity < 0.4);
  }
});
