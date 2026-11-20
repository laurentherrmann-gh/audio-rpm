// Detection worker: receives audio chunks from the capture worklet (own MessagePort), runs the
// pipeline, and posts results to the page. If detection ever falls behind, chunks that arrived in
// the meantime are all pushed first and only the newest moment is analysed: the backlog is skipped,
// it never turns into lag.
import { Pipeline } from './pipeline.js';

let pipe = null, audioPort = null;
let pending = false, lastT = 0, chunksSinceRun = 0, lastSpectrum = 0, peakRms = 0;

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') {
    pipe = new Pipeline(m.fs, m.D, m.cfg);
    audioPort = m.port;
    audioPort.onmessage = onChunk;
  } else if (m.type === 'config' && pipe) {
    pipe.configure(m.cfg);
  } else if (m.type === 'reset' && pipe) {
    pipe.reset();
  }
};

function onChunk(e) {
  const m = e.data;
  if (m.type !== 'chunk' || !pipe) return;
  pipe.push(m.raw, m.dec);
  lastT = m.t;
  let sum = 0;
  for (let i = 0; i < m.raw.length; i++) sum += m.raw[i] * m.raw[i];
  peakRms = Math.max(peakRms, Math.sqrt(sum / m.raw.length));
  chunksSinceRun++;
  if (!pending) { pending = true; setTimeout(run, 0); }
}

function run() {
  pending = false;
  const skipped = chunksSinceRun - 1;
  chunksSinceRun = 0;
  const r = pipe.step(lastT);
  const now = performance.now();
  if (r.gyro) {
    if (now - lastSpectrum > 33) lastSpectrum = now; // spectrum for the display at ~30 Hz
    else r.gyro.ex = null;
  }
  const levelDb = 20 * Math.log10(Math.max(peakRms, 1e-6)); // input level, for the meter
  peakRms = 0;
  self.postMessage({ type: 'result', t: lastT, skipped, levelDb, gyro: r.gyro, pd: r.pd, cyl: r.cyl });
}
