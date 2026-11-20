import { EngineSim } from './engine-sim.js';
import { firingHz, CYLINDERS, RALLY_CYLINDERS } from './engine-model.js';
import { estimateLag } from './lag.js';
import { slug, recordingName } from './cars.js';

const $ = id => document.getElementById(id);
const HIST_S = 20;       // chart window
const STATS_S = 2;       // latency averages
const LAG_S = 8;         // measured-lag window

// ---------- persisted settings (localStorage may be unavailable: never let it throw) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('ab3.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ab3.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const SETTING_IDS = ['cylinders', 'simdrive', 'idle', 'redline', 'maxgear', 'hop', 'predict', 'fft', 'gvariant', 'gmode', 'algo', 'pdmax', 'adaptive', 'tau', 'accel', 'reacq', 'actual'];
const isBox = id => $(id).type === 'checkbox';
const val = id => (isBox(id) ? $(id).checked : $(id).value);
for (const id of SETTING_IDS) {
  const v = store.get(id, null);
  if (v === null) continue;
  if (isBox(id)) $(id).checked = v; else $(id).value = v;
}
$('hear').checked = store.get('hear', false);
$('loopback').checked = store.get('loopback', false);
const feedStored = store.get('feed', 'pd');
document.querySelectorAll('input[name=feed]').forEach(r => { r.checked = r.value === feedStored; });
let scales = store.get('scales', { gyro: 1, pd: 1 });

