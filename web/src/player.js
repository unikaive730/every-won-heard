/**
 * Plays 24 kHz PCM16 speech (Voice Agent reply.audio, or the demo caller's lines) through a ring-buffer
 * worklet. Chunks are queued as they arrive, `flush()` stops the sound at once (barge-in), and the
 * resampler bridges 24 kHz to whatever rate the context really runs at (48 kHz on most machines).
 *
 * A ring buffer rather than one AudioBufferSource per chunk: per-chunk scheduling drifts and clicks
 * under network jitter.
 */
import { ensureWorklets } from './audio.js';
import { createResampler, int16ToFloat, WIRE_RATE } from './lib/va.js';

export class Player {
  /**
   * @param {AudioContext} ctx
   * @param {{rate?:number, gain?:number, onState?:(s:{type:'playing'|'drained'|'level', flushed?:boolean, rms?:number})=>void}} opts
   */
  static async create(ctx, opts = {}) {
    await ensureWorklets(ctx);
    return new Player(ctx, opts);
  }

  constructor(ctx, { rate = WIRE_RATE, gain = 1, onState = () => {} } = {}) {
    this.ctx = ctx;
    this.rate = rate;
    this.listeners = new Set([onState]);
    this.resampler = createResampler(rate, ctx.sampleRate);
    this.node = new AudioWorkletNode(ctx, 'pcm-playback', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.gain = ctx.createGain();
    this.gain.gain.value = gain;
    this.node.connect(this.gain).connect(ctx.destination);
    this.playing = false;
    this.queuedSamples = 0; // at the wire rate, since the last drain (for the caller's line length)
    this.waiters = [];
    this.node.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'playing') this.playing = true;
      if (m.type === 'drained') {
        this.playing = false;
        this.queuedSamples = 0;
        const w = this.waiters;
        this.waiters = [];
        for (const r of w) r();
      }
      for (const fn of this.listeners) fn(m);
    };
  }

  /** Another listener for playing / drained / level. @returns {() => void} unsubscribe */
  onStateChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** @param {Int16Array} pcm  mono PCM16 at this.rate */
  enqueue(pcm) {
    if (!pcm?.length) return;
    const f = this.resampler.process(int16ToFloat(pcm));
    this.queuedSamples += pcm.length;
    this.node.port.postMessage(f, [f.buffer]);
  }

  /** Stop at once and forget what was queued. */
  flush() {
    this.node.port.postMessage('flush');
    this.resampler.reset();
  }

  /** Resolves when the queue runs dry (or after timeoutMs). */
  whenDrained(timeoutMs = 30000) {
    if (!this.playing && !this.queuedSamples) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => { clearTimeout(t); resolve(); });
    });
  }

  close() {
    try { this.node.port.onmessage = null; this.node.disconnect(); this.gain.disconnect(); } catch { /* ignore */ }
    for (const r of this.waiters) r();
    this.waiters = [];
  }
}
