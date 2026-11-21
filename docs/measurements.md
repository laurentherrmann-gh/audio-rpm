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

| | describes the moment | error mean / p90 (rpm) | glitches | process time per chunk |
|---|---|---|---|---|
| the path, read 30 ms back (**default**) | 30 ms ago | **14 / 25** | 0.0% | 0.55 ms |
| the path, read at now | 10 ms ago | 26 / 57 | 0.0% | 0.55 ms |
| the first way (rules, reading by reading) | 2 ms ahead | 32 / 44 | 0.0% | 0.46 ms |

The combined rpm is read a little back on purpose (see "The path" below): its error is measured
against the true rpm of the moment it describes, and the first column says how late that moment is.

That engine is cleaner than a real one: its cylinders sound alike. The benchmark also runs the same
drive with cylinders that don't (the tones of the engine cycle at 0.3, as on most real cars; see
"Is the rpm right?" for why it matters):

| | lag | error mean / p90 (rpm) | glitches |
|---|---|---|---|
| pitch-detection | −26 ms | 132 / 162 | 3.1% |
| gyroball | 0 ms | 174 / 330 | 3.1% |
| **combined** (the path, 28 ms back) | 28 ms | **25 / 56** | **0.0%** |
| combined, without the second try and the firing-tone check | 46 ms | 269 / 456 | 6.8% |

(With the first way of combining, the rules, the combined rows were 82 / 141 rpm with 1.1% glitches,
and 2,986 / 5,121 rpm with 70% glitches without the second try. The negative lag of
pitch-detection is its prediction running ahead on that engine.)

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
error of the combined rpm once locked, against the true rpm of the moment it describes, 30 ms back):

| engine | mode | idle, then four pulls | rally: never idle |
|---|---|---|---|
| 4 cylinders | rally | 4 after 1.7 s · 0% · 12 rpm | 4 after 0.8 s · 0% · 11 rpm |
| 5 cylinders | rally | 5 after 1.5 s · 0% · 10 rpm | 5 after 0.7 s · 0% · 10 rpm |
| 6 cylinders | rally | 6 after 1.3 s · 0% · 10 rpm | 6 after 0.7 s · 0% · 11 rpm |
| V8 | rally | 8 after 1.1 s · 0% · 10 rpm | 8 after 0.7 s · 0% · 12 rpm |
| V10 | any | 10 after 1.2 s · 0% · 10 rpm | 10 after 0.7 s · 0% · 12 rpm |
| V12 | any | 12 after 1.1 s · 0% · 8 rpm | 12 after 0.9 s · 0% · 11 rpm |
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

### The path: looking back a little

The rules decide reading by reading, and they put every reading at "now". Neither is right. A
reading describes the middle of its analysis window: pitch-detection's is 10 to 65 ms old when it
arrives, gyroball's 85 ms. And which reading to believe is easier to say with the readings around
it in view, which is what the offline reference does. `public/path.js` does both, live, and is now
what makes the combined rpm (`fusion.js` is kept: `combine: 'rules'` in the pipeline settings,
for comparison):

- every reading is filed under the moment it describes, so the two detectors' readings of the same
  moment meet, however late each arrives;
- on a grid of rpm values (48 per octave, one moment every 5 ms), a value costs nothing where a
  detector reads it, a little where it is twice, four times or half a reading (the detector has
  slipped to a neighbouring tone), and a fixed price where no reading is near. The two detectors'
  costs add up, gyroball's counting 0.8;
- from one moment to the next the rpm may move a little for little, or jump anywhere for a fixed
  price;
- the cheapest path through all of it is kept up to date (the Viterbi algorithm), and its last
  0.11 s is worked out again at every step, since readings of those moments are still arriving.

The combined rpm is that path, read **30 ms back** by default (the "Look-back" setting): by then
pitch-detection has spoken of the moment and gyroball is about to. Read at "now", the path's end is
carried on from the newest reading. The tach and SimHub show the value 30 ms later than they could;
it is right more often, most of all while the revs move:

