// Probe harness for the web client (web갈래): a small HTTP server that serves dist/ and answers the design's
// section 6-8 contract, so the browser client can be tried end to end before the real routes land.
// It is NOT the product server (server/index.js is): the stages, tools and prompts here follow design 6-3/6-4
// with the 9/28 finding (no number arguments; the model passes the owner's words, we read the amount).
// Reuses server/lib (grounding, ledger, amounts, brief, assemblyai) read-only.
//
//   node scripts/probe/web-contract-stub.mjs [--port 8799] [--live]
//     --live   GET /api/voice-agent/token mints a real Voice Agent token (max 240 s per session, at most
//              STUB_MAX_TOKENS per process, default 3). Without it the token is "fake" (for the fake socket).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGrounding } from '../../server/lib/grounding.js';
import { createLedger } from '../../server/lib/ledger.js';
import { englishWords } from '../../server/lib/amounts.js';
import { reconcile, reconcileTurns } from '../../server/lib/brief.js';
import { createAssemblyAI } from '../../server/lib/assemblyai.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

/** The key from the environment or .env (never printed). */
function readKey() {
  if (process.env.ASSEMBLYAI_API_KEY) return process.env.ASSEMBLYAI_API_KEY.trim();
  try {
    const m = readFileSync(path.join(root, '.env'), 'utf8').match(/^ASSEMBLYAI_API_KEY=(.+)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}

const COMMON = [
  'You are a marketing consultant from MarketPilot on a voice call with a small shop owner in Korea.',
  'Keep every reply to one or two short sentences. Ask one question at a time.',
  'Never name apps or platforms. Say "map listing", "photo social account", "messenger channel".',
  'NEVER say a price, total, quantity or budget unless that exact value came from a tool result in this call. If you have not seen a tool result, you do not have the number. Do not estimate. Do not say "around" a number. When in doubt, call the tool. A wasted call is fine. A wrong number is not.',
  "You can't give discounts. If asked, say you can only use catalog prices and can fit the plan to a smaller budget.",
  'When the owner says goodbye or thanks you at the end, call end_call.',
].join('\n');

const STAGE_PROMPT = {
  s0: 'Find out what kind of shop they run, the neighborhood, and the main problem. As soon as you know those, call record_shop.',
  s1: [
    'Ask for the monthly marketing budget in won. Whenever the owner says any amount, even a range, call record_budget with the owner\'s words. The tool decides whether the amount is usable.',
    'Owner: "Maybe four or five hundred thousand."',
    'You: [call record_budget] (result: ambiguous_amount, options 400000 and 500000)',
    'You: "Which one should I plan for, four hundred thousand or five hundred thousand?"',
    'Owner: "Four hundred eighty thousand."',
    'You: [call record_budget]',
  ].join('\n'),
  s2: 'When record_budget returns ok, read back read_back word for word and ask if it is right. When the owner answers yes or no, call confirm_budget. If they say a different amount, call record_budget with their words.',
  s3: 'The budget is confirmed. Call build_plan now. Then read the plan from the tool result only: each line in a few words, then the total, then ask if they want the checkout link.',
  s4: 'You read the plan. If the owner wants to go ahead, call create_checkout_link and say the link is on their screen. If they change the budget, call record_budget with their words.',
};

const T = {
  record_shop: { type: 'function', name: 'record_shop', description: 'Call this once the owner has said what kind of shop they run and where. Pick the closest business_type and main_problem.', parameters: { type: 'object', properties: { business_type: { type: 'string', enum: ['cafe', 'restaurant', 'salon', 'clinic', 'fitness', 'academy', 'retail', 'lodging'] }, neighborhood: { type: 'string', description: 'Seoul neighborhood, romanized.', examples: ['Mangwon', 'Seongsu', 'Yeonnam'] }, main_problem: { type: 'string', enum: ['new_open', 'low_traffic', 'reviews', 'map_visibility', 'social_growth', 'repeat', 'press'] } }, required: ['business_type', 'neighborhood', 'main_problem'] } },
  record_budget: { type: 'function', name: 'record_budget', description: 'Call this right after the owner says any monthly marketing budget, including a corrected one or a range. Pass the owner\'s words. Do not call it for prices or totals.', parameters: { type: 'object', properties: { owner_words: { type: 'string', description: "The owner's words for the amount, as heard.", examples: ['four hundred eighty thousand won', 'fifty man won', 'make that three hundred eighty thousand'] }, period: { type: 'string', enum: ['monthly', 'one_time'] } }, required: ['owner_words'] } },
  confirm_budget: { type: 'function', name: 'confirm_budget', description: 'Call this after you read the budget back and the owner answers yes or no.', parameters: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'] } },
  build_plan: { type: 'function', name: 'build_plan', description: 'Build the 30-day plan from the confirmed budget and the real catalog.', parameters: { type: 'object', properties: {} } },
  create_checkout_link: { type: 'function', name: 'create_checkout_link', description: 'Create the checkout link after the owner agrees to the plan.', parameters: { type: 'object', properties: {} } },
  end_call: { type: 'function', name: 'end_call', description: 'End the call after the owner says goodbye.', parameters: { type: 'object', properties: {} } },
};
const STAGE_TOOLS = { s0: ['record_shop', 'end_call'], s1: ['record_budget', 'record_shop', 'end_call'], s2: ['confirm_budget', 'record_budget', 'end_call'], s3: ['build_plan', 'record_budget', 'end_call'], s4: ['create_checkout_link', 'record_budget', 'build_plan', 'end_call'] };
const LISTEN = {
  intake: { keyterms: ['Mangwon', 'Mangwon Market', 'Seongsu', 'Yeonnam', 'Hapjeong', 'Hongdae', 'Euljiro', 'ramen', 'brunch'], transcription_mode: 'balanced' },
  money: { keyterms: ['won', 'man won', 'thousand won', 'a month'], transcription_mode: 'max_accuracy' },
  services: { keyterms: ['press release', 'flyer', 'blog post', 'listing audit', 'retouching'], transcription_mode: 'balanced' },
};
const STAGE_LISTEN = { s0: 'intake', s1: 'money', s2: 'money', s3: 'services', s4: 'services' };

function sessionFor(stage, { first = false } = {}) {
  const s = { system_prompt: `${COMMON}\n\n${STAGE_PROMPT[stage]}`, tools: STAGE_TOOLS[stage].map((n) => T[n]), input: { ...LISTEN[STAGE_LISTEN[stage]] } };
  if (first) s.greeting = 'Hi, this is MarketPilot. Tell me about your shop: what do you run, and where?';
  return s;
}

// design 6-9 demo catalog (generic names)
const FIXED = [{ name: 'Map listing audit report', unit_krw: 100000 }, { name: 'Press release, basic', unit_krw: 90000 }, { name: 'Flyer design and print', unit_krw: 99000 }];
const BLOG = { name: 'Sponsored blog post by a recruited blogger', unit_krw: 9000, min: 10 };
function plan(budget) {
  const lines = [];
  let left = budget;
  for (const f of FIXED) if (left - f.unit_krw >= BLOG.unit_krw * BLOG.min) { lines.push({ ...f, qty: 1 }); left -= f.unit_krw; }
  const posts = Math.floor(left / BLOG.unit_krw);
  if (posts >= BLOG.min) lines.push({ name: BLOG.name, unit_krw: BLOG.unit_krw, qty: posts });
  const total = lines.reduce((a, l) => a + l.qty * l.unit_krw, 0);
  return { budget_krw: budget, total_krw: total, spoken_total: `${englishWords(total)} won`, lines };
}

const YES = /\b(yes|yeah|yep|correct|that'?s right|right|sure|okay|ok|go ahead)\b/i;
const NO = /\b(no|nope|not right|wrong)\b/i;

export function createStub({ live = false, apiKey = '', maxTokens = Number(process.env.STUB_MAX_TOKENS || 3), port = 8799, logger = console } = {}) {
  const sessions = new Map();
  const aai = createAssemblyAI({ apiKey });
  let tokens = 0;
  const log = [];

  function newSession() {
    const id = `web_${Math.random().toString(36).slice(2, 10)}`;
    const s = { id, stage: 's0', grounding: createGrounding(), ledger: createLedger({ lang: 'en' }), aaiSessionId: null, profile: {}, plan: null, tools: [] };
    sessions.set(id, s);
    return s;
  }

  async function runTool(s, { call_id, name, arguments: args = {} }) {
    const out = (result, is_error = false, stage = s.stage) => {
      s.stage = stage;
      s.tools.push({ call_id, name, args, result, is_error, stage });
      return { result: JSON.stringify(result), is_error, state: stage, session_update: sessionFor(stage) };
    };
    if (name === 'record_shop') {
      s.profile = { business_label: args.business_type, location: args.neighborhood, problems: args.main_problem ? [args.main_problem] : [] };
      return { ...out({ ok: true, next_step: 'Ask for the monthly marketing budget in won.' }, false, 's1'), profile: s.profile };
    }
    if (name === 'record_budget') {
      await new Promise((r) => setTimeout(r, 300)); // a transcript can land just after the call (design 6-5 rule 1)
      const j = s.grounding.judge({ amount_krw: null, owner_words: args.owner_words || '', lang: 'en' });
      if (!j.ok) {
        if (j.error === 'ambiguous_amount') s.ledger.addRejected({ reason: 'range', options: j.options, phrase: j.phrase, owner_words: args.owner_words, item_id: j.item_id, heard_at: j.heard_at || Date.now(), via: 'voice-agent' });
        return out({ error: j.error, options: j.options, ask: j.ask }, true, s.stage === 's0' ? 's1' : s.stage);
      }
      const row = s.ledger.addHeard({ value_krw: j.amount_krw, phrase: j.phrase, owner_words: args.owner_words, item_id: j.item_id, heard_at: j.heard_at, via: 'voice-agent', paraphrased: j.paraphrased });
      s.ledger.markReadBack(row.id); // the read-back sentence goes to the agent in this result
      return out({ ok: true, heard_krw: j.amount_krw, read_back: j.read_back, next_step: 'Read back read_back word for word and ask if it is right.' }, false, 's2');
    }
    if (name === 'confirm_budget') {
      const pending = s.ledger.pending();
      if (!pending) return out({ error: 'nothing_to_confirm', ask: 'Ask for the monthly budget.' }, true, 's1');
      const last = s.grounding.heard[s.grounding.heard.length - 1]?.text || '';
      const yes = YES.test(last) && !NO.test(last);
      if (args.confirmed && yes) { s.ledger.confirm(pending.id); return out({ ok: true, status: 'confirmed', next_step: 'Call build_plan now.' }, false, 's3'); }
      if (!args.confirmed || NO.test(last)) { s.ledger.deny(pending.id); return out({ ok: true, status: 'rejected', next_step: 'Ask for the monthly budget again.' }, false, 's1'); }
      return out({ error: 'no_clear_answer', ask: 'Ask the owner to say yes or no.' }, true, 's2');
    }
    if (name === 'build_plan') {
      const b = s.ledger.budget();
      if (!b) return out({ error: 'no_confirmed_budget', ask: 'Ask for the monthly budget first.' }, true, 's1');
      s.plan = plan(b.value_krw);
      s.ledger.addComputed({ kind: 'plan_total', value_krw: s.plan.total_krw, label: 'plan total, catalog prices' });
      return out({ ...s.plan, next_step: 'Read each line in a few words, then the total, then ask if they want the checkout link.' }, false, 's4');
    }
    if (name === 'create_checkout_link') {
      if (!s.plan) return out({ error: 'no_plan', ask: 'Call build_plan first.' }, true, 's3');
      return out({ ok: true, demo: true, url: `http://localhost:${port}/demo-checkout/${s.id}`, next_step: 'Say the link is on their screen.' }, false, 's4');
    }
    if (name === 'end_call') return out({ ok: true, next_step: 'Say goodbye in one short sentence.' });
    return out({ error: 'unknown_tool' }, true);
  }

  async function handleApi(req, res, url) {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    const body = req.method === 'POST' ? await new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { try { r(b ? JSON.parse(b) : {}); } catch { r({}); } }); }) : {};
    const parts = url.pathname.split('/').filter(Boolean);
    log.push({ t: Date.now(), m: req.method, p: url.pathname, body: parts[3] === 'tool' || parts[3] === 'heard' ? body : undefined });
    if (url.pathname === '/api/health') return send(200, { ok: true, assemblyai: { configured: true }, llm: { configured: false }, mcp: { reachable: false, catalogSource: 'mock', products: 6 }, stub: live ? 'live' : 'fake' });
    if (url.pathname === '/api/voice-agent/token') {
      if (!live) return send(200, { token: 'fake-token', expires_in_seconds: 60 });
      if (tokens >= maxTokens) return send(503, { error: 'voice_demo_paused', message: `stub token cap (${maxTokens}) reached` });
      tokens += 1;
      const u = new URL('https://agents.assemblyai.com/v1/token');
      u.searchParams.set('expires_in_seconds', '60');
      u.searchParams.set('max_session_duration_seconds', '240');
      const r = await fetch(u, { headers: { Authorization: `Bearer ${apiKey}` } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { logger.error(`[stub] token ${r.status}`); return send(r.status === 401 || r.status === 403 || r.status === 429 ? r.status : 502, { error: `token_${r.status}`, message: JSON.stringify(j).slice(0, 200) }); }
      return send(200, { token: j.token, expires_in_seconds: j.expires_in_seconds ?? 60 });
    }
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const s = newSession();
      return send(200, { sessionId: s.id, agentId: null, state: s.stage, session_update: sessionFor('s0', { first: true }) });
    }
    if (parts[1] === 'session' && parts[2]) {
      const s = sessions.get(parts[2]);
      if (!s) return send(404, { error: 'no_session' });
      const a = parts[3];
      if (a === 'heard') { s.grounding.addHeard({ item_id: body.item_id, text: body.text, at: body.at || Date.now(), via: body.via || 'voice-agent' }); return send(200, { ok: true }); }
      if (a === 'tool') return send(200, await runTool(s, body));
      if (a === 'aai-session') { s.aaiSessionId = body.aai_session_id; return send(200, { ok: true }); }
      if (a === 'ledger') return send(200, { rows: s.ledger.snapshot() });
      if (a === 'receipt') {
        const rows = s.ledger.snapshot();
        if (live && s.aaiSessionId) {
          const { timeline, polls } = await aai.waitForTimeline(s.aaiSessionId, { intervalMs: 5000, tries: 6 });
          if (!timeline) return send(202, { pending: true, polls, message: 'The session record is not ready yet.' });
          s.timeline = timeline;
          return send(200, { ...reconcile(rows, timeline), polls });
        }
        return send(200, reconcileTurns(rows, s.grounding.heard));
      }
    }
    return send(404, { error: 'not_found' });
  }

  const dist = path.join(root, 'dist');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wav': 'audio/wav', '.json': 'application/json' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (url.pathname.startsWith('/demo-checkout/')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><meta charset="utf-8"><title>Demo checkout</title><p>Demo checkout. No payment is taken.</p>'); }
      let p = path.normalize(path.join(dist, url.pathname === '/' ? 'index.html' : url.pathname));
      if (!p.startsWith(dist)) { res.writeHead(403); return res.end(); }
      try { if ((await stat(p)).isDirectory()) p = path.join(p, 'index.html'); } catch { p = path.join(dist, 'index.html'); }
      const data = await readFile(p);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    } catch (err) {
      logger.error(`[stub] ${req.method} ${url.pathname}: ${err.stack || err}`);
      if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: 'internal', message: err.message })); }
    }
  });
  return { server, sessions, log, get tokens() { return tokens; }, listen: () => new Promise((r) => server.listen(port, () => r(port))) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]) || 8799;
  const live = args.includes('--live');
  const stub = createStub({ live, apiKey: live ? readKey() : '', port });
  await stub.listen();
  console.log(`[stub] http://localhost:${port}  token=${live ? 'LIVE' : 'fake'}`);
}

export { readKey };