const num = (id, lo, hi, d) => { const v = Number($(id).value); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
function readSettings() {
  const gm = $('gmode').value;
  return {
    cylinders: $('cylinders').value.startsWith('auto') ? 'auto' : Number($('cylinders').value),
    autoCandidates: $('cylinders').value === 'auto-any' ? CYLINDERS : RALLY_CYLINDERS,
    simdrive: $('simdrive').value,
    idle: num('idle', 300, 3000, 900),
    redline: num('redline', 2000, 20000, 7500),
    maxGear: Math.round(num('maxgear', 3, 8, 6)),
    hop: Number($('hop').value) || 256,
    predict: $('predict').checked,
    fft: Number($('fft').value) || 8192,
    gtuned: $('gvariant').value === 'tuned',
    gmode: gm === 'auto' ? 'auto' : Number(gm),
    algo: $('algo').value,
    pdmax: Number($('pdmax').value) || 0.085,
    adaptive: $('adaptive').checked,
    tau: num('tau', 0, 2, 0.05),
    accel: num('accel', 1000, 200000, 40000),
    reacq: num('reacq', 0.05, 2, 0.25),
  };
}
let S = readSettings();
// Idle and redline are kept per car ('' = no car picked). First run: today's values are the no-car ones.
const profiles = store.get('profiles', {});
if (!profiles['']) profiles[''] = { idle: S.idle, redline: S.redline };
const feed = () => document.querySelector('input[name=feed]:checked').value;
const pipelineCfg = () => ({
  cylinders: S.cylinders, car: $('car').value === 'auto' ? 'auto' : 'off', autoCandidates: S.autoCandidates, idle: S.idle, redline: S.redline, maxGear: S.maxGear, scale: { ...scales }, predict: S.predict,
  gyro: { enabled: true, fft: S.fft, tuned: S.gtuned, mode: S.gmode },
  pd: { enabled: true, algo: S.algo, maxWin: S.pdmax, adaptive: S.adaptive },
  tracker: { tau: S.tau, accel: S.accel, reacq: S.reacq },
});

// ---------- state ----------
let ac = null, stream = null, sim = null, monitor = null, worklet = null, worker = null, nodes = [];
let running = false, captureMs = 0, D = 4, hop = 256;
let history = [];        // chart points
let last = null;         // latest worker result
let lastShift = null;    // latest gear shift, with the wall time it arrived (for the tach's arrow)
const lat = { gyro: [], pd: [] };          // per-result latency samples
const lagPts = { gyro: [], pd: [] };       // {t: audio time at delivery, y}
const measured = { gyro: null, pd: null };

function setMsg(s, isError = false) { $('msg').textContent = s || ''; $('msg').classList.toggle('error', Boolean(s) && isError); }
window.addEventListener('error', e => setMsg('Error: ' + e.message, true));
window.addEventListener('unhandledrejection', e => setMsg('Error: ' + (e.reason?.message || e.reason), true));
function sendConfig() { worker?.postMessage({ type: 'config', cfg: pipelineCfg() }); }

// ---------- car picker: the car gives the cylinder count; idle and redline are remembered per car ----------
let cars = []; // the manifest's cars, plus n (number from 1, as in the tools) and key
let carProfiles = null; // learned sounds (npm run learn-cars), for "Auto · recognise"
let heardCar = null;    // key of the car recognised from the sound
const carByKey = key => cars.find(c => c.key === key) ?? null;
const recognising = () => $('car').value === 'auto';
const carNow = () => carByKey($('car').value);                 // the car picked by hand
const profileKey = () => (recognising() ? heardCar ?? '' : $('car').value); // whose idle and redline are showing
async function loadCars() {
  try {
    const m = await (await fetch('cars.json')).json();
    cars = m.cars.map((c, i) => ({ ...c, n: i + 1, key: slug(c.car) }));
  } catch { return; } // no list: the page works as before, without the picker's cars
  for (const c of [...cars].sort((a, b) => a.car.localeCompare(b.car))) {
    const o = document.createElement('option');
    o.value = c.key; o.textContent = `${c.car} · ${c.cylinders ? cylName(c.cylinders) : 'cyl ?'}`;
    $('car').appendChild(o);
  }
  try {
    const r = await fetch('car-profiles.json');
    const p = r.ok ? await r.json() : null;
    const known = Object.keys(p?.cars || {}).length;
    if (known) {
      carProfiles = p;
      const o = $('car').options[1];
      o.disabled = false; o.textContent = 'Auto · recognise'; o.title = `${known} cars learned`;
      worker?.postMessage({ type: 'cars', cars: p });
    }
  } catch { /* no profiles: recognition stays unavailable */ }
  $('car').value = store.get('car', '');
  if ($('car').value === 'auto' ? !carProfiles : !carNow()) { $('car').value = ''; store.set('car', ''); }
  sendConfig();
}
function applyRevs(key) { // a car's remembered idle and redline (or the no-car ones) into the settings
  const own = profiles[key], p = own ?? profiles[''];
  $('idle').value = p.idle; $('redline').value = p.redline;
  for (const id of ['idle', 'redline']) store.set(id, val(id));
  return { own, text: `idle ${p.idle} · redline ${p.redline} rpm` };
}
/** Auto · recognise: follow what the pipeline hears. */
function onCarHeard(state) {
  const el = $('car-state');
  if (!recognising() || !state) { el.textContent = ''; return; }
  const names = state.top.map(x => carByKey(x.key)?.car ?? x.key);
  const text = state.car ? `→ ${carByKey(state.car)?.car ?? state.car}`
    : state.listening ? 'listening…'
      : state.cylinders && names.length ? `→ ${names.join(' or ')}`
        : names.length ? `${names[0]}? ${Math.round(state.top[0].p * 100)}%` : 'unknown sound';
  if (el.textContent !== text) { el.textContent = text; el.style.color = state.car || state.cylinders ? '' : 'var(--warn)'; }
  if (state.car === heardCar || !state.car) return; // a named car stays until another one is named
  heardCar = state.car;
  const c = carByKey(heardCar), { own, text: revs } = applyRevs(heardCar);
  settingsChanged();
  setMsg(`Recognised ${c?.car ?? heardCar}${c?.cylinders ? ` (${cylName(c.cylinders)})` : ''}: ${revs}${own ? ' as you set them for this car.' : ' (not set for this car yet: change them under Settings and they are remembered for it).'}`);
}
function pickCar() {
  const key = $('car').value, c = carNow();
  store.set('car', key);
  heardCar = null; $('car-state').textContent = '';
  const { own, text: revs } = applyRevs(recognising() ? '' : key);
  $('cylinders').value = c?.cylinders ? String(c.cylinders) : 'auto'; // no car, or count unknown: detect it
  store.set('cylinders', val('cylinders'));
  settingsChanged();
  if (recognising()) setMsg(`Recognising the car from its sound. Until it is recognised: cylinders on Auto, ${revs}.` + (running ? '' : ' Press Start.'));
  else if (!c) setMsg(`No car: cylinders back to Auto, ${revs}.`);
  else setMsg(`${c.car}: ${c.cylinders ? `${cylName(c.cylinders)} (${c.layout})` : `cylinder count not known for the game's model, so Auto detects it`}, ` +
    (own ? `${revs} as you set them for this car.` : `${revs} (not set for this car yet: change them under Settings and they are remembered for it).`));
}
function settingsChanged() {
  const prev = S; S = readSettings();
  $('pd-algo-name').textContent = S.algo;
  if (!running) { drawTach(); return; }
  const simChanged = sim && (prev.simdrive !== S.simdrive || prev.idle !== S.idle || prev.redline !== S.redline);
  if (simChanged || prev.hop !== S.hop) { start(); return; }
  sendConfig();
}

// ---------- inputs ----------
const SIM_OPTIONS = '<optgroup label="Simulated engine (known RPM)">' +
  [[4, '4-cyl'], [5, '5-cyl'], [6, '6-cyl'], [8, 'V8'], [10, 'V10'], [12, 'V12']]
    .map(([n, name]) => `<option value="sim:${n}">Sim ${name}</option>`).join('') +
  '<option value="sim:random">Sim random (count hidden)</option></optgroup>';
let simRandom = null; // { n, revealed, started } when the random engine is playing
async function listInputs(askPermission) {
  if (!navigator.mediaDevices?.enumerateDevices) { setMsg('This page cannot access audio inputs (open it via http://localhost).'); return; }
  if (askPermission) {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); }
    catch (e) { setMsg('Microphone permission refused: ' + e.message); return; }
  }
  // Before microphone access is granted, Chrome lists inputs without names or ids; those can't be
  // opened ("Constraints could not be satisfied"), so only list inputs it actually names.
  const devs = (await navigator.mediaDevices.enumerateDevices())
    .filter(d => d.kind === 'audioinput' && d.deviceId && d.label);
  const sel = $('source');
  let keep = store.get('source', 'sim:4');
  if (keep === 'sim') keep = 'sim:4';
  sel.innerHTML = SIM_OPTIONS;
  const inputs = document.createElement('optgroup');
  inputs.label = 'Audio inputs';
  for (const d of devs) {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label;
    inputs.appendChild(o);
  }
  if (!devs.length && !askPermission) {
    const o = document.createElement('option');
    o.disabled = true; o.textContent = 'click "List inputs"';
    inputs.appendChild(o);
  }
  sel.appendChild(inputs);
  const blackhole = devs.find(d => /blackhole/i.test(d.label));
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  else if (blackhole && askPermission) sel.value = blackhole.deviceId;
  if (askPermission && !blackhole) setMsg('No BlackHole input found: install BlackHole 2ch to capture what the Mac is playing (see README).');
}

