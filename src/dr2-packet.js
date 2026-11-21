// DiRT Rally 2.0 UDP telemetry packet ("extradata=3"): 66 little-endian float32 = 264 bytes.
//
// Field offsets match open-source DR2 decoders (e.g. the cm-telemetry crate reads speed at
// bytes 28..32, gear at 132..136, rpm at 148..152, track length at 244..248).
// DR2 sends the three rpm fields divided by 10; RPM_DIVISOR lets you change that if
// SimHub shows a value 10x off.

export const DR2_FLOATS = 66;
export const DR2_BYTES = DR2_FLOATS * 4;

export const FIELD = Object.freeze({
  time: 0,          // s, total time
  lapTime: 1,       // s
  lapDistance: 2,   // m
  totalDistance: 3, // m
  speed: 7,         // m/s
  throttle: 29,     // 0..1
  steer: 30,        // −1..1
  brake: 31,        // 0..1
  clutch: 32,       // 0..1
  gear: 33,         // 0 = neutral, -1 (or 10) = reverse
  lap: 36,
  rpm: 37,          // rpm / divisor
  totalLaps: 60,
  trackLength: 61,  // m
  maxRpm: 63,       // rpm / divisor
  idleRpm: 64,      // rpm / divisor
  maxGears: 65,
});

/**
 * @param {{time:number, rpm:number, maxRpm:number, idleRpm:number,
 *          gear?:number, maxGears?:number, speed?:number, throttle?:number}} s
 * @param {{rpmDivisor?:number}} [opts]
 * @returns {Buffer}
 */
export function buildDr2Packet(s, { rpmDivisor = 10 } = {}) {
  const buf = Buffer.alloc(DR2_BYTES);
  const set = (field, v) => buf.writeFloatLE(Number.isFinite(v) ? v : 0, FIELD[field] * 4);
  set('time', s.time);
  set('lapTime', s.time);
  set('speed', s.speed ?? 0);
  set('throttle', s.throttle ?? 0);
  set('gear', s.gear ?? 0);
  set('lap', 0);
  set('rpm', s.rpm / rpmDivisor);
  set('totalLaps', 1);
  set('trackLength', 10000);
  set('maxRpm', s.maxRpm / rpmDivisor);
  set('idleRpm', s.idleRpm / rpmDivisor);
  set('maxGears', s.maxGears ?? 6);
  return buf;
}

/** Inverse of buildDr2Packet, for the listener tool and tests. */
export function parseDr2Packet(buf, { rpmDivisor = 10 } = {}) {
  if (buf.length < 256) throw new Error(`packet too short: ${buf.length} bytes (expected ${DR2_BYTES})`);
  const get = field => (FIELD[field] * 4 + 4 <= buf.length ? buf.readFloatLE(FIELD[field] * 4) : NaN);
  return {
    time: get('time'),
    speed: get('speed'),
    gear: get('gear'),
    rpm: get('rpm') * rpmDivisor,
    maxRpm: get('maxRpm') * rpmDivisor,
    idleRpm: get('idleRpm') * rpmDivisor,
    maxGears: get('maxGears'),
    throttle: get('throttle'),
    steer: get('steer'),
    brake: get('brake'),
    clutch: get('clutch'),
    distance: get('lapDistance'),
  };
}
