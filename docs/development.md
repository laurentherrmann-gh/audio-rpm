# Tests, layout, next steps

Back to the [README](../README.md).

## Tests

```sh
npm test          # packet layout, car list, car recognition, combined rpm, shifts and gear, recording checks, detectors (4–12 cyl), cylinder detection (incl. no idle, gating), tracker, pipeline, lag estimator
npm run bench     # step-by-step lag benchmark (-- --cylinders 6 etc.)
npm run bench -- --auto   # cylinder auto-detection on every engine, with and without idle
npm run bench -- --shifts # gear shifts and gear on the simulated stage
npm run eval-rpm  # real clips: each rpm against the offline reference (needs samples/dr2/)
npm run eval-shifts # real clips: gear shifts against the shifts in the reference rpm
npm run test:ui   # the page in a real browser at Retina scale (needs Playwright, see test/ui/smoke.mjs)
```

## Layout

```
README.md, docs/             the short guide; setup, SimHub, car sounds, measurements, development
server.js                    page + vendor files (bare imports rewritten for workers), WebSocket, UDP
src/dr2-packet.js            DR2 packet build/parse (66 floats, rpm at bytes 148..152)
public/index.html, app.js    UI: tachometer, cards, latency panel, chart, settings
public/capture-worklet.js    audio thread: chunks raw + low-passed audio to the worker
public/detect-worker.js      runs the pipeline on each chunk, skips backlog
public/pipeline.js           both detectors, adaptive window, trackers, prediction (shared with bench/tests)
public/detectors/            gyroball-core.js (ported, engine-tuned), pd-core.js (pitch-detection wrapper),
                             cylinders.js (cylinder count from the engine-cycle tones),
                             car-id.js (car recognition from the tone: snapshots, profiles, matcher),
                             tones.js (a car's tone map: its engine orders' levels by rpm, to pick the firing tone),
                             shifts.js (gear shifts from the rpm's steps, counted gear)
public/tracker.js            alpha-beta tracker (adapted from gyroball-rpm)
public/path.js               one rpm from the two detectors: the smoothest path through their readings
public/fusion.js             the first way of combining them (rules), kept for comparison
public/lag.js                measured-lag estimator
public/ring.js               ring buffer
public/engine-model.js       engine sound model + rpm schedule (simulator, WAV, bench)
public/engine-sim.js         in-browser simulated engine
public/cars.js               car keys and file names, shared by the car picker and the dataset tools
tools/                       udp-listen (SimHub stand-in), make-test-wav, bench, analyze (replay a WAV),
                             init (gets a clone ready), fetch-dr2 / eval-dr2 (DiRT Rally 2.0 car-sound set), cars (learn-cars / eval-cars:
                             car profiles and how well cars are recognised), lib/audio.js (WAV + replay),
                             lib/quality.js (lost sound, clipping), lib/align.js (cut points vs the sound),
                             eval-rpm (is the rpm right on the real clips?), eval-shifts (are the shifts found?),
                             lib/reference.js (offline reference rpm), lib/tone-learn.js (a tone map from a recording),
                             reference-rpm (that reference as .rpm.csv and .tacho.wav files)
samples/dr2-cars.json        the 82 cars: chapter times, real cylinder count, engine layout (the page's car list)
```

## Next: POC 2

Plug the DualSense's 3.5 mm headphone jack into a line-in on the Mac (a USB audio interface with a
line input works), and pick that input instead of BlackHole. On the PS5, send all audio to the
headphones. Nothing else changes; the latency panel's *capture* column will show the new device.

Credits: detector and tracker logic adapted from [gyroball-rpm](https://github.com/berkenbu/gyroball-rpm)
(MIT); pitch algorithms from [pitch-detection](https://github.com/audiojs/pitch-detection) (MIT).
See THIRD_PARTY.md.
