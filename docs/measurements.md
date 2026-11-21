# How it works and what was measured

Back to the [README](../README.md). Numbers here are re-measured when the detection changes
(`npm run bench`, `npm run eval-rpm`, `npm run eval-dr2`, `npm run eval-cars`).

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

(With the firing-tone check of the next section the detectors themselves read 83% and 80% right on
this clip; the combined rpm stays at 90%.)

With the combined rpm, the two clean upshifts in the clip are found (×0.72 and ×0.73), with no false
shift; with pitch-detection alone one was missed and two were misread. What is left wrong is mostly
revving in neutral on the limiter, where the readings also hop to three quarters of the revs, a ratio a
real shift can have. One car and 24 seconds: these rules will be re-measured on the full set.

## Is the rpm right? Every real car against a reference

The recordings of the 82 cars have no rpm truth, so one is computed offline, from the sound alone and
without the cylinder count (`tools/lib/reference.js`):

1. Follow the car's loudest tone through the clip (a ridge in the spectrogram, found with a path
   search that allows fast shifts but no jumps to an unrelated tone).
2. Resample the sound along that tone, so that the tone stands still, and take the spectrum: every
   engine tone is a multiple of the **cycle frequency** (rpm / 120, one cycle = two turns of the
   crank), so the tones now sit at fractions k/j of the loudest one. The j that explains them says the
   loudest tone is the j-th multiple of the cycle.
3. rpm = 120 × tone / j.

On the DS 21 clip it agrees with the hand-traced reference on 96% of the moments where it is sure
(83% of the clip). It needs about a second of sound around each moment, so it is a measuring tool, not
a detector. It is not always right either: whine from a turbo or gearbox can make it read j = 10 or 12
on a four. So `npm run eval-rpm` only scores the moments where the reference is sure **and** j is the
car's cylinder count, half of it or twice it (from a few percent to 86% of a clip; two cars have no such moment).

**What it found.** With the cylinder count set by hand, the combined rpm was right 69% of the scored
time. The largest single fault: on many cars pitch-detection and gyroball lock onto the cycle or the
crank tone and read a quarter or a half of the revs, even while the firing tone is the loudest tone
in the spectrum (Ford Escort RS Cosworth, Subaru Legacy: a quarter of the revs for more than half of
the driving).

**The fix: the firing tone among the multiples of the pitch** (`firingTone` in `public/pipeline.js`).
With the cylinder count known, a pitch that is not the firing tone can only be the firing tone divided
by a divisor of the count. So the few candidates (pitch × 2 and × 4 on a four; × 2, × 3, × 6 on a six)
are looked up in the spectrum gyroball already has, and the loudest is taken if it:

- beats the pitch by 3 dB and stays within the rev range;
- beats the pitch's next multiples by 5 dB. Above a true firing tone those are weak in-between tones;
  above the second harmonic of a firing tone they are its third harmonic, nearly as loud. Without this
  test a strong second harmonic was read as twice the revs (Mitsubishi Lancer Evo VI, Opel Manta);
- has lasted 60 ms, or lands where the detector already was. A wrong correction of a few frames costs
  seconds otherwise: the combined rpm takes the true readings that follow for a slip to half.

**Three V6s that sound like two threes.** On the Lancia Stratos and both MG Metro 6R4s the loudest
tone is half the firing tone and the firing tone itself is weak, so both detectors read half the revs
throughout, and nothing in one spectrum tells that from a six at half the revs. The car list
(`samples/dr2-cars.json`) now gives these three `"scale": 2`, and the page starts their calibration
from it (picked or recognised; "Reset scales" goes back to it). Right on those cars: 0–8% → 64–78%.

Share of the scored time each rpm is right (within 6% of the reference), 80 cars, before → after both
changes:

| | all | 4-cyl (68) | 5-cyl (1) | 6-cyl (8) | 8-cyl (3) | reads ½ or ¼ |
|---|---|---|---|---|---|---|
| pitch-detection | 58 → 70% | 65 → 74% | 11 → 27% | 21 → 54% | 2 → 44% | 14 → 3% |
| gyroball | 63 → 72% | 68 → 73% | 64 → 64% | 28 → 67% | 7 → 69% | 9 → 2% |
| **combined** | **69 → 78%** | 75 → 79% | 36 → 62% | 38 → 72% | 3 → 66% | 9 → 2% |

The simulator benchmarks are unchanged by it (its firing tone is always the loudest). It is off while
the cylinder count is being detected from the sound (auto-detection works on the pitch as found, and
lost 5 of its 66 right counts with it on): pick the car, or let it be recognised, to get it. The 8-cyl
column is two cars (Ford Mustang GT4 and a few seconds of the Aston Martin; the Camaro has no scored
moment).

What is still wrong:

- A car with a saved calibration keeps it: if you calibrated one of the three V6s before this change,
  press "Reset scales" on it once.
- Subaru Legacy RS (28%), Aston Martin V8 Vantage GT4 (20%), Lancia 037 (46%), Subaru Impreza (49%,
  half the revs a third of the time): boxer and V8 rumble; not looked into yet.
- Peugeot 206 Rally (39%, "twice the revs" 47%): here the reference is the doubtful one (it only found
  moments where the loudest tone is twice the firing tone).
- The 17% "other" on all cars is not broken down yet: part of it is the detectors' lag at shifts
  against a reference that has none.

```sh
npm run eval-rpm
npm run eval-rpm -- --only 13,25
npm run eval-rpm -- --cylinders auto
```

It writes `samples/dr2/results-rpm.md` (per car: share of the clip scored, the loudest tone the
reference found, share right for each rpm, most common error).

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
