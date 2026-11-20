// Runs on the audio thread. Collects `hop` samples of the raw input (input 0) and of the
// low-passed input (input 1, decimated by D here), stamps the chunk with the audio-clock time of
// its last sample, and transfers it straight to the detection worker through a MessagePort
// (the page's main thread is not in the path, so tab throttling and rendering can't delay it).
class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const { hop, D } = options.processorOptions;
    this.hop = hop; this.D = D;
    this.out = this.port; // replaced by the worker's port once it arrives
    this.port.onmessage = e => { if (e.data && e.data.port) this.out = e.data.port; };
    this.alloc();
  }

  alloc() {
    this.raw = new Float32Array(this.hop);
    this.dec = new Float32Array(this.hop / this.D);
    this.n = 0; this.nd = 0; this.phase = 0;
  }

  process(inputs) {
    const a = inputs[0], b = inputs[1];
    const len = (a[0] || b[0] || []).length;
    if (!len) return true; // no input connected yet
    for (let i = 0; i < len; i++) {
      // mix to mono
      const r = a.length > 1 ? (a[0][i] + a[1][i]) * 0.5 : a.length ? a[0][i] : 0;
      this.raw[this.n++] = r;
      if (this.phase === 0) this.dec[this.nd++] = b.length > 1 ? (b[0][i] + b[1][i]) * 0.5 : b.length ? b[0][i] : 0;
      this.phase = (this.phase + 1) % this.D;
      if (this.n === this.hop) {
        const t = (currentFrame + i + 1) / sampleRate;
        this.out.postMessage({ type: 'chunk', raw: this.raw, dec: this.dec, t }, [this.raw.buffer, this.dec.buffer]);
        this.alloc();
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
