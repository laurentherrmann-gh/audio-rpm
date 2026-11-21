# audio-rpm: instructions for Claude

## Git workflow

- Commit and push every change **directly to `main`**. No feature branches, no pull requests.
- Run `npm test` before pushing; push only when it passes. After a change to the page (`public/`) or
  `server.js`, also run `npm run test:ui` (Playwright at deviceScaleFactor 2); GitHub Actions runs both.

## Project notes

- `README.md` is the short guide (start, use, results in one table, commands). Detail goes in `docs/`:
  setup.md, simhub.md, car-sounds.md, measurements.md (how it works, every measured table),
  development.md. Keep the README short; when a headline number changes, update its "How good is it"
  table too.
- `npm run init` (`tools/init.js`) gets a clone ready and must stay safe to re-run; it imports nothing
  from node_modules.
- Engine RPM is estimated from game audio in the browser (`public/`), and `server.js` serves the page
  and forwards RPM to SimHub over UDP (paused by default).
- Detection lives in `public/pipeline.js`, shared by the browser worker (`detect-worker.js`),
  `tools/bench.js` and the tests. Change detection logic there, not in the UI.
- `npm run bench` measures lag and error per optimization step; `npm run bench -- --auto` measures
  cylinder auto-detection. Re-run it after touching the
  pipeline, tracker or detectors, and update the tables in `docs/measurements.md` if the numbers change.
- Car recognition is `public/detectors/car-id.js` (thresholds in `CAR_ID`), learned and measured by
  `tools/cars.js` (`npm run learn-cars`, `npm run eval-cars`). Its thresholds were set on simulated
  cars and hold on the real clips (72 of 82 named, 1 wrong, cylinder count 80 of 80): the cars it
  cannot tell apart share one sound in the game, so there is nothing left to tune there. The open
  question is recordings of the user's own driving, which the clips (learned and tested on two parts
  of the same recording) do not answer.
- `npm run eval-rpm` scores each rpm on the real clips (`samples/dr2/`, not in the repo) against an
  offline reference (`tools/lib/reference.js`). Re-run it after touching `firingTone`, the detectors
  or the fusion, and update the table in `docs/measurements.md` ("Is the rpm right?"). A change that helps one car
  can cost another: compare the per-car table in `samples/dr2/results-rpm.md` before and after.
- `public/fusion.js` makes the combined rpm (tach, SimHub and shift detection use it). Its rules come
  from real clips (DS 21, then all 80 cars with `npm run eval-rpm`); re-measure on real clips before
  changing them, not on the simulator. The simulator's default engine is too clean to show what real
  cars do: `synthesize(..., { cycleLevel: 0.3 })` gives cylinders that don't sound alike.
- Shift and gear detection is `public/detectors/shifts.js` (thresholds in `SHIFT`), fed by
  the combined rpm in the pipeline. `npm run bench -- --shifts` measures it on the simulator,
  `npm run eval-shifts` on the real clips (shifts read from the reference rpm). Tune it on the real
  clips: the simulator's rpm is too smooth to show false shifts. Anything that makes the combined rpm
  jumpier (tracker settings) costs shifts: re-run eval-shifts after touching the tracker or fusion.
- The user runs this on a Retina Mac (devicePixelRatio 2). Test UI changes at deviceScaleFactor 2.
  Canvas CSS height comes from `data-h`; never read it back from the canvas element.
