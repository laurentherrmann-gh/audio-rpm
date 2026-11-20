# audio-rpm: instructions for Claude

## Git workflow

- Commit and push every change **directly to `main`**. No feature branches, no pull requests.
- Run `npm test` before pushing; push only when it passes.

## Project notes

- Engine RPM is estimated from game audio in the browser (`public/`), and `server.js` serves the page
  and forwards RPM to SimHub over UDP (paused by default).
- Detection lives in `public/pipeline.js`, shared by the browser worker (`detect-worker.js`),
  `tools/bench.js` and the tests. Change detection logic there, not in the UI.
- `npm run bench` measures lag and error per optimization step; `npm run bench -- --auto` measures
  cylinder auto-detection. Re-run it after touching the
  pipeline, tracker or detectors, and update the tables in README.md if the numbers change.
- Car recognition is `public/detectors/car-id.js` (thresholds in `CAR_ID`), learned and measured by
  `tools/cars.js` (`npm run learn-cars`, `npm run eval-cars`). Its thresholds were set on simulated
  cars only; retune them on the user's `samples/dr2/results-cars.md` when it exists.
- `public/fusion.js` makes the combined rpm (tach, SimHub and shift detection use it). Its rules come
  from one real clip (DS 21); re-measure on real clips before changing them, not on the simulator.
- Shift and gear detection is `public/detectors/shifts.js` (thresholds in `SHIFT`), fed by
  the combined rpm in the pipeline; `npm run bench -- --shifts` measures it. Also tuned
  on the simulator only.
- The user runs this on a Retina Mac (devicePixelRatio 2). Test UI changes at deviceScaleFactor 2.
  Canvas CSS height comes from `data-h`; never read it back from the canvas element.
