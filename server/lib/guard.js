/**
 * Public demo guard (design 6-7, 7): limits on the routes that spend AssemblyAI credit.
 *
 *   voice    token routes (a token is a call): 3 per IP per minute, 10 per IP per day,
 *            DAILY_SESSION_CAP per day for everyone together (default 25)
 *   upload   audio sent for transcription (Korean per-turn fallback, whole-call analysis)
 *   session  new consultations (memory only, no credit): a looser per-IP limit
 *
 * The limits are on in the public deployment (DEMO_MODE=1) and off on a developer's machine;
 * VOICE_GUARD=1 or 0 forces them either way. VOICE_DEMO_ENABLED=0 pauses every voice route at once
 * in any mode (typing keeps working), for when the credit runs out or a bill looks wrong.
 * Counters live in memory and reset at 00:00 UTC; a restart resets them too, so the account
 * balance stays the last line of defence.
 */
import { isDemoMode } from './demo.js';

export const PAUSED_MESSAGE = 'The voice demo is paused. The video shows a full call. You can still type to the consultant.';
export const CAP_MESSAGE = "Today's voice demo calls are used up. The video shows a full call. You can still type to the consultant.";

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_LIMITS = {
  voice: { perMinute: 3, perDay: 10, dailyCap: 25 },
  upload: { perMinute: 20, perDay: 150, dailyCap: 600 },
  session: { perMinute: 20, perDay: 300, dailyCap: Infinity },
};

function forced(v) {
  const s = String(v ?? '').trim();
  return s === '1' ? true : s === '0' ? false : null;
}

function intOr(v, fallback) {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Guard options from the environment. */
export function guardOptionsFromEnv(env = process.env) {
  return {
    limitsOn: forced(env.VOICE_GUARD) ?? isDemoMode(env),
    voiceEnabled: String(env.VOICE_DEMO_ENABLED ?? '1').trim() !== '0',
    limits: { ...DEFAULT_LIMITS, voice: { ...DEFAULT_LIMITS.voice, dailyCap: intOr(env.DAILY_SESSION_CAP, DEFAULT_LIMITS.voice.dailyCap) } },
    trustProxyHops: intOr(env.TRUST_PROXY_HOPS, 0),
  };
}

function stripV4Mapped(ip) {
  return String(ip || '').trim().replace(/^::ffff:/i, '') || 'unknown';
}

/**
 * The caller's address. Behind a proxy (TRUST_PROXY_HOPS=n) it is the n-th X-Forwarded-For entry from
 * the right, the one the outermost trusted proxy appended; entries further left are client-supplied.
 */
export function clientIp(req, { trustProxyHops = 0 } = {}) {
  const direct = stripV4Mapped(req.socket?.remoteAddress);
  if (!trustProxyHops) return direct;
  const chain = String(req.headers?.['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!chain.length) return direct;
  return stripV4Mapped(chain[Math.max(0, chain.length - trustProxyHops)]);
}

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function createBucket({ perMinute, perDay, dailyCap }, now) {
  let day = utcDay(now());
  let total = 0;
  const ips = new Map(); // ip -> { recent: [ms], today: n }

  function roll() {
    const d = utcDay(now());
    if (d !== day) { day = d; total = 0; ips.clear(); }
  }

  function take(ip) {
    roll();
    const t = now();
    const e = ips.get(ip) || { recent: [], today: 0 };
    e.recent = e.recent.filter((x) => t - x < 60_000);
    const resetsAt = Date.parse(`${day}T00:00:00Z`) + DAY_MS;
    if (total >= dailyCap) return { ok: false, scope: 'daily_cap', retryAfter: Math.ceil((resetsAt - t) / 1000), resetsAt };
    if (e.today >= perDay) return { ok: false, scope: 'ip_day', retryAfter: Math.ceil((resetsAt - t) / 1000), resetsAt };
    if (e.recent.length >= perMinute) return { ok: false, scope: 'ip_minute', retryAfter: Math.max(1, Math.ceil((60_000 - (t - e.recent[0])) / 1000)), resetsAt };
    e.recent.push(t);
    e.today += 1;
    total += 1;
    ips.set(ip, e);
    return { ok: true, day, at: t };
  }

  /** Give a use back (the upstream call failed, so nothing was spent). */
  function refund(ip, ticket) {
    roll();
    if (!ticket || ticket.day !== day) return;
    const e = ips.get(ip);
    if (!e) return;
    const i = e.recent.lastIndexOf(ticket.at);
    if (i >= 0) e.recent.splice(i, 1);
    e.today = Math.max(0, e.today - 1);
    total = Math.max(0, total - 1);
  }

  function status() {
    roll();
    return { used_today: total, left_today: Number.isFinite(dailyCap) ? Math.max(0, dailyCap - total) : null, resets_at: new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString() };
  }

  return { take, refund, status };
}

/**
 * @param {{limitsOn?:boolean, voiceEnabled?:boolean, limits?:object, now?:()=>number}} opts
 */
export function createGuard({ limitsOn = true, voiceEnabled = true, limits = DEFAULT_LIMITS, now = () => Date.now() } = {}) {
  const cfg = { ...DEFAULT_LIMITS, ...limits };
  const buckets = Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, createBucket(v, now)]));

  /**
   * @param {string} ip
   * @param {'voice'|'upload'|'session'} kind
   * @returns {{ok:true, ticket:object} | {ok:false, status:number, retryAfter?:number, body:object}}
   */
  function take(ip, kind) {
    if (kind !== 'session' && !voiceEnabled) {
      return { ok: false, status: 503, body: { error: 'voice_paused', paused: true, message: PAUSED_MESSAGE } };
    }
    if (!limitsOn || !buckets[kind]) return { ok: true, ticket: null };
    const r = buckets[kind].take(ip);
    if (r.ok) return { ok: true, ticket: { ip, kind, day: r.day, at: r.at } };
    if (r.scope === 'daily_cap') {
      return { ok: false, status: 503, retryAfter: r.retryAfter, body: { error: 'daily_cap', paused: kind === 'voice', message: kind === 'voice' ? CAP_MESSAGE : 'Daily limit reached. Try again tomorrow.', resets_at: new Date(r.resetsAt).toISOString() } };
    }
    return { ok: false, status: 429, retryAfter: r.retryAfter, body: { error: 'rate_limited', scope: r.scope, retry_after_seconds: r.retryAfter, message: r.scope === 'ip_day' ? 'Daily limit for your connection reached. Try again tomorrow.' : `Too many requests. Try again in ${r.retryAfter} s.` } };
  }

  function refund(ticket) {
    if (ticket) buckets[ticket.kind]?.refund(ticket.ip, ticket);
  }

  /** What /api/health tells the web app (so it can show the paused note before anyone presses Start). */
  function status() {
    const v = buckets.voice.status();
    return {
      enabled: voiceEnabled && (!limitsOn || v.left_today > 0),
      paused: !voiceEnabled,
      message: !voiceEnabled ? PAUSED_MESSAGE : limitsOn && v.left_today === 0 ? CAP_MESSAGE : null,
      limits: limitsOn ? { per_ip_minute: cfg.voice.perMinute, per_ip_day: cfg.voice.perDay, daily_cap: cfg.voice.dailyCap } : null,
      used_today: limitsOn ? v.used_today : null,
      left_today: limitsOn ? v.left_today : null,
      resets_at: limitsOn ? v.resets_at : null,
    };
  }

  return { take, refund, status, get voiceEnabled() { return voiceEnabled; } };
}
