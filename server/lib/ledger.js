/**
 * The money ledger of one call. Every amount on screen is a row here, with its evidence:
 *
 *   value_krw   the number
 *   source      'owner' (the owner said it) | 'catalog' (a catalog price) | 'computed' (a total the server added up)
 *   phrase      the words the server found in the transcript ("48만 원", "four hundred eighty thousand")
 *   item_id     transcript item the phrase came from (Voice Agent item_id or a streaming turn id)
 *   via         'voice-agent' | 'realtime' | 'text'
 *   status      'heard' -> 'read_back' -> 'confirmed', or 'rejected' (range / no / mismatch)
 *   heard_at, read_back_at, confirmed_at, rejected_at   epoch ms
 *
 * The confirmed owner row is the budget. Nothing else sets it.
 */
import { spokenAmount } from './amounts.js';

const fmt = (n) => Math.round(n).toLocaleString('en-US');

/** "사십팔만 원 · ₩480,000 · confirmed" (the words follow the call language, the number does not). */
export function rowLabel(row) {
  if (row.source !== 'owner') return `${row.label || row.kind} · ₩${fmt(row.value_krw)} · ${row.source}`;
  if (row.status === 'rejected' && row.value_krw == null) {
    const opts = (row.options || []).map((o) => `₩${fmt(o)}`).join(' / ');
    return `${row.reason === 'range' ? 'range' : row.reason || 'rejected'}${opts ? ` · ${opts}` : ''} · not accepted`;
  }
  const words = row.spoken || spokenAmount(row.value_krw, row.lang);
  return `${words} · ₩${fmt(row.value_krw)} · ${row.status === 'rejected' ? 'not accepted' : row.status}`;
}

export function createLedger({ now = () => Date.now(), t0 = null, lang = 'en' } = {}) {
  const start = t0 ?? now();
  const rows = [];
  let seq = 0;

  function add(fields) {
    const row = {
      id: `r${++seq}`,
      kind: 'budget',
      source: 'owner',
      value_krw: null,
      phrase: null,
      owner_words: null,
      item_id: null,
      via: 'text',
      lang,
      status: 'heard',
      heard_at: null,
      read_back_at: null,
      confirmed_at: null,
      rejected_at: null,
      paraphrased: false,
      ...fields,
    };
    if (row.value_krw != null && !row.spoken) row.spoken = spokenAmount(row.value_krw, row.lang);
    rows.push(row);
    return row;
  }

  function get(id) {
    return rows.find((r) => r.id === id) || null;
  }

  /** The owner said an amount and it passed the grounding check. */
  function addHeard({ value_krw, phrase = null, owner_words = null, item_id = null, heard_at = now(), via = 'text', paraphrased = false, lang: l = lang, forced = false }) {
    return add({ value_krw, phrase, owner_words, item_id, heard_at, via, paraphrased, lang: l, forced, status: 'heard' });
  }

  /** The owner said something money-like that we did not accept (a range, or an amount the model got wrong). */
  function addRejected({ reason, options = null, value_krw = null, phrase = null, owner_words = null, item_id = null, heard_at = now(), via = 'text', lang: l = lang }) {
    return add({ reason, options, value_krw, phrase, owner_words, item_id, heard_at, via, lang: l, status: 'rejected', rejected_at: now() });
  }

  function markReadBack(id, at = now()) {
    const r = get(id);
    if (r && r.status === 'heard') { r.status = 'read_back'; r.read_back_at = at; }
    return r;
  }

  function confirm(id, at = now()) {
    const r = get(id);
    if (r && (r.status === 'heard' || r.status === 'read_back')) {
      if (!r.read_back_at) r.read_back_at = at;
      r.status = 'confirmed';
      r.confirmed_at = at;
    }
    return r;
  }

  /** The owner said "no" to the read-back. */
  function deny(id, at = now()) {
    const r = get(id);
    if (r && (r.status === 'heard' || r.status === 'read_back')) { r.status = 'rejected'; r.reason = 'owner_said_no'; r.rejected_at = at; }
    return r;
  }

  /** A catalog price or a computed total shown on screen. */
  function addComputed({ kind = 'plan_total', value_krw, source = 'computed', label = null, note = null }) {
    return add({ kind, value_krw, source, label, note, status: 'confirmed', via: 'server', heard_at: null, confirmed_at: now() });
  }

  /** Latest owner budget row still waiting for a yes. */
  function pending() {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.kind === 'budget' && r.source === 'owner' && (r.status === 'heard' || r.status === 'read_back')) return r;
      if (r.kind === 'budget' && r.source === 'owner' && r.status === 'confirmed') return null;
    }
    return null;
  }

  /** The budget: the most recent confirmed owner row. */
  function budget() {
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (r.kind === 'budget' && r.source === 'owner' && r.status === 'confirmed') return r;
    }
    return null;
  }

  /** Rows for the API/UI, with times relative to the start of the call (seconds, one decimal). */
  function snapshot() {
    const rel = (t) => (t == null ? null : Math.round((t - start) / 100) / 10);
    return rows.map((r) => ({ ...r, t: { heard: rel(r.heard_at), read_back: rel(r.read_back_at), confirmed: rel(r.confirmed_at), rejected: rel(r.rejected_at) }, label: rowLabel(r) }));
  }

  return { rows, add, get, addHeard, addRejected, markReadBack, confirm, deny, addComputed, pending, budget, snapshot, get t0() { return start; } };
}
