// In-browser engine simulator: a harmonic engine tone following the shared rpm schedule.
// One ConstantSourceNode carries the firing frequency; each partial's oscillator frequency is
// driven from it through a gain (= the partial's multiple), so one automation curve moves them all.
import { PARTIALS, firingHz, makeSchedule, rpmAt, scheduleDuration } from './engine-model.js';

export class EngineSim {
  constructor(ac, { cylinders = 4, idleRpm = 900, redline = 7500, noise = 0.08 } = {}) {
    this.ac = ac;
    this.cylinders = cylinders;
    this.schedule = makeSchedule({ idleRpm, redline });
    this.T = scheduleDuration(this.schedule);
    this.output = ac.createGain();
    this.output.gain.value = 0.25;

    this.base = ac.createConstantSource();
    this.base.offset.value = firingHz(this.schedule[0][1], cylinders);
    this.nodes = [this.base];

    for (const [mult, amp] of PARTIALS) {
      const osc = ac.createOscillator();
      osc.frequency.value = 0;
      const m = ac.createGain(); m.gain.value = mult;
      this.base.connect(m).connect(osc.frequency);
      const g = ac.createGain(); g.gain.value = amp * 0.3;
      osc.connect(g).connect(this.output);
      osc.start();
      this.nodes.push(osc);
    }

    const nb = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
    const d = nb.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * noise;
    const ns = ac.createBufferSource(); ns.buffer = nb; ns.loop = true;
    ns.connect(this.output); ns.start();
    this.nodes.push(ns);

    this.t0 = ac.currentTime + 0.05;
    this.nextLoop = this.t0;
    this.base.start();
    this.scheduleAhead();
    this.timer = setInterval(() => this.scheduleAhead(), 1000);
  }

  scheduleAhead() {
    while (this.nextLoop < this.ac.currentTime + 2 * this.T) {
      for (const [t, rpm] of this.schedule) {
        this.base.offset.linearRampToValueAtTime(firingHz(rpm, this.cylinders), this.nextLoop + t);
      }
      this.nextLoop += this.T;
    }
  }

  /** True rpm right now. */
  truth() {
    return rpmAt(this.schedule, this.ac.currentTime - this.t0);
  }

  stop() {
    clearInterval(this.timer);
    for (const n of this.nodes) { try { n.stop(); } catch { /* already stopped */ } }
    this.output.disconnect();
  }
}
