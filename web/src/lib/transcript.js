/**
 * Pure helpers shared by the browser client and the server tests (no DOM, no Node APIs).
 *
 * - sttModeFor(lang)          : "stream" (AssemblyAI Universal-Streaming) or "turn" (per-utterance pre-recorded API)
 * - buildStreamingUrl(...)    : wss URL for AssemblyAI Universal-Streaming v3 with a temporary token
 * - createTranscriptState()   : empty reducer state
 * - reduceTurn(state, msg)    : folds a server "Turn" message into transcript state, returns {state, event}
 * - flushPending(state)       : finalizes a pending unformatted turn (e.g. when the socket closes)
 * - detectLanguage(text)      : cheap Hangul-ratio language guess
 */

export const STREAMING_WS = 'wss://streaming.assemblyai.com/v3/ws';
export const STREAMING_MODEL = { ko: 'universal-3-6-pro', en: 'universal-3-5-pro' };

/**
 * Both languages stream now. Korean runs on Universal-3.6 Pro streaming (Korean `ko` is in its
 * language table; measured 2026-09-28). English keeps Universal-3.5 Pro on this path.
 */
export function sttModeFor(lang) {
  void lang;
  return 'stream';
}

/** Limits for agent_context / keyterms_prompt (an invalid value closes a 3.6 Pro session with error 3006). */
export const STREAM_LIMITS = { agentContext: 1750, keyterms: 100, keytermChars: 50, modes: ['min_latency', 'balanced', 'max_accuracy'] };

function cleanKeyterms(list) {
  return (Array.isArray(list) ? list : [])
    .map((t) => String(t || '').trim())
    .filter((t) => t && t.length <= STREAM_LIMITS.keytermChars)
    .slice(0, STREAM_LIMITS.keyterms);
}

function cleanContext(s) {
  const t = String(s || '').trim();
  return t.length > STREAM_LIMITS.agentContext ? t.slice(-STREAM_LIMITS.agentContext) : t;
}

/**
 * Build the WebSocket URL. Only a short-lived token ever reaches the browser.
 *
 * Korean (3.6 Pro): no format_turns and no end_of_turn_confidence_threshold (retired on 3.6 Pro; every Turn
 * is already formatted). language_codes goes as a JSON list: measured 2026-09-28, `["ko","en"]` and a
 * repeated parameter work, a comma list ("ko,en") is rejected with error 3006.
 *
 * @param {{token:string, lang?:string, sampleRate?:number, prompt?:string, agentContext?:string, keyterms?:string[], mode?:string, languageCodes?:string[]}} opts
 */
export function buildStreamingUrl({ token, lang = 'en', sampleRate = 16000, prompt, agentContext, keyterms, mode, languageCodes } = {}) {
  if (!token) throw new Error('token is required');
  const p = new URLSearchParams();
  p.set('sample_rate', String(sampleRate));
  p.set('encoding', 'pcm_s16le');
  if (lang === 'ko') {
    p.set('speech_model', STREAMING_MODEL.ko);
    p.set('language_detection', 'true');
    if (Array.isArray(languageCodes) && languageCodes.length) p.set('language_codes', JSON.stringify(languageCodes));
    const ctx = cleanContext(agentContext);
    if (ctx) p.set('agent_context', ctx); // the greeting, so the first answer is heard in context
    const terms = cleanKeyterms(keyterms);
    if (terms.length) p.set('keyterms_prompt', JSON.stringify(terms));
    if (STREAM_LIMITS.modes.includes(mode)) p.set('mode', mode);
  } else {
    p.set('speech_model', STREAMING_MODEL.en);
    p.set('format_turns', 'true'); // get a punctuated, formatted final for each turn
    p.set('language_detection', 'true'); // Turn messages carry language_code / language_confidence
    p.set('end_of_turn_confidence_threshold', '0.5');
    if (prompt) p.set('prompt', prompt.slice(0, 1700));
  }
  p.set('token', token);
  return `${STREAMING_WS}?${p.toString()}`;
}

