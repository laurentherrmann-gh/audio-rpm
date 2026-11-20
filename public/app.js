import { analyseSpectrum } from './detectors/gyroball-core.js';
import { detectPitch, decimate } from './detectors/pd-core.js';
import { Tracker } from './tracker.js';
import { EngineSim } from './engine-sim.js';
import { firingHz, rpmFromFiringHz } from './engine-model.js';

const $ = id => document.getElementById(id);
const TICK_MS = 20;      // detector + send rate (50 Hz); the server re-sends to SimHub at 60 Hz
const HIST_S = 20;       // chart window

// ---------- persisted settings (localStorage may be unavailable: never let it throw) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('ab.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ab.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const SETTING_IDS = ['cylinders', 'idle', 'redline', 'fft', 'gvariant', 'gmode', 'algo', 'pdwin', 'tau', 'accel', 'reacq', 'actual'];
for (const id of SETTING_IDS) {
  const v = store.get(id, null);
  if (v !== null) $(id).value = v;
}
$('hear').checked = store.get('hear', false);
const feedStored = store.get('feed', 'gyro');
document.querySelectorAll('input[name=feed]').forEach(r => { r.checked = r.value === feedStored; });
let scales = store.get('scales', { gyro: 1, pd: 1 });

const num = (id, lo, hi, d) => { const v = Number($(id).value); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d; };
function readSettings() {
  const gm = $('gmode').value;
  return {
    cylinders: num('cylinders', 1, 12, 4),
    idle: num('idle', 300, 3000, 900),
    redline: num('redline', 2000, 20000, 7500),
    fft: Number($('fft').value),
    gtuned: $('gvariant').value === 'tuned',
    gmode: gm === 'auto' ? 'auto' : Number(gm),
    algo: $('algo').value,
    pdwin: Number($('pdwin').value),
    tau: num('tau', 0, 2, 0.08),
    accel: num('accel', 1000, 200000, 40000),
    reacq: num('reacq', 0.05, 2, 0.25),
  };
}
let S = readSettings();
const feed = () => document.querySelector('input[name=feed]:checked').value;

// ---------- state ----------
let ac = null, srcNode = null, stream = null, sim = null, monitor = null;
let gAn = null, pAn = null, lp = [], db = null, td = null, dec = null, D = 4;
let timer = null, running = false;
let history = [];
let last = null;
const trackers = { gyro: new Tracker(), pd: new Tracker() };
const lastTracked = { gyro: null, pd: null };

function setMsg(s) { $('msg').textContent = s || ''; }

function applyTrackers() {
  const winS = { gyro: S.fft / (ac ? ac.sampleRate : 48000), pd: S.pdwin / (ac ? ac.sampleRate : 48000) };
  for (const k of ['gyro', 'pd']) {
    trackers[k].set({ tau: S.tau, maxAccel: S.accel, maxVel: S.accel, reacquire: S.reacq, lag: winS[k] / 2 });
  }
}

function band() {
  return { fLo: firingHz(S.idle * 0.7, S.cylinders), fHi: firingHz(S.redline * 1.15, S.cylinders) };
}

// ---------- inputs ----------
async function listInputs(askPermission) {
  if (!navigator.mediaDevices?.enumerateDevices) { setMsg('This page cannot access audio inputs (open it via http://localhost).'); return; }
  if (askPermission) {
    try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()); }
    catch (e) { setMsg('Microphone permission refused: ' + e.message); return; }
  }
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
  const sel = $('source');
  const keep = store.get('source', 'sim');
  sel.innerHTML = '<option value="sim">Simulated engine (known RPM)</option>';
  devs.forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId; o.textContent = d.label || `Input ${i + 1}`;
    sel.appendChild(o);
  });
  const blackhole = devs.find(d => /blackhole/i.test(d.label));
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  else if (blackhole && askPermission) sel.value = blackhole.deviceId;
  if (askPermission && !blackhole) setMsg('No BlackHole input found: install BlackHole 2ch to capture what the Mac is playing (see README).');
}

// ---------- audio graph ----------
function buildAnalysers() {
  for (const n of [gAn, pAn, ...lp]) n?.disconnect();
  D = 2 ** Math.round(Math.log2(ac.sampleRate / 12000)) || 1;
  gAn = ac.createAnalyser();
  gAn.fftSize = S.fft;
  gAn.smoothingTimeConstant = 0; // no extra averaging across frames: the tracker does the smoothing
  db = new Float32Array(gAn.frequencyBinCount);
  const cutoff = Math.min(2500, 0.4 * ac.sampleRate / D);
  lp = [0, 1].map(() => Object.assign(ac.createBiquadFilter(), { type: 'lowpass' }));
  lp.forEach(f => { f.frequency.value = cutoff; f.Q.value = 0.707; });
  pAn = ac.createAnalyser();
  pAn.fftSize = S.pdwin;
  td = new Float32Array(S.pdwin);
  dec = new Float32Array(S.pdwin / D);
  srcNode.connect(gAn);
  srcNode.connect(lp[0]); lp[0].connect(lp[1]); lp[1].connect(pAn);
  applyTrackers();
}

