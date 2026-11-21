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

Open **http://localhost:8777** in Chrome and press **Start**. The **Simulated engine** source needs no
setup. To listen to the Mac's own sound, install [BlackHole 2ch](https://github.com/ExistentialAudio/BlackHole)
(`brew install blackhole-2ch`) and route the sound through it: [docs/setup.md](docs/setup.md).

`npm run init` installs the dependencies, checks for BlackHole and ffmpeg, asks for your recording of
the car-sound video to cut it into one clip per car (Enter takes `~/Desktop/recording.m4a`, `s` skips:
the page works without the clips), and learns the car profiles from them. Run it again whenever you
like; it skips what is done. (It is not `npm init`, which is npm's own command.)

## Use

- **Car** (top bar): pick the car, or **Auto · recognise** to have it named from its sound. The car
  sets the cylinder count; without one, the count is detected from the sound.
- **Tachometer**: the combined RPM of two detectors, the gear, shift lights.
- **Send to SimHub (UDP)** (bottom of the page): off by default. To start with it on:
  `SIMHUB_UDP=on SIMHUB_HOST=192.168.1.50 npm start`. Details: [docs/simhub.md](docs/simhub.md).
- **● Rec**: saves what the detectors heard (WAV) and what they read (CSV) to Downloads.

## How good is it

Measured on recordings of the game's 82 cars ([docs/measurements.md](docs/measurements.md)):

| | result |
|---|---|
| RPM, car picked | right (within 6%) 82% of the scored time, 90% while the revs are steady; most of the rest is lag while they jump |
| Cylinder count from the sound | 73 of 80 cars right, 7 undecided, none wrong |
| Car recognised from its sound | 72 of 82 right, 1 wrong, 9 not sure |
| Gear shifts | all found on the simulator; on the one real clip with known shifts, 3 of 3 found plus 3 false |

## Commands

| command | what it does |
|---|---|
| `npm run init` | get a clone ready (`-- --source rec.m4a` gives the recording without being asked; `-- --tests` installs the browser test's needs) |
| `npm start` | the page and the SimHub bridge |
| `npm test` · `npm run test:ui` | unit tests · the page in a real browser |
| `npm run bench` | lag and error on the simulator (`-- --auto` cylinder detection, `-- --shifts` gear shifts) |
| `npm run fetch-dr2` | cut a recording of the "All Cars Sounds" video into one clip per car |
| `npm run learn-cars` · `npm run eval-cars` | learn the cars' sounds · measure recognition |
| `npm run eval-dr2` | cylinder detection on the real clips |
| `npm run eval-rpm` | is the RPM right on the real clips |
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
