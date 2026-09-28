/**
 * English calls on the AssemblyAI Voice Agent API, straight from the browser.
 *
 *   GET  /api/voice-agent/token            a single-use token (the API key stays on our server)
 *   wss://agents.assemblyai.com/v1/ws?token=...
 *     -> session.update                    the session our server built (or {agent_id} alone)
 *     <- session.ready                     session_id -> POST /api/session/:id/aai-session (for the receipt)
 *     -> input.audio                       50 ms of 24 kHz PCM16, base64, only after session.ready
 *     <- transcript.user                   -> POST /api/session/:id/heard: our server keeps its own copy of what
 *                                             the owner said, and checks every budget against it
 *     <- tool.call ... reply.done          -> POST /api/session/:id/tool (in order), then tool.result, then the
 *                                             next stage's session.update (tools, prompt, listening settings)
 *     <- input.speech.started              the owner talks: stop the agent's audio here at once
 *     <- reply.done status=interrupted     drop the tool calls collected for that reply
 *     -> session.end                       billing stops now (a bare close bills a 30 s resume window)
 *
 * The model never passes a number: tools take the owner's words, and our server reads the amount from the
 * words and from the transcripts it received (docs/hackathon/23_va_toolcall_finding.md).
 */
import { agentWsUrl, firstUpdate, laterUpdate, int16ToBase64, base64ToInt16, createToolGate, createLatencyMeter, listeningFrom, pauseReason } from './lib/va.js';

const QUIET = new Set(['reply.audio', 'transcript.user.delta', 'transcript.agent.delta', 'input.audio']);

