import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { slug, fileFor, recordingName, carNumberIn } from '../public/cars.js';
import { CYLINDERS } from '../public/engine-model.js';

const { cars } = JSON.parse(readFileSync(new URL('../samples/dr2-cars.json', import.meta.url), 'utf8'));

test('car list: every car has its own key, and a cylinder count the detectors handle (or none)', () => {
  const keys = cars.map(c => slug(c.car));
  assert.equal(new Set(keys).size, cars.length);
  for (const c of cars) assert.ok(c.cylinders === null || CYLINDERS.includes(c.cylinders), c.car);
});

test('car names: accents and punctuation leave file-safe names', () => {
  assert.equal(slug('ŠKODA Fabia R5'), 'skoda-fabia-r5');
  assert.equal(slug('Citroën C3 R5'), 'citroen-c3-r5');
  assert.equal(fileFor({ car: 'Renault Clio R.S. S1600' }, 62), '63-renault-clio-r-s-s1600.wav');
});

test('a recording made with a car picked names its car number, and the tools read it back', () => {
  for (const [i, c] of cars.entries()) assert.equal(carNumberIn(recordingName(i + 1, c.car, '20261120190000') + '.wav'), i + 1);
  assert.equal(carNumberIn('audio-rpm-Sim-6-cyl-20261120152408.wav'), null);
  assert.equal(carNumberIn('audio-rpm-BlackHole-2ch-20261120152408.wav'), null);
});

test('a starting calibration is only given to the V6s whose loudest rhythm is half the firing rate', () => {
  const scaled = cars.filter(c => c.scale !== undefined);
  assert.deepEqual(scaled.map(c => c.car), ['Lancia Stratos', 'MG Metro 6R4', 'MG Metro 6R4 Rallycross']);
  assert.ok(scaled.every(c => c.scale === 2 && c.cylinders === 6));
});