async function start() {
  stop();
  try {
    ac = new AudioContext({ latencyHint: 'interactive' });
    await ac.resume();
    const choice = $('source').value;
    if (choice === 'sim') {
      sim = new EngineSim(ac, { cylinders: S.cylinders, idleRpm: S.idle, redline: S.redline });
      srcNode = sim.output;
      monitor = ac.createGain();
      monitor.gain.value = $('hear').checked ? 1 : 0;
      srcNode.connect(monitor).connect(ac.destination);
    } else {
      stream = await navigator.mediaDevices.getUserMedia({ audio: {
        deviceId: { exact: choice }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      srcNode = ac.createMediaStreamSource(stream);
    }
    buildAnalysers();
    trackers.gyro.reset(); trackers.pd.reset();
    history = [];
    running = true;
    timer = setInterval(tick, TICK_MS);
    $('start').textContent = 'Stop';
    setMsg(choice === 'sim' ? 'Simulated engine: idle, four pulls with gear shifts, back to idle (loops).' : '');
    requestAnimationFrame(draw);
  } catch (e) {
    setMsg('Could not start audio: ' + e.message);
    stop();
  }
}

function stop() {
  clearInterval(timer); timer = null;
  running = false;
  sim?.stop(); sim = null;
  stream?.getTracks().forEach(t => t.stop()); stream = null;
  if (ac) ac.close();
  ac = null; srcNode = null; monitor = null; gAn = pAn = null; lp = [];
  $('start').textContent = 'Start';
  sendRpm(null);
}

// ---------- analysis tick ----------
function tick() {
  if (!running) return;
  const now = performance.now();
  const { fLo, fHi } = band();

  gAn.getFloatFrequencyData(db);
  const g = analyseSpectrum(db, ac.sampleRate / gAn.fftSize, S.gtuned
    ? { fLo, fHi, mode: S.gmode, octaveCheck: true, maxHz: Math.min(ac.sampleRate * 0.45, Math.max(1500, fHi * 8)) }
    : { fLo, fHi, mode: S.gmode });
  const gRaw = g.valid ? rpmFromFiringHz(g.f0, S.cylinders) * scales.gyro : null;
  const gOut = trackers.gyro.step(gRaw, now);

  pAn.getFloatTimeDomainData(td);
  decimate(td, D, dec);
  const p = detectPitch(dec, { fs: ac.sampleRate / D, algo: S.algo, fLo, fHi });
  const pRaw = p.valid ? rpmFromFiringHz(p.f0, S.cylinders) * scales.pd : null;
  const pOut = trackers.pd.step(pRaw, now);

  lastTracked.gyro = gOut?.rpm ?? null;
  lastTracked.pd = pOut?.rpm ?? null;
  const truth = sim ? sim.truth() : null;
  history.push({ t: now, truth, g: lastTracked.gyro, gRaw, p: lastTracked.pd, pRaw });
  while (history.length && history[0].t < now - HIST_S * 1000) history.shift();
  last = { g, p, gOut, pOut, truth, fLo, fHi };

  const out = feed() === 'gyro' ? gOut : pOut;
  sendRpm(out ? Math.max(0, out.rpm) : 0);
}

// ---------- WebSocket to the server ----------
let ws = null;
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => { $('ws-dot').classList.add('on'); $('ws-state').textContent = 'connected'; };
  ws.onclose = () => {
    $('ws-dot').classList.remove('on'); $('ws-state').textContent = 'disconnected (is `npm start` running?)';
    setTimeout(connect, 1000);
  };
  ws.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type !== 'status') return;
    $('target').textContent = m.target;
    $('pps').textContent = m.packetsPerSec;
    $('sending').textContent = m.packetsPerSec ? `${m.rpm} rpm from ${m.source}` : '—';
    $('udp-err').textContent = m.error ? ' · UDP error: ' + m.error : '';
  };
}
function sendRpm(rpm) {
  if (!ws || ws.readyState !== 1 || rpm === null) return;
  ws.send(JSON.stringify({ type: 'rpm', rpm, maxRpm: S.redline, idleRpm: S.idle, source: feed() }));
}

// ---------- drawing ----------
function setupCanvas(c) {
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = Number(c.getAttribute('height'));
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return { g, w, h };
}
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

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
    for (const p of history) if (p[key] != null) g.fillRect(X(p.t) - 1, Y(p[key]) - 1, 2, 2);
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
  g.globalAlpha = 0.35; dots('gRaw', css('--gyro')); dots('pRaw', css('--pd')); g.globalAlpha = 1;
  line('truth', css('--truth'), 1.5);
  line('g', css('--gyro'), 2);
  line('p', css('--pd'), 2);
}