export class VoiceAgentClient {
  /**
   * @param {{api:Function, session:{sessionId:string, agentId?:string, state?:string, session_update?:object},
   *          player:import('./player.js').Player, WebSocketImpl?:typeof WebSocket, maxSeconds?:number, now?:()=>number}} opts
   */
  constructor({ api, session, player, WebSocketImpl = globalThis.WebSocket, maxSeconds = 240, readyTimeoutMs = 12000, now = () => performance.now() }) {
    this.api = api;
    this.session = session;
    this.id = session.sessionId;
    this.player = player;
    this.WS = WebSocketImpl;
    this.maxSeconds = maxSeconds;
    this.readyTimeoutMs = readyTimeoutMs;
    this.now = now;
    this.state = session.state || null; // our server's stage (s0 .. s4)
    this.ws = null;
    this.ready = false;
    this.ended = false;
    this.aaiSessionId = null;
    this.config = null;
    this.lastItemId = null;
    this.audioSeconds = 0;
    this.typed = 0;
    this.listeners = new Set();
    this.heardChain = Promise.resolve(); // /heard posts, in order; a tool relay waits for them
    this.callNames = new Map(); // call_id -> tool name
    this.endAfterReply = false;
    this.latency = createLatencyMeter();
    this.gate = createToolGate({
      runTool: (call) => this.runTool(call),
      send: (m) => this.send(m),
      onDropped: (calls, why) => { for (const c of calls) this.emit('tool-settled', { call_id: c.call_id, name: c.name, sent: false, why }); },
    });
    this.onPageHide = () => { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type: 'session.end' })); };
  }

  /** @returns {() => void} unsubscribe. Listener gets (type, data). */
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, data = {}) {
    for (const fn of this.listeners) {
      try { fn(type, data); } catch (err) { console.error(err); }
    }
  }

  wire(dir, type, detail = '') {
    this.emit('wire', { dir, type, detail, t: this.now() });
  }

  async connect() {
    let token;
    try {
      ({ token } = await this.api('/api/voice-agent/token'));
    } catch (err) {
      throw Object.assign(new Error(err.data?.message || err.message), { pause: pauseReason({ status: err.status, code: err.data?.error }), status: err.status });
    }
    const first = firstUpdate(this.session);
    if (!first) throw new Error('the server gave no session configuration');
    // a stored agent binds first; our inline stage settings follow once the session is ready
    const afterReady = first.session.agent_id ? laterUpdate(this.session.session_update) : null;

    await new Promise((resolve, reject) => {
      const ws = new this.WS(agentWsUrl(token));
      this.ws = ws;
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const timer = setTimeout(() => {
        done(new Error('The voice agent did not get ready in time.'));
        this.end('ready_timeout');
      }, this.readyTimeoutMs);
      ws.onopen = () => this.send(first);
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'session.ready') {
          this.handle(msg);
          if (afterReady) this.send(afterReady);
          done();
          return;
        }
        if (msg.type === 'session.error' && !this.ready) {
          this.handle(msg);
          done(Object.assign(new Error(msg.message || msg.code), { code: msg.code, pause: pauseReason({ code: msg.code }) }));
          return;
        }
        this.handle(msg);
      };
      ws.onerror = () => { if (!this.ready) done(Object.assign(new Error('Could not reach the voice agent.'), { pause: null })); };
      ws.onclose = (e) => {
        // before the handshake a browser shows UNAUTHORIZED as a bare close (1006)
        if (!this.ready) done(Object.assign(new Error(`The voice agent closed the connection (${e.code}).`), { pause: e.code === 1008 || e.code === 1006 ? 'paused' : null }));
        this.finish(e.code === 1000 || this.ended ? 'closed' : `socket closed ${e.code}`);
      };
    });
    globalThis.addEventListener?.('pagehide', this.onPageHide);
    this.watchdog = setTimeout(() => this.end('time_limit'), this.maxSeconds * 1000);
    return { sessionId: this.aaiSessionId, config: this.config };
  }

  send(msg) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify(msg));
    if (msg.type === 'tool.result') {
      const name = this.callNames.get(msg.call_id) || '';
      this.wire('up', 'tool.result', `${name}${msg.is_error ? ' is_error: true' : ''}`);
      this.emit('tool-settled', { call_id: msg.call_id, name, sent: true, is_error: msg.is_error });
      if (name === 'end_call') this.armEnd();
    } else if (msg.type === 'session.update') {
      const s = msg.session || {};
      this.wire('up', 'session.update', s.agent_id ? 'agent_id' : [s.tools ? `${s.tools.length} tools` : '', s.input ? 'listening' : '', s.system_prompt ? 'prompt' : ''].filter(Boolean).join(' · '));
    } else if (!QUIET.has(msg.type)) {
      this.wire('up', msg.type);
    }
    return true;
  }

  /** @param {Int16Array} pcm  24 kHz mono PCM16 (a 50 ms frame from the mic, or from the demo caller) */
  sendAudio(pcm) {
    if (!this.ready || this.ended || !this.ws || this.ws.readyState !== 1) return false;
    this.ws.send(JSON.stringify({ type: 'input.audio', audio: int16ToBase64(pcm) }));
    this.audioSeconds += pcm.length / 24000;
    return true;
  }

  /** The owner typed instead of speaking: same conversation, and our server hears it like a transcript. */
  sendText(text) {
    const t = String(text || '').trim();
    if (!t || !this.ready || this.ended) return false;
    const item_id = `typed_${++this.typed}`;
    this.postHeard({ item_id, text: t, via: 'typed' });
    this.player.flush();
    this.send({ type: 'conversation.message', role: 'user', content: t });
    this.send({ type: 'reply.create' });
    this.emit('user', { item_id, text: t, typed: true });
    return true;
  }

  postHeard({ item_id, text, via = 'voice-agent' }) {
    const body = { item_id, text, at: Date.now(), via };
    this.heardChain = this.heardChain
      .then(() => this.api(`/api/session/${this.id}/heard`, { method: 'POST', json: body }))
      .catch((err) => this.emit('warn', { message: `heard: ${err.message}` }));
  }

  async runTool(call) {
    await this.heardChain; // the grounding check must see every transcript that came before the call
    const r = await this.api(`/api/session/${this.id}/tool`, { method: 'POST', json: { call_id: call.call_id, name: call.name, arguments: call.arguments, last_item_id: this.lastItemId } });
    if (r.state) this.state = r.state;
    let parsed = r.result;
    if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch { /* keep the text */ } }
    this.emit('tool-result', { call, result: parsed, is_error: Boolean(r.is_error), state: this.state, raw: r });
    return r;
  }

  handle(msg) {
    const t = msg.type;
    if (!QUIET.has(t)) this.wire('down', t, detailOf(msg));
    switch (t) {
      case 'session.ready':
        this.ready = true;
        this.aaiSessionId = msg.session_id || null;
        this.config = msg.config || null;
        this.emit('ready', { session_id: this.aaiSessionId, config: this.config });
        this.emit('listening', listeningFrom(this.config, this.state));
        if (this.aaiSessionId) {
          this.api(`/api/session/${this.id}/aai-session`, { method: 'POST', json: { aai_session_id: this.aaiSessionId } })
            .catch((err) => this.emit('warn', { message: `aai-session: ${err.message}` }));
        }
        break;
      case 'session.updated':
        this.config = msg.config || this.config;
        this.emit('listening', listeningFrom(this.config, this.state));
        break;
      case 'input.speech.started':
        this.player.flush(); // barge-in: silence the agent here right away
        this.gate.onTurnEvent(t);
        this.latency.speechStarted();
        this.emit('speech', { started: true });
        break;
      case 'input.speech.stopped':
        this.latency.speechStopped(this.now());
        this.emit('speech', { started: false });
        break;
      case 'transcript.user.delta':
        this.emit('user-partial', { item_id: msg.item_id, text: msg.text });
        break;
      case 'transcript.user':
        this.lastItemId = msg.item_id || this.lastItemId;
        this.postHeard({ item_id: msg.item_id, text: msg.text });
        this.emit('user', { item_id: msg.item_id, text: msg.text });
        break;
      case 'reply.started':
        this.gate.onTurnEvent(t);
        this.emit('reply-started', { reply_id: msg.reply_id, item_id: msg.item_id });
        break;
      case 'reply.audio': {
        const ms = this.latency.replyAudio(this.now());
        if (ms != null) this.emit('latency', { ms, median: this.latency.median, count: this.latency.count });
        this.player.enqueue(base64ToInt16(msg.data));
        this.emit('reply-audio', {});
        break;
      }
      case 'transcript.agent.delta':
        this.emit('agent-partial', { reply_id: msg.reply_id, delta: msg.delta });
        break;
      case 'transcript.agent':
        this.emit('agent', { reply_id: msg.reply_id, text: msg.text, interrupted: Boolean(msg.interrupted) });
        break;
      case 'reply.done':
        if (msg.status === 'interrupted') this.player.flush();
        Promise.resolve(this.gate.onReplyDone(msg.status)).catch((err) => this.emit('warn', { message: `tool relay: ${err.message}` }));
        this.emit('reply-done', { reply_id: msg.reply_id, status: msg.status });
        if (this.endAfterReply && msg.status === 'completed' && !String(msg.reply_id || '').startsWith('fc-')) {
          this.endAfterReply = false;
          this.player.whenDrained(8000).then(() => this.end('end_call'));
        }
        break;
      case 'tool.call':
        this.callNames.set(msg.call_id, msg.name);
        this.emit('tool-call', { call_id: msg.call_id, name: msg.name, arguments: msg.arguments || {} });
        Promise.resolve(this.gate.onToolCall(msg)).catch((err) => this.emit('warn', { message: `tool relay: ${err.message}` }));
        break;
      case 'session.error':
        this.emit('error', { code: msg.code, message: msg.message, param: msg.param || null });
        break;
      case 'session.ended':
        this.emit('ended', { session_duration_seconds: msg.session_duration_seconds, audio_duration_seconds: msg.audio_duration_seconds });
        this.finish('session.ended');
        break;
      default:
        break;
    }
  }

  /** end_call's result went out: let the agent say goodbye, then end (or end anyway after a few seconds). */
  armEnd() {
    this.endAfterReply = true;
    clearTimeout(this.endTimer);
    this.endTimer = setTimeout(() => this.end('end_call'), 9000);
  }

  /** Ends the call: session.end, wait for session.ended (up to 3 s), close. Safe to call twice. */
  async end(reason = 'hangup') {
    if (this.ended) return this.endPromise;
    this.ended = true;
    this.endReason = reason;
    clearTimeout(this.watchdog);
    clearTimeout(this.endTimer);
    const ws = this.ws;
    this.endPromise = new Promise((resolve) => {
      if (!ws || ws.readyState > 1) { this.finish(reason); resolve(); return; }
      const t = setTimeout(() => { try { ws.close(); } catch { /* ignore */ } this.finish(reason); resolve(); }, 3000);
      this.listeners.add((type) => { if (type === 'closed') { clearTimeout(t); resolve(); } });
      if (ws.readyState === 1) this.send({ type: 'session.end' });
      else ws.addEventListener('open', () => this.send({ type: 'session.end' }), { once: true });
    });
    this.emit('ending', { reason });
    return this.endPromise;
  }

  finish(why) {
    if (this.closed) return;
    this.closed = true;
    this.ended = true;
    clearTimeout(this.watchdog);
    clearTimeout(this.endTimer);
    globalThis.removeEventListener?.('pagehide', this.onPageHide);
    try { if (this.ws && this.ws.readyState <= 1) this.ws.close(); } catch { /* ignore */ }
    this.player?.flush();
    this.emit('closed', { why: this.endReason || why, audioSeconds: this.audioSeconds });
  }
}

function detailOf(msg) {
  switch (msg.type) {
    case 'reply.done': return msg.status === 'interrupted' ? 'interrupted' : '';
    case 'tool.call': return `${msg.name} ${JSON.stringify(msg.arguments || {})}`;
    case 'session.error': return `${msg.code}${msg.param ? ` (${msg.param})` : ''}: ${msg.message || ''}`;
    case 'session.updated': {
      const l = listeningFrom(msg.config);
      return `${l.mode} · ${l.keyterms} key terms`;
    }
    case 'transcript.user': return msg.text || '';
    default: return '';
  }
}
