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
| + adaptive pitch window (**default**) | −2 ms | **36 / 44** | **0.0%** | **0.27 ms** |

**gyroball (engine-tuned, FFT 8192)**

| | lag | error mean / p90 (rpm) | glitches | process time per chunk |
|---|---|---|---|---|
| POC 1 settings | 86 ms | 264 / 342 | 4.2% | 0.70 ms |
| all optimizations, analysed every 20 ms (**default**) | 0 ms | 191 / 316 | 4.2% | 0.17 ms |

**combined** (both detectors, see [One RPM from two detectors](#one-rpm-from-two-detectors))

| | lag | error mean / p90 (rpm) | glitches | process time per chunk |
|---|---|---|---|---|
| default | −2 ms | 32 / 44 | 0.0% | 0.43 ms |

That engine is cleaner than a real one: its cylinders sound alike. The benchmark also runs the same
drive with cylinders that don't (the tones of the engine cycle at 0.3, as on most real cars; see
"Is the rpm right?" for why it matters):

| | lag | error mean / p90 (rpm) | glitches |
|---|---|---|---|
| pitch-detection | −26 ms | 132 / 162 | 3.1% |
| gyroball | 0 ms | 174 / 330 | 3.1% |
| **combined** | −26 ms | **82 / 141** | **1.1%** |
| combined, without the second try and the firing-tone check | no match | 2,986 / 5,121 | 70% |

(The negative lag is the prediction running ahead on that engine; on the real clips the combined rpm
is a median 60 ms behind.)

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
| 4 cylinders | rally | 4 after 1.7 s · 0% · 30 rpm | 4 after 0.8 s · 0% · 37 rpm |
| 5 cylinders | rally | 5 after 1.5 s · 0% · 27 rpm | 5 after 0.7 s · 0% · 32 rpm |
| 6 cylinders | rally | 6 after 1.3 s · 0% · 25 rpm | 6 after 0.7 s · 0% · 30 rpm |
| V8 | rally | 8 after 1.1 s · 0% · 23 rpm | 8 after 0.7 s · 0% · 29 rpm |
| V10 | any | 10 after 1.2 s · 0% · 22 rpm | 10 after 0.7 s · 0% · 28 rpm |
| V12 | any | 12 after 1.1 s · 0% · 21 rpm | 12 after 0.9 s · 0% · 29 rpm |
| **V12** | **rally** | **no count** · wrong 13% of the time | **no count** · wrong 20% of the time |

The last row is the price of the rally set: a V12 isn't in it, so its rpm can't come out right
(~2,000 rpm error). Gating keeps it from settling on a wrong count (before gating it stayed locked as a
4-cylinder, at 3× the real rpm, 97% of the time). Use **Auto · any** for anything that isn't a
DiRT Rally 2.0 car.

What this can't know: it relies on the faint per-cylinder tones. A perfectly regular engine (the
simulator with them switched off) is never given a count, rather than a wrong one. On the one clean
clip of real game audio so far (the DS 21, a 4-cylinder), it locked on 4 within the first second of
driving. On the recordings of all the game's cars (`npm run eval-dr2`): **72 of 80 right, none wrong,
8 undecided** (67 of the 68 fours and the five right; 4 of 8 sixes; none of the 3 V8s). It was 66 before
pitch-detection learned to read engines whose cylinders don't sound alike (see "Is the rpm right?"). A car whose loudest tone isn't the firing tone (some boxers and cross-plane V8s) may need
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

(With the changes of the next section the detectors themselves read 85% and 78% right on this clip,
and the combined rpm 94%.)

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

**Pitch-detection was deaf on many cars.** With the revs steady it had a reading only 59% of the time
(4% on the Ford Escort RS Cosworth, the Subaru Legacy and the Audi quattro). Its window is a few firing
periods long, and on a real engine one firing period does not repeat the last one closely enough: the
cylinders don't sound alike. What repeats exactly is the whole engine cycle, two turns of the crank.
So when the short window finds nothing, a second try now uses a window that holds the cycle twice,
and accepts YIN's deepest dip when it is clear enough (the package gives up without a dip below its
threshold; the YIN paper doesn't). The cycle it finds becomes the firing tone through `firingTone`.
A second-try reading may only continue the detector's track (through a shift too), not start a new
level: in a shift the firing tone fades and the cycle alone would read a quarter of the revs. With the
revs steady, pitch-detection now has a reading 93% of the time, and it is right 86% of the time.

