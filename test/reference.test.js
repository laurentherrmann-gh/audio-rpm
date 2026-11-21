import test from 'node:test';
import assert from 'node:assert/strict';
import { synthesize, makeNoIdleSchedule, rpmAt } from '../public/engine-model.js';
import { referenceRpm, referenceCsv, tachoPulses, REF } from '../tools/lib/reference.js';

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

test('the reference as files: a CSV with its analysis parameters, and a tacho track with one pulse per turn', () => {
  const fs = 48000, seconds = 8, schedule = makeNoIdleSchedule({ redline: 7000 });
  const samples = synthesize(schedule, { fs, seconds, cylinders: 4, cycleLevel: 0.2 });
  const ref = referenceRpm(samples, fs);

  const lines = referenceCsv(ref, { source: 'sim.wav', fs }).trimEnd().split('\n');
  const head = lines.filter(l => l.startsWith('#')), rows = lines.filter(l => !l.startsWith('#'));
  assert.ok(head.some(l => l.includes(`${REF.win} samples`) && l.includes(`hop ${REF.hop} s`)), 'window and hop are in the header');
  assert.equal(rows[0], 'time_s,rpm,sure,engine_order,tone_hz');
  assert.equal(rows.length - 1, ref.t.length);
  const sure = rows.slice(1).map(r => r.split(',').map(Number)).filter(r => r[2] === 1);
  assert.ok(sure.length > 100);
  for (const [, rpm, , order, hz] of sure) {
    assert.equal(order, 2, 'the firing tone of a four is engine order 2');
    assert.ok(Math.abs(rpm - (60 * hz) / order) < 0.2, 'rpm = 60 × tone / order');
  }

  // the pulses, read back the way a tacho is: rpm = 60 / time between two pulses
  const pulses = tachoPulses(ref, fs, samples.length), at = [];
  for (let i = 1; i < pulses.length; i++) if (pulses[i] > 0.5 && pulses[i - 1] <= 0.5) at.push(i / fs);
  assert.ok(at.length > 200, `${at.length} pulses`);
  let right = 0, n = 0;
  for (let k = 1; k < at.length; k++) {
    const gap = at[k] - at[k - 1];
    if (gap > 0.2) continue; // a stretch where the reference was not sure
    n++;
    if (Math.abs(60 / gap / rpmAt(schedule, (at[k] + at[k - 1]) / 2) - 1) <= 0.03) right++;
  }
  assert.ok(right / n >= 0.95, `${right} of ${n} pulse gaps give the true rpm`);
});
