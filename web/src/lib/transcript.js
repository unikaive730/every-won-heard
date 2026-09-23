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

/**
 * AssemblyAI Universal-Streaming (v3) covers 18+ languages but not Korean yet
 * (AssemblyAI lists Korean streaming as "coming soon", 2026-09).
 * Korean therefore runs in "turn" mode: the browser records one utterance (VAD),
 * the server transcribes it with the pre-recorded API where Universal-2 supports `ko`.
 */
export function sttModeFor(lang) {
  return lang === 'ko' ? 'turn' : 'stream';
}

/**
 * Build the WebSocket URL. Only a short-lived token ever reaches the browser.
 * @param {{token:string, lang?:string, sampleRate?:number, prompt?:string}} opts
 */
export function buildStreamingUrl({ token, lang = 'en', sampleRate = 16000, prompt } = {}) {
  if (!token) throw new Error('token is required');
  const p = new URLSearchParams();
  p.set('sample_rate', String(sampleRate));
  p.set('encoding', 'pcm_s16le');
  p.set('speech_model', 'universal-3-5-pro');
  p.set('format_turns', 'true'); // get a punctuated, formatted final for each turn
  p.set('language_detection', 'true'); // Turn messages carry language_code / language_confidence
  p.set('end_of_turn_confidence_threshold', '0.5');
  if (prompt) p.set('prompt', prompt.slice(0, 1700));
  p.set('token', token);
  void lang; // universal-3-5-pro is multilingual by default; no steering needed for the demo
  return `${STREAMING_WS}?${p.toString()}`;
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
