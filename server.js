// audio-rpm server:
//  - serves the browser UI (public/) and the two npm packages the UI imports (/vendor/...)
//  - receives the selected RPM from the page over WebSocket (/ws)
//  - sends it to SimHub as DiRT Rally 2.0 UDP telemetry at SEND_HZ, when UDP output is on
//    (off by default: SIMHUB_UDP=on to start with it on, or use the toggle in the page)
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createSocket } from 'node:dgram';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { buildDr2Packet } from './src/dr2-packet.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HTTP_PORT = Number(process.env.HTTP_PORT || 8777);
const SIMHUB_HOST = process.env.SIMHUB_HOST || '127.0.0.1';
const SIMHUB_PORT = Number(process.env.SIMHUB_PORT || 20777);
const SEND_HZ = Number(process.env.SEND_HZ || 60);
const RPM_DIVISOR = Number(process.env.RPM_DIVISOR || 10);
const STALE_MS = 1500; // stop sending when the page goes quiet
let udpOn = /^(1|on|true|yes)$/i.test(process.env.SIMHUB_UDP || '');

const MOUNTS = [
  ['/vendor/pitch-detection/', path.join(ROOT, 'node_modules/pitch-detection')],
  ['/vendor/fourier-transform/', path.join(ROOT, 'node_modules/fourier-transform')],
  ['/', path.join(ROOT, 'public')],
];
const CARS = path.join(ROOT, 'samples/dr2-cars.json');
// learned by `npm run learn-cars`; absent until then (the page then has no "Auto · recognise")
const CAR_PROFILES = path.resolve(ROOT, process.env.CAR_PROFILES || 'samples/dr2/car-profiles.json');
// Browsers can't resolve bare package names inside workers, so rewrite them when serving JS
// (the same specifiers resolve from node_modules when the modules run in Node for tests).
const BARE = /((?:from|import)\s*\(?\s*)(['"])(pitch-detection\/[^'"]+|fourier-transform)\2/g;
const resolveBare = js => js.replace(BARE, (m, pre, q, spec) =>
  pre + q + (spec === 'fourier-transform' ? '/vendor/fourier-transform/index.js' : '/vendor/' + spec) + q);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    let file;
    if (pathname === '/cars.json') file = CARS; // the car picker's list
    else if (pathname === '/car-profiles.json') {
      file = CAR_PROFILES;
      if (!existsSync(file)) { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"cars":{}}'); return; }
    }
    else {
      const [prefix, dir] = MOUNTS.find(([p]) => pathname.startsWith(p));
      file = path.resolve(dir, '.' + pathname.slice(prefix.length - 1));
      if (!file.startsWith(dir + path.sep)) { res.writeHead(403).end(); return; }
    }
    let body = await readFile(file);
    if (file.endsWith('.js')) body = resolveBare(body.toString('utf8'));
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

// ---- telemetry state (latest values from the page) ----
const state = { rpm: 0, maxRpm: 7500, idleRpm: 900, gear: 0, source: '', updated: 0 };
const num = (v, lo, hi, fallback) => (Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  ws.on('message', data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.type === 'udp') { udpOn = Boolean(m.enabled); console.log(`UDP output ${udpOn ? 'ON' : 'paused'}`); return; }
    if (m.type !== 'rpm') return;
    state.rpm = num(m.rpm, 0, 30000, 0);
    state.maxRpm = num(m.maxRpm, 1000, 30000, state.maxRpm);
    state.idleRpm = num(m.idleRpm, 0, 5000, state.idleRpm);
    state.source = String(m.source || '').slice(0, 40);
    state.updated = Date.now();
  });
});

// ---- UDP output to SimHub ----
const udp = createSocket('udp4');
const t0 = Date.now();
let sent = 0, sentLastSecond = 0, lastError = '';

setInterval(() => {
  if (!udpOn || Date.now() - state.updated > STALE_MS) return;
  const pkt = buildDr2Packet({ time: (Date.now() - t0) / 1000, ...state }, { rpmDivisor: RPM_DIVISOR });
  udp.send(pkt, SIMHUB_PORT, SIMHUB_HOST, err => { if (err) lastError = err.message; });
  sent++;
}, 1000 / SEND_HZ);

setInterval(() => {
  sentLastSecond = sent; sent = 0;
  const status = JSON.stringify({
    type: 'status', udp: udpOn, target: `${SIMHUB_HOST}:${SIMHUB_PORT}`, packetsPerSec: sentLastSecond,
    rpm: Math.round(state.rpm), source: state.source, error: lastError,
  });
  for (const c of wss.clients) if (c.readyState === 1) c.send(status);
}, 1000);

server.listen(HTTP_PORT, () => {
  console.log(`audio-rpm UI:           http://localhost:${HTTP_PORT}`);
  console.log(`SimHub UDP target:      ${SIMHUB_HOST}:${SIMHUB_PORT} (DiRT Rally 2.0 format, rpm/${RPM_DIVISOR}, ${SEND_HZ} Hz)`);
  console.log(`UDP output:             ${udpOn ? 'ON' : 'paused (toggle in the page, or SIMHUB_UDP=on)'}`);
});
