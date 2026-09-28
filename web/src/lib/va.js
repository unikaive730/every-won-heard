/**
 * Pure helpers for the Voice Agent API browser client (no DOM, no Web Audio). Shared with the tests.
 *
 * - agentWsUrl(token)             wss://agents.assemblyai.com/v1/ws?token=...
 * - firstUpdate({...})            the first session.update: the server's inline session, or {agent_id} only
 * - laterUpdate(x)                a mid-call session.update without the fields that raise immutable_field
 * - int16ToBase64 / base64ToInt16 PCM16 <-> base64 for input.audio / reply.audio
 * - createResampler(from, to)     streaming linear resampler (Float32 in, Float32 out)
 * - createToolGate({...})         the tool.call -> reply.done -> /tool -> tool.result ordering rules
 * - createLatencyMeter()          input.speech.stopped -> first reply.audio, in ms
 * - listeningFrom(config, state)  "money · max accuracy · 4 key terms" from session.ready / session.updated
 *
 * Protocol facts used here (docs/hackathon/va_events.md, va_client_tools.md):
 * - send tool.result only when reply.done is the latest event received; a reply.done with status
 *   "interrupted" drops every result collected for that reply
 * - agent_id goes alone in the first session.update (agent_id_not_first otherwise)
 * - greeting, output.voice and output.format are immutable after session.ready
 */

export const VA_WS = 'wss://agents.assemblyai.com/v1/ws';
export const WIRE_RATE = 24000; // audio/pcm, both directions
export const FRAME_MS = 50;
export const FRAME_SAMPLES = (WIRE_RATE * FRAME_MS) / 1000; // 1200

export function agentWsUrl(token) {
  if (!token) throw new Error('token is required');
  return `${VA_WS}?token=${encodeURIComponent(token)}`;
}

/** Accepts {type, session}, a bare session object, or nothing. Returns a session.update message or null. */
function asUpdate(x) {
  if (!x || typeof x !== 'object') return null;
  if (x.type === 'session.update' && x.session && typeof x.session === 'object') return { type: 'session.update', session: { ...x.session } };
  if (x.type) return null; // some other event, not ours to send
  return Object.keys(x).length ? { type: 'session.update', session: { ...x } } : null;
}

/**
 * The first session.update. The server's inline session wins; with only a stored agent id, send {agent_id}
 * alone (it is mutually exclusive with inline fields, and must be first).
 * @param {{session_update?:object, agentId?:string}} s  the POST /api/session response
 */
export function firstUpdate({ session_update: su = null, agentId = null } = {}) {
  const u = asUpdate(su);
  if (u) {
    if (u.session.agent_id) return { type: 'session.update', session: { agent_id: u.session.agent_id } };
    return u;
  }
  if (agentId) return { type: 'session.update', session: { agent_id: agentId } };
  return null;
}

const IMMUTABLE = ['agent_id', 'greeting'];

/**
 * A session.update to send after session.ready: drops agent_id, greeting, output.voice and output.format
 * (each would raise immutable_field or agent_id_not_first). Returns null when nothing is left.
 */
export function laterUpdate(x) {
  const u = asUpdate(x);
  if (!u) return null;
  const s = { ...u.session };
  for (const k of IMMUTABLE) delete s[k];
  if (s.output && typeof s.output === 'object') {
    const { voice, format, ...rest } = s.output;
    void voice; void format;
    if (Object.keys(rest).length) s.output = rest; else delete s.output;
  }
  return Object.keys(s).length ? { type: 'session.update', session: s } : null;
}

// --- PCM16 <-> base64 (btoa/atob exist in browsers and Node 16+) ---

export function int16ToBase64(pcm) {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function base64ToInt16(b64) {
  const bin = atob(String(b64 || ''));
  const n = bin.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const v = bin.charCodeAt(i * 2) | (bin.charCodeAt(i * 2 + 1) << 8);
    out[i] = v >= 0x8000 ? v - 0x10000 : v;
  }
  return out;
}