| combined rpm, 80 real cars, tone maps on | right | while the revs are steady | while they move fast |
|---|---|---|---|
| the rules | 86% | 94% | 44% |
| the path, read at now | 89% | 95% | 60% |
| **the path, read 30 ms back (default)** | **92%** | **96%** | **72%** |

70 of the 78 scored cars gain 2 points or more over the rules, one loses 2 (Ford Sierra Cosworth
RS500, 85 → 83%, on 3 s of scored sound). It costs 0.09 ms per 5 ms chunk.

On the hand-traced DS 21 clip above, the path is right 94% of the time, as the rules that were
written from that clip. Getting there took two corrections that the 80 cars did not ask for but
that clip did: a reading also stands for four times its value (pitch-detection on a quarter of the
revs while gyroball reads them right, on the limiter), and a jump costs more than two moments of
one detector reading something else (the path used to follow every stray reading during a shift).

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
| without the tone maps | 91% | 92% | 67% | 86% | 78% | 2% |
| **with them** | **92%** | 93% | **76%** | **90%** | **85%** | **1%** |

9 cars gain 2 points or more (Porsche 911 RGT 67 → 93%, Audi quattro 67 → 76%, Datsun 240Z
80 → 88%, Ford Mustang GT4 80 → 88%, Subaru Impreza 1995 85 → 92%), 2 lose 2 or 3. Most cars were
already right, so the average moves little; the weak ones move a lot. (Before the path, with the
rules, the same test read 84% and 85%, with 15 cars gaining: the path now gets by itself part of
what the maps corrected.) It is still one recording per car, learned and tested on two halves of
it: your own driving, and another camera, are the real test.

On the whole clips, with the maps learned from those same clips (flattering, but it is what the page
does with these recordings):

| | all | 4-cyl (68) | 5-cyl (1) | 6-cyl (8) | 8-cyl (3) |
|---|---|---|---|---|---|
| pitch-detection | 84% | 85% | 56% | 76% | 65% |
| gyroball | 75% | 76% | 64% | 73% | 70% |
| **combined** (the path, 30 ms back) | **92%** | 92% | 76% | 91% | 83% |
| combined, without the maps (`--tones off`) | 91% | 92% | 69% | 83% | 71% |
| combined the first way (the rules: `--cfg '{"combine":"rules"}'`) | 86% | 87% | 69% | 81% | 70% |

72 of the 78 scored cars are at 80% or more, 61 at 90% or more; the median car is at 93%. (The first
measurement of all, before any of this section and against the first version of the reference, was
69%.) With cylinder
auto-detection instead of the car's count (`npm run eval-rpm -- --cylinders auto`) the combined rpm
is right 79% of the time: until a count is locked the rpm is on the guess of four cylinders, and the
firing-tone check, the second try's long window and the tone map wait for a car or a count that is
certain (letting a locked count switch them on gained nothing and cost 6 right counts): pick the car,
or let it be recognised. The 8-cyl column is two cars (Ford Mustang GT4 and a few seconds of the
Aston Martin; the Camaro has no scored moment).

**What the remaining 8% is.** Each wrong moment is checked against the reference a little earlier
and later (`eval-rpm` reports it as "timing"):

| share of the scored time | the rules | the path |
|---|---|---|
| right | 86% | 92% |
| right, but late or early: the value matches the reference of up to 0.15 s before or after | 10% | 4% |
| on another tone of the engine (½, ¼, ×2…) | under 1% | 1% |
| wrong otherwise | 3% | 2% |