**A jump up an octave is not believed from pitch-detection alone** (`upHold` in `public/fusion.js`).
The first fusion rules assumed a detector only ever slips down. On real cars pitch-detection also
slips up, onto the second harmonic of the firing tone, for a tenth of a second (Peugeot 205 GTI); the
combined rpm then took the true readings that followed for a slip to half and showed twice the revs
for seconds. Revs cannot double between two readings, so the output now stays where it was heading
until gyroball reads the higher value too, or the jump has lasted 0.5 s. In `firingTone`, a multiple
that is twice one already accepted must beat it by 3 dB on fours and V8s (it could be its second
harmonic), and a correction away from a pitch that continues the detector's own track must last 0.5 s.

**The reference was wrong on three cars, and with it part of the above.** On the Subaru Impreza it
read ten seconds of a 160 Hz tone as the crank tone (9,600 rpm) between two stretches of the same
tone read as the firing tone (4,800 rpm); likewise on the Škoda Fabia 2005 and the Ford RS200. The
"half the revs a third of the time" these cars were charged with was the reference at twice the
revs. A tone that carries on from one stretch to the next is now the same order in both: where two
readings of it disagree, the cylinder count (when given) settles it for the firing tone, and
otherwise the larger order wins if the smaller divides it. Against the corrected reference the
Impreza is right 88% of the time instead of 51%, without any change to the detectors.