/**
 * One UpdateConfiguration message for 3.6 Pro, sent right before the agent reads its next line:
 * the line itself as agent_context, this step's key terms, and the accuracy mode. Returns null if empty.
 * @param {{agent_context?:string, keyterms_prompt?:string[], mode?:string, language_codes?:string[]}} listen
 */
export function updateConfigMessage(listen = {}) {
  const msg = { type: 'UpdateConfiguration' };
  const ctx = cleanContext(listen.agent_context);
  if (ctx) msg.agent_context = ctx;
  if (Array.isArray(listen.keyterms_prompt)) msg.keyterms_prompt = cleanKeyterms(listen.keyterms_prompt);
  if (STREAM_LIMITS.modes.includes(listen.mode)) msg.mode = listen.mode;
  if (Array.isArray(listen.language_codes)) msg.language_codes = listen.language_codes.filter((c) => /^[a-z]{2,3}$/.test(c));
  return Object.keys(msg).length > 1 ? msg : null;
}

export function createTranscriptState() {
  return {
    turns: [], // finalized turns: {order, text, languageCode, at}
    partial: '', // text of the turn in progress
    partialOrder: null,
    pending: null, // end_of_turn=true but not yet formatted (format_turns=true sends a 2nd formatted message)
  };
}

/**
 * Reduce one server message. Returns { state, event } where event is
 * null | {type:'partial', text, order} | {type:'final', text, order, languageCode}
 *
 * With format_turns=true AssemblyAI emits, per turn:
 *   ... partials (end_of_turn=false) ... -> {end_of_turn:true, turn_is_formatted:false} -> {end_of_turn:true, turn_is_formatted:true}
 * We surface the formatted final only, and never the same turn_order twice.
 */
export function reduceTurn(state, msg, { formatTurns = true, now = () => Date.now() } = {}) {
  if (!msg || msg.type !== 'Turn') return { state, event: null };
  const text = String(msg.transcript || '').trim();
  const order = typeof msg.turn_order === 'number' ? msg.turn_order : state.turns.length;
  const alreadyFinal = state.turns.some((t) => t.order === order);
  if (alreadyFinal) return { state, event: null };

  const finalize = () => {
    if (!text) return { state: { ...state, partial: '', partialOrder: null, pending: null }, event: null };
    const turn = { order, text, languageCode: msg.language_code || null, at: now() };
    return {
      state: { ...state, turns: [...state.turns, turn], partial: '', partialOrder: null, pending: null },
      event: { type: 'final', text, order, languageCode: turn.languageCode },
    };
  };

  if (msg.end_of_turn) {
    if (formatTurns && !msg.turn_is_formatted) {
      // keep showing it as a partial until the formatted copy arrives
      return {
        state: { ...state, partial: text, partialOrder: order, pending: { order, text } },
        event: text ? { type: 'partial', text, order } : null,
      };
    }
    return finalize();
  }
  if (!text) return { state, event: null };
  return { state: { ...state, partial: text, partialOrder: order }, event: { type: 'partial', text, order } };
}

/** Finalize a pending (unformatted) turn, e.g. on socket close. */
export function flushPending(state, { now = () => Date.now() } = {}) {
  if (!state.pending) return { state, event: null };
  const { order, text } = state.pending;
  if (state.turns.some((t) => t.order === order)) return { state: { ...state, pending: null, partial: '' }, event: null };
  const turn = { order, text, languageCode: null, at: now() };
  return {
    state: { ...state, turns: [...state.turns, turn], partial: '', partialOrder: null, pending: null },
    event: { type: 'final', text, order, languageCode: null },
  };
}

export function fullText(state) {
  return state.turns.map((t) => t.text).join(' ');
}

/** Hangul ratio based guess: 'ko' | 'en'. */
export function detectLanguage(text) {
  const s = String(text || '');
  const hangul = (s.match(/[가-힣]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (hangul === 0 && latin === 0) return 'en';
  return hangul >= latin ? 'ko' : 'en';
}
