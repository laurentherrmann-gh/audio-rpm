import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesize, makeNoIdleSchedule, rpmAt } from '../public/engine-model.js';
import { referenceRpm } from '../tools/lib/reference.js';

// The offline reference: rpm from the spacing of the engine's tones, with no cylinder count given.
for (const cylinders of [4, 6]) {
  test(`reference rpm of a simulated ${cylinders}-cylinder drive, without being told the count`, () => {
    const fs = 48000, seconds = 14, schedule = makeNoIdleSchedule({ redline: 7000 });
    const samples = synthesize(schedule, { fs, seconds, cylinders, cycleLevel: 0.2 });
    const ref = referenceRpm(samples, fs);
    let sure = 0, right = 0;
    for (let i = 0; i < ref.t.length; i++) {
      if (!ref.sure[i]) continue;
      sure++;
      if (Math.abs(ref.rpm[i] / rpmAt(schedule, ref.t[i]) - 1) <= 0.04) right++;
    }
    assert.ok(sure / ref.t.length >= 0.5, `sure for ${Math.round((100 * sure) / ref.t.length)}% of the drive`);
    assert.ok(right / sure >= 0.9, `right for ${Math.round((100 * right) / sure)}% of the sure moments`);
    assert.ok(ref.stretches.filter(s => s.sure).every(s => s.j === cylinders), 'loudest tone = the firing tone');
  });
}