Lag was the larger half of what the rules left, and it is what the path took back. These clips are
showcases with much revving in neutral: the revs move faster than 75% per second during 16% of the
scored time. There the rules were right 44% of the time, the path is 72% (and 96% against 94% when
they are steady). The rules ran a median 60 ms behind the reference: each tracker smooths, predicts
through a steady slope but not through a blip or a shift, and gyroball's 170 ms window reads the
past. Three tracker changes were measured for it before the path. Two were not kept: a shorter time
constant (0.03 s: +1 point, but auto-detection loses 3 right counts) and carrying the rate of change
through a re-acquire (+1 point, but the rpm overshoots and shift detection loses 12 points). One
was: readings from the second try's long window are stamped earlier than those of the short window
before them, and the tracker used to drop them or predict from the wrong moment; it now weighs each
reading at its own time. The path goes further the same way: it takes the raw readings, each at its
own time, and does not smooth.

**Is it worth running both detectors?** Yes. Measured with the rules, on the same moments (before
the tone maps and the corrected reference, which lift every row by a few points):

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
values either. The conclusion drawn then was that what is left to win is in the 17% where neither
is right, and that it needs a detector that follows fast rev changes, not a better mix. That was half
right. Choosing between the two trackers' values of the same instant was used up; but each of those
values is late by a different time, and a reading that is "wrong" now was often right for the moment
it describes. The path, which puts each raw reading at its own moment and may take twice or four
times a reading, is right 92% of the time, above that ceiling (which stands at 87% today, with the
tone maps and the corrected reference, and the rules at 86%), and
it beats the better detector by more than a point on 72 of 78 cars.

What is still wrong:

- A car with a saved calibration keeps it: if you calibrated one of the three V6s before `"scale": 2`
  existed, press "Reset scales" on it once.