// ---------- audio graph: source → [raw, low-passed] → capture worklet → worker ----------
async function start() {
  stop();
  try {
    ac = new AudioContext({ latencyHint: 'interactive' });
    await ac.resume();
    await ac.audioWorklet.addModule('capture-worklet.js');
    const choice = $('source').value;
    const isSim = choice.startsWith('sim:');
    const loop = !isSim && $('loopback').checked;
    let src;
    captureMs = 0;
    simRandom = null;
    if (isSim) {
      let n = Number(choice.slice(4));
      if (choice === 'sim:random') {
        const pool = S.cylinders === 'auto' ? S.autoCandidates : CYLINDERS;
        n = pool[Math.floor(Math.random() * pool.length)];
        simRandom = { n, revealed: false, started: performance.now() };
      }
      sim = new EngineSim(ac, { cylinders: n, idleRpm: S.idle, redline: S.redline, drive: S.simdrive });
      src = sim.output;
      monitor = ac.createGain();
      monitor.gain.value = $('hear').checked ? 1 : 0;
      src.connect(monitor).connect(ac.destination);
    } else {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: {
          deviceId: { exact: choice }, echoCancellation: false, noiseSuppression: false, autoGainControl: false, latency: 0 } });
      } catch (err) {
        if (err.name !== 'OverconstrainedError' && err.name !== 'NotFoundError') throw err;
        // the remembered input is gone or was listed before access was granted: refresh and explain
        stop();
        await listInputs(true);
        setMsg('That input is not available. The list is refreshed: pick your input (e.g. BlackHole 2ch) and press Start again.', true);
        return;
      }
      src = ac.createMediaStreamSource(stream);
      const l = stream.getAudioTracks()[0]?.getSettings?.().latency;
      captureMs = Number.isFinite(l) ? l * 1000 : 0;
      if (loop) { // play the simulated engine to the speakers (and BlackHole); analyse what comes back
        sim = new EngineSim(ac, { cylinders: 4, idleRpm: S.idle, redline: S.redline, drive: S.simdrive });
        sim.output.connect(ac.destination);
      }
    }

    D = 2 ** Math.round(Math.log2(ac.sampleRate / 12000)) || 1;
    hop = S.hop;
    const lp = [0, 1].map(() => ac.createBiquadFilter());
    lp.forEach(f => { f.type = 'lowpass'; f.frequency.value = Math.min(2500, 0.4 * ac.sampleRate / D); f.Q.value = 0.707; });
    worklet = new AudioWorkletNode(ac, 'capture', {
      numberOfInputs: 2, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { hop, D } });
    src.connect(worklet, 0, 0);
    src.connect(lp[0]); lp[0].connect(lp[1]); lp[1].connect(worklet, 0, 1);
    worklet.connect(ac.destination); // silent; keeps the worklet in the render graph
    nodes = [src, ...lp, worklet];

    worker = new Worker('detect-worker.js', { type: 'module' });
    worker.onmessage = onResult;
    worker.onerror = e => setMsg('Detection worker error: ' + (e.message || 'see the browser console'), true);
    const ch = new MessageChannel();
    worklet.port.postMessage({ port: ch.port1 }, [ch.port1]);
    worker.postMessage({ type: 'init', fs: ac.sampleRate, D, cfg: pipelineCfg(), cars: carProfiles, port: ch.port2 }, [ch.port2]);

    history = []; lat.gyro = []; lat.pd = []; lagPts.gyro = []; lagPts.pd = [];
    measured.gyro = measured.pd = null;
    resultsThisSecond = 0; peakLevel = -120; silentSince = 0;
    running = true;
    $('start').textContent = 'Stop';
    const driving = S.simdrive === 'rally' ? 'pulls and gear shifts, never idle'
      : S.simdrive === 'stage' ? 'a stage: standing start, gears 1–5 up and down, stop' : 'idle, four pulls with gear shifts, back to idle';
    setMsg(simRandom ? `Random engine, cylinder count hidden (${driving}). It is revealed once Auto has locked a count.`
      : isSim ? `Simulated ${cylName(sim.cylinders)} engine: ${driving} (loops).`
      : loop ? 'Loopback test: the simulated engine plays on the Mac output and is analysed from the selected input.' : '');
    requestAnimationFrame(draw);
  } catch (e) {
    setMsg('Could not start audio: ' + e.message, true);
    stop();
  }
}

