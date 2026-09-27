/**
 * Post-call summary through AssemblyAI LLM Gateway (same AssemblyAI key, no second provider key on the server).
 *
 * The model never writes a number. It gets the call's facts with every amount replaced by a placeholder and must
 * answer with placeholders only: {budget} (the owner's confirmed budget), {plan_total}, {line_count}. The server
 * fills them from the ledger. If the reply has a digit, a money phrase, an unknown placeholder or a brand name,
 * it is thrown away and a template summary is used instead (source: 'template', with the reason).
 *
 * Model: qwen3.5-4b-32k-fast (the one Gateway model this account can use, measured 2026-09-28). Its model table
 * lists max_tokens / temperature / stream only (no response_format), so JSON is asked for in the prompt and parsed
 * leniently.
 *
 * Off by default (CALL_SUMMARY=1 turns it on). Measured 2026-09-28 on two live Korean calls: neither reply was
 * JSON, one invented a placeholder ({owner}), one wrote "{budget} 원" (double unit) and added a claim the owner
 * never made. The guard rejected both and the template was used, so the template is the default and the model
 * stays opt-in until a better Gateway model is available on this account. Notes: docs/hackathon/22_korean.md.
 */
import { parseAmounts, koreanShort } from './amounts.js';

export const GATEWAY_URL = 'https://llm-gateway.assemblyai.com/v1/chat/completions';
export const DEFAULT_SUMMARY_MODEL = 'qwen3.5-4b-32k-fast';
const PLACEHOLDERS = ['{budget}', '{plan_total}', '{line_count}'];
const BRANDS = /네이버|인스타|카카오|배민|배달의민족|쿠팡|요기요|구글|유튜브|틱톡|naver|instagram|kakao|google|youtube|tiktok|baemin|coupang|yogiyo/i;

// generic names for problems and tried channels (the planner's labels still carry platform names)
const PROBLEM_WORDS = {
  new_open: ['신규 오픈', 'just opened'], low_traffic: ['손님 부족', 'not enough customers'], reviews: ['후기 부족', 'few reviews'],
  place_rank: ['지도 검색 노출', 'map listing visibility'], instagram: ['사진 SNS 성장', 'photo social account growth'], competition: ['경쟁', 'competition'],
  delivery: ['배달 주문', 'delivery orders'], repeat: ['재방문', 'repeat customers'], press: ['신뢰도', 'credibility'], app_growth: ['앱 가입', 'app sign-ups'], foreign: ['외국인 손님', 'foreign customers'],
};
const TRIED_WORDS = { blog: ['블로그 후기', 'blog posts'], instagram: ['사진 SNS', 'photo social account'], paid_ads: ['유료 광고', 'paid ads'], flyers: ['전단지', 'flyers'], naver_place: ['지도 매장정보', 'map listing'], delivery_apps: ['배달 앱', 'delivery apps'] };
const BIZ_WORDS = { cafe: ['카페', 'cafe'], restaurant: ['음식점', 'restaurant'], salon: ['미용실', 'salon'], clinic: ['병원', 'clinic'], fitness: ['운동 시설', 'gym'], ecommerce: ['온라인 쇼핑몰', 'online store'], app: ['앱 서비스', 'app'], academy: ['학원', 'academy'], franchise: ['프랜차이즈', 'franchise'], lodging: ['숙박업', 'lodging'], retail: ['매장', 'shop'] };

const pick = (map, key, lang) => (map[key] ? map[key][lang === 'ko' ? 0 : 1] : key);

/** Replace amounts and brand names in an owner quote before it reaches the model. */
export function maskQuote(text) {
  let s = String(text || '');
  const items = parseAmounts(s).items.filter((i) => i.money).sort((a, b) => b.index - a.index);
  for (const it of items) s = `${s.slice(0, it.index)}[amount]${s.slice(it.end)}`;
  return s.replace(/\d+(?:[.,]\d+)*/g, '[n]').replace(new RegExp(BRANDS.source, 'gi'), '[platform]').replace(/\[amount\]\s*(원|won)/gi, '[amount]');
}

