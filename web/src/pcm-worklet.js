/**
 * AudioWorklet: mono float input -> 16 kHz Int16 PCM frames of ~100 ms, with an RMS level.
 * Runs off the main thread. No imports allowed here.
 */
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.targetRate = o.targetRate || 16000;
    this.frameSamples = Math.round((o.frameMs || 100) / 1000 * this.targetRate);
    this.ratio = sampleRate / this.targetRate; // global `sampleRate` is the AudioContext rate
    this.buf = new Float32Array(0);
    this.pos = 0; // fractional read position into buf for resampling
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    // append
    const merged = new Float32Array(this.buf.length + ch.length);
    merged.set(this.buf, 0);
    merged.set(ch, this.buf.length);
    this.buf = merged;

    // resample (linear) as many target samples as available
    const outCount = Math.floor((this.buf.length - 1 - this.pos) / this.ratio);
    if (outCount <= 0) return true;
    const out = new Float32Array(outCount);
    let p = this.pos;
    for (let i = 0; i < outCount; i++) {
      const idx = Math.floor(p);
      const frac = p - idx;
      out[i] = this.buf[idx] * (1 - frac) + this.buf[idx + 1] * frac;
      p += this.ratio;
    }
    const consumed = Math.floor(p);
    this.buf = this.buf.subarray(consumed);
    this.pos = p - consumed;

    // accumulate into fixed frames
    this.pending = this.pending ? concat(this.pending, out) : out;
    while (this.pending.length >= this.frameSamples) {
      const frame = this.pending.subarray(0, this.frameSamples);
      this.pending = this.pending.subarray(this.frameSamples);
      const pcm = new Int16Array(frame.length);
      let sum = 0;
      for (let i = 0; i < frame.length; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sum += s * s;
      }
      const rms = Math.sqrt(sum / frame.length);
      this.port.postMessage({ pcm, rms }, [pcm.buffer]);
    }
    return true;
  }
}

function concat(a, b) {
  const r = new Float32Array(a.length + b.length);
  r.set(a, 0);
  r.set(b, a.length);
  return r;
}

registerProcessor('pcm-capture', PcmCapture);
