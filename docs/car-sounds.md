# The DiRT Rally 2.0 car-sound set and the reference rpm files

Back to the [README](../README.md).

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

### The reference as files

Estimating the speed of a machine from its own sound or vibration, then resampling at equal angle
to read "orders", is known as **tacholess order tracking**; the reference is one of those methods
(ridge in the spectrogram → angle resampling → order spectrum), with one addition: it works out by
itself which order the ridge is. No standard prescribes such an algorithm or a file for its result.
What the files below follow is the usual practice: orders counted per turn of the crank (**engine
order**: the firing tone of a four is order 2), and the analysis parameters kept with the result, as
ISO 18431-3 asks for time-frequency analyses.

```sh
npm run reference-rpm
npm run reference-rpm -- ~/Downloads/clip.wav --tacho
```

| file | content |
|---|---|
| `<clip>.rpm.csv` | one row every 20 ms: `time_s` (centre of the analysis window), `rpm`, `sure` (1 = the order was read from that stretch of sound; 0 = taken over from the nearest such stretch), `engine_order` and `tone_hz` of the tone that was followed (rpm = 60 × tone_hz / engine_order). The lines starting with `#` say how it was computed (sample rate, window, hop, search band). `npm run eval-rpm` writes it too. |
| `<clip>.tacho.wav` | with `--tacho`: stereo, left = the sound, right = one 1 ms pulse per turn of the crank where the reference is sure. This is the form order-analysis tools take as a tacho channel (MATLAB's `tachorpm` reads such pulses), to cross-check the reference or draw an order map elsewhere. |

In Python: `pandas.read_csv(f, comment='#')`. For a tool that does not skip comment lines, delete the
lines starting with `#` first. It is an estimate, not a measurement: use the rows with `sure` = 1. Not written as ASAM MDF (`.mf4`, the
automotive standard for measured channels): there is no writer for it in JavaScript here, and a CSV
converts to it with Python's `asammdf` if it is ever needed.
