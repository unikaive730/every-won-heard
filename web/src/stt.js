/**
 * Two speech-to-text paths, both AssemblyAI:
 *  - StreamingSTT : browser -> wss://streaming.assemblyai.com/v3/ws with a temporary token (English and 17 other languages)
 *  - TurnVAD      : simple energy VAD that cuts one utterance at a time; the WAV goes to the server, which uses
 *                   the AssemblyAI pre-recorded API (Korean, which Universal-Streaming does not cover yet)
 */
import { buildStreamingUrl, createTranscriptState, reduceTurn, flushPending } from './lib/transcript.js';

export class StreamingSTT {
  constructor({ getToken, lang = 'en', onEvent, onStatus, prompt }) {
    this.getToken = getToken;
    this.lang = lang;
    this.onEvent = onEvent || (() => {});
    this.onStatus = onStatus || (() => {});
    this.prompt = prompt;
    this.state = createTranscriptState();
    this.ws = null;
    this.sessionId = null;
    this.bytesSent = 0;
  }

  async start() {
    const { token } = await this.getToken();
    const url = buildStreamingUrl({ token, lang: this.lang, prompt: this.prompt });
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      const t = setTimeout(() => reject(new Error('AssemblyAI socket timeout')), 8000);
      ws.onopen = () => { clearTimeout(t); this.onStatus({ type: 'open' }); resolve(); };
      ws.onerror = () => { clearTimeout(t); this.onStatus({ type: 'error' }); reject(new Error('AssemblyAI socket error')); };
      ws.onclose = (e) => {
        const r = flushPending(this.state);
        this.state = r.state;
        if (r.event) this.onEvent(r.event);
        this.onStatus({ type: 'close', code: e.code, reason: e.reason });
      };
      ws.onmessage = (m) => this.handleMessage(m);
    });
  }

  handleMessage(m) {
    let msg;
    try { msg = JSON.parse(m.data); } catch { return; }
    if (msg.type === 'Begin') {
      this.sessionId = msg.id;
      this.onStatus({ type: 'begin', id: msg.id, expiresAt: msg.expires_at });
      return;
    }
    if (msg.type === 'Turn') {
      const r = reduceTurn(this.state, msg);
      this.state = r.state;
      if (r.event) this.onEvent(r.event);
      return;
    }
    if (msg.type === 'Termination') {
      this.onStatus({ type: 'termination', audioSeconds: msg.audio_duration_seconds, sessionSeconds: msg.session_duration_seconds });
      return;
    }
    if (msg.type === 'Error' || msg.error) {
      this.onStatus({ type: 'error', message: msg.error || JSON.stringify(msg) });
    }
  }

  /** @param {Int16Array} pcm */
  send(pcm) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(pcm.buffer);
      this.bytesSent += pcm.byteLength;
    }
  }

  forceEndpoint() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ForceEndpoint' }));
  }

  async stop() {
    const ws = this.ws;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'Terminate' })); } catch { /* ignore */ }
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } resolve(); }, 1500);
        ws.addEventListener('close', () => { clearTimeout(t); resolve(); }, { once: true });
      });
    } else {
      try { ws.close(); } catch { /* ignore */ }
    }
    this.ws = null;
  }
}

/**
 * Energy-based voice activity detection over 100 ms frames.
 * Adaptive noise floor; emits the Int16 frames of one utterance when the speaker pauses.
 */
export class TurnVAD {
  constructor({ onUtterance, onState, minSpeechMs = 350, endSilenceMs = 900, maxUtteranceMs = 25000, preRollFrames = 3, frameMs = 100 } = {}) {
    this.onUtterance = onUtterance || (() => {});
    this.onState = onState || (() => {});
    this.minSpeechFrames = Math.ceil(minSpeechMs / frameMs);
    this.endSilenceFrames = Math.ceil(endSilenceMs / frameMs);
    this.maxFrames = Math.ceil(maxUtteranceMs / frameMs);
    this.preRollFrames = preRollFrames;
    this.frameMs = frameMs;
    this.noise = 0.004;
    this.reset();
  }

  reset() {
    this.speaking = false;
    this.frames = [];
    this.pre = [];
    this.speechFrames = 0;
    this.silenceFrames = 0;
  }

  threshold() {
    return Math.max(0.012, this.noise * 3.5);
  }

  /** @param {Int16Array} pcm @param {number} rms */
  feed(pcm, rms) {
    const th = this.threshold();
    const loud = rms > th;
    if (!this.speaking) {
      if (!loud) this.noise = this.noise * 0.95 + rms * 0.05; // track the floor only in silence
      this.pre.push(pcm);
      if (this.pre.length > this.preRollFrames) this.pre.shift();
      if (loud) {
        this.speechFrames += 1;
        if (this.speechFrames >= 2) {
          this.speaking = true;
          this.frames = [...this.pre];
          this.silenceFrames = 0;
          this.onState({ speaking: true });
        }
      } else {
        this.speechFrames = 0;
      }
      return;
    }
    this.frames.push(pcm);
    if (loud) { this.silenceFrames = 0; this.speechFrames += 1; } else { this.silenceFrames += 1; }
    const ended = this.silenceFrames >= this.endSilenceFrames || this.frames.length >= this.maxFrames;
    if (ended) {
      const frames = this.frames;
      const speechFrames = this.speechFrames;
      this.reset();
      this.onState({ speaking: false });
      if (speechFrames >= this.minSpeechFrames) this.onUtterance(frames);
    }
  }

  /** Force-cut the current utterance (e.g. the owner pressed "send"). */
  flush() {
    if (!this.speaking) return;
    const frames = this.frames;
    const speechFrames = this.speechFrames;
    this.reset();
    this.onState({ speaking: false });
    if (speechFrames >= this.minSpeechFrames) this.onUtterance(frames);
  }
}