/** Everything the summary may say, from the session. Numbers stay on the server side. */
export function summaryFacts(session) {
  const lang = session.lang === 'ko' ? 'ko' : 'en';
  const p = session.profile || {};
  const budgetRow = session.ledger?.budget() || null;
  const totals = (session.ledger?.rows || []).filter((r) => r.kind === 'plan_total');
  const total = totals.length ? totals[totals.length - 1].value_krw : session.plan?.total_cost ?? null;
  const lines = session.plan ? session.plan.channels.reduce((n, c) => n + c.items.length, 0) : null;
  const quotes = (session.history || []).filter((h) => h.role === 'user').slice(-6).map((h) => maskQuote(h.text));
  return {
    lang,
    business: p.business_type ? pick(BIZ_WORDS, p.business_type, lang) : null,
    location: p.location || null,
    problems: (p.problems || []).map((k) => pick(PROBLEM_WORDS, k, lang)),
    tried: (p.channels_tried || []).map((k) => pick(TRIED_WORDS, k, lang)),
    values: { budget: budgetRow ? budgetRow.value_krw : null, plan_total: total, line_count: lines },
    quotes,
  };
}

function money(v, lang) {
  return lang === 'ko' ? `월 ${koreanShort(v)}` : `₩${Math.round(v).toLocaleString('en-US')} a month`;
}

/** Fill placeholders from the ledger values. Returns null if a needed value is missing. */
export function fillPlaceholders(text, values, lang) {
  let missing = false;
  const out = String(text).replace(/\{(budget|plan_total|line_count)\}/g, (_, k) => {
    const v = values[k];
    if (v == null) { missing = true; return ''; }
    if (k === 'line_count') return String(v);
    if (k === 'budget') return money(v, lang);
    return lang === 'ko' ? koreanShort(v) : `₩${Math.round(v).toLocaleString('en-US')}`;
  });
  return missing ? null : out;
}

/** Why a model reply cannot be used, or null if it is clean. */
export function rejectReason(text) {
  const s = String(text || '').trim();
  if (!s) return 'empty';
  if (s.length > 700) return 'too_long';
  const bare = s.replace(/\{(budget|plan_total|line_count)\}/g, '');
  if (/\{[^}]*\}/.test(bare)) return 'unknown_placeholder';
  if (/\d/.test(bare)) return 'digit';
  if (parseAmounts(bare).items.some((i) => i.money) || /\b(hundred|thousand|million|man won)\b/i.test(bare) || /[일이삼사오육칠팔구십백천]+\s?(만|억)\s?원?/.test(bare)) return 'number_word';
  if (BRANDS.test(bare)) return 'brand_name';
  return null;
}

/** Deterministic summary with the same placeholders (used when the model is off or its reply is rejected). */
export function templateSummary(facts) {
  const ko = facts.lang === 'ko';
  const who = [facts.location, facts.business].filter(Boolean).join(' ') || (ko ? '매장' : 'shop');
  const probs = facts.problems.join(ko ? '·' : ' and ') || (ko ? '고민 미확인' : 'no problem stated');
  const tried = facts.tried.length ? (ko ? ` 해 본 것: ${facts.tried.join('·')}.` : ` Tried before: ${facts.tried.join(', ')}.`) : '';
  const budget = facts.values.budget != null ? (ko ? ' 사장님이 확인한 예산은 {budget}' : ' Confirmed budget {budget}') : (ko ? ' 예산은 확인 전' : ' Budget not confirmed');
  const plan = facts.values.plan_total != null ? (ko ? `, 계획은 서비스 {line_count}개 합계 {plan_total}입니다.` : `; plan total {plan_total} across {line_count} services.`) : '.';
  const summary = ko ? `${who} 사장님, ${probs} 고민.${tried}${budget}${plan}` : `Owner of a ${who}; main problem: ${probs}.${tried}${budget}${plan}`;
  const next = facts.values.plan_total != null ? (ko ? '계획서를 보내고 결제 링크로 시작을 안내합니다.' : 'Send the plan and the checkout link to start.') : (ko ? '예산을 확인하는 후속 연락이 필요합니다.' : 'Follow up to confirm the budget.');
  return { summary, next_step: next };
}

/** Template summary for a session, filled from the ledger (no model call). */
export function templateCallSummary(session, reason = 'no_key') {
  const facts = summaryFacts(session);
  const t = templateSummary(facts);
  return { text: fillPlaceholders(t.summary, facts.values, facts.lang), next_step: fillPlaceholders(t.next_step, facts.values, facts.lang), source: 'template', model: null, reason };
}

