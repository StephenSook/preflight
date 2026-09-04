/**
 * Narrowband 1000 Hz probe that runs on the AUDIO RENDERING THREAD.
 *
 * Why not AnalyserNode + setInterval: Chrome throttles main-thread timers to ~1 Hz
 * in a background tab, which silently destroys latency resolution and produces
 * latency numbers that are really just the throttle period. The audio thread is
 * not throttled, and its clock (currentTime) is exact, so every timestamp here is
 * derived from the audio clock rather than from wall-clock timer scheduling.
 *
 * Goertzel over a WINDOW_MS window == the magnitude of the FFT bin at TARGET_HZ,
 * computed with the bin centred exactly on the tone instead of rounded to a bin edge.
 */
const TARGET_HZ = 1000;
const WINDOW_MS = 20;

class ToneProbe extends AudioWorkletProcessor {
  constructor() {
    super();
    this.N = Math.round(sampleRate * WINDOW_MS / 1000);   // 960 @ 48 kHz
    const k = Math.round(this.N * TARGET_HZ / sampleRate);
    this.omega = (2 * Math.PI * k) / this.N;
    this.coeff = 2 * Math.cos(this.omega);
    this.effectiveHz = k * sampleRate / this.N;
    this.reset();
    this.port.postMessage({ kind: 'ready', N: this.N, sampleRate, effectiveHz: this.effectiveHz });
  }
  reset() { this.s1 = 0; this.s2 = 0; this.n = 0; this.startTime = currentTime; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) {                       // no input connected yet: emit nothing, never fake a value
      return true;
    }
    for (let i = 0; i < ch.length; i++) {
      const s0 = ch[i] + this.coeff * this.s1 - this.s2;
      this.s2 = this.s1; this.s1 = s0; this.n++;
      if (this.n >= this.N) {
        const power = this.s1 * this.s1 + this.s2 * this.s2 - this.coeff * this.s1 * this.s2;
        const mag = Math.sqrt(Math.max(power, 0)) * 2 / this.N;
        // floor at -200 dB. NEVER emit -Infinity: an infinity silently satisfies any
        // ">= threshold" comparison downstream and reads as a spectacular pass.
        const db = mag > 1e-10 ? 20 * Math.log10(mag) : -200;
        this.port.postMessage({ kind: 's', ctxTime: this.startTime, db });
        this.reset();
      }
    }
    return true;
  }
}
registerProcessor('tone-probe', ToneProbe);
