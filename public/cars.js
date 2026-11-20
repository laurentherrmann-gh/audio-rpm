// Names for the DiRT Rally 2.0 car list (samples/dr2-cars.json, served to the page as /cars.json),
// shared by the page's car picker and the dataset tools.

/** "Škoda Fabia Rally 2005" → "skoda-fabia-rally-2005": a car's key in the page and in file names. */
export const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** File name of car number i+1 in samples/dr2/. */
export const fileFor = (car, i) => `${String(i + 1).padStart(2, '0')}-${slug(car.car)}.wav`;

/** Base name the page gives a recording made with a car picked: audio-rpm-car20-audi-…-<stamp>. */
export const recordingName = (n, car, stamp) => `audio-rpm-car${String(n).padStart(2, '0')}-${slug(car).slice(0, 40)}-${stamp}`;

/** Car number (from 1) in a recording's file name, or null. */
export const carNumberIn = name => { const m = /(?:^|-)car(\d+)-/.exec(name); return m ? Number(m[1]) : null; };
