# audio-rpm

Engine RPM from game audio, for games that send no telemetry (DiRT Rally 2.0 on PS5). It listens to
what your Mac plays, shows RPM and gear on a tachometer, and can send them to SimHub as DiRT Rally 2.0
telemetry.

```
Mac audio ─BlackHole─▶ Chrome page (localhost:8777) ─▶ Node server ─UDP─▶ SimHub (Windows)
```

## Start

```sh
npm run init
npm start
```

Open **http://localhost:8777** in Chrome and press **Start**. The build number next to the title says
which version is running (hover for the commit and its date); after a `git pull`, restart `npm start`
and reload the page. The **Simulated engine** source needs no
setup. To listen to the Mac's own sound, install [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole)
(`brew install blackhole-2ch`) and route the sound through it: [docs/setup.md](docs/setup.md).

`npm run init` installs the dependencies, checks for BlackHole and ffmpeg, asks for your recording of
the car-sound video to cut it into one clip per car (Enter takes `~/Desktop/recording.m4a`, `s` skips:
the page works without the clips), and learns the car profiles from them. Run it again whenever you
like; it skips what is done. (It is not `npm init`, which is npm's own command.)

## Use

- **Car** (top bar): pick the car, or **Auto · recognise** to have it named from its sound. The car
  sets the cylinder count; without one, the count is detected from the sound.
- **Tachometer**: the combined RPM of two detectors, the gear, shift lights. The gear is counted
  from 1st by the shifts, so press Start before the car sets off. It is dim with a **?** (as in
  **2?**) while the car could be in a higher gear than counted, until it has stood at idle for a
  second. Another car, picked or recognised, starts again from **1?**.
- **Send to SimHub (UDP)** (bottom of the page): off by default. To start with it on:
  `SIMHUB_UDP=on SIMHUB_HOST=192.168.1.50 npm start`. Details: [docs/simhub.md](docs/simhub.md).
- **● Rec**: saves what the detectors heard (WAV) and what they read (CSV) to Downloads.

## How good is it

Measured on recordings of the game's 82 cars ([docs/measurements.md](docs/measurements.md)):

| | result |
|---|---|
| RPM, car picked | right (within 6%) 92% of the scored time (91% without the car's tone map), 96% while the revs are steady, 72% while they jump. It describes the moment 30 ms ago ("Look-back" in the settings) |
| Cylinder count from the sound | 72 of 80 cars right, 8 undecided, none wrong |
| Car recognised from its sound | 72 of 82 right, 1 wrong, 9 not sure |
| Gear shifts | 85% of the clean shifts found, 7% of the reported ones false: the counted gear drifts after a few shifts |
| With a co-driver's voice and road noise mixed in (made up, not the game's) | RPM right 86% with the voice 6 dB and the road 10 dB under the engine; shifts 71% found, 13% false. The voice is what costs: lower the game's speech volume if the gear matters |

## Commands

| command | what it does |
|---|---|
| `npm run init` | get a clone ready (`-- --source rec.m4a` gives the recording without being asked; `-- --tests` installs the browser test's needs) |
| `npm start` | the page and the SimHub bridge |
| `npm test` · `npm run test:ui` | unit tests · the page in a real browser |
| `npm run bench` | lag and error on the simulator (`-- --auto` cylinder detection, `-- --shifts` gear shifts) |
| `npm run fetch-dr2` | cut a recording of the "All Cars Sounds" video into one clip per car |
| `npm run learn-cars` · `npm run eval-cars` | learn the cars' sounds and tone maps (add `-- --file rec.wav` for your own recording of a car, one per camera) · measure recognition |
| `npm run eval-dr2` | cylinder detection on the real clips |
| `npm run eval-rpm` · `npm run eval-shifts` | is the RPM right on the real clips · are the gear shifts found |
| `npm run record` · `npm run eval-recording` | PC version of the game: record its sound and telemetry together, one recording per car and camera · score the detectors against the game's own rpm and gear |
| `npm run reference-rpm` | the offline reference RPM of a recording, as CSV (and a tacho track) |
| `npm run analyze -- clip.wav` | replay any recording through the detectors |
| `npm run listen` | stand-in for SimHub: prints the telemetry it receives |
| `npm run make-wav` | a test engine sound |

## More

- [docs/setup.md](docs/setup.md): sound routing, the page, recording, settings
- [docs/simhub.md](docs/simhub.md): SimHub and the server's options
- [docs/car-sounds.md](docs/car-sounds.md): recording the car-sound video, the checks on a recording, the reference RPM files
- [docs/measurements.md](docs/measurements.md): how detection works and every measurement (lag, cylinders, combined RPM, real cars, shifts, car recognition)
- [docs/development.md](docs/development.md): tests, code layout, next steps

Credits: detector and tracker logic adapted from [gyroball-rpm](https://github.com/berkenbu/gyroball-rpm)
(MIT); pitch algorithms from [pitch-detection](https://github.com/audiojs/pitch-detection) (MIT).
See THIRD_PARTY.md.