export function buildSummaryMessages(facts) {
  const ko = facts.lang === 'ko';
  const system = [
    `You write a short call summary for a marketing agency's CRM, in ${ko ? 'Korean (polite, plain sentences)' : 'English'}.`,
    'Reply with JSON only, no other text: {"summary": "<two sentences>", "next_step": "<one sentence>"}.',
    'Never write a digit or a number in words. Where an amount belongs, write exactly one of these placeholders:',
    '{budget} = the monthly budget the owner confirmed, {plan_total} = the plan total, {line_count} = how many services are in the plan.',
    'Use only the facts given. Do not name any app, platform or company. Do not invent results or promises.',
  ].join('\n');
  const f = [
    `Business: ${facts.business || 'unknown'}${facts.location ? ` in ${facts.location}` : ''}`,
    `Problems: ${facts.problems.join(', ') || 'unknown'}`,
    `Tried before: ${facts.tried.join(', ') || 'nothing mentioned'}`,
    `Budget: ${facts.values.budget != null ? '{budget} (the owner confirmed it)' : 'not confirmed yet'}`,
    `Plan: ${facts.values.plan_total != null ? '{line_count} services, total {plan_total}' : 'not built yet'}`,
    'Owner said (amounts masked):',
    ...facts.quotes.map((q) => `- "${q}"`),
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: `${f}\n\n/no_think` }];
}

/** Pull {summary, next_step} out of a model reply (think blocks, code fences and stray text tolerated). */
export function parseSummaryReply(text) {
  const s = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (typeof j.summary !== 'string') return null;
    return { summary: j.summary.trim(), next_step: typeof j.next_step === 'string' ? j.next_step.trim() : '' };
  } catch {
    return null;
  }
}

/**
 * @returns {null | {model, summarizeCall(session), chat(body), state}} null when there is no key.
 */
export function createGateway({ apiKey = process.env.ASSEMBLYAI_API_KEY || '', model = process.env.LLM_GATEWAY_MODEL || DEFAULT_SUMMARY_MODEL, enabled = process.env.CALL_SUMMARY === '1', fetchImpl = globalThis.fetch, timeoutMs = 20_000, logger = console } = {}) {
  if (!apiKey || !apiKey.trim()) return null;
  const state = { calls: 0, failures: 0, rejected: 0, disabled: !enabled, lastError: null };

  async function chat(body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      state.calls += 1;
      const res = await fetchImpl(GATEWAY_URL, { method: 'POST', headers: { Authorization: apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, ...body }), signal: ctrl.signal });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`LLM Gateway ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
        err.status = res.status;
        // no retries on auth or rate errors: turn the model off for this process
        if ([401, 403, 429].includes(res.status)) state.disabled = true;
        throw err;
      }
      return { text: j.choices?.[0]?.message?.content || '', usage: j.usage || null, request_id: j.request_id || j.id || null };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Summary for the receipt. Always returns something: the model's text if it passes, else the template. */
  async function summarizeCall(session) {
    const facts = summaryFacts(session);
    const fromTemplate = (reason) => {
      const t = templateSummary(facts);
      return { text: fillPlaceholders(t.summary, facts.values, facts.lang), next_step: fillPlaceholders(t.next_step, facts.values, facts.lang), source: 'template', model: null, reason };
    };
    if (state.disabled) return fromTemplate('model_off');
    const started = Date.now();
    try {
      const r = await chat({ messages: buildSummaryMessages(facts), max_tokens: 400, temperature: 0.2 });
      const parsed = parseSummaryReply(r.text);
      if (!parsed) { state.rejected += 1; return { ...fromTemplate('unparsable'), raw: r.text.slice(0, 400) }; }
      const reason = rejectReason(parsed.summary) || (parsed.next_step ? rejectReason(parsed.next_step) : null);
      if (reason) { state.rejected += 1; return { ...fromTemplate(reason), raw: `${parsed.summary} | ${parsed.next_step}`.slice(0, 400) }; }
      const text = fillPlaceholders(parsed.summary, facts.values, facts.lang);
      const next = parsed.next_step ? fillPlaceholders(parsed.next_step, facts.values, facts.lang) : '';
      if (text == null || next == null) { state.rejected += 1; return fromTemplate('placeholder_without_value'); }
      return { text, next_step: next, source: 'llm-gateway', model, request_id: r.request_id, usage: r.usage, latency_ms: Date.now() - started, template: parsed.summary };
    } catch (err) {
      state.failures += 1;
      state.lastError = String(err?.message || err);
      logger?.warn?.(`[gateway] ${state.lastError}`);
      return fromTemplate(err?.status ? `http_${err.status}` : 'error');
    }
  }

  return { model, chat, summarizeCall, get state() { return { ...state }; } };
}