**Each car's tone map** (`public/detectors/tones.js`). The general rule above (the loudest
candidate is the firing tone) is wrong on exactly the cars that are hard: the Porsche 911 RGT, whose
half-firing tone is often the louder, the Subaru Impreza 1995, the Audi quattro. With the car known,
each rpm the pitch could stand for is tested instead against what this car sounds like at that rpm:
the levels of its first 16 engine orders, read from the spectrum at the places that rpm puts them,
compared with the levels learned for that rpm band (a likelihood: deviation in units of each
order's own spread, with a charge for a wide spread). The map overrules the general rule only when
another rpm fits the car clearly better, and where it backs the answer the waiting rules are skipped.
`npm run learn-cars` learns the maps from the clips (the reference gives the rpm) into
`car-profiles.json`; the page uses the map of the car that is picked or recognised. A car has one
map per recording it was learned from, and the one that fits the sound answers: the engine sounds
different from each camera, so record a car once per camera you use and learn each.

The fair test (`npm run eval-rpm -- --tones split`): each car's map learned from every other 4 s
of its clip, the detectors scored on the rest, without and with it:

| combined rpm right | all | 4-cyl (68) | 5-cyl (1) | 6-cyl (8) | 8-cyl (3) | on a wrong tone |
|---|---|---|---|---|---|---|
| without the tone maps | 84% | 86% | 58% | 75% | 73% | 3% |
| **with them** | **85%** | 86% | **69%** | **80%** | 74% | **1%** |

15 cars gain 2 points or more (Porsche 911 RGT 53 → 82%, Subaru Impreza 1995 66 → 84%, Audi quattro
58 → 69%, Datsun 240Z 64 → 75%), 7 lose 2 to 4. Most cars were already right, so the average moves
little; the weak ones move a lot. It is still one recording per car, learned and tested on two
halves of it: your own driving, and another camera, are the real test.

On the whole clips, with the maps learned from those same clips (flattering, but it is what the page
does with these recordings):

| | all | 4-cyl (68) | 5-cyl (1) | 6-cyl (8) | 8-cyl (3) |
|---|---|---|---|---|---|
| pitch-detection | 84% | 85% | 56% | 76% | 65% |
| gyroball | 75% | 76% | 64% | 73% | 70% |
| **combined** | **86%** | 87% | 69% | 81% | 70% |
| combined, without the maps (`--tones off`) | 83% | 85% | 61% | 73% | 69% |

66 of the 78 scored cars are at 80% or more; the median car is at 87%. (The first measurement of all,
before any of this section and against the first version of the reference, was 69%.) With cylinder
auto-detection instead of the car's count (`npm run eval-rpm -- --cylinders auto`) the combined rpm
is right 72% of the time: until a count is locked the rpm is on the guess of four cylinders, and the
firing-tone check, the second try's long window and the tone map wait for a car or a count that is
certain (letting a locked count switch them on gained nothing and cost 6 right counts): pick the car,
or let it be recognised. The 8-cyl column is two cars (Ford Mustang GT4 and a few seconds of the
Aston Martin; the Camaro has no scored moment).

**What the remaining 14% is.** Each wrong moment is checked against the reference a little earlier
and later (`eval-rpm` reports it as "timing"):

| share of the scored time | what |
|---|---|
| 86% | right |
| 10% | right, but late or early: the value matches the reference of up to 0.15 s before or after |
| under 1% | on another tone of the engine (½, ¼, ×2…) |
| 3% | wrong otherwise |

The lag is the larger half of what is left. These clips are showcases with much revving in neutral:
the revs move faster than 75% per second during 16% of the scored time, and there the combined rpm is
right 44% of the time, against 94% when they are steady. Two tracker changes were measured for it and
not kept: a shorter time constant (0.03 s: +1 point, but auto-detection loses 3 right counts) and
carrying the rate of change through a re-acquire (+1 point, but the rpm overshoots and shift
detection loses 12 points). One was kept: readings from the second try's long window are stamped
earlier than those of the short window before them, and the tracker used to drop them or predict
from the wrong moment; it now weighs each reading at its own time. The combined rpm runs a median 60 ms behind
the reference (40 ms on the simulated stage, where a steady pull hides it: the tracker predicts
through a steady slope, not through a blip or a shift). During fast changes pitch-detection often
has no reading, and gyroball's 170 ms window reads the past.

**Is it worth running both detectors?** Yes, measured on the same moments (before the tone maps and
the corrected reference, which lift every row by a few points):

| | right |
|---|---|
| pitch-detection alone | 79% |
| gyroball alone | 72% |
| plain average of the two | 74% |
| **combined** (the rules above) | **82%** |
| at least one of the two right: the most any choice between them could reach | 83% |

Both are right 68% of the time, only pitch-detection 11%, only gyroball 4%, neither 17%. The combined
rpm is right in 97.5% of the moments where at least one is, so choosing between them is nearly used
up; averaging is worse than pitch-detection alone, because when they disagree one of them is on a
wrong tone and the average is on none. Per car, the combined rpm beats the better detector by more
than a point on 32 of 77 cars and loses by more than a point on 4. When both are right, gyroball's
value is the less exact (median error 0.8% against 0.45%), so there is nothing to gain from mixing
values either. What is left to win is in the 17% where neither is right, most of it fast rev changes:
that needs a detector that follows them, not a better mix.

What is still wrong:

- A car with a saved calibration keeps it: if you calibrated one of the three V6s before `"scale": 2`
  existed, press "Reset scales" on it once.
- Aston Martin V8 Vantage GT4 (21%, 2 s scored), Volkswagen Golf GTI 16v (57%), Lancia 037 (65%),
  Subaru WRX STI RX (68%), Audi quattro (69%), MG Metro 6R4 (69%), Datsun 240Z (72%): mostly lag now,
  not wrong tones.
- Peugeot 206 Rally (39%, "twice the revs" half of the time): its loudest tone is the second
  harmonic of the firing tone, and the reference is sure of only 7 s of it, too little for a map that
  overrules the detectors.
- Fast rev changes, as above.

```sh
npm run eval-rpm
npm run eval-rpm -- --only 13,25
npm run eval-rpm -- --cylinders auto
npm run eval-rpm -- --tones split
npm run eval-rpm -- --tones off
```

It writes `samples/dr2/results-rpm.md` (per car: share of the clip scored, the loudest tone the
reference found, share right for each rpm, most common error).

## Gear shifts and gear

In gear, the revs follow the car's speed: over a third of a second they are a straight line (in log
rpm). A shift is a break between two such lines: the revs drop (upshift) or jump (downshift) by a
gearbox ratio. `public/detectors/shifts.js` fits a line to the combined rpm over 0.3 s before a gap
of 0.18 s and one over 0.2 s after it, carries both to the middle of the gap, and reports a shift when
they differ by 11% to ×1.93. Both lines must fit (2.5% rms), neither may be steeper than 1.2 per
second (a rev blip is), the difference in their slopes may explain half the step at most (a lift
followed by throttle is a V, not a step), and revs falling on both sides of a drop are a lift. A
change of exactly ×2 or ÷2 is a detector slipping an octave, not a shift.

