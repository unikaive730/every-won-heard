/**
 * Microphone capture -> Int16 frames at a target rate via an AudioWorklet.
 *
 *   Korean (Universal-3.6 Pro streaming)  16 kHz, 100 ms frames, browser noise suppression on (unchanged)
 *   English (Voice Agent API)             24 kHz, 50 ms frames, echo cancellation on, noise suppression and
 *                                         auto gain off: the server's voice_focus does the denoising, and a
 *                                         second layer costs accuracy (browser-integration doc, section 4)
 */
export const SAMPLE_RATE = 16000; // Korean streaming path
export const VOICE_AGENT_CAPTURE = { rate: 24000, frameMs: 50, noiseSuppression: false, autoGainControl: false };

const loaded = new WeakMap(); // AudioContext -> addModule promise (a processor name can be registered once)

/** Load both worklets (capture and playback) into a context, once. */
export function ensureWorklets(ctx) {
  if (!loaded.has(ctx)) loaded.set(ctx, ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url)));
  return loaded.get(ctx);
}

/**
 * One context for a Voice Agent call: capture, agent playback and the demo caller's voice all live here.
 * The device rate is kept (see pcm-worklet.js). Create it inside a click handler so every browser starts it.
 */
export async function createCallContext() {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  if (ctx.state === 'suspended') await ctx.resume();
  await ensureWorklets(ctx);
  return ctx;
}

/**
 * @param {{onFrame?:Function, onLevel?:Function, rate?:number, frameMs?:number, noiseSuppression?:boolean,
 *          autoGainControl?:boolean, context?:AudioContext}} opts  a passed context is shared and not closed on stop
 */
export async function startMic({ onFrame, onLevel, rate = SAMPLE_RATE, frameMs = 100, noiseSuppression = true, autoGainControl = true, context = null } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia not supported in this browser');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression, autoGainControl },
    video: false,
  });
  let ctx = context;
  if (!ctx) {
    try {
      ctx = new AudioContext({ sampleRate: rate });
    } catch {
      ctx = new AudioContext(); // Safari may refuse a custom rate; the worklet resamples
    }
  }
  if (ctx.state === 'suspended') await ctx.resume();
  await ensureWorklets(ctx);
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { targetRate: rate, frameMs } });
  node.port.onmessage = (e) => {
    const { pcm, rms } = e.data;
    onLevel?.(rms);
    onFrame?.(pcm, rms);
  };
  src.connect(node);
  return {
    contextRate: ctx.sampleRate,
    stop() {
      try { node.port.onmessage = null; src.disconnect(); node.disconnect(); } catch { /* ignore */ }
      for (const t of stream.getTracks()) t.stop();
      if (!context) ctx.close().catch(() => {});
    },
  };
}