export function int16ToFloat(pcm) {
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / 32768;
  return out;
}

export function floatToInt16(f) {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = Math.max(-1, Math.min(1, f[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Streaming linear resampler. Keeps the fractional position and the last sample between chunks so a
 * stream cut into 50 ms pieces comes out the same as one long buffer (no clicks at chunk edges).
 * `reset()` after a flush, so the next reply does not interpolate from the old one.
 */
export function createResampler(fromRate, toRate) {
  const step = fromRate / toRate; // input samples per output sample
  let pos = 0; // position of the next output sample, relative to the current chunk (-1 = the carried sample)
  let prev = 0;
  let primed = false;
  return {
    get ratio() { return step; },
    process(input) {
      if (!input.length) return new Float32Array(0);
      if (step === 1) { prev = input[input.length - 1]; primed = true; return Float32Array.from(input); }
      if (!primed) { prev = input[0]; primed = true; pos = 0; }
      const out = [];
      // sample at x in [-1, n-1]: x = -1 is `prev`, the last sample of the previous chunk
      const at = (x) => {
        const i = Math.floor(x);
        const frac = x - i;
        const a = i < 0 ? prev : input[i];
        const b = i + 1 < 0 ? prev : input[Math.min(i + 1, input.length - 1)];
        return a + (b - a) * frac;
      };
      while (pos <= input.length - 1) {
        out.push(at(pos));
        pos += step;
      }
      pos -= input.length; // carry into the next chunk
      prev = input[input.length - 1];
      return Float32Array.from(out);
    },
    reset() { pos = 0; prev = 0; primed = false; },
  };
}

/**
 * Ordering rules for client-side tools (va_client_tools.md "Returning tool results"):
 *
 *   tool.call            collect; nothing is sent to our server yet
 *   reply.done completed relay every collected call to POST /tool (in order), then send tool.result for each,
 *                        then the next stage's session.update, but only while reply.done is still the latest
 *                        event. If the owner starts talking meanwhile, hold the results for the next reply.done.
 *   reply.done interrupted  drop the collected calls (they never reach the server) and any held results
 *   reply.started / input.speech.started   a turn is in flight: hold
 *
 * @param {{runTool:(call)=>Promise<{result:any, is_error?:boolean, session_update?:object, state?:string}>,
 *          send:(msg)=>void, onResult?:(call, r)=>void, onDropped?:(calls, why)=>void}} deps
 */
export function createToolGate({ runTool, send, onResult = () => {}, onDropped = () => {} }) {
  let last = null; // latest server event type that matters for ordering
  let calls = []; // tool.call events not yet relayed
  let ready = []; // [{call, r}] relayed, waiting to be sent
  let relaying = null; // promise of the relay in flight
  let gen = 0; // bumps on interruption: results of an older generation are dropped

  const resultText = (r) => (typeof r.result === 'string' ? r.result : JSON.stringify(r.result ?? {}));

  function flush() {
    if (last !== 'reply.done' || !ready.length) return false;
    const batch = ready;
    ready = [];
    let update = null;
    for (const { call, r } of batch) {
      send({ type: 'tool.result', call_id: call.call_id, result: resultText(r), is_error: Boolean(r.is_error) });
      if (r.session_update) update = r.session_update;
    }
    const u = laterUpdate(update);
    if (u) send(u); // the next stage: tools, system prompt, listening settings
    return true;
  }

  async function relay() {
    if (relaying || !calls.length) return relaying;
    const myGen = gen;
    const batch = calls;
    calls = [];
    relaying = (async () => {
      for (const call of batch) {
        let r;
        try {
          r = await runTool(call);
        } catch (err) {
          r = { result: { error: 'tool_unavailable', message: String(err && err.message || err), ask: 'Say sorry, the tool did not answer, and ask the owner to repeat that.' }, is_error: true };
        }
        if (myGen !== gen) { // interrupted while our server was working: the model moved on
          onDropped([call], 'interrupted');
          const u = laterUpdate(r.session_update);
          if (u) send(u); // our server's stage did change, keep the agent's tools in step with it
          continue;
        }
        ready.push({ call, r });
        onResult(call, r);
      }
    })();
    try { await relaying; } finally { relaying = null; }
    flush();
    if (calls.length && last === 'reply.done') return relay(); // more arrived while we were busy
    return null;
  }

  return {
    get pending() { return calls.length + ready.length + (relaying ? 1 : 0); },
    get last() { return last; },
    onToolCall(ev) {
      calls.push({ call_id: ev.call_id, name: ev.name, arguments: ev.arguments || {} });
      if (last === 'reply.done') return relay(); // the call came after reply.done
      return null;
    },
    onTurnEvent(type) { last = type; }, // reply.started, input.speech.started
    onReplyDone(status) {
      last = 'reply.done';
      if (status === 'interrupted') {
        gen += 1;
        const dropped = [...calls, ...ready.map((x) => x.call)];
        calls = [];
        ready = [];
        if (dropped.length) onDropped(dropped, 'interrupted');
        return null;
      }
      if (ready.length) flush();
      return relay();
    },
    /** Wait until nothing is being relayed (tests, and the demo caller before its next line). */
    async idle() { while (relaying) await relaying.catch(() => {}); },
  };
}

/** Owner stops talking -> first agent audio chunk. The number the design asks to show, measured, not estimated. */
export function createLatencyMeter({ keep = 50 } = {}) {
  let stoppedAt = null;
  const values = [];
  return {
    speechStarted() { stoppedAt = null; }, // still talking: wait for the next stop
    speechStopped(t) { stoppedAt = t; },
    /** @returns {number|null} the measured ms when this is the first audio after a stop */
    replyAudio(t) {
      if (stoppedAt == null) return null;
      const ms = Math.max(0, Math.round(t - stoppedAt));
      stoppedAt = null;
      values.push(ms);
      if (values.length > keep) values.shift();
      return ms;
    },
    get last() { return values.length ? values[values.length - 1] : null; },
    get count() { return values.length; },
    get median() {
      if (!values.length) return null;
      const s = [...values].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
    },
  };
}

const STAGES = { s0: 'intake', s1: 'budget', s2: 'confirm', s3: 'plan', s4: 'commit' };

/** Server stage name ('s1', 'budget', 's1_budget') -> the listen step used by the UI labels. */
export function stepOf(state) {
  const s = String(state || '').toLowerCase();
  if (STAGES[s]) return STAGES[s];
  const m = s.match(/^s([0-4])/);
  if (m) return STAGES[`s${m[1]}`];
  return Object.values(STAGES).includes(s) ? s : null;
}

/**
 * What the agent listens for, read back from the config AssemblyAI echoed (session.ready / session.updated),
 * not from what we meant to send.
 * @returns {{step:string|null, mode:string, keyterms:number, prompt:boolean}}
 */
export function listeningFrom(config, state = null) {
  const input = (config && (config.input || config.session?.input)) || {};
  const terms = Array.isArray(input.keyterms) ? input.keyterms.length : 0;
  return {
    step: stepOf(state),
    mode: input.transcription_mode || 'balanced',
    keyterms: terms,
    prompt: Boolean(input.transcription_prompt),
  };
}

/** Classify a failed token call or a pre-ready socket error into what the page should say. */
export function pauseReason({ status = 0, code = '' } = {}) {
  const c = String(code || '').toLowerCase();
  if (status === 429 || /rate|too_many/.test(c)) return 'busy';
  if (status === 402 || status === 503 || status === 401 || status === 403 || /paused|disabled|cap|credit|balance|no_key|unauthorized|forbidden|insufficient/.test(c)) return 'paused';
  return null;
}
