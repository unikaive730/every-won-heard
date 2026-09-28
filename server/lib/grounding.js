/**
 * Grounding check for budgets (design 6-5). The server listens separately and decides.
 *
 * 1. Candidates: the owner's final turns since the previous budget decision, at most the last 2, within 20 s.
 * 2. parseAmounts() over those turns (joined, so a number split by a pause still reads as one).
 * 3. No amount            -> { error: 'no_amount_heard' } (the turns are not consumed)
 * 4. Correction marker    -> only the last amount counts. Two amounts or a range without one -> 'ambiguous_amount'.
 * 5. The model passed a different amount than the server heard -> 'amount_mismatch' with heard_krw.
 * 6. Pass                 -> the caller writes a ledger row 'heard' with phrase, item_id, time, via, paraphrased.
 * 7. A mismatch is rejected once per heard amount; the second time the server's value is used (no re-ask loop).
 * 8. Errors go back to Voice Agent as tool.result with is_error: true (the route does that).
 *
 * The Korean path has no model argument: amount_krw is null and the server's reading is the answer.
 */
import { pickAmount, readBack } from './amounts.js';

const ASK = {
  no_amount_heard: 'Ask for the monthly budget as a number.',
  ambiguous_amount: 'Ask which one to plan for.',
  amount_mismatch: 'Read back heard_krw and ask the owner to confirm.',
};

/**
 * A number cut in two by a pause and transcribed in digits: "400... 80,000 won", often as two turns ("400." then
 * "80,000 won."). The words form ("Four hundred... eighty thousand") already parses as one number; the digit form
 * reads as 80,000. When a bare hundreds number (100..900) sits right before a thousands amount under 100,000 with
 * only pause punctuation between them, the owner may have meant either, so the caller asks: [80,000, 480,000].
 */
function splitByPause(joined, pick) {
  const { item, value, items } = pick;
  if (value >= 100_000 || value % 1000 !== 0) return null;
  const k = items.indexOf(item);
  const prev = k > 0 ? items[k - 1] : null;
  if (!prev || prev.money || prev.value == null || prev.value % 100 !== 0 || prev.value < 100 || prev.value > 900) return null;
  if (!/^[\s.,…]*$/.test(joined.slice(prev.end, item.index))) return null;
  return prev.value * 1000 + value;
}

function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function createGrounding({ now = () => Date.now(), windowMs = 20_000, maxTurns = 2 } = {}) {
  const heard = []; // {item_id, text, at, via}
  // turns before lastDecisionIdx were already judged (by order, not time: two turns can share a millisecond)
  const state = { lastDecisionIdx: 0, rejections: new Set(), decisions: 0 };

  /** A final owner transcript (Voice Agent transcript.user, or a streaming end-of-turn). */
  function addHeard({ item_id = null, text, at = now(), via = 'text' }) {
    const t = String(text || '').trim();
    if (!t) return null;
    const turn = { item_id: item_id || `turn_${heard.length + 1}`, text: t, at, via };
    heard.push(turn);
    return turn;
  }

  function candidates(at = now()) {
    return heard.slice(state.lastDecisionIdx).filter((h) => at - h.at <= windowMs).slice(-maxTurns);
  }

  /**
   * @param {{amount_krw?:number|null, owner_words?:string, lang?:'en'|'ko', at?:number}} input
   */
  function judge({ amount_krw = null, owner_words = '', lang = 'en', at = now() } = {}) {
    const turns = candidates(at);
    const idxBefore = state.lastDecisionIdx;
    state.lastDecisionIdx = heard.length;
    state.decisions += 1;
    // join the turns and remember where each one starts, to find the phrase's turn afterwards
    let joined = '';
    const spans = [];
    for (const t of turns) {
      if (joined) joined += ' ';
      spans.push({ turn: t, start: joined.length, end: joined.length + t.text.length });
      joined += t.text;
    }
    const pick = pickAmount(joined);
    const base = { turns: turns.map((t) => ({ item_id: t.item_id, text: t.text })) };

    if (pick.status === 'none') {
      // nothing money-like was decided, so these turns stay candidates: "Four hundred..." heard before the
      // model's early call still joins "eighty thousand" on the next one
      state.lastDecisionIdx = idxBefore;
      return { ok: false, error: 'no_amount_heard', ask: ASK.no_amount_heard, ...base };
    }
    if (pick.status === 'ambiguous') {
      const span = pick.item ? spans.find((s) => pick.item.index >= s.start && pick.item.index < s.end) : spans[spans.length - 1];
      return { ok: false, error: 'ambiguous_amount', options: pick.options, ask: ASK.ambiguous_amount, phrase: pick.item?.text || null, item_id: span?.turn.item_id || null, heard_at: span?.turn.at || null, ...base };
    }

    const value = pick.value;
    const span = spans.find((s) => pick.item.index >= s.start && pick.item.index < s.end) || spans[spans.length - 1];
    const found = { phrase: pick.item.text, item_id: span.turn.item_id, heard_at: span.turn.at, via: span.turn.via };
    const split = splitByPause(joined, pick);
    if (split) return { ok: false, error: 'ambiguous_amount', options: [value, split], ask: ASK.ambiguous_amount, ...found, ...base };
    let forced = false;
    if (amount_krw != null && Number(amount_krw) !== value) {
      const key = `mismatch:${value}`;
      if (!state.rejections.has(key)) {
        state.rejections.add(key);
        return { ok: false, error: 'amount_mismatch', heard_krw: value, model_krw: Number(amount_krw), ask: ASK.amount_mismatch, ...found, ...base };
      }
      forced = true; // second time: the server's reading wins, the agent reads it back
    }
    const paraphrased = Boolean(owner_words) && !norm(joined).includes(norm(owner_words));
    return { ok: true, amount_krw: value, read_back: readBack(value, lang), paraphrased, forced, ...found, ...base };
  }

  /** A turn by item_id (Voice Agent item ids are unique per utterance). */
  function find(itemId) {
    return itemId ? heard.find((h) => h.item_id === itemId) || null : null;
  }

  return { heard, state, addHeard, candidates, judge, find };
}
