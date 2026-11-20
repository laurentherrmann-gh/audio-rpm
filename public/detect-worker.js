// Detection worker: receives audio chunks from the capture worklet (own MessagePort), runs the
// pipeline, and posts results to the page. If detection ever falls behind, chunks that arrived in
// the meantime are all pushed first and only the newest moment is analysed: the backlog is skipped,
// it never turns into lag.
import { Pipeline } from './pipeline.js';
import { loadProfiles } from './detectors/car-id.js';

let pipe = null, audioPort = null;
let pending = false, lastT = 0, chunksSinceRun = 0, lastSpectrum = 0, peakRms = 0;
let shiftSeen = null; // time of the last shift written to a recording
let rec = null; // { need, got, chunks: Float32Array[], rows: [] } while recording; stops at need or on 'record-stop'

self.onmessage = e => {
  const m = e.data;
  if (m.type === 'init') {
    pipe = new Pipeline(m.fs, m.D, m.cfg);
    if (m.cars) pipe.setCars(loadProfiles(m.cars));
    audioPort = m.port;
    audioPort.onmessage = onChunk;
  } else if (m.type === 'config' && pipe) {
    pipe.configure(m.cfg);
  } else if (m.type === 'cars' && pipe) {
    pipe.setCars(loadProfiles(m.cars));
  } else if (m.type === 'reset' && pipe) {
    pipe.reset();
  } else if (m.type === 'record' && pipe) {
    rec = { need: Math.round(m.seconds * pipe.fs), got: 0, chunks: [], rows: [] };
  } else if (m.type === 'record-stop' && rec) {
    finishRecording();
  }
};

function finishRecording() {
  const samples = new Float32Array(rec.got);
  let o = 0;
  for (const c of rec.chunks) { samples.set(c, o); o += c.length; }
  self.postMessage({ type: 'recording', fs: pipe.fs, samples, rows: rec.rows }, [samples.buffer]);
  rec = null;
}

function onChunk(e) {
  const m = e.data;
  if (m.type !== 'chunk' || !pipe) return;
  pipe.push(m.raw, m.dec);
  lastT = m.t;
  if (rec) { rec.chunks.push(m.raw); rec.got += m.raw.length; } // the worker owns these (transferred)
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
  self.postMessage({ type: 'result', t: lastT, skipped, levelDb, gyro: r.gyro, pd: r.pd, cyl: r.cyl, car: r.car, gear: r.gear });
  if (rec) {
    const f = v => (v == null ? '' : Math.round(v));
    rec.rows.push([lastT.toFixed(4), f(r.pd?.raw), f(r.pd?.rpm), r.pd?.f0 ? r.pd.f0.toFixed(2) : '', f(r.gyro?.raw), f(r.gyro?.rpm),
      r.gyro?.f0 ? r.gyro.f0.toFixed(2) : '', r.cyl.n, r.cyl.locked ?? '', levelDb.toFixed(1),
      r.gear.gear ?? '', ...(r.gear.last && r.gear.last.t !== shiftSeen ? [r.gear.last.dir, r.gear.last.ratio.toFixed(3)] : ['', ''])].join(','));
    shiftSeen = r.gear.last?.t ?? null;
    if (rec.got >= rec.need) finishRecording();
  }
}
