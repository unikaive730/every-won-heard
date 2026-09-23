/** Microphone capture -> 16 kHz Int16 frames via an AudioWorklet. */
export const SAMPLE_RATE = 16000;

export async function startMic({ onFrame, onLevel } = {}) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('getUserMedia not supported in this browser');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  let ctx;
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  } catch {
    ctx = new AudioContext(); // Safari may refuse a custom rate; the worklet resamples
  }
  if (ctx.state === 'suspended') await ctx.resume();
  await ctx.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0, processorOptions: { targetRate: SAMPLE_RATE, frameMs: 100 } });
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
      ctx.close().catch(() => {});
    },
  };
}