function stop() {
  running = false;
  const w = worker; worker = null;
  if (w && recSince) { // save what was recorded so far, then let the worker go
    w.addEventListener('message', e => { if (e.data.type === 'recording') w.terminate(); });
    w.postMessage({ type: 'record-stop' });
    setTimeout(() => w.terminate(), 3000);
  } else w?.terminate();
  sim?.stop(); sim = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  for (const n of nodes) { try { n.disconnect(); } catch { /* already */ } }
  nodes = [];
  if (ac) ac.close();
  ac = null; monitor = null; worklet = null;
  $('start').textContent = 'Start';
  last = null; lastShift = null;
  drawTach();
}

// ---------- recording: the detectors' input + their readings, click to start, click to stop ----------
const REC_MAX_SECONDS = 120; // a whole DR2 video chapter fits; longer belongs in a real recorder
let recSince = 0; // performance.now() when recording started, 0 when not recording
let recCar = null; // the car picked when recording started
let recTruth = null; // the simulated engine's cylinder count, if the source was a simulator
function toggleRecording() {
  if (recSince) { worker?.postMessage({ type: 'record-stop' }); return; }
  if (!running || !worker) { setMsg('Press Start first: the recorder saves what the detectors are hearing.'); return; }
  worker.postMessage({ type: 'record', seconds: REC_MAX_SECONDS });
  recSince = performance.now();
  recTruth = sim?.cylinders ?? null;
  recCar = carNow();
}
function download(blob, name) {
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function wavBlob(samples, fs) { // 16-bit PCM mono
  const n = samples.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const str = (o, x) => { for (let i = 0; i < x.length; i++) v.setUint8(o + i, x.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, fs, true);
  v.setUint32(28, fs * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), true);
  return new Blob([buf], { type: 'audio/wav' });
}
function saveRecording(m) {
  recSince = 0;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  const label = $('source').selectedOptions[0]?.textContent || 'audio';
  const src = label.replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const c = recCar;
  const base = c ? recordingName(c.n, c.car, stamp) : `audio-rpm-${src}-${stamp}`;
  const settings = { ...S, scales, truthCylinders: recTruth, car: c ? { n: c.n, car: c.car, cylinders: c.cylinders } : null };
  const csv = `# audio-rpm recording ${new Date().toISOString()} · source: ${label}${c ? ` · car #${c.n} ${c.car}` : ''}\n` +
    `# settings: ${JSON.stringify(settings)}\n` +
    't_audio_s,pd_raw_rpm,pd_rpm,pd_hz,gyro_raw_rpm,gyro_rpm,gyro_hz,cyl_used,cyl_locked,level_db,gear,shift,shift_ratio\n' + m.rows.join('\n') + '\n';
  download(wavBlob(m.samples, m.fs), base + '.wav');
  download(new Blob([csv], { type: 'text/csv' }), base + '.csv');
  setMsg(`Saved ${base}.wav (what the detectors heard) and ${base}.csv (their readings) to your Downloads.`);
}

// ---------- results from the worker ----------
let resultsThisSecond = 0, peakLevel = -120, silentSince = 0;
function onResult(e) {
  const m = e.data;
  if (m.type === 'recording') { saveRecording(m); return; }
  if (m.type !== 'result' || !ac) return;
  const tNow = ac.currentTime;
  const wall = performance.now();
  resultsThisSecond++;
  peakLevel = Math.max(peakLevel, m.levelDb);
  if (m.levelDb > -70) silentSince = 0; else if (!silentSince) silentSince = wall;
  const transitMs = (tNow - m.t) * 1000; // chunk's last sample → result on the page

  for (const k of ['gyro', 'pd']) {
    const r = m[k];
    if (!r) continue;
    lat[k].push({ wall, win: r.windowDelayMs, pred: r.predictedMs, comp: r.computeMs, transit: transitMs });
    while (lat[k].length && lat[k][0].wall < wall - STATS_S * 1000) lat[k].shift();
    if (sim) {
      lagPts[k].push({ t: tNow, y: r.rpm });
      while (lagPts[k].length && lagPts[k][0].t < tNow - LAG_S) lagPts[k].shift();
    }
  }
  const truth = sim ? sim.truthAt(tNow) : null;
  history.push({ t: wall, truth, g: m.gyro?.rpm ?? null, gRaw: m.gyro?.raw ?? null, p: m.pd?.rpm ?? null, pRaw: m.pd?.raw ?? null });
  while (history.length && history[0].t < wall - HIST_S * 1000) history.shift();
  if (m.gyro && !m.gyro.ex && last?.gyro) { m.gyro.ex = last.gyro.ex; m.gyro.binHz = last.gyro.binHz; }
  if (m.gear?.last && m.gear.last.t !== lastShift?.t) lastShift = { ...m.gear.last, wall };
  last = { ...m, truth, trueGear: sim?.gearAt(tNow) ?? null };
  onCarHeard(m.car);

  const r = m[feed()];
  if (udpOn && r) sendWs({ type: 'rpm', rpm: r.rpm ?? 0, maxRpm: S.redline, idleRpm: S.idle, gear: m.gear?.gear ?? 0, source: feed() });
}

// once a second: input level, update rate, silent-input hint
setInterval(() => {
  if (!running) { $('level').textContent = '—'; $('level-bar').style.width = '0'; $('rate').textContent = '0'; return; }
  $('rate').textContent = resultsThisSecond;
  $('level').textContent = peakLevel <= -119 ? 'silent' : Math.round(peakLevel) + ' dB';
  $('level-bar').style.width = Math.max(0, Math.min(100, (peakLevel + 80) * 1.25)) + '%';
  $('level-bar').style.background = peakLevel > -3 ? 'var(--bad)' : peakLevel > -70 ? 'var(--gyro)' : 'var(--dim)';
  if (resultsThisSecond === 0) setMsg('The detectors are not receiving audio chunks (audio worklet / worker not running). Open the browser console for details.', true);
  else if (stream && silentSince && performance.now() - silentSince > 2000) {
    setMsg(`No sound is reaching "${$('source').selectedOptions[0]?.textContent}". If it's BlackHole: set System Settings → Sound → Output to your Multi-Output Device (it feeds BlackHole), and play something.`, true);
  } else if ($('msg').classList.contains('error')) setMsg('');
  resultsThisSecond = 0; peakLevel = -120;
}, 1000);

// measured end-to-end lag, once a second (off the audio path)
setInterval(() => {
  if (!sim) return;
  for (const k of ['gyro', 'pd']) {
    const pts = lagPts[k];
    const stride = Math.max(1, Math.floor(pts.length / 500));
    const r = estimateLag(pts.filter((_, i) => i % stride === 0), t => sim.truthAt(t));
    measured[k] = !r ? null : r.match ? r.lag * 1000 : 'nomatch';
  }
}, 1000);

// ---------- WebSocket to the server ----------
let ws = null, udpOn = false;
function sendWs(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { $('ws-dot').classList.add('on'); $('ws-state').textContent = 'server'; };
  ws.onclose = () => {
    $('ws-dot').classList.remove('on'); $('ws-state').textContent = 'server down (npm start?)';
    setTimeout(connect, 1000);
  };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type !== 'status') return;
    udpOn = m.udp;
    $('udp').checked = m.udp;
    $('udp-state').textContent = m.udp ? `→ ${m.target} · ${m.packetsPerSec} pkt/s` : '· UDP paused';
    $('udp-err').textContent = m.error ? ' · UDP error: ' + m.error : '';
  };
}

