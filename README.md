# audio-bridge — POC 1

Estimate engine RPM from game audio, for games that send no telemetry (DiRT Rally 2.0 on PS5).
POC 1 listens to whatever your Mac is playing. It runs two detectors side by side so you can compare
them, shows the result on a tachometer, and measures the lag from sound to RPM live. It can also send
the RPM to SimHub as DiRT Rally 2.0 UDP telemetry, but that output is **paused by default**.

```
Mac audio ─BlackHole─▶ Chrome page (localhost:8777)
                         audio worklet ──every 5.3 ms──▶ detection worker
                                                          ├─ gyroball-rpm   (spectral harmonics)
                                                          └─ pitch-detection (YIN / McLeod / HPS)
                         tachometer · latency panel ◀────────┘
                         Node server ──UDP (paused by default)──▶ SimHub (Windows) :20777
```

The estimate comes from the pitch of the engine sound: a 4-stroke engine fires each cylinder once
every two crank turns, so its loudest tone is at **rpm / 60 × cylinders / 2** Hz. That gives you RPM
only: no speed, gear or G-forces.

## Requirements

- Node 18+ and Chrome on the Mac
- [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole) to capture the Mac's own output:
  `brew install blackhole-2ch`
- Optional: SimHub, which runs on **Windows only** (a PC on the same network, or a VM)

## Setup

### 1. Route Mac audio to BlackHole and still hear it

1. Open **Audio MIDI Setup** → **+** → **Create Multi-Output Device**.
2. Tick your speakers/headphones **and** BlackHole 2ch. Put your speakers first and make them the
   clock source.
3. In System Settings → Sound → Output, choose that Multi-Output Device.

Everything the Mac plays now also goes into the BlackHole input, which the page records.

### 2. Run it

```sh
npm install
npm start
```

Open **http://localhost:8777** in Chrome. Click **List inputs** (Chrome asks for microphone access:
this is how the page reads BlackHole), pick **BlackHole 2ch**, then **Start**. Or start with the
**Simulated engine**, which needs no setup and knows the true RPM.

Detection runs on the audio thread and in a worker, so it keeps going when the tab is hidden.

### 3. Something to listen to

- **Simulated engine** (first entry in the source list): each card shows its error against the
  truth, and the latency panel measures the real lag. Tick *hear simulation* to hear it.
- **A test WAV** through the real capture path: `npm run make-wav` (60 s sweep with gear shifts) or
  `npm run make-wav -- --rpm 4000` (constant), then `afplay engine-sweep.wav`.
- **Real footage:** a DiRT Rally 2.0 onboard video. Set *cylinders* to the car's engine, then use
  **Calibrate** while the in-game rev counter holds steady.

## The page

- **Tachometer:** needle and readout for the detector picked with *on tach*; the other detector is the
  thin needle; the white mark on the rim is the true RPM (simulation). The 15 shift lights run from
  72% to 97% of redline, then flash.
- **Latency: sound → RPM value**, live, per detector:

  | column | what it is |
  |---|---|
  | capture | input buffering reported by the browser for the device (0 for the simulation) |
  | ½ window | a reading describes the middle of its analysis window, so it starts half a window old |
  | predicted ahead | the tracker extrapolates each reading to the newest sample (cancels ½ window) |
  | chunk wait | detection runs once per chunk; a sound waits half a chunk on average |
  | process time | time to run the detector once, average / 95th percentile |
  | transport | audio thread → worker → page, including queueing |
  | = estimate | the sum |
  | measured | delay that best aligns the output with the true RPM (simulation or loopback test) |

- **Chart:** last 20 s, both detectors against the true RPM; dots are raw readings before tracking.
- **Spectrum:** what gyroball sees, with each detector's pick marked.

### Measuring the real capture path (loopback test)

The simulated engine runs inside the page, so its measured lag excludes the sound card. To include
BlackHole: pick **BlackHole 2ch** as the source, tick **loopback lag test**, and press Start. The page
plays the simulated engine through the Mac's output (the Multi-Output Device sends it to BlackHole)
and analyses what comes back. The measured value then includes the output latency too. The panel
shows the value Chrome reports for it, so subtract that to get capture → RPM.

