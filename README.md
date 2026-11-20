# audio-bridge — POC 1

Estimate engine RPM from game audio and feed it to SimHub, for games that send no telemetry
(DiRT Rally 2.0 on PS5). POC 1 listens to whatever your Mac is playing. It runs two detectors
side by side so you can compare them, and sends the one you pick to SimHub as
DiRT Rally 2.0 UDP telemetry.

```
Mac audio ──BlackHole──▶ Chrome page (localhost:8777)
                           ├─ gyroball-rpm   (spectral harmonic scoring)  ─┐
                           └─ pitch-detection (YIN / McLeod / HPS)        ─┤ pick one
                                                                           ▼
                         Node server ──UDP, DR2 "extradata=3" packets──▶ SimHub (Windows) :20777
```

The estimate comes from the pitch of the engine sound: a 4-stroke engine fires each cylinder once
every two crank turns, so its loudest tone is at **rpm / 60 × cylinders / 2** Hz. That gives you RPM
only (no speed, gear or G-forces), and it lags the sound by about half the analysis window.

## Requirements

- Node 18+ and Chrome on the Mac
- [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) to capture the Mac's own output:
  `brew install blackhole-2ch`
- SimHub runs on **Windows only**: a Windows PC on the same network, or a Windows VM.
  Without it you can still check everything with `npm run listen` (see below).

## Setup

### 1. Route Mac audio to BlackHole and still hear it

1. Open **Audio MIDI Setup** → **+** → **Create Multi-Output Device**.
2. Tick your speakers/headphones **and** BlackHole 2ch. Put your speakers first and make them the
   clock source.
3. In System Settings → Sound → Output, choose that Multi-Output Device.

Everything the Mac plays now also goes into the BlackHole input, which the page records.

### 2. Run the bridge

```sh
npm install
SIMHUB_HOST=192.168.1.50 npm start      # IP of the Windows PC running SimHub
```

Open **http://localhost:8777** in Chrome. Click **List inputs** (Chrome asks for microphone access:
this is how the page reads BlackHole), pick **BlackHole 2ch**, then **Start**.

Keep the tab **visible**. Chrome slows timers in hidden tabs to about once a second, so SimHub would
get sparse updates. A separate window works.

| Variable | Default | |
|---|---|---|
| `SIMHUB_HOST` | `127.0.0.1` | where SimHub runs |
| `SIMHUB_PORT` | `20777` | SimHub's DiRT Rally 2.0 UDP port |
| `HTTP_PORT` | `8777` | the page |
| `SEND_HZ` | `60` | packets per second to SimHub |
| `RPM_DIVISOR` | `10` | DR2 sends rpm / 10; set to `1` if SimHub shows rpm 10× too high |

### 3. Something to listen to

- **Simulated engine** (first entry in the source list): no BlackHole needed, and the true RPM is
  known, so each card shows its error against the truth. Tick *hear simulation* to hear it.
- **A test WAV** through the real capture path: `npm run make-wav` (60 s sweep with gear shifts) or
  `npm run make-wav -- --rpm 4000` (constant), then `afplay engine-sweep.wav`.
- **Real footage:** a DiRT Rally 2.0 onboard video. Set *cylinders* to the car's engine, then use
  **Calibrate** while the in-game rev counter holds steady.

## Seeing the RPM in SimHub

Yes, you can. On the Windows PC:

1. In SimHub, select **DiRT Rally 2.0** as the game. SimHub listens for it on UDP 20777.
   SimHub may say DR2 telemetry is "not configured" because it can't find the game's config file on
   that PC. That doesn't matter here: the packets come from the bridge.
2. Make sure Windows Firewall allows **inbound UDP 20777** for SimHub.
3. Start the bridge and press Start in the page. SimHub should show the game as receiving data.
4. To see the RPM:
   - **Dash Studio**: open any dashboard with a rev counter or shift lights. The page sends
     redline and idle too, so the shift lights scale to your settings.
   - **Property browser**: search the property list for `Rpms` (under `DataCorePlugin.GameData`).
   - SimHub's dashboards can also be opened in a browser on the Mac through SimHub's web server.

### If SimHub shows nothing

1. Run `npm run listen` on the machine the packets go to, with SimHub closed (both can't hold port
   20777 at once). If it prints RPM, the bridge side works and the problem is on SimHub's side.
2. Check the firewall rule and that `SIMHUB_HOST` is the PC's LAN IP.
3. Value 10× off: restart with `RPM_DIVISOR=1`.
4. Untested: if SimHub insists the game isn't running even though packets arrive, it may be checking
   for the game's process. Tools that fake DR2 telemetry for other games have shipped a stand-in
   executable named `DirtRally2.exe` for this reason.