// ---------- drawing ----------
function setupCanvas(c) {
  // CSS size comes from data-h (fixed) and the layout width; the backing store is that × devicePixelRatio.
  // (Reading the height back from the canvas itself made it double every frame on Retina screens.)
  const dpr = window.devicePixelRatio || 1;
  const h = Number(c.dataset.h);
  if (c.style.height !== h + 'px') c.style.height = h + 'px';
  const w = c.clientWidth;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function drawTach() {
  const { g, w, h } = setupCanvas($('tach'));
  const k = feed(), other = k === 'gyro' ? 'pd' : 'gyro';
  const color = { gyro: css('--gyro'), pd: css('--pd') };
  const rpm = last?.[k]?.rpm ?? null, rpmOther = last?.[other]?.rpm ?? null;
  const max = Math.ceil((S.redline * 1.1) / 1000) * 1000;

  // shift lights: 15 LEDs from 72% to 97% of redline; all flash blue at the limiter
  const n = 15, lo = S.redline * 0.72, hi = S.redline * 0.97, ledW = Math.min(22, (w - 40) / n - 4);
  const x0 = (w - n * (ledW + 4)) / 2, flash = rpm !== null && rpm >= hi && Math.floor(performance.now() / 90) % 2;
  for (let i = 0; i < n; i++) {
    const on = rpm !== null && rpm >= lo + ((hi - lo) * i) / (n - 1);
    const base = i < 5 ? '#34c759' : i < 10 ? '#ffcc00' : '#ff3b30';
    g.fillStyle = flash ? '#3fb9ff' : on ? base : '#1f262e';
    g.beginPath(); g.arc(x0 + i * (ledW + 4) + ledW / 2, 18, ledW / 2, 0, Math.PI * 2); g.fill();
  }

  // dial: 270° sweep
  const cx = w / 2, cy = h * 0.58, R = Math.min(w * 0.4, h * 0.44);
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const ang = v => a0 + (Math.min(Math.max(v, 0), max) / max) * (a1 - a0);
  g.lineCap = 'butt';
  g.lineWidth = 12; g.strokeStyle = '#1f262e'; g.beginPath(); g.arc(cx, cy, R, a0, a1); g.stroke();
  g.strokeStyle = '#ff3b30'; g.beginPath(); g.arc(cx, cy, R, ang(S.redline), a1); g.stroke();
  if (rpm !== null) { g.strokeStyle = color[k] + '55'; g.beginPath(); g.arc(cx, cy, R, a0, ang(rpm)); g.stroke(); }
  g.fillStyle = css('--dim'); g.strokeStyle = css('--dim'); g.font = '600 13px system-ui'; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (let v = 0; v <= max; v += 500) {
    const a = ang(v), major = v % 1000 === 0, r1 = R - 8, r2 = R - (major ? 22 : 15);
    g.lineWidth = major ? 2 : 1;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
    if (major) { g.fillStyle = v >= S.redline ? '#ff6b6b' : css('--dim'); g.fillText(String(v / 1000), cx + Math.cos(a) * (R - 36), cy + Math.sin(a) * (R - 36)); }
  }
  // truth marker on the rim
  if (last?.truth) {
    const a = ang(last.truth);
    g.strokeStyle = css('--truth'); g.lineWidth = 3;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * (R + 9), cy + Math.sin(a) * (R + 9)); g.lineTo(cx + Math.cos(a) * (R - 6), cy + Math.sin(a) * (R - 6)); g.stroke();
  }
  const needle = (v, c, width, len) => {
    const a = ang(v);
    g.strokeStyle = c; g.lineWidth = width; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx - Math.cos(a) * 14, cy - Math.sin(a) * 14); g.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len); g.stroke();
  };
  if (rpmOther !== null) needle(rpmOther, color[other] + 'aa', 2, R - 20);
  needle(rpm ?? 0, rpm === null ? '#3a444f' : '#f5f7fa', 4, R - 12);
  if (!running) { g.fillStyle = css('--dim'); g.font = '13px system-ui'; g.textAlign = 'center'; g.fillText('press Start', cx, cy - R * 0.15); }
  g.fillStyle = color[k]; g.beginPath(); g.arc(cx, cy, 8, 0, Math.PI * 2); g.fill();

  g.textBaseline = 'alphabetic';
  g.fillStyle = rpm === null ? css('--dim') : css('--text');
  g.font = `700 ${Math.round(R * 0.3)}px system-ui`;
  g.fillText(rpm === null ? '—' : Math.round(rpm).toLocaleString(), cx, cy + R * 0.62);
  g.font = '12px system-ui'; g.fillStyle = css('--dim');
  g.fillText('rpm · ' + (k === 'gyro' ? 'gyroball' : 'pitch-detection'), cx, cy + R * 0.62 + 18);
  g.fillText('× 1000', cx, cy - R * 0.38);
  // gear, counted from the shifts ("?" until the car has been standing); an arrow marks a shift
  if (running && last?.gear) {
    const gear = last.gear.gear, fresh = lastShift && performance.now() - lastShift.wall < 600;
    g.font = `700 ${Math.round(R * 0.17)}px system-ui`;
    g.fillStyle = gear === null ? css('--dim') : fresh ? css('--accent') : css('--text');
    g.fillText((gear ?? '?') + (fresh ? (lastShift.dir === 'up' ? ' ▲' : ' ▼') : ''), cx, cy + R * 0.27);
    g.font = '12px system-ui'; g.fillStyle = css('--dim');
    g.textAlign = 'right';
    g.fillText('gear', cx - R * 0.14, cy + R * 0.27);
    g.textAlign = 'left';
    if (last.trueGear && !fresh) g.fillText(`true ${last.trueGear}`, cx + R * 0.14, cy + R * 0.27);
    g.textAlign = 'center';
  }
  g.fillStyle = last?.cyl?.locked || last?.cyl?.fromCar || S.cylinders !== 'auto' ? css('--text') : css('--warn');
  g.fillText(cylText().short, cx, cy - R * 0.38 + 16);
  const m = measured[k];
  if (typeof m === 'number') { g.fillStyle = color[k]; g.fillText(`measured lag ${Math.round(m)} ms`, cx, cy + R * 0.62 + 34); }
  else if (m === 'nomatch') { g.fillStyle = css('--warn'); g.fillText('rpm ≠ truth: wrong cylinder count?', cx, cy + R * 0.62 + 34); }
}

