// Fixed-size ring buffer of float samples.
export class Ring {
  constructor(size) {
    this.buf = new Float32Array(size);
    this.pos = 0;     // next write index
    this.filled = 0;  // samples written so far, capped at size
  }

  get size() { return this.buf.length; }

  push(chunk) {
    const b = this.buf, n = b.length;
    for (let i = 0; i < chunk.length; i++) {
      b[this.pos] = chunk[i];
      this.pos = this.pos + 1 === n ? 0 : this.pos + 1;
    }
    this.filled = Math.min(n, this.filled + chunk.length);
  }

  /** Copy the most recent `count` samples, oldest first, into `out` (zeros if not filled yet). */
  latest(count, out = new Float32Array(count)) {
    const b = this.buf, n = b.length;
    const avail = Math.min(count, this.filled);
    const pad = count - avail;
    out.fill(0, 0, pad);
    let start = (this.pos - avail + n) % n;
    for (let i = pad; i < count; i++) {
      out[i] = b[start];
      start = start + 1 === n ? 0 : start + 1;
    }
    return out;
  }
}
