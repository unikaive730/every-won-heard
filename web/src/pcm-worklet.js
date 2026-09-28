/**
 * AudioWorklets, off the main thread. No imports allowed here.
 *
 * pcm-capture   mono float input at the context rate -> Int16 PCM frames at `targetRate` (16 kHz for the Korean
 *               streaming path, 24 kHz for the Voice Agent API), `frameMs` long (100 ms / 50 ms), with an RMS
 *               level. Resampling happens here, so the page can keep the context at the device rate: Safari
 *               ignores a requested rate and Firefox drops echo cancellation for a non-default one.
 * pcm-playback  a ring buffer at the context rate for agent speech. The main thread resamples 24 kHz to the
 *               context rate before posting. 'flush' empties it at once (barge-in). Posts 'playing' when it
 *               starts from empty and 'drained' when it runs dry, so the page knows when the agent is audible.
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

class PcmPlayback extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(sampleRate * 60); // one minute of speech is plenty; overflow is dropped
    this.read = 0;
    this.write = 0;
    this.available = 0;
    this.active = false;
    this.levelEvery = Math.round(sampleRate / 10); // report the level ten times a second while playing
    this.sinceLevel = 0;
    this.sum = 0;
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        const had = this.available > 0;
        this.read = this.write = this.available = 0;
        if (had || this.active) { this.active = false; this.port.postMessage({ type: 'drained', flushed: true }); }
        return;
      }
      const f = e.data;
      if (!(f instanceof Float32Array) || !f.length) return;
      const cap = this.ring.length;
      for (let i = 0; i < f.length && this.available < cap; i++) {
        this.ring[this.write] = f[i];
        this.write = (this.write + 1) % cap;
        this.available++;
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    const out = output[0];
    const cap = this.ring.length;
    let played = 0;
    for (let i = 0; i < out.length; i++) {
      if (this.available > 0) {
        const v = this.ring[this.read];
        out[i] = v;
        this.read = (this.read + 1) % cap;
        this.available--;
        played++;
        this.sum += v * v;
        this.n++;
      } else {
        out[i] = 0;
      }
    }
    for (let c = 1; c < output.length; c++) output[c].set(out); // mono source, stereo sink
    if (played && !this.active) { this.active = true; this.port.postMessage({ type: 'playing' }); }
    if (this.active) {
      this.sinceLevel += out.length;
      if (this.sinceLevel >= this.levelEvery) {
        this.port.postMessage({ type: 'level', rms: this.n ? Math.sqrt(this.sum / this.n) : 0, bufferedMs: Math.round((this.available / sampleRate) * 1000) });
        this.sinceLevel = 0; this.sum = 0; this.n = 0;
      }
    }
    if (this.active && this.available === 0) { this.active = false; this.port.postMessage({ type: 'drained' }); }
    return true;
  }
}

registerProcessor('pcm-playback', PcmPlayback);