## SimHub (optional)

UDP output starts paused. Turn it on with **Send to SimHub (UDP)** at the bottom of the page, or
start with it on:

```sh
SIMHUB_UDP=on SIMHUB_HOST=192.168.1.50 npm start     # IP of the Windows PC running SimHub
```

| Variable | Default | |
|---|---|---|
| `SIMHUB_UDP` | off | `on` to start sending immediately |
| `SIMHUB_HOST` | `127.0.0.1` | where SimHub runs |
| `SIMHUB_PORT` | `20777` | SimHub's DiRT Rally 2.0 UDP port |
| `HTTP_PORT` | `8777` | the page |
| `SEND_HZ` | `60` | packets per second to SimHub |
| `RPM_DIVISOR` | `10` | DR2 sends rpm / 10; set to `1` if SimHub shows rpm 10× too high |

On the Windows PC: select **DiRT Rally 2.0** in SimHub (it may say telemetry is "not configured",
because it can't find the game's config file there; that doesn't matter), allow inbound UDP 20777 in
Windows Firewall, then open any dashboard with a rev counter. The page sends redline and idle too,
so shift lights scale to your settings.

If SimHub shows nothing: run `npm run listen` on that machine with SimHub closed (both can't hold port
20777). If it prints RPM, the bridge works and the problem is on SimHub's side. Untested: if SimHub
insists the game isn't running even though packets arrive, it may be checking for the game's process.
Tools that fake DR2 telemetry for other games have shipped a stand-in `DirtRally2.exe` for this reason.

## Lag: what was done and what it bought

`npm run bench` runs the detection pipeline (the same module the worker uses) on the simulated
shifting sweep, adding one optimization at a time. 4 cylinders, 900–7,500 rpm:

**pitch-detection (YIN)**

| | lag | error mean / p90 (rpm) | glitches | process time |
|---|---|---|---|---|
| POC 1 settings: 20 ms timer, reading stamped when computed | 56 ms | 178 / 254 | 3.6% | 0.30 ms |
| + run on every 5.3 ms audio chunk | 56 ms | 177 / 255 | 3.4% | 0.31 ms |
| + stamp at window centre, predict forward | 14 ms | 143 / 219 | 3.5% | 0.33 ms |
| + tracker τ 0.05 s | 14 ms | 128 / 132 | 3.4% | 0.31 ms |
| + adaptive pitch window (**default**) | −2 ms | **53 / 58** | **0.9%** | **0.11 ms** |

**gyroball (engine-tuned, FFT 8192)**

| | lag | error mean / p90 (rpm) | glitches | process time |
|---|---|---|---|---|
| POC 1 settings | 84 ms | 269 / 349 | 4.2% | 0.68 ms |
| all optimizations (**default**) | 0 ms | 188 / 301 | 4.1% | 0.65 ms |

*lag* is measured, not computed: the delay that best aligns the output with the true RPM, using only
moments when the revs are ramping. *Error* is at the same instant, lag included, which is what the
tach and SimHub show. *Glitches* = share of time more than 1,500 rpm off. "POC 1 settings" already
include today's tracker fixes. In the browser the page adds ~3 ms chunk wait and a few ms transport,
measured live in the latency panel: about 10 ms end to end on the simulated engine.

What each step does:

- **Audio worklet + worker.** The worklet hands every 256 samples (5.3 ms) straight to a worker over
  a MessagePort. Before, the page polled every 20 ms on a timer that Chrome throttles in hidden
  tabs. If detection ever falls behind, older chunks are skipped rather than queued, so a slow
  moment can't turn into growing lag.
- **Window-centre timestamps + prediction.** A reading describes the middle of its window. The
  tracker is fed that time and extrapolates to the newest sample with its velocity estimate. This
  is the largest single gain.
- **Adaptive pitch window.** The window is about 2.5 periods of 60% of the current engine tone (so a
  gear-shift drop still fits): 85 ms at idle, about 17 ms near redline on a 4-cylinder. Shorter windows also mean
  less smearing across a shift, hence the drop in error and glitches. HPS can't use it (it needs
  power-of-two FFT sizes), so it stays on the fixed window.