function drawSpectrum() {
  const { g, w, h } = setupCanvas($('spec'));
  if (!last || !ac) return;
  const r = last.g, binHz = ac.sampleRate / gAn.fftSize;
  const XMAX = Math.max(200, Math.min(1500, last.fHi * 1.6)), YMAX = 50, padB = 16;
  const X = hz => (hz / XMAX) * w, Y = d => (h - padB) - (Math.max(0, Math.min(YMAX, d)) / YMAX) * (h - padB - 6);
  g.fillStyle = 'rgba(63,185,255,0.07)';
  g.fillRect(X(last.fLo), 0, X(last.fHi) - X(last.fLo), h - padB);
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
  if (last.truth) marker(firingHz(last.truth, S.cylinders), css('--truth'), [2, 3]);
  if (last.g.valid) marker(r.f0, css('--gyro'), [5, 4]);
  if (last.p.valid) marker(last.p.f0, css('--pd'), [5, 4]);
  g.strokeStyle = '#3fb9ff'; g.lineWidth = 1.2; g.beginPath();
  for (let i = 1; i <= r.nb && i * binHz <= XMAX; i++) {
    const x = X(i * binHz), y = Y(r.ex[i]);
    if (i === 1) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.stroke();
}

function stats(key) {
  let n = 0, locked = 0, err = 0;
  for (const p of history) {
    if (p.truth == null) continue;
    n++;
    if (p[key] != null) { locked++; err += Math.abs(p[key] - p.truth); }
  }
  if (!n) return '';
  if (!locked) return 'vs truth: never locked';
  const mae = err / locked;
  return `vs truth (${HIST_S}s): mean error ${Math.round(mae)} rpm · locked ${Math.round((100 * locked) / n)}%`;
}

let lastStats = 0;
function drawCards() {
  if (!last) return;
  const show = (k, out, sub) => {
    const el = $(k + '-rpm');
    if (out) { el.textContent = Math.round(out.rpm).toLocaleString(); el.classList.remove('off'); }
    else { el.textContent = '—'; el.classList.add('off'); }
    $(k + '-sub').textContent = out?.coast ? 'holding (reading rejected)' : sub;
  };
  const g = last.g, p = last.p;
  show('gyro', last.gOut, g.valid ? `${g.f0.toFixed(1)} Hz · score ${g.score.toFixed(0)} · harmonics ${g.harmonics.join(',')}×` : 'no clear signal');
  show('pd', last.pOut, p.valid ? `${p.f0.toFixed(1)} Hz · clarity ${p.clarity.toFixed(2)}` : 'no clear signal');
  $('card-gyro').classList.toggle('selected', feed() === 'gyro');
  $('card-pd').classList.toggle('selected', feed() === 'pd');
  $('truth').textContent = last.truth ? `true rpm ${Math.round(last.truth).toLocaleString()}` : '';
  const now = performance.now();
  if (now - lastStats > 250) {
    lastStats = now;
    $('gyro-err').textContent = sim ? stats('g') : '';
    $('pd-err').textContent = sim ? stats('p') : '';
  }
}

function draw() {
  if (!running) return;
  drawCards(); drawHistory(); drawSpectrum();
  requestAnimationFrame(draw);
}

function showScales() {
  $('scales').textContent = `scale: gyroball ×${scales.gyro.toFixed(3)} · pitch ×${scales.pd.toFixed(3)} (1.000 = pure cylinder math)`;
}

// ---------- UI wiring ----------
$('start').onclick = () => (running ? stop() : start());
$('refresh').onclick = () => listInputs(true);
$('source').onchange = () => { store.set('source', $('source').value); if (running) start(); };
$('hear').onchange = () => { store.set('hear', $('hear').checked); if (monitor) monitor.gain.value = $('hear').checked ? 1 : 0; };
document.querySelectorAll('input[name=feed]').forEach(r => { r.onchange = () => store.set('feed', feed()); });
for (const id of SETTING_IDS) {
  $(id).addEventListener('change', () => {
    store.set(id, $(id).value);
    const prev = S; S = readSettings();
    $('pd-algo-name').textContent = S.algo;
    if (!running) return;
    if (sim && (prev.cylinders !== S.cylinders || prev.idle !== S.idle || prev.redline !== S.redline)) { start(); return; }
    if (prev.fft !== S.fft || prev.pdwin !== S.pdwin) buildAnalysers();
    applyTrackers();
  });
}
for (const k of ['gyro', 'pd']) {
  $('cal-' + k).onclick = () => {
    const cur = lastTracked[k], actual = num('actual', 300, 20000, 3000);
    if (!cur) { setMsg(`No ${k === 'gyro' ? 'gyroball' : 'pitch'} reading to calibrate against: hold steady revs first.`); return; }
    scales[k] = (scales[k] * actual) / cur;
    trackers[k].reset();
    store.set('scales', scales); showScales();
    setMsg(`Calibrated ${k}: ${Math.round(cur)} → ${actual} rpm.`);
  };
}
$('cal-reset').onclick = () => { scales = { gyro: 1, pd: 1 }; store.set('scales', scales); showScales(); };
document.addEventListener('visibilitychange', () => {
  if (document.hidden && running) setMsg('This tab is hidden: Chrome slows its timers to about 1 Hz, so SimHub will get sparse updates. Keep the tab visible (its own window works).');
});

$('pd-algo-name').textContent = S.algo;
showScales();
connect();
listInputs(false);
