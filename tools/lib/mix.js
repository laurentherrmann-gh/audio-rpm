// Stand-ins for what a stage adds to the engine: a co-driver talking and the road.
//
// The real clips are showcases: the engine alone. On a stage the co-driver calls the notes over it
// and gravel hisses under it. There is no recording of that to measure against (it would need the
// game's telemetry for the truth), so these are made here and mixed into the clean clips, whose
// reference rpm stays the truth: `npm run eval-rpm -- --mix speech:0,road:-6`.
//
// They are stand-ins, not the game's sound. What matters for the detectors is kept:
//   speech  a voiced tone at 95–180 Hz with harmonics and moving formants, in phrases with pauses.
//           A voice's pitch sits where a four-cylinder's firing tone is at 2,900–5,400 rpm, and it is
//           periodic: this is the sound a pitch detector can mistake for the engine.
//   road    broadband noise, strongest below 2 kHz, swelling and fading, with gravel hitting the car.
// Everything is seeded: the same clip gets the same sound every run.

/** Small seeded generator (mulberry32): () => [0, 1). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Two-pole resonator (band-pass) at f Hz, bandwidth bw Hz: returns a per-sample function. */
function resonator(f, bw, fs) {
  const r = Math.exp((-Math.PI * bw) / fs), c = 2 * r * Math.cos((2 * Math.PI * f) / fs), g = 1 - r;
  let y1 = 0, y2 = 0;
  return x => { const y = g * x + c * y1 - r * r * y2; y2 = y1; y1 = y; return y; };
}

const VOWELS = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410], [440, 1020, 2240]];

/**
 * A voice calling notes: phrases of 3–8 syllables with pauses between them.
 * @returns {{ x: Float32Array, active: Uint8Array }} the sound, and where it is speaking
 */
export function speech(n, fs, seed = 1) {
  const rand = rng(seed), x = new Float32Array(n), active = new Uint8Array(n);
  let i = Math.floor(fs * (0.3 + rand()));
  while (i < n) {
    const syllables = 3 + Math.floor(rand() * 6);
    let f0 = 130 + 50 * rand(), phase = 0; // each phrase starts high and falls, as speech does
    for (let s = 0; s < syllables && i < n; s++) {
      const len = Math.floor(fs * (0.11 + 0.14 * rand())), v = VOWELS[Math.floor(rand() * VOWELS.length)];
      const res = v.map((f, k) => resonator(f, 70 + 40 * k, fs)), bend = (rand() - 0.5) * 30, hiss = rand() < 0.4;
      for (let j = 0; j < len && i < n; j++, i++) {
        const u = j / len, env = Math.sin(Math.PI * u) ** 0.6;
        const f = Math.max(95, Math.min(180, f0 + bend * (u - 0.5)));
        phase += f / fs;
        phase -= Math.floor(phase);
        // a glottal pulse: a sawtooth has every harmonic, falling 6 dB per octave
        let src = 2 * phase - 1;
        if (hiss && u < 0.25) src = 0.3 * src + (rand() * 2 - 1); // a consonant: mostly noise
        let y = 0;
        for (let k = 0; k < res.length; k++) y += res[k](src) * (k === 0 ? 1 : k === 1 ? 0.6 : 0.3);
        x[i] = (0.35 * src + 4 * y) * env; // some of the bare tone, as a voice close to the microphone has
        active[i] = 1;
      }
      f0 = Math.max(100, f0 - 4 - 8 * rand());
      i += Math.floor(fs * 0.02 * rand()); // a short gap between syllables
    }
    i += Math.floor(fs * (0.4 + 2.2 * rand())); // …and a longer one between calls
  }
  return { x, active };
}

/** The road under the car: low-heavy noise that swells and fades, with gravel thrown at the floor. */
export function road(n, fs, seed = 2) {
  const rand = rng(seed), x = new Float32Array(n), active = new Uint8Array(n).fill(1);
  const band = resonator(600, 1800, fs), low = resonator(140, 200, fs), hit = resonator(1700, 900, fs);
  let level = 0.7, target = 0.7, knock = 0;
  for (let i = 0; i < n; i++) {
    if (i % Math.floor(fs * 0.25) === 0) target = 0.35 + 0.65 * rand(); // speed and surface change
    level += (target - level) * (4 / fs);
    if (rand() < 12 / fs) knock = 1; // a stone, a dozen times a second
    knock *= 1 - 60 / fs;
    const w = rand() * 2 - 1;
    x[i] = level * (band(w) + 1.5 * low(w)) + 2.5 * knock * hit(rand() * 2 - 1);
  }
  return { x, active };
}

const KINDS = { speech, road };
const rmsOf = (x, on) => { let s = 0, c = 0; for (let i = 0; i < x.length; i++) if (!on || on[i]) { s += x[i] * x[i]; c++; } return Math.sqrt(s / Math.max(1, c)); };

/**
 * Mix stage sounds into a clip. spec: "speech:0,road:-6" — each sound's level in dB against the
 * clip's own rms (0 = as loud as the engine; speech is measured while it speaks).
 * @returns {Float32Array} a new array; the clip is not changed
 */
export function mixIn(samples, fs, spec, seed = 1) {
  const out = Float32Array.from(samples), engine = rmsOf(samples);
  for (const part of String(spec).split(',').filter(Boolean)) {
    const [kind, db = '0'] = part.split(':'), make = KINDS[kind];
    if (!make) throw new Error(`mix: unknown sound "${kind}" (known: ${Object.keys(KINDS).join(', ')})`);
    const { x, active } = make(samples.length, fs, seed * 7919 + kind.length), gain = (engine * 10 ** (Number(db) / 20)) / (rmsOf(x, active) || 1);
    for (let i = 0; i < out.length; i++) out[i] += gain * x[i];
  }
  return out;
}