function drawHistory() {
  const { g, w, h } = setupCanvas($('hist'));
  const padL = 44, padB = 4, top = S.redline * 1.15;
  const now = performance.now();
  const X = t => padL + (1 - (now - t) / (HIST_S * 1000)) * (w - padL);
  const Y = v => (h - padB) - (Math.min(v, top) / top) * (h - padB - 6);
  g.strokeStyle = css('--grid'); g.fillStyle = css('--dim'); g.font = '11px system-ui'; g.textAlign = 'right'; g.lineWidth = 1;
  const step = top > 12000 ? 2000 : 1000;
  for (let v = 0; v <= top; v += step) {
    g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(w, Y(v)); g.stroke();
    g.fillText(v / 1000 + 'k', padL - 6, Y(v) + 4);
  }
  const dots = (key, color) => {
    g.fillStyle = color;
    for (let i = 0; i < history.length; i += 2) { const p = history[i]; if (p[key] != null) g.fillRect(X(p.t) - 1, Y(p[key]) - 1, 2, 2); }
  };
  const line = (key, color, width) => {
    g.strokeStyle = color; g.lineWidth = width; g.beginPath();
    let pen = false, prevT = 0;
    for (const p of history) {
      if (p[key] == null) { pen = false; continue; }
      if (!pen || p.t - prevT > 300) g.moveTo(X(p.t), Y(p[key])); else g.lineTo(X(p.t), Y(p[key]));
      pen = true; prevT = p.t;
    }
    g.stroke();
  };
  g.globalAlpha = 0.3; dots('gRaw', css('--gyro')); dots('pRaw', css('--pd')); g.globalAlpha = 1;
  line('truth', css('--truth'), 1.5);
  line('g', css('--gyro'), 2);
  line('p', css('--pd'), 2);
}

