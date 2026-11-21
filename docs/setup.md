# Setup, the page and its settings

Back to the [README](../README.md).

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

The volume on the way in does not matter: the detectors judge silence against the loudest sound
they have heard, so BlackHole's own volume slider (Audio MIDI Setup) can sit anywhere. The page only
complains when no sound arrives at all.

### 2. Run it

```sh
npm run init
npm start
```

`npm run init` installs the dependencies and checks the rest (see the README); plain `npm install` is enough for the page alone.

Open **http://localhost:8777** in Chrome. Click **List inputs** (Chrome asks for microphone access:
this is how the page reads BlackHole), pick **BlackHole 2ch**, then **Start**. Or start with the
**Simulated engine**, which needs no setup and knows the true RPM.

Detection runs on the audio thread and in a worker, so it keeps going when the tab is hidden.

### 3. Something to listen to

- **Simulated engines** (top of the source list): 4-cyl, 5-cyl, 6-cyl, V8, V10, V12, or **random**, whose
  cylinder count stays hidden until Auto has locked one, then is revealed with ✓ or ✗. Each card shows
  its error against the truth, and the latency panel measures the real lag. *Settings → Simulated
  driving* switches between idle-then-pulls and a rally pattern that never idles. Tick *hear sim* to
  hear it.
- **A test WAV** through the real capture path: `npm run make-wav` (60 s sweep with gear shifts) or
  `npm run make-wav -- --rpm 4000` (constant), then `afplay engine-sweep.wav`.
- **Real footage:** a DiRT Rally 2.0 onboard video. Set *cylinders* to the car's engine, then use
  **Calibrate** while the in-game rev counter holds steady.

## The page

- **build N** (next to the title): the version the page was loaded from. The number is the count of
  commits, so it only goes up; the tooltip has the commit and its date. If the server is restarted on
  another version while the page is open, it turns orange and asks for a reload. `npm start` prints the
  same version in the terminal, and `/version.json` has it for scripts.

- **Car** (top bar): the 82 DiRT Rally 2.0 cars. Picking one sets its cylinder count, which is certain
  where auto-detection can be wrong (the two cars whose count isn't known stay on Auto). Idle, redline
  and the calibration are remembered per car: set them once under Settings with the car picked. The list doesn't
  include each car's redline; the game's values aren't in it. Recordings made with a car picked are
  named `audio-rpm-carNN-…`, and `eval-dr2 --file` reads the car from that name.
  **Auto · recognise** names the car from its sound instead, in a fixed slot next to the list ("→ Opel Ascona 400 or 2 others"; hover for every candidate) (see [Car recognition](measurements.md#car-recognition));
  it is available once `npm run learn-cars` has learned the cars.
- **Tachometer:** needle and readout for the rpm picked with *tach* on its card: **combined** by default
  (see [One RPM from two detectors](measurements.md#one-rpm-from-two-detectors)), or either detector alone; the thin
  needle is gyroball (pitch-detection when gyroball is on the tach); the white mark on the rim is the true RPM (simulation). The 15 shift lights run from
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
  | measured | delay that best aligns the output with the true RPM (simulation or loopback test). **no match** = no delay explains the output: the rpm is on the wrong scale (wrong cylinder count), not late |

- **Chart:** last 20 s, both detectors against the true RPM; dots are raw readings before tracking.
- **Spectrum:** what gyroball sees, with each detector's pick marked.

### Recording what the detectors hear

**● Rec** (top bar, while running): click to start, click **■ Stop** to end (at most 2 minutes; pressing
Stop on the app also ends and saves it). It saves two files to your Downloads: a WAV of exactly what
the detectors received, and a CSV of their readings (pitch, gyroball, cylinder count, input level, gear and shifts) at
every update, with the settings in its header. Replay a recording offline through the same pipeline:

```sh
npm run analyze -- ~/Downloads/audio-rpm-….wav                      # rally auto mode
npm run analyze -- clip.wav --cylinders auto-any --idle 1000 --redline 8500 --every 0.25
ffmpeg -i clip.m4a -ac 1 -ar 48000 clip.wav                        # other formats: convert first
```

### Measuring the real capture path (loopback test)

The simulated engine runs inside the page, so its measured lag excludes the sound card. To include
BlackHole: pick **BlackHole 2ch** as the source, tick **loopback lag test**, and press Start. The page
plays the simulated engine through the Mac's output (the Multi-Output Device sends it to BlackHole)
and analyses what comes back. The measured value then includes the output latency too. The panel
shows the value Chrome reports for it, so subtract that to get capture → RPM.

## Settings

- **Cylinders** (top bar): see above. **Idle / redline**: the search band (also sent to SimHub).
- **Simulated driving**: idle then four pulls, rally (pulls and shifts, never idle), or stage (standing
  start, gears 1–5 up and down, stop; the tach then also shows the true gear).
- **Gears**: number of forward gears; the counted gear never goes above it.
- **Chunk**: how often detection runs (2.7 / 5.3 / 11 ms). Smaller = less waiting, more CPU.
- **Predict ahead**: compensates the half-window delay. **Adaptive pitch window**: see above.
  **Pitch max window**: the window at idle and when nothing is locked.
- **Calibrate**: hold steady revs, type the in-game RPM in *Actual rpm now*, click the detector's
  button. Fixes a constant factor, such as a car whose loudest tone isn't the firing order. It is
  remembered for the car picked (or recognised), like idle and redline; another car starts at ×1.
- **Smoothing τ**: tracker time constant (0 = raw readings). **Max accel**: readings that jump further
  than the engine could move are treated as errors. **Re-acquire**: the longest to wait before
  accepting a new level.
