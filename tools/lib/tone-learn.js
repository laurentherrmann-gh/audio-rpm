// Learn a car's tone map (public/detectors/tones.js) from a recording: the offline reference gives
// the rpm, the pipeline's own spectrum gives the levels of the engine's orders at that rpm.
import { ToneLearner, orderLevels } from '../../public/detectors/tones.js';
import { replay } from './audio.js';
import { referenceRpm, REF } from './reference.js';

const HALF_WINDOW = 0.085; // s: the spectrum the pipeline has at t describes the sound around t − this

/** Where the reference of a car with that many cylinders can be trusted: sure, and on a tone such an engine has. */
export function trustedFrames(ref, cylinders) {
  const trusted = new Array(ref.rpm.length).fill(false);
  for (const s of ref.stretches) {
    if (!s.sure || (cylinders && ![cylinders, cylinders / 2, 2 * cylinders].includes(s.j))) continue;
    for (let i = Math.round((s.from - ref.t[0]) / REF.hop); i <= Math.round((s.to - ref.t[0]) / REF.hop); i++) trusted[i] = true;
  }
  return trusted;
}

/**
 * @param {Float32Array} samples  @param {number} fs  @param {number} cylinders
 * @param {{ ref?: object, keep?: (t:number) => boolean }} [opts] keep: which moments to learn from (default all)
 * @returns {{ map: object, frames: number }} frames = spectra learned from
 */
export function learnTones(samples, fs, cylinders, { ref = referenceRpm(samples, fs, { cylinders }), keep = () => true } = {}) {
  const trusted = trustedFrames(ref, cylinders), learner = new ToneLearner();
  let frames = 0;
  replay(samples, fs, { cylinders, idle: 800, redline: 9000, gyro: { every: 0.05 } }, (t, r, pipe) => {
    const spec = pipe.gyroSpec;
    if (!spec || spec.t !== t || !keep(t)) return; // a new spectrum this step
    const i = Math.round((t - HALF_WINDOW - ref.t[0]) / REF.hop);
    if (!(i >= 0 && trusted[i])) return;
    const levels = orderLevels(spec.db, spec.binHz, ref.rpm[i] / 120);
    if (levels) { learner.add(ref.rpm[i], levels); frames++; }
  });
  return { map: learner.map(), frames };
}