The rpm doesn't say which gear, so the gear is **counted**: 1st whenever the car has been standing
(steady revs below 1.6 × the idle setting for a second), then +1 or −1 per shift, kept within 1 and
the **Gears** setting. Until the car has stood still once it shows `?`, and one missed or false shift
leaves it off by one until the next stop. The tach shows the gear and marks each shift with ▲ or ▼;
recordings get `gear`, `shift` and `shift_ratio` columns; `npm run analyze` lists the shifts; the
UDP packet carries the gear (0 while unknown).

**On the simulated stage** (`npm run bench -- --shifts`; 3 laps, shifts of 0.1 s up and 0.08 s down,
drops of ×0.69 to ×0.83):

| engine | shifts found | false | delay, median / max | ratio error (median) | gear right |
|---|---|---|---|---|---|
| 4 cyl | 36 of 36 | 0 | 280 / 315 ms | 2.8% | 100% |
| 5 cyl | 36 of 36 | 0 | 273 / 309 ms | 2.3% | 100% |
| 6 cyl | 36 of 36 | 0 | 273 / 309 ms | 1.6% | 100% |
| 8 cyl | 36 of 36 | 0 | 273 / 309 ms | 3.1% | 100% |

**On the 80 real cars** (`npm run eval-shifts`). The clips have no gear truth, so the shifts are
read from the offline reference rpm with the same idea, strictly: a break of 10% or more between two
lines that fit within 2%. On the simulator's own reference that lists its shifts and nothing else
(11 or 12 of 12). A live shift that matches none of those is checked against the reference at that
moment: real (the reference steps there too, just not cleanly enough to be listed), false (it does
not), or not judged (the reference is unsure there: idle, revving in neutral, the first second of a
launch).

| | first detector (a fast, short change of the rpm) | now (break between two lines) |
|---|---|---|
| clean shifts found | 243 of 313 (78%) | **300 of 363 (83%)** |
| live shifts judged false | 214 of 644 (33%) | **46 of 445 (10%)** |
| live shifts not judged | 1,584 (20 per clip) | 527 (7 per clip) |
| reported after the shift | 225 ms | 314 ms |
| ratio off by (median) | 6.4% | 5.0% |

(The first column was measured before the reference was corrected and the tone maps added, which is
why it has fewer clean shifts to find.) The first detector was tuned on the simulator, where the rpm is smooth; on real sound the rpm has
glitches and holes that look just like its "fast, short change". The price of the line fit is
0.09 s: a shift is reported 0.32 s after it instead of 0.23 s (0.28 s instead of 0.19 s on the
simulator, where the ratio is also measured to 2–3% instead of 1%).

What this means for the gear on the tach: on a real stage it is right after a standstill and for the
next few shifts, then drifts: one shift in five is missed, one reported shift in ten is false, and
revving in neutral still gives a few. All clean shifts are found on 43 of the 73 cars that have any;
the worst are the Porsche 911 RGT, Ford Mustang GT4 and Audi quattro (1 found of 6 to 8), where the
rpm itself is weak. A count cannot correct itself. The way to a gear that can is each gear pair's
own ratio (×0.69 for 1→2, ×0.83 for 4→5 in the simulation): at 5% the ratios are not yet measured
well enough for it, and it is not built.

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