function drawSpectrum() {
  const { g, w, h } = setupCanvas($('spec'));
  const gy = last?.gyro;
  if (!gy?.ex) return;
  const fLo = firingHz(S.idle * 0.7, cylNow()), fHi = firingHz(S.redline * 1.15, cylNow());
  const XMAX = Math.max(200, Math.min(1500, fHi * 1.6)), YMAX = 50, padB = 16;
  const X = hz => (hz / XMAX) * w, Y = d => (h - padB) - (Math.max(0, Math.min(YMAX, d)) / YMAX) * (h - padB - 6);
  g.fillStyle = 'rgba(63,185,255,0.07)';
  g.fillRect(X(fLo), 0, X(fHi) - X(fLo), h - padB);
  g.strokeStyle = css('--grid'); g.fillStyle = css('--dim'); g.font = '11px system-ui'; g.textAlign = 'center'; g.lineWidth = 1;
  const tick = XMAX > 800 ? 200 : 100;
  for (let hz = 0; hz <= XMAX; hz += tick) {
    g.beginPath(); g.moveTo(X(hz), 0); g.lineTo(X(hz), h - padB); g.stroke();
    g.fillText(hz + ' Hz', Math.min(w - 22, Math.max(18, X(hz))), h - 3);
  }
  const marker = (hz, color, dash) => {
    if (!hz) return;
    g.strokeStyle = color; g.setLineDash(dash); g.beginPath(); g.moveTo(X(hz), 0); g.lineTo(X(hz), h - padB); g.stroke(); g.setLineDash([]);
  };
  if (last.truth && sim) marker(firingHz(last.truth, sim.cylinders), css('--truth'), [2, 3]);
  if (gy.valid) marker(gy.f0, css('--gyro'), [5, 4]);
  if (last.pd?.valid) marker(last.pd.f0, css('--pd'), [5, 4]);
  g.strokeStyle = '#3fb9ff'; g.lineWidth = 1.2; g.beginPath();
  for (let i = 1; i < gy.ex.length && i * gy.binHz <= XMAX; i++) {
    const x = X(i * gy.binHz), y = Y(gy.ex[i]);
    if (i === 1) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

const cylName = n => (n >= 8 ? `V${n}` : `${n}-cyl`);
const cylNow = () => last?.cyl?.n ?? (S.cylinders === 'auto' ? 4 : S.cylinders);
function cylText() {
  const c = last?.cyl;
  if (c?.fromCar) return { short: `${cylName(c.n)} car`, long: `${cylName(c.n)} (recognised car)` };
  if (S.cylinders !== 'auto') return { short: cylName(S.cylinders), long: `${cylName(S.cylinders)} (${carNow()?.cylinders === S.cylinders ? 'car' : 'manual'})` };
  if (!c || c.locked === null) {
    return { short: 'auto…', long: c?.candidate ? `detecting… (${cylName(c.candidate)}?)` : 'detecting… needs steady revs' };
  }
  return { short: `${cylName(c.locked)} auto`, long: `${cylName(c.locked)} · ${Math.round(c.confidence * 100)}%` };
}

const avg = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const pctl = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const ms = v => (Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)) + ' ms';

function latencyRow(k) {
  const L = lat[k];
  const row = $('lat-' + k).children;
  if (!L.length) { for (let i = 1; i < row.length; i++) row[i].textContent = '—'; $('bar-' + k).innerHTML = ''; return null; }
  const win = avg(L.map(x => x.win)), pred = avg(L.map(x => x.pred));
  const comp = L.map(x => x.comp), compAvg = avg(comp), compP95 = pctl(comp, 0.95);
  const transport = Math.max(0, avg(L.map(x => x.transit)) - compAvg);
  const wait = (hop / ac.sampleRate / 2) * 1000;
  const est = captureMs + win - pred + wait + compAvg + transport;
  const cells = [ms(captureMs), ms(win), pred ? '−' + ms(pred) : 'off', ms(wait), `${compAvg.toFixed(2)} / ${compP95.toFixed(2)} ms`, ms(transport), ms(est),
    measured[k] === 'nomatch' ? 'no match' : measured[k] !== null ? ms(measured[k]) : sim ? 'needs revs…' : 'sim / loopback only'];
  cells.forEach((c, i) => { row[i + 1].textContent = c; });
  return { capture: captureMs, window: Math.max(0, win - pred), wait, comp: compAvg, transport };
}

function drawLatency() {
  if (!ac) return;
  const parts = { pd: latencyRow('pd'), gyro: latencyRow('gyro') };
  const total = p => (p ? p.capture + p.window + p.wait + p.comp + p.transport : 0);
  const scale = Math.max(20, total(parts.pd), total(parts.gyro));
  const colors = { capture: '#8b98a5', window: '#3fb9ff', wait: '#c792ea', comp: '#ffb020', transport: '#ff6b6b' };
  for (const k of ['pd', 'gyro']) {
    const p = parts[k];
    $('bar-' + k).innerHTML = p ? Object.entries(colors).map(([key, c]) => `<span style="width:${(100 * p[key]) / scale}%;background:${c}"></span>`).join('') : '';
  }
  $('lat-scale').textContent = `bar width = ${Math.round(scale)} ms`;
  const notes = [];
  if (sim && stream) notes.push(`Loopback: the measured value includes the Mac's output latency (reported ${ms((ac.outputLatency || ac.baseLatency || 0) * 1000)}); subtract it for capture → RPM.`);
  if (!stream) notes.push('Simulated engine runs inside the page: capture is 0 ms. Use the loopback test to include BlackHole.');
  else if (!captureMs) notes.push('The browser did not report the input latency; the loopback test measures it.');
  if (last?.skipped > 0) notes.push(`Detection fell behind: ${last.skipped} chunk(s) skipped (no added lag). Try a larger chunk.`);
  $('lat-note').textContent = notes.join(' ');
}

function stats(key) {
  let n = 0, locked = 0, err = 0;
  for (const p of history) {
    if (p.truth == null) continue;
    n++;
    if (p[key] != null) { locked++; err += Math.abs(p[key] - p.truth); }
  }
  if (!n) return '';
  if (!locked) return 'vs truth: no lock';
  return `vs truth: ±${Math.round(err / locked)} rpm · locked ${Math.round((100 * locked) / n)}%`;
}

let lastStats = 0;
function drawCards() {
  if (!last) return;
  const show = (k, r) => {
    const el = $(k + '-rpm');
    if (r && r.rpm !== null) { el.textContent = Math.round(r.rpm).toLocaleString(); el.classList.remove('off'); }
    else { el.textContent = '—'; el.classList.add('off'); }
    $(k + '-sub').textContent = !r ? '' : r.coast ? 'holding (reading rejected)'
      : r.valid ? `${r.f0.toFixed(0)} Hz · window ${Math.round(r.winMs)} ms` : 'no clear signal';
  };
  show('gyro', last.gyro); show('pd', last.pd);
  $('cyl-state').textContent = cylText().long;
  $('rec').textContent = recSince ? `■ Stop ${Math.floor((performance.now() - recSince) / 1000)} s` : '● Rec';
  $('rec').style.color = recSince ? 'var(--bad)' : '';
  if (simRandom && !simRandom.revealed) {
    const locked = last.cyl?.locked, waited = (performance.now() - simRandom.started) / 1000;
    if (locked != null || waited > 20) {
      simRandom.revealed = true;
      const real = cylName(simRandom.n);
      setMsg(locked == null ? `Random engine was a ${real}: Auto found no count in 20 s.`
        : locked === simRandom.n ? `Random engine was a ${real}: Auto said ${cylName(locked)} after ${waited.toFixed(1)} s ✓`
          : `Random engine was a ${real}: Auto said ${cylName(locked)} ✗`, locked != null && locked !== simRandom.n);
    }
  }
  $('card-gyro').classList.toggle('selected', feed() === 'gyro');
  $('card-pd').classList.toggle('selected', feed() === 'pd');
  $('truth').textContent = last.truth ? `true rpm ${Math.round(last.truth).toLocaleString()}` : '';
  const now = performance.now();
  if (now - lastStats > 250) {
    lastStats = now;
    $('gyro-err').textContent = sim ? stats('g') : '';
    $('pd-err').textContent = sim ? stats('p') : '';
    drawLatency();
  }
}

function draw() {
  if (!running) return;
  drawTach(); drawCards(); drawHistory(); drawSpectrum();
  requestAnimationFrame(draw);
}

function showScales() {
  $('scales').textContent = `scale: gyroball ×${scales.gyro.toFixed(3)} · pitch ×${scales.pd.toFixed(3)} (1.000 = pure cylinder math)`;
}

// ---------- UI wiring ----------
$('start').onclick = () => {
  if (running) { stop(); return; }
  if (recognising() && heardCar) { heardCar = null; applyRevs(''); S = readSettings(); } // a new run listens afresh
  start();
};
$('refresh').onclick = () => listInputs(true);
$('rec').onclick = toggleRecording;
$('car').onchange = pickCar;
$('source').onchange = () => { store.set('source', $('source').value); if (running) start(); };
$('hear').onchange = () => { store.set('hear', $('hear').checked); if (monitor) monitor.gain.value = $('hear').checked ? 1 : 0; };
$('loopback').onchange = () => { store.set('loopback', $('loopback').checked); if (running && !$('source').value.startsWith('sim:')) start(); };
$('udp').onchange = () => sendWs({ type: 'udp', enabled: $('udp').checked });
document.querySelectorAll('input[name=feed]').forEach(r => { r.onchange = () => store.set('feed', feed()); });
for (const id of SETTING_IDS) {
  $(id).addEventListener('change', () => {
    store.set(id, val(id));
    settingsChanged();
    if (id === 'idle' || id === 'redline') { // typed by the user: remember them for this car
      profiles[profileKey()] = { idle: S.idle, redline: S.redline };
      store.set('profiles', profiles);
    }
  });
}
for (const k of ['gyro', 'pd']) {
  $('cal-' + k).onclick = () => {
    const cur = last?.[k]?.rpm, actual = num('actual', 300, 20000, 3000);
    if (!cur) { setMsg(`No ${k === 'gyro' ? 'gyroball' : 'pitch'} reading to calibrate against: hold steady revs first.`); return; }
    scales[k] = (scales[k] * actual) / cur;
    store.set('scales', scales); showScales(); sendConfig();
    setMsg(`Calibrated ${k}: ${Math.round(cur)} → ${actual} rpm.`);
  };
}
$('cal-reset').onclick = () => { scales = { gyro: 1, pd: 1 }; store.set('scales', scales); showScales(); sendConfig(); };

$('pd-algo-name').textContent = S.algo;
showScales();
connect();
loadCars();
listInputs(false);
drawTach();
window.addEventListener('resize', () => { if (!running) drawTach(); });