## Comparing the two detectors

**In the page:** run the simulated engine. Each card shows its mean error against the true RPM and
how often it held a lock, over the last 20 s. The chart overlays both against the truth. Raw readings
(dots) show what each tracker rejected.

**Offline benchmark:** `npm run bench` (`-- --cylinders 6` etc.) runs the same pipeline on the
simulated shifting sweep: same windows, same tracker, 20 ms ticks. "SimHub error" is what SimHub
actually receives (lag included), in rpm:

| | 4 cyl mean / p90 | 6 cyl mean / p90 | 8 cyl mean / p90 |
|---|---|---|---|
| gyroball 8192, original | 467 / 1888 | 1955 / 3472 | 1949 / 3241 |
| gyroball 8192, engine-tuned | 275 / 363 | 223 / 341 | 194 / 312 |
| gyroball 16384, engine-tuned | 388 / 1117 | 451 / 1419 | 533 / 2314 |
| pitch-detection McLeod | 182 / 260 | 187 / 283 | 159 / 224 |
| pitch-detection YIN | 188 / 260 | 193 / 280 | 179 / 261 |
| pitch-detection HPS | 198 / 230 | 179 / 183 | 177 / 180 |

What the testing found:

- **Original gyroball fails on engines.** Engines produce half-order tones, so the candidate at half
  the firing frequency explains almost the same peaks and often wins. That's an octave-low reading
  (73% of the time on a V8). A gyro ball has no half orders, which is why the original never hits
  this. The **engine-tuned** variant adds an octave check and analyses enough of the spectrum to
  cover 8 harmonics at redline.
- **Gyroball needs long windows at idle.** With 8192 samples (5.9 Hz bins), a 4-cylinder idling at
  30 Hz reads about 25% low; 16384 fixes idle but smears fast revs and adds lag.
- **pitch-detection is better here:** an 85 ms window, accurate from idle to redline on 4, 6 and
  8 cylinders. YIN is the default. McLeod needed its peak-picking constant lowered from 0.9 to 0.8
  (still within the range its paper allows) to stop octave errors on 6 and 8 cylinders. HPS is
  weak at idle.
- **Most of the remaining error is lag:** half the window plus the tracker's smoothing, during
  ramps of about 3,000 rpm/s.

The simulated engine is a simple harmonic model. Real game audio (exhaust, turbo, gravel,
co-driver) will be harder, so treat these numbers as a ranking, not a promise.

## Settings

- **Cylinders / idle / redline**: set the search band and the Hz → rpm conversion. Idle and redline
  are also sent to SimHub.
- **Calibrate**: hold steady revs, type the in-game RPM in *Actual rpm now*, click the detector's
  button. This fixes a constant factor, such as a car whose loudest tone isn't the firing order.
- **Smoothing τ**: tracker time constant (0 = raw readings). **Max accel**: readings that jump
  further than the engine could move are treated as errors. **Re-acquire**: the longest to wait
  before accepting a new level. A gear shift is normally accepted after 3 agreeing readings (60 ms).

## Tests

```sh
npm test          # packet layout, detectors at fixed RPMs (4/6/8 cyl), tracker behaviour
npm run bench     # detector comparison on the simulated sweep
```

## Layout

```
server.js                    page + vendor files, WebSocket in, DR2 UDP out
src/dr2-packet.js            DR2 packet build/parse (66 floats, rpm at bytes 148..152)
public/index.html, app.js    UI, audio capture, runs both detectors each 20 ms
public/detectors/            gyroball-core.js (ported), pd-core.js (pitch-detection wrapper)
public/tracker.js            alpha-beta tracker (adapted from gyroball-rpm)
public/engine-model.js       engine sound model + rpm schedule (simulator, WAV, bench)
public/engine-sim.js         in-browser simulated engine
tools/                       udp-listen (SimHub stand-in), make-test-wav, bench
```

## Next: POC 2

Plug the DualSense's 3.5 mm headphone jack into a line-in on the Mac (a USB audio interface with a
line input works), and pick that input instead of BlackHole. On the PS5, send all audio to the
headphones. Nothing else changes.

Credits: detector and tracker logic adapted from [gyroball-rpm](https://github.com/berkenbu/gyroball-rpm)
(MIT); pitch algorithms from [pitch-detection](https://github.com/audiojs/pitch-detection) (MIT).
See THIRD_PARTY.md.