- **Tracker fixes for shifts.** While readings are rejected or missing, velocity bleeds off instead
  of extrapolating (POC 1 could overshoot past redline during a shift). A new level is accepted once
  it persists for 15 ms.
- **Gyroball rejects smeared readings.** Its 170 ms window straddles each shift for about 100 ms; the
  smeared spectrum fit upper harmonics of a low frequency with no fundamental, which read as
  idle-like dips. The engine-tuned variant now requires the fundamental to be present. The window
  length itself remains gyroball's limit: it can't react faster than its window.

## What the detector comparison found

- **Original gyroball fails on engines.** Engines produce half-order tones, so the candidate at half
  the firing frequency explains almost the same peaks and often wins (73% octave-low readings on a
  V8). The **engine-tuned** variant adds an octave check, analyses enough spectrum for 8 harmonics at
  redline, and rejects readings without a fundamental.
- **Gyroball needs long windows at idle.** With 8192 samples (5.9 Hz bins), a 4-cylinder idling at
  30 Hz reads about 25% low; 16384 fixes idle but smears fast revs.
- **pitch-detection is better here:** accurate from idle to redline on 4, 6 and 8 cylinders, at a
  fraction of the lag. YIN is the default. McLeod needed its peak-picking constant lowered from 0.9
  to 0.8 (within the range its paper allows) to stop octave errors on 6 and 8 cylinders. HPS is
  weak at idle.

The simulated engine is a simple harmonic model. Real game audio (exhaust, turbo, gravel,
co-driver) will be harder, so treat these numbers as a ranking, not a promise.

## Settings

- **Cylinders / idle / redline**: the search band and the Hz → rpm conversion (also sent to SimHub).
- **Chunk**: how often detection runs (2.7 / 5.3 / 11 ms). Smaller = less waiting, more CPU.
- **Predict ahead**: compensates the half-window delay. **Adaptive pitch window**: see above.
  **Pitch max window**: the window at idle and when nothing is locked.
- **Calibrate**: hold steady revs, type the in-game RPM in *Actual rpm now*, click the detector's
  button. Fixes a constant factor, such as a car whose loudest tone isn't the firing order.
- **Smoothing τ**: tracker time constant (0 = raw readings). **Max accel**: readings that jump further
  than the engine could move are treated as errors. **Re-acquire**: the longest to wait before
  accepting a new level.

## Tests

```sh
npm test          # packet layout, detectors (4/6/8 cyl), tracker, pipeline, lag estimator
npm run bench     # step-by-step lag benchmark (-- --cylinders 6 etc.)
```

## Layout

```
server.js                    page + vendor files (bare imports rewritten for workers), WebSocket, UDP
src/dr2-packet.js            DR2 packet build/parse (66 floats, rpm at bytes 148..152)
public/index.html, app.js    UI: tachometer, cards, latency panel, chart, settings
public/capture-worklet.js    audio thread: chunks raw + low-passed audio to the worker
public/detect-worker.js      runs the pipeline on each chunk, skips backlog
public/pipeline.js           both detectors, adaptive window, trackers, prediction (shared with bench/tests)
public/detectors/            gyroball-core.js (ported, engine-tuned), pd-core.js (pitch-detection wrapper)
public/tracker.js            alpha-beta tracker (adapted from gyroball-rpm)
public/lag.js                measured-lag estimator
public/ring.js               ring buffer
public/engine-model.js       engine sound model + rpm schedule (simulator, WAV, bench)
public/engine-sim.js         in-browser simulated engine
tools/                       udp-listen (SimHub stand-in), make-test-wav, bench
```

## Next: POC 2

Plug the DualSense's 3.5 mm headphone jack into a line-in on the Mac (a USB audio interface with a
line input works), and pick that input instead of BlackHole. On the PS5, send all audio to the
headphones. Nothing else changes; the latency panel's *capture* column will show the new device.

Credits: detector and tracker logic adapted from [gyroball-rpm](https://github.com/berkenbu/gyroball-rpm)
(MIT); pitch algorithms from [pitch-detection](https://github.com/audiojs/pitch-detection) (MIT).
See THIRD_PARTY.md.