- Aston Martin V8 Vantage GT4 (54%, 2 s scored), Volkswagen Golf GTI 16v (71%), Lancia 037 (73%,
  on twice the revs 18% of the time), Audi quattro S1 E2 (76%), Subaru WRX STI RX (78%).
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
npm run eval-rpm -- --cfg '{"look":0}'
npm run eval-rpm -- --cfg '{"combine":"rules"}'
```

It writes `samples/dr2/results-rpm.md` (per car: share of the clip scored, the loudest tone the
reference found, share right for each rpm, most common error).

## Gear shifts and gear

In gear, the revs follow the car's speed: over a third of a second they are a straight line (in log
rpm). A shift is a break between two such lines: the revs drop (upshift) or jump (downshift) by a
gearbox ratio. `public/detectors/shifts.js` fits a line to the combined rpm over 0.3 s before a gap
of 0.28 s and one over 0.2 s after it, finds where in the gap the revs step (the largest change
within 0.1 s, or a hole in the readings), carries both lines to that place, and reports a shift when
they differ by 11% to ×1.93. Both lines must fit (2.5% rms), neither may be steeper than 1.2 per
second (a rev blip is), the difference in their slopes may explain half the step at most (a lift
followed by throttle is a V, not a step), revs falling on both sides of a drop are a lift, and half
of the step must happen within that 0.1 s: a shift is quick, revs that swing slowly from one line to
the other are not one. A change of exactly ×2 or ÷2 is a detector slipping an octave, not a shift.
The detector reads the path 50 ms back (`shiftLook`), where it is surer than at the 30 ms of the tach.

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
| 4 cyl | 36 of 36 | 0 | 311 / 320 ms | 3.0% | 100% |
| 5 cyl | 36 of 36 | 0 | 307 / 320 ms | 3.1% | 100% |
| 6 cyl | 36 of 36 | 0 | 311 / 320 ms | 2.8% | 100% |
| 8 cyl | 36 of 36 | 0 | 311 / 320 ms | 3.0% | 100% |

**On the 80 real cars** (`npm run eval-shifts`). The clips have no gear truth, so the shifts are
read from the offline reference rpm with the same idea, strictly: a break of 10% or more between two
lines that fit within 2%. On the simulator's own reference that lists its shifts and nothing else
(11 or 12 of 12). A live shift that matches none of those is checked against the reference at that
moment: real (the reference steps there too, just not cleanly enough to be listed), false (it does
not), or not judged (the reference is unsure there: idle, revving in neutral, the first second of a
launch).

| | first detector (a fast, short change of the rpm) | break between two lines, on the rules' rpm | **now**: the same on the path, longer gap, quick step |
|---|---|---|---|
| clean shifts found | 243 of 313 (78%) | 300 of 363 (83%) | **306 of 363 (84%)** |
| live shifts judged false | 214 of 644 (33%) | 46 of 445 (10%) | **29 of 424 (7%)** |
| live shifts not judged | 1,584 (20 per clip) | 527 (7 per clip) | 492 (6 per clip) |
| reported after the shift | 225 ms | 314 ms | 364 ms |
| ratio off by (median) | 6.4% | 5.0% | **3.3%** |

(The first column was measured before the reference was corrected and the tone maps added, which is
why it has fewer clean shifts to find.) The first detector was tuned on the simulator, where the rpm
is smooth; on real sound the rpm has glitches and holes that look just like its "fast, short
change". The line fit cost 0.09 s, and reading the path 50 ms back another 0.05 s: a shift is
reported 0.36 s after it (0.31 s on the simulator).

Moving to the path did not help the shifts by itself: with the detector as it was, 287 of 363 were
found (79%), fewer than on the rules' rpm. The readings around a real shift are a mess for longer
than the shift lasts, and the path follows them where the trackers smoothed over them. A longer gap
between the two lines (0.28 s instead of 0.18 s) leaves that mess out: 79% → 86% found. A shift is
reported as soon as both lines fit, so the longer gap does not delay it; but two lines 0.28 s apart
also fit around revs that only swing from one level to another (a lift from a steady pull, a wobble
on the throttle), which the simulator showed at once. Hence the quick-step rule, which costs 2
points of shifts found and removes a third of the false ones; placing the shift where the step is,
not in the middle of the gap, is what brought the ratio error from 5% to 3%.

**Seeing the car stand.** The gear is counted from 1st once the car has been seen standing: over
one second, the median of the readings is below 30% of the redline (or 1.6 × the idle setting, if
that is higher) and 80% of them are within 6% of it, with no hole longer than 0.25 s. The share of
the redline came second: with the idle setting alone, left at its 900 rpm, a car had to idle below
1,440 rpm to be seen standing, and the lowest steady second in the 80 clips is below that for 18
cars only (most idle at 1,300 to 2,000 rpm). The gear became known on 3 clips; it now does on 36,
on 34 of them within 3 s of the start. The other 44 do not idle for a second. When another car
is picked, or recognised after a first one, the count is forgotten: the gear is unknown again until
that car stands. The first build with the path lost the gear altogether on
real sound, for two reasons that the 80 clips could not show (they are showcases: the car stands
for a second in 3 of them). The shift detector read the path 50 ms back, and at low revs
pitch-detection's window is long: its reading is 65 ms old when it comes, so the detector was given
nothing most of the time. And standing was judged reading by reading (each within 6% of the first),
which the smoothed rpm of the rules passed and raw readings do not: one stray started the second
again. The detector now reads the path at the newest moment a reading speaks of (50 ms back or
more), and standing is judged on the second as a whole. On the three clips: Ford Sierra Cosworth
RS500 in 1st after 0.8 s (never, in that build), Chevrolet Camaro GT4.R after 6.1 s (24.8 s), Ford
Mustang GT4 after 6.5 s (6.7 s); the rules gave 1.3, 6.5 and 6.6 s. Shifts found and false shifts
are unchanged by it (306 of 363, 7%).

What this means for the gear on the tach: on a real stage it is right after a standstill and for the
next few shifts, then drifts: one shift in six is missed, one reported shift in fourteen is false,
and revving in neutral still gives a few. All clean shifts are found on 36 of the 74 cars that have
any; the worst are the Audi quattro S1 E2 (3 of 6), the Ford Mustang GT4 and the Fiesta Rallycross
Mk7 (4 of 7). A count cannot correct itself. The way to a gear that can is each gear pair's own
ratio (×0.69 for 1→2, ×0.83 for 4→5 in the simulation): at 3% the ratios are getting measured well
enough to try it; it is not built.

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
