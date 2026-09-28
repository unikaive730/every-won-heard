/**
 * "Watch a demo call": a synthesized caller (web/public/demo/*.wav, made by scripts/make-demo-audio.ps1)
 * talks to the live Voice Agent. Only the caller's voice is synthesized; the agent, transcription, tools and
 * prices are live.
 *
 * - The WAVs go into input.audio at real-time speed, 50 ms per frame, with silence frames between lines,
 *   exactly like a microphone would (faster than real time is an audio_rate_violation).
 * - The same samples play through the speakers so a screen recording has both voices.
 * - The next line starts after the agent's reply is done and has finished playing here; the barge-in line
 *   (C4) starts 2.5 s after the agent begins reading the plan. Timing rules: lib/demo-script.js.
 */
import { parseWav, createPacer, createDirector } from './lib/demo-script.js';
import { createResampler, int16ToFloat, floatToInt16, FRAME_MS, FRAME_SAMPLES, WIRE_RATE } from './lib/va.js';
import SCRIPT from './demo-lines.json';

export const DEMO_LINES = SCRIPT.lines;

export class DemoCaller {
  /**
   * @param {{agentPlayer:import('./player.js').Player, voice:import('./player.js').Player, base?:string, onEvent?:Function}} opts
   */
  constructor({ agentPlayer, voice, base = '/demo/', onEvent = () => {} }) {
    this.client = null;
    this.agentPlayer = agentPlayer;
    this.voice = voice;
    this.base = base;
    this.onEvent = onEvent;
    this.audio = new Map(); // id -> Int16Array at 24 kHz
    this.director = createDirector(DEMO_LINES);
    this.pacer = createPacer({ frameMs: FRAME_MS });
    this.current = null; // {id, samples, offset}
    this.silence = new Int16Array(FRAME_SAMPLES);
    this.unsubs = [];
    this.stats = { pumps: 0, frames: 0, maxBurst: 0, bursts: 0, maxGapMs: 0, last: null }; // pacing health, reported on stop
  }

  /** Fetch and check every line before the call starts (a missing WAV must not cost a paid session). */
  async load() {
    const missing = [];
    await Promise.all(DEMO_LINES.map(async (l) => {
      try {
        const res = await fetch(`${this.base}${l.id}.wav`, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const w = parseWav(await res.arrayBuffer()); // an HTML fallback page fails here
        this.audio.set(l.id, w.sampleRate === WIRE_RATE ? w.samples : floatToInt16(createResampler(w.sampleRate, WIRE_RATE).process(int16ToFloat(w.samples))));
      } catch {
        missing.push(l.id);
      }
    }));
    if (missing.length) throw Object.assign(new Error(`Demo caller audio is missing (${missing.join(', ')}). Run scripts/make-demo-audio.ps1 on a Windows machine, then rebuild.`), { code: 'demo_audio_missing' });
    return DEMO_LINES.map((l) => ({ id: l.id, seconds: this.audio.get(l.id).length / WIRE_RATE }));
  }

  /** @param {import('./voice-agent.js').VoiceAgentClient} client  a connected client (session.ready seen) */
  start(client) {
    this.client = client;
    const now = () => performance.now();
    this.pacer.start(now());
    const on = (type, data) => this.apply(this.director.on(type, data, now()));
    this.unsubs.push(this.client.subscribe((type, d) => {
      if (type === 'reply-started') on('reply.started', d);
      else if (type === 'reply-audio') on('reply.audio', d);
      else if (type === 'reply-done') on('reply.done', d);
      else if (type === 'tool-call') on('tool.call', d);
      else if (type === 'tool-settled') on('tool.settled', d);
      else if (type === 'closed') this.stop();
    }));
    this.unsubs.push(this.agentPlayer.onStateChange((s) => { if (s.type === 'drained') on('playback.drained'); }));
    this.timer = setInterval(() => this.pump(now()), 20);
  }

  /** Send every frame that is due by the wall clock: the current line, or silence between lines. */
  pump(t) {
    const n = this.pacer.due(t);
    const st = this.stats;
    if (st.last != null) st.maxGapMs = Math.max(st.maxGapMs, Math.round(t - st.last));
    st.last = t;
    st.pumps += 1;
    st.frames += n;
    if (n > 1) st.bursts += 1;
    st.maxBurst = Math.max(st.maxBurst, n);
    for (let i = 0; i < n; i++) {
      let frame = this.silence;
      const c = this.current;
      if (c) {
        frame = new Int16Array(FRAME_SAMPLES);
        frame.set(c.samples.subarray(c.offset, c.offset + FRAME_SAMPLES));
        c.offset += FRAME_SAMPLES;
        if (c.offset >= c.samples.length) {
          this.current = null;
          this.onEvent('line-end', { id: c.id });
          this.client.sendAudio(frame);
          this.apply(this.director.on('line.ended', {}, t));
          continue;
        }
      }
      this.client.sendAudio(frame);
    }
    this.apply(this.director.tick(t));
  }

  apply(cmds) {
    for (const c of cmds) {
      if (c.cmd === 'play') {
        const samples = this.audio.get(c.id);
        const line = DEMO_LINES[c.index];
        this.current = { id: c.id, samples, offset: 0 };
        this.voice.enqueue(samples); // what the caller says is heard in the room too
        this.onEvent('line', { id: c.id, text: line.text, bargeIn: c.bargeIn, index: c.index, total: DEMO_LINES.length });
      } else if (c.cmd === 'done') {
        this.onEvent('done', {});
      }
    }
  }

  stop() {
    if (this.timer) this.onEvent('stats', { ...this.stats, last: undefined });
    clearInterval(this.timer);
    this.timer = null;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.current = null;
    this.voice?.flush();
  }
}
