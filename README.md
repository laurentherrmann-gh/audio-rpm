# audio-rpm — POC 1

Estimate engine RPM from game audio, for games that send no telemetry (DiRT Rally 2.0 on PS5).
POC 1 listens to whatever your Mac is playing. It runs two detectors side by side so you can compare
them, counts the engine's cylinders by itself (or takes the count you pick), shows the result on a
tachometer, and measures the lag from sound to RPM live. It can also send
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
every two crank turns, so its loudest tone is at **rpm / 60 × cylinders / 2** Hz. That gives you RPM,
and from the way the RPM steps, gear shifts and a counted gear: no speed or G-forces.

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

- **Car** (top bar): the 82 DiRT Rally 2.0 cars. Picking one sets its cylinder count, which is certain
  where auto-detection can be wrong (the two cars whose count isn't known stay on Auto). Idle, redline
  and the calibration are remembered per car: set them once under Settings with the car picked. The list doesn't
  include each car's redline; the game's values aren't in it. Recordings made with a car picked are
  named `audio-rpm-carNN-…`, and `eval-dr2 --file` reads the car from that name.
  **Auto · recognise** names the car from its sound instead (see [Car recognition](#car-recognition));
  it is available once `npm run learn-cars` has learned the cars.
- **Tachometer:** needle and readout for the rpm picked with *tach* on its card: **combined** by default
  (see [One RPM from two detectors](#one-rpm-from-two-detectors)), or either detector alone; the thin
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

### DiRT Rally 2.0 car sounds (labelled test set)

The video "DiRT Rally 2.0 All Cars Sounds" has one 40-second chapter per car (82 cars). Each car's
real cylinder count is in `samples/dr2-cars.json` (null where unknown: the Ford Fiesta R2 may be the
3-cylinder EcoBoost version, and the Speedcar Xtrem; those two are not scored). That makes it labelled
game audio to measure cylinder auto-detection against.

```sh
brew install yt-dlp ffmpeg
npm run fetch-dr2       # downloads the video's audio once, cuts samples/dr2/NN-car.wav per car
npm run eval-dr2        # auto-detection per car vs its real cylinder count → samples/dr2/results.md
npm run eval-dr2 -- --only 11,20,53                  # just some cars (manifest numbers)
npm run fetch-dr2 -- --source audio.m4a              # cut from an audio file you already have
```

YouTube's terms only allow downloading through YouTube's own features, so using yt-dlp is your call
(YouTube may also refuse it with HTTP 403). The alternative is to record the video's playback through
BlackHole, then let the script cut it:

1. In **QuickTime Player**: File > New Audio Recording, microphone **BlackHole 2ch** (the arrow next to
   the record button), the window's volume slider at zero (it plays the input back, and with BlackHole
   as output that feeds the recording into itself), then record.
2. Play the video at 1× from 0:00; stop the recording when it ends; File > Save.

```sh
npm run fetch-dr2 -- --source test.m4a --check         # after one minute: is this recording method sound?
npm run fetch-dr2 -- --source dr2.m4a --offset auto    # checks the whole recording, finds the video's 0:00, cuts per car
npm run eval-dr2
```

The Mac must play into BlackHole while it records: in System Settings > Sound > Output choose
BlackHole 2ch, or a Multi-Output Device with BlackHole and your speakers to hear it too.

**Don't capture with `ffmpeg -f avfoundation`.** It was tried here and lost about one block of sound in
eight (512 samples at a time): the 54:40 video came out 48:15 long, with a join about every 80 ms. Each
join is a click that breaks the engine's rhythm and colours its tone. ffmpeg is fine for converting.

Before cutting anything, fetch-dr2 checks the recording:

| check | what it catches | what it does |
|---|---|---|
| silence | the Mac was not playing into BlackHole | stops |
| lost sound | joins that fall on one grid of 2^k samples: a recorder dropping buffers | stops (`--force` to cut anyway) |
| feedback loop | the recording repeats itself after a fixed delay, the same in three excerpts: the recorder plays its input back into BlackHole (QuickTime: the volume slider of the recording window) | removes it (subtracts what came back: exact for a loop that only delays and scales) and cuts from the cleaned sound |
| clipping | flat tops at the recording's ceiling | warns |
| level over full scale | not cut off (AAC keeps it): only loud | scales the clips down |
| length | the recording ends before the video does | cuts only the cars that are in it |
| cut points | the sound should change where the cars change (`tools/lib/align.js`) | reports how many car changes line up; moves the start past an ad that played first; when it is sure of an ad or a pause in the middle, cuts only the cars before it (`--all` to cut them all) |

The cut-point check compares how well the first car changes fit the start with how well they fit any
other start. On the real recording of the video it confirms the start (77 of 81 car changes show a
clear change of sound; the 3 s comparison span matters, since a longer one sees the moment the driving
starts inside every clip as clearly as the change of car). An ad before the video moves the start; an
ad in the middle is only caught when the cars around it sound different enough (two trials on the real
recording with 12 s inserted were both missed, so a drop in that count is the only hint: listen to a
late clip). Clips are always cut afresh, so files from an
earlier recording never stay behind. For one car only, pick the car in the page, use **● Rec** over its
chapter, and run `npm run eval-dr2 -- --file ~/Downloads/audio-rpm-car20-….wav` (or
`--file clip.wav --car 20` for any other recording of car 20).

Don't record at 2× to save time. Players keep the pitch at 2× by cutting and splicing the sound, and
the splices land on firing pulses, which scrambles the 4-stroke cycle that cylinder detection reads.
Tested on the simulator (ffmpeg `atempo=2`, then `atempo=0.5` back to normal): rpm with the cylinder
count set by hand stays good (median error 8–11 rpm vs 3–5), but auto-detection locks the wrong count
81–95% of the time on every engine, against 0% at 1×. The set is there to test cylinder detection,
so 2× would make it useless.

The audio stays on your Mac (`samples/dr2/` is git-ignored). `results.md` has, per car: final count (✓/✗), time to first lock,
share of time locked right / wrong, how often each detector had a reading, and how often
pitch-detection and gyroball agree within 5% (there is no rpm truth in these recordings).

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
| `HTTP_HOST` | `127.0.0.1` | the page and its control socket answer on this computer only; `0.0.0.0` opens them to the network |
| `SEND_HZ` | `60` | packets per second to SimHub at least, while the rpm is fresh |
| `MAX_HZ` | `250` | each new rpm is forwarded as it arrives, up to this rate (`60` if SimHub minds) |
| `RPM_DIVISOR` | `10` | DR2 sends rpm / 10; set to `1` if SimHub shows rpm 10× too high |

The rpm (the detector on the tach: **combined** by default), the gear and the idle and redline settings
go from the detection worker straight to the server, and from there to SimHub as each one arrives.
The page's main thread is not in that path (Chrome slows it down when the tab is hidden), and there is
no waiting for a 60 Hz tick (which cost 8 ms on average).

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
| POC 1 settings: 20 ms timer, reading stamped when computed | 56 ms | 179 / 256 | 3.7% | 0.34 ms |
| + run on every 5.3 ms audio chunk | 56 ms | 176 / 250 | 3.4% | 0.32 ms |
| + stamp at window centre, predict forward | 14 ms | 142 / 220 | 3.4% | 0.33 ms |
| + tracker τ 0.05 s | 14 ms | 127 / 130 | 3.4% | 0.35 ms |
| + adaptive pitch window (**default**) | −2 ms | **52 / 58** | **0.8%** | **0.28 ms** |

**gyroball (engine-tuned, FFT 8192)**

| | lag | error mean / p90 (rpm) | glitches | process time per chunk |
|---|---|---|---|---|
| POC 1 settings | 86 ms | 264 / 342 | 4.2% | 0.70 ms |
| all optimizations, analysed every 20 ms (**default**) | 0 ms | 191 / 316 | 4.2% | 0.17 ms |

**combined** (both detectors, see [One RPM from two detectors](#one-rpm-from-two-detectors))

| | lag | error mean / p90 (rpm) | glitches | process time per chunk |
|---|---|---|---|---|
| default | −2 ms | 48 / 59 | 0.8% | 0.49 ms |

*lag* is measured, not computed: the delay that best aligns the output with the true RPM, using only
moments when the revs are ramping. *Error* is at the same instant, lag included, which is what the
tach and SimHub show. *Glitches* = share of time more than 1,500 rpm off. "POC 1 settings" already
include today's tracker fixes. The benchmark audio goes through the same low-pass and decimation as in
the page. In the browser the page adds ~3 ms chunk wait and a few ms transport,
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
  less smearing across a shift, hence the drop in error and glitches. Windows of 25 ms or less read
  the full-rate audio instead of the 12 kHz copy: at 12 kHz a V8–V12's tone near redline spans too few
  samples and YIN slips an octave. HPS can't adapt (it needs power-of-two FFT sizes), so it stays on
  the fixed window.
- **Octave check in pitch-detection.** Engines have strong half-order tones, so the waveform can repeat
  only every two firings and a period detector then reads half the RPM. If the sound repeats almost
  as well at half the detected period, the firing tone is the octave above. Without it, a simulated
  V12 locked at half its RPM after gear shifts.
- **Tracker fixes for shifts.** While readings are rejected or missing, velocity bleeds off instead
  of extrapolating (POC 1 could overshoot past redline during a shift). A new level is accepted once
  it persists for 15 ms.
- **Gyroball every 20 ms, not every chunk.** Its window is 171 ms, so analysing it every 5.3 ms brought
  nothing: same lag, error within noise (181 → 191 rpm), a quarter of the work. Between analyses its
  value is carried forward by the tracker's rate of change.
- **Gyroball rejects smeared readings.** Its 170 ms window straddles each shift for about 100 ms; the
  smeared spectrum fit upper harmonics of a low frequency with no fundamental, which read as
  idle-like dips. The engine-tuned variant now requires the fundamental to be present. The window
  length itself remains gyroball's limit: it can't react faster than its window.

## Cylinders: auto-detection

The detected pitch alone can't give the RPM: a 4-cylinder at 6,000 rpm and a V8 at 3,000 rpm fire at
the same rate. For a DiRT Rally 2.0 car, pick it in the **car** list and the count is known. Otherwise
the cylinder selector in the top bar offers:

- **Auto · rally (4/5/6/8)**, the default. Every DiRT Rally 2.0 car has 4, 5, 6 or 8 cylinders:
  mostly 4; the Audi quattro S1 E2 5; the Metro 6R4, Stratos, Porsche 911s, BMW M1/M2 and Datsun 240Z 6;
  the Rally GT V8s (Aston Martin Vantage, Camaro, Mustang) 8.
- **Auto · any (4–12)**, for other engines, such as a V10 or V12.
- **4, 5, 6, 8, 10 or 12** by hand.

How auto works: no two cylinders fire exactly alike, so an engine's sound also repeats once per engine
cycle (two crank turns). That adds faint tones between the firing harmonics, spaced by firing ÷ N.
`public/detectors/cylinders.js` checks, for each candidate N, whether those tones stand out against the
spectrum halfway between them, and takes the largest N that fits (a V8's pattern contains a
4-cylinder's, never the reverse). Votes are counted every 0.1 s; a count locks once it holds a clear
majority, and the tach shows "auto…" until then.

**No idle needed: order tracking.** While the revs change, an ordinary spectrum smears those faint tones.
So the pipeline resamples the audio on the engine's own rhythm: the tracked firing tone gives the
engine's phase at every moment, and the sound is re-sampled 64 times per firing cycle over the last
64 cycles (at most 1.4 s). In that "order spectrum" the firing tone sits at order 1 and an N-cylinder's
cycle tones at k/N, whatever the revs did, so the count works during pulls just as at idle.

**RPM gating (0–10,500 rpm).** For a firing tone f, N cylinders means 120·f/N rpm. A count is ruled out
once the revs have stayed for half a second at a level it would turn into more than 10,500 rpm (or
idle below 400 rpm), and a locked count is dropped if that happens. Gating alone can't separate 4, 5
and 6 (their rpm differ by only 20–25%, less than the uncertainty on idle and redline: a 4-cylinder at
7,500 rpm rules nothing out), but it rules out gross errors at high revs: a V8 at 7,500 rpm can't be
a 4- or 5-cylinder, a V12 at 7,000 can't be a 4, 5 or 6. Before a lock, the count used is the
smallest one still possible.

`npm run bench -- --auto`, simulated engines (time to lock, share of time locked to a wrong count,
error of the combined rpm once locked):

| engine | mode | idle, then four pulls | rally: never idle |
|---|---|---|---|
| 4 cylinders | rally | 4 after 1.7 s · 0% · 49 rpm | 4 after 0.8 s · 0% · 37 rpm |
| 5 cylinders | rally | 5 after 1.5 s · 0% · 34 rpm | 5 after 0.7 s · 0% · 32 rpm |
| 6 cylinders | rally | 6 after 1.4 s · 0% · 49 rpm | 6 after 0.7 s · 0% · 34 rpm |
| V8 | rally | 8 after 1.1 s · 0% · 49 rpm | 8 after 0.7 s · 0% · 29 rpm |
| V10 | any | 10 after 1.2 s · 0% · 26 rpm | 10 after 0.7 s · 0% · 28 rpm |
| V12 | any | 12 after 1.1 s · 0% · 24 rpm | 12 after 1.2 s · 0% · 29 rpm |
| **V12** | **rally** | **no count** · wrong 13% of the time | **no count** · wrong 20% of the time |

The last row is the price of the rally set: a V12 isn't in it, so its rpm can't come out right
(~2,000 rpm error). Gating keeps it from settling on a wrong count (before gating it stayed locked as a
4-cylinder, at 3× the real rpm, 97% of the time). Use **Auto · any** for anything that isn't a
DiRT Rally 2.0 car.

What this can't know: it relies on the faint per-cylinder tones. A perfectly regular engine (the
simulator with them switched off) is never given a count, rather than a wrong one. On the one clean
clip of real game audio so far (the DS 21, a 4-cylinder), it locked on 4 within the first second of
driving. A car whose loudest tone isn't the firing tone (some boxers and cross-plane V8s) may need
the count picked by hand or **Calibrate**.

## One RPM from two detectors

The first clean clip of real DiRT Rally 2.0 sound (24 s of the DS 21: idle, two revs to the limiter in
neutral, then driving through three shifts) showed how the detectors fail on game audio, which the
simulator had not: never at random, but by reading **a half or a quarter of the true revs**. On the
rev limiter and when revving in neutral, the engine's slower rhythms (the crank and cycle tones) get as
loud as the firing tone, and a period detector then finds the longer period. The slip is always
downward, and gyroball slips less often than pitch-detection.

`public/fusion.js` combines them into the **combined** rpm, the default for the tach, SimHub and
shift detection:

- when they agree, or disagree by anything but an octave: pitch-detection (the faster one; gyroball
  is still catching up at a gear shift);
- when a reading sits exactly an octave or two below where the revs just were, it is raised, for as
  long as gyroball still reads the higher octave, or else for up to 2.5 s while the corrected revs don't
  fall (a stay on the limiter). A real shift that halves the revs exactly would be shown 2.5 s late;
  gearboxes rarely have one;
- an octave relation must last 80 ms before it is acted on (falling revs cross "half of the other
  reading" for an instant; a slip stays there).

Share of the time each rpm is right (within 6%) on that clip, against a reference traced on its
spectrogram:

| | right | half | quarter | other / none |
|---|---|---|---|---|
| pitch-detection | 55% | 15% | 20% | 10% |
| gyroball | 70% | 19% | 1% | 11% |
| **combined** | **90%** | 4% | 0% | 7% |

With the combined rpm, the two clean upshifts in the clip are found (×0.72 and ×0.73), with no false
shift; with pitch-detection alone one was missed and two were misread. What is left wrong is mostly
revving in neutral on the limiter, where the readings also hop to three quarters of the revs, a ratio a
real shift can have. One car and 24 seconds: these rules will be re-measured on the full set.

## Gear shifts and gear

In gear, the revs follow the car's speed and change gradually. A shift is a step: the revs drop
(upshift) or jump (downshift) by a gearbox ratio in a fraction of a second, then change gradually
again. `public/detectors/shifts.js` reports a shift when the combined rpm makes a fast, short
change of 10% to ×1.93 that starts from calm revs and then stops. A lift, a launch and a stop are
fast too, but last longer or change the revs more; a change of exactly ×2 or ÷2 is the pitch detector
slipping an octave, not a shift.

The rpm doesn't say which gear, so the gear is **counted**: 1st whenever the car has been standing
(steady revs below 1.6 × the idle setting for a second), then +1 or −1 per shift, kept within 1 and
the **Gears** setting. Until the car has stood still once it shows `?`, and one missed shift leaves
it off by one until the next stop. The tach shows the gear and marks each shift with ▲ or ▼;
recordings get `gear`, `shift` and `shift_ratio` columns; `npm run analyze` lists the shifts; the
UDP packet carries the gear (0 while unknown).

Measured on the simulated stage only (`npm run bench -- --shifts`; 3 laps, shifts of 0.1 s up and
0.08 s down, drops of ×0.69 to ×0.83):

| engine | shifts found | false | delay, median / max | ratio error (median) | gear right |
|---|---|---|---|---|---|
| 4 cyl | 36 of 36 | 1 | 184 / 220 ms | 0.8% | 100% |
| 5 cyl | 36 of 36 | 2 | 185 / 204 ms | 1.0% | 100% |
| 6 cyl | 36 of 36 | 0 | 183 / 207 ms | 0.7% | 100% |
| 8 cyl | 36 of 36 | 0 | 180 / 209 ms | 0.8% | 100% |

The delay runs from the start of the shift to its report: the shift itself (0.1 s), then the check
that the revs have stopped moving (40 ms; 80 ms gave 245 ms for the same results). "Gear right" leaves
out the 0.4 s around each shift. On the one real clip so far (DS 21), its three upshifts are found, none
false. Expect wheelspin and jumps (revs flaring with no shift) to give false shifts on
loose surfaces, and slow H-pattern shifts to be missed: the thresholds are in `SHIFT`.

Each shift's drop is measured to about 1%, and each pair of gears has its own (×0.69 for 1→2,
×0.83 for 4→5 in the simulation). That is the way to an absolute gear that corrects a miscount, once
a car's ratios are known or learned; it is not built.

## Car recognition

With **car → Auto · recognise**, the page names the car from its sound and uses that car's cylinder
count, idle and redline. It needs each car's sound learned first:

```sh
npm run fetch-dr2 -- --source dr2.wav --offset auto   # the 82 clips (see above)
npm run learn-cars                                     # → samples/dr2/car-profiles.json; then reload the page
npm run eval-cars                                      # how well it tells the clips apart → samples/dr2/results-cars.md
npm run learn-cars -- --file ~/Downloads/audio-rpm-car20-….wav   # add a recording of your own driving of car 20
npm run eval-cars -- --file some-recording.wav         # what is recognised in a recording, second by second
```

**How.** Shazam-style fingerprints match one exact recording, and a car in a game never plays the same
sound twice. What a car keeps is its tone at each engine speed and load. A profile is up to 32 typical
"snapshots" of the car's sound per recording: the level of 20 third-octave bands from 80 Hz to 8 kHz,
whatever the volume (`public/detectors/car-id.js`). Ten times a second the live sound's snapshot is
compared with every car's; the evidence adds up over about 6 seconds, against an "unknown sound"
option that wins when the sound is far from every car. Nothing in it uses the rpm or the cylinder
detection, so it can give them the cylinder count.

**What it does with the answer.** Cars that sound alike split the evidence, so no car is named, but if
they share a cylinder count (they usually do) the count is still used. In Auto cylinder mode a
recognised count replaces the one counted from the engine-cycle tones; a count you pick by hand is
never overridden. A named car stays until another car is named: silence or other sounds don't erase it.

**How good.** Measured on simulated cars only: 82 engines with the real cars' cylinder counts, each
given its own tone, two pairs made to sound identical, learned from a 40 s drive (idle, then pulls to
the redline) and recognised on 12 s of rally-style driving it was not learned from.

| simulated cars | result |
|---|---|
| car named, right | 78 of 82 |
| car named, wrong | 0 |
| not named (the two identical-sounding pairs) | 4, cylinder count still right |
| cylinder count | 80 of 80 right, known 2.8 s after the sound starts |
| a sound unlike every car (V12 with another tone) | left unrecognised |

Real game audio has not been measured: `npm run eval-cars` does it on your clips. Two things to expect.
The clips come from one video with its own camera and mix, so profiles learned from it may be far from
your in-game sound: add recordings of your own driving with `learn-cars -- --file`. And a sound that
resembles a learned car can be taken for it (`unknown: 6` in `CAR_ID` sets how far is too far; 8 of 30
simulated engines with no profile but a tone of the same kind were matched to some car), so use
Auto · recognise for DiRT Rally 2.0 only.

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

## Tests

```sh
npm test          # packet layout, car list, car recognition, combined rpm, shifts and gear, recording checks, detectors (4–12 cyl), cylinder detection (incl. no idle, gating), tracker, pipeline, lag estimator
npm run bench     # step-by-step lag benchmark (-- --cylinders 6 etc.)
npm run bench -- --auto   # cylinder auto-detection on every engine, with and without idle
npm run bench -- --shifts # gear shifts and gear on the simulated stage
npm run test:ui   # the page in a real browser at Retina scale (needs Playwright, see test/ui/smoke.mjs)
```

## Layout

```
server.js                    page + vendor files (bare imports rewritten for workers), WebSocket, UDP
src/dr2-packet.js            DR2 packet build/parse (66 floats, rpm at bytes 148..152)
public/index.html, app.js    UI: tachometer, cards, latency panel, chart, settings
public/capture-worklet.js    audio thread: chunks raw + low-passed audio to the worker
public/detect-worker.js      runs the pipeline on each chunk, skips backlog
public/pipeline.js           both detectors, adaptive window, trackers, prediction (shared with bench/tests)
public/detectors/            gyroball-core.js (ported, engine-tuned), pd-core.js (pitch-detection wrapper),
                             cylinders.js (cylinder count from the engine-cycle tones),
                             car-id.js (car recognition from the tone: snapshots, profiles, matcher),
                             shifts.js (gear shifts from the rpm's steps, counted gear)
public/tracker.js            alpha-beta tracker (adapted from gyroball-rpm)
public/fusion.js             one rpm from the two detectors (octave slips corrected)
public/lag.js                measured-lag estimator
public/ring.js               ring buffer
public/engine-model.js       engine sound model + rpm schedule (simulator, WAV, bench)
public/engine-sim.js         in-browser simulated engine
public/cars.js               car keys and file names, shared by the car picker and the dataset tools
tools/                       udp-listen (SimHub stand-in), make-test-wav, bench, analyze (replay a WAV),
                             fetch-dr2 / eval-dr2 (DiRT Rally 2.0 car-sound set), cars (learn-cars / eval-cars:
                             car profiles and how well cars are recognised), lib/audio.js (WAV + replay),
                             lib/quality.js (lost sound, clipping), lib/align.js (cut points vs the sound)
samples/dr2-cars.json        the 82 cars: chapter times, real cylinder count, engine layout (the page's car list)
```

## Next: POC 2

Plug the DualSense's 3.5 mm headphone jack into a line-in on the Mac (a USB audio interface with a
line input works), and pick that input instead of BlackHole. On the PS5, send all audio to the
headphones. Nothing else changes; the latency panel's *capture* column will show the new device.

Credits: detector and tracker logic adapted from [gyroball-rpm](https://github.com/berkenbu/gyroball-rpm)
(MIT); pitch algorithms from [pitch-detection](https://github.com/audiojs/pitch-detection) (MIT).
See THIRD_PARTY.md.
