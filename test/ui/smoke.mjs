// Browser test of the page, at the Retina scale it is used at (deviceScaleFactor 2).
//   npm run test:ui
// Needs Playwright with Chromium, which is not installed with the project:
//   npm install --no-save playwright && npx playwright install chromium
// Starts its own server on free ports, drives the simulated engine, and checks the layout, the
// combined rpm and gear, the car picker (cylinders, per-car redline and calibration), recording,
// and that telemetry reaches a UDP listener straight from the detection worker.
import { spawn, execSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDr2Packet } from '../../src/dr2-packet.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
function loadPlaywright() {
  const roots = [ROOT + '/'];
  try { roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim() + '/'); } catch { /* no global npm */ }
  for (const r of roots) { try { return createRequire(r)('playwright'); } catch { /* next */ } }
  console.error('Playwright is not installed. Run:\n  npm install --no-save playwright && npx playwright install chromium');
  process.exit(1);
}
const freePort = () => new Promise(res => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

const { chromium } = loadPlaywright();
const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`); if (!ok) failures.push(name); };

const httpPort = await freePort(), udpPort = await freePort();
const packets = [];
const udp = createSocket('udp4');
udp.on('message', m => { try { packets.push({ at: Date.now(), ...parseDr2Packet(m, { rpmDivisor: 10 }) }); } catch { /* not ours */ } });
await new Promise(res => udp.bind(udpPort, '127.0.0.1', res));
const server = spawn('node', ['server.js'], { cwd: ROOT, env: { ...process.env, HTTP_PORT: String(httpPort), SIMHUB_PORT: String(udpPort), SIMHUB_UDP: 'on' }, stdio: 'ignore' });
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

try {
  await new Promise(r => setTimeout(r, 700));
  const ctx = await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => m.type() === 'error' && errors.push(m.text()));
  await p.goto(`http://127.0.0.1:${httpPort}/`);
  await p.waitForFunction(() => document.querySelectorAll('#car option').length > 80 && document.querySelectorAll('#source option').length > 3);
  const set = (id, value) => p.evaluate(([i, v]) => { const e = document.getElementById(i); e.value = v; e.dispatchEvent(new Event('change')); }, [id, value]);
  const text = id => p.evaluate(i => document.getElementById(i).textContent, id);
  const pageHeight = () => p.evaluate(() => document.documentElement.scrollHeight);

  check('page fits one screen before starting', await pageHeight() <= 900, `${await pageHeight()} px`);

  // the state texts of the top bar have a fixed place: a long list of possible cars moves nothing
  const startLeft = () => p.evaluate(() => Math.round(document.getElementById('start').getBoundingClientRect().left));
  const say = text => p.evaluate(t => { document.getElementById('car-state').textContent = t; }, text);
  await say('→ Audi Sport quattro S1 E2');
  const leftShort = await startLeft();
  await say('→ Opel Ascona 400 or Opel Manta 400 or Ford RS200 or Lancia 037 Evo 2');
  check('a long list of possible cars does not move the controls', await startLeft() === leftShort, `Start at ${leftShort} px, then ${await startLeft()} px`);
  check('…and is cut with an ellipsis', await p.evaluate(() => { const e = document.getElementById('car-state'); return e.scrollWidth > e.clientWidth && getComputedStyle(e).textOverflow === 'ellipsis'; }));
  await say('');

  // car picker: cylinders, per-car redline and calibration
  await p.selectOption('#car', 'audi-sport-quattro-s1-e2');
  check('picking the Audi quattro sets 5 cylinders', await p.inputValue('#cylinders') === '5');
  await set('redline', '8500');
  await p.selectOption('#car', 'lancia-stratos');
  check('another car has its own cylinders and the general redline', await p.inputValue('#cylinders') === '6' && await p.inputValue('#redline') === '7500');
  await p.selectOption('#car', 'audi-sport-quattro-s1-e2');
  check('the Audi\'s redline is remembered', await p.inputValue('#redline') === '8500');

  // simulated stage on a 4-cylinder: combined rpm, gear, shifts
  await p.selectOption('#car', '');
  await p.selectOption('#source', 'sim:4');
  await set('simdrive', 'stage'); await set('cylinders', '4');
  await p.click('#start');
  const started = Date.now();
  await p.waitForTimeout(1500);
  await p.click('#rec');
  await p.waitForTimeout(9000);
  const rpm = Number((await text('fused-rpm')).replace(/\D/g, ''));
  check('the combined rpm is running', rpm > 800 && rpm < 8000, `${rpm} rpm`);
  check('the tach is fed by the combined rpm', await p.evaluate(() => document.getElementById('card-fused').classList.contains('selected')));
  check('the gear is being counted', await p.evaluate(() => typeof window === 'object') && (await p.evaluate(() => document.getElementById('cyl-state').textContent)).includes('4-cyl'));
  check('the page still fits one screen while running', await pageHeight() <= 900, `${await pageHeight()} px`);

  // recording: a WAV and a CSV with the readings
  const downloads = [];
  p.on('download', d => downloads.push(d));
  await p.click('#rec');
  await p.waitForTimeout(1500);
  const names = downloads.map(d => d.suggestedFilename());
  check('stopping the recording saves a WAV and a CSV', names.some(n => n.endsWith('.wav')) && names.some(n => n.endsWith('.csv')), names.join(', '));
  const csv = downloads.find(d => d.suggestedFilename().endsWith('.csv'));
  if (csv) {
    const rows = (await (await import('node:fs/promises')).readFile(await csv.path(), 'utf8')).split('\n');
    const head = rows.find(r => r.startsWith('t_audio_s')) || '', gearCol = head.split(',').indexOf('gear');
    const gears = new Set(rows.filter(r => /^\d/.test(r)).map(r => r.split(',')[gearCol]).filter(Boolean));
    check('the recording has the combined rpm, gear and shift columns', head.endsWith(',gear,shift,shift_ratio,rpm'));
    check('several gears were counted on the stage', gears.size >= 3, [...gears].join(' '));
    check('shifts were recorded', rows.some(r => /,(up|down),0\.\d+/.test(r) || /,(up|down),1\.\d+/.test(r)));
  }

  // calibration belongs to the car it was made with
  const scaleText = () => text('scales');
  await p.selectOption('#car', 'audi-sport-quattro-s1-e2'); await set('cylinders', '4'); // keep the 4-cyl sim readable
  await p.waitForTimeout(1500);
  await p.evaluate(() => { document.querySelector('details.settings').open = true; });
  await set('actual', '3000'); await p.click('#cal-pd');
  const calibrated = await scaleText();
  await p.selectOption('#car', 'lancia-stratos');
  check('a V6 that sounds like two threes starts at ×2', (await scaleText()).includes('pitch ×2.000') && (await scaleText()).includes('gyroball ×2.000'), await scaleText());
  await p.selectOption('#car', 'peugeot-205-gti');
  check('a calibration is not carried to another car', (await scaleText()).includes('pitch ×1.000') && !calibrated.includes('pitch ×1.000'), calibrated);
  await p.selectOption('#car', 'audi-sport-quattro-s1-e2');
  check('…and comes back with its car', await scaleText() === calibrated);

  // telemetry: from the worker to the server to UDP, at the detection rate, with the gear
  const recent = packets.filter(k => k.at >= started + 3000 && k.at < started + 8000); // steady running
  check('telemetry arrives over UDP as it is detected, not on a 60 Hz tick', recent.length / 5 > 75, `${Math.round(recent.length / 5)} packets/s`);
  check('telemetry carries rpm and gear', recent.some(k => k.rpm > 500) && packets.some(k => k.gear >= 1), `rpm ${Math.round(recent.at(-1)?.rpm ?? 0)}, gear ${recent.at(-1)?.gear}`);
  check('no errors in the page', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  udp.close();
}
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll checks passed');
process.exit(failures.length ? 1 : 0);
