// Voice Agent API probe for the call receipt (W12). One short English session with inline config, a synthetic caller
// (C2a range, C2b, C3, C7 from voice-lines.json, 24 kHz), and a minimal tool relay that uses the real grounding +
// ledger on an in-process server session. After session.end it measures when the Sessions API artifacts appear,
// saves the timeline, and calls GET /api/session/:id/receipt on the real server code.
//
//   node scripts/probe/va-receipt-probe.mjs [out.json]
//
// Cost guard: token max_session_duration_seconds=120 (hard cap), 100 s watchdog sends session.end, every exit path
// sends session.end (closing the socket alone bills a 30 s grace window). Stops on 401/403/429.
// Run 1 (2026-09-28) stalled: after the range line the managed model returned an empty reply (no audio, no text,
// no tool call) and the harness waited for speech. Now an empty reply moves the caller to the next line.
import fs from 'node:fs';
import { createApp } from '../../server/index.js';
import { createAssemblyAI } from '../../server/lib/assemblyai.js';
import { createMcpClient } from '../../server/lib/mcp.js';

const env = Object.fromEntries(fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.ASSEMBLYAI_API_KEY;
const outPath = process.argv[2] || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { warn() {}, error() {}, log() {} };
const pcmOf = (id) => fs.readFileSync(new URL(`./${id}.wav`, import.meta.url)).subarray(44);
const LINES = ['C2a', 'C2b', 'C3', 'C7'];
const YES = /^(yes|yeah|yep|correct|right|that'?s right|exactly)\b/i;

const mock = JSON.parse(fs.readFileSync(new URL('../../server/data/products.mock.json', import.meta.url), 'utf8'));
const app = createApp({ assemblyai: createAssemblyAI({ apiKey: KEY, logger: quiet }), mcp: createMcpClient({ fetchImpl: async () => { throw new Error('offline'); }, mock, logger: quiet }), llm: null, gateway: null, logger: quiet });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const post = async (p, body) => (await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
const created = await post('/api/session', { lang: 'en', engine: 'voice-agent' });
const session = app.agent.getSession(created.sessionId);

const log = { at: new Date().toISOString(), events: [], user: [], agent: [], tools: [], errors: [], ready: null, ended: null, artifacts: null, receipt: null };
const t0 = Date.now();
const rel = () => Math.round((Date.now() - t0) / 100) / 10;

// token (Bearer), hard cap 120 s
const tr = await fetch('https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=120', { headers: { Authorization: `Bearer ${KEY}` } });
if ([401, 403, 429].includes(tr.status)) { console.log(`STOP: token HTTP ${tr.status} ${await tr.text()}`); process.exit(2); }
const { token } = await tr.json();
if (!token) { console.log('no token'); process.exit(2); }

const tools = [
  { type: 'function', name: 'record_budget', description: 'Call this right after the owner says any monthly marketing budget, including a corrected one or a range. If it is a range, pass either number; the tool will ask for one. Do not call it for prices or totals.',
    parameters: { type: 'object', properties: { amount_krw: { type: 'integer', description: 'Monthly budget in Korean won, whole number.' }, owner_words: { type: 'string', description: "The owner's words for the amount, as heard." }, period: { type: 'string', enum: ['monthly', 'one_time'] } }, required: ['amount_krw', 'owner_words', 'period'] } },
  { type: 'function', name: 'confirm_budget', description: 'Call this after you read the budget back and the owner answers yes or no.',
    parameters: { type: 'object', properties: { confirmed: { type: 'boolean' } }, required: ['confirmed'] } },
];
const system_prompt = [
  'You are a marketing consultant from MarketPilot on a voice call with a small shop owner in Korea.',
  'Keep every reply to one or two short sentences. Ask one question at a time.',
  'NEVER say a price, total, quantity or budget unless that exact value came from a tool result in this call.',
  'Whenever the owner says any amount, even a range, call record_budget with the owner\'s words. The tool decides whether the amount is usable.',
  'When record_budget returns ok, read back read_back word for word and ask if it is right. When the owner answers, call confirm_budget.',
  'After the budget is confirmed, say the plan comes next and say goodbye when the owner does.',
].join('\n');

const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${token}`);
let ended = false;
let sessionId = null;
const queue = []; // PCM chunks waiting to be streamed
const pendingCalls = [];
let lastUserText = '';
let pendingRow = null;
let lineIdx = 0;
let replyHadSpeech = false;
let speechStoppedAt = null;

function end(reason) {
  if (ended) return;
  ended = true;
  log.end_reason = reason;
  try { ws.send(JSON.stringify({ type: 'session.end' })); } catch { /* socket gone */ }
}
const watchdog = setTimeout(() => end('watchdog_80s'), 80_000);

function nextLine() {
  if (lineIdx >= LINES.length) { setTimeout(() => end('script_done'), 4000); return; }
  const id = LINES[lineIdx++];
  const pcm = pcmOf(id);
  for (let i = 0; i < pcm.length; i += 2400) { const c = Buffer.alloc(2400); pcm.subarray(i, i + 2400).copy(c); queue.push(c); }
  log.events.push({ t: rel(), caller: id });
  console.log(`[${rel()}s] caller ${id}`);
}

function handleTool(call) {
  const a = call.arguments || {};
  if (call.name === 'record_budget') {
    const d = session.grounding.judge({ amount_krw: a.amount_krw, owner_words: a.owner_words, lang: 'en' });
    if (d.ok) {
      pendingRow = session.ledger.addHeard({ value_krw: d.amount_krw, phrase: d.phrase, owner_words: a.owner_words, item_id: d.item_id, heard_at: d.heard_at, via: 'voice-agent', paraphrased: d.paraphrased, forced: d.forced });
      return { result: { ok: true, heard_krw: d.amount_krw, read_back: d.read_back, next_step: "Read back read_back word for word and ask if it's right." }, is_error: false };
    }
    if (d.error === 'ambiguous_amount') session.ledger.addRejected({ reason: 'range', options: d.options, phrase: d.phrase, item_id: d.item_id, via: 'voice-agent' });
    return { result: { error: d.error, options: d.options, heard_krw: d.heard_krw, ask: d.ask }, is_error: true };
  }
  if (call.name === 'confirm_budget') {
    if (pendingRow && a.confirmed === true && YES.test(lastUserText.trim())) {
      session.ledger.confirm(pendingRow.id);
      pendingRow = null;
      return { result: { ok: true, status: 'confirmed', next_step: 'Say the plan comes next.' }, is_error: false };
    }
    return { result: { error: 'not_confirmed', ask: 'Ask the owner to confirm the amount with a yes.' }, is_error: true };
  }
  return { result: { error: 'unknown_tool' }, is_error: true };
}

ws.onopen = () => ws.send(JSON.stringify({ type: 'session.update', session: { system_prompt, greeting: 'Hi, this is MarketPilot. What monthly marketing budget should I plan for, in won?', input: { keyterms: ['won', 'man won', 'thousand won', 'a month'], transcription_mode: 'max_accuracy' }, tools } }));
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  if (m.type === 'reply.audio' || m.type === 'transcript.agent.delta' || m.type === 'transcript.user.delta') { if (m.type === 'reply.audio') replyHadSpeech = true; return; }
  log.events.push({ t: rel(), type: m.type, ...(m.status ? { status: m.status } : {}), ...(m.item_id ? { item_id: m.item_id } : {}), ...(m.reply_id ? { reply_id: m.reply_id } : {}) });
  if (m.type === 'session.ready') {
    sessionId = m.session_id;
    log.ready = { t: rel(), session_id: m.session_id, voice: m.config?.output?.voice ?? null, transcription_mode: m.config?.input?.transcription_mode ?? null, keyterms: m.config?.input?.keyterms ?? null };
    await post(`/api/session/${session.id}/aai-session`, { aai_session_id: m.session_id });
    console.log(`[${rel()}s] session.ready ${m.session_id}`);
  } else if (m.type === 'input.speech.stopped') {
    speechStoppedAt = Date.now();
  } else if (m.type === 'transcript.user') {
    lastUserText = m.text;
    session.grounding.addHeard({ item_id: m.item_id, text: m.text, via: 'voice-agent' });
    log.user.push({ t: rel(), item_id: m.item_id, text: m.text });
    console.log(`[${rel()}s] user: ${m.text}  (${m.item_id})`);
  } else if (m.type === 'transcript.agent') {
    log.agent.push({ t: rel(), text: m.text, interrupted: m.interrupted, item_id: m.item_id });
    console.log(`[${rel()}s] agent: ${m.text}`);
  } else if (m.type === 'reply.started') {
    if (speechStoppedAt) { log.events[log.events.length - 1].ms_since_speech_stopped = Date.now() - speechStoppedAt; speechStoppedAt = null; }
  } else if (m.type === 'tool.call') {
    pendingCalls.push(m);
    console.log(`[${rel()}s] tool.call ${m.name} ${JSON.stringify(m.arguments)}`);
  } else if (m.type === 'reply.done') {
    if (m.status === 'interrupted') { pendingCalls.length = 0; replyHadSpeech = false; return; }
    if (pendingCalls.length) {
      for (const c of pendingCalls.splice(0)) {
        const { result, is_error } = handleTool(c);
        log.tools.push({ t: rel(), name: c.name, arguments: c.arguments, result, is_error });
        ws.send(JSON.stringify({ type: 'tool.result', call_id: c.call_id, result: JSON.stringify(result), is_error }));
        console.log(`[${rel()}s] tool.result ${c.name} ${is_error ? 'ERROR' : 'ok'} ${JSON.stringify(result)}`);
      }
      return;
    }
    if (replyHadSpeech) {
      replyHadSpeech = false;
      if (pendingRow && pendingRow.status === 'heard') session.ledger.markReadBack(pendingRow.id);
      setTimeout(nextLine, 700);
    } else {
      log.events.push({ t: rel(), silent_reply: m.reply_id });
      console.log(`[${rel()}s] silent reply ${m.reply_id}, caller moves on`);
      setTimeout(nextLine, 1500);
    }
  } else if (m.type === 'session.ended') {
    log.ended = { t: rel(), at: Date.now(), session_duration_seconds: m.session_duration_seconds, audio_duration_seconds: m.audio_duration_seconds };
    console.log(`[${rel()}s] session.ended ${m.session_duration_seconds}s`);
  } else if (m.type === 'session.error') {
    log.errors.push(m);
    console.log(`[${rel()}s] session.error ${m.code} ${m.message}`);
    if (/unauthor|forbidden/i.test(m.code)) end('auth_error');
    else if (!sessionId) end('error_before_ready'); // e.g. invalid_config: do not wait for the watchdog
  }
};
ws.onerror = () => {};
const closed = new Promise((r) => { ws.onclose = (e) => { log.close = { code: e.code, reason: e.reason, t: rel() }; r(); }; });

// audio pump: 50 ms chunks at real-time pace (caller audio when queued, silence otherwise), after session.ready only
(async () => {
  let sent = 0;
  while (!ended && ws.readyState <= 1) {
    if (ws.readyState === 1 && sessionId) {
      const due = Math.floor((Date.now() - pumpStart()) / 50);
      while (sent < due) {
        const chunk = queue.shift() || Buffer.alloc(2400);
        ws.send(JSON.stringify({ type: 'input.audio', audio: chunk.toString('base64') }));
        sent++;
      }
    }
    await sleep(20);
  }
})();
let pumpT = null;
function pumpStart() { if (pumpT == null) pumpT = Date.now(); return pumpT; }

await closed;
clearTimeout(watchdog);
if (!ended) log.end_reason = log.end_reason || 'closed_by_server';
console.log(`closed ${JSON.stringify(log.close)} end_reason=${log.end_reason}`);

// when do the artifacts appear? (free REST polling, 1 s)
if (sessionId) {
  const endedAt = log.ended?.at || Date.now();
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`https://agents.assemblyai.com/v1/sessions/${sessionId}`, { headers: { Authorization: KEY } });
    if ([401, 403, 429].includes(r.status)) { log.artifacts = { stopped: r.status }; break; }
    const j = await r.json();
    if ((j.artifacts || []).some((a) => a.type === 'timeline')) {
      log.artifacts = { seconds_after_session_ended: Math.round((Date.now() - endedAt) / 100) / 10, polls: i + 1, status: j.status, public_close_reason: j.public_close_reason, duration_seconds: j.duration_seconds, types: j.artifacts.map((a) => a.type) };
      const tl = await (await fetch(j.artifacts.find((a) => a.type === 'timeline').url)).json();
      log.timeline = tl;
      break;
    }
    await sleep(1000);
  }
  console.log('artifacts:', JSON.stringify(log.artifacts));
  const rec = await fetch(`${base}/api/session/${session.id}/receipt`);
  log.receipt = { status: rec.status, body: await rec.json() };
  console.log('receipt:', JSON.stringify(log.receipt).slice(0, 1500));
}
log.ledger = session.ledger.snapshot().map((r) => ({ label: r.label, status: r.status, item_id: r.item_id, phrase: r.phrase, owner_words: r.owner_words, paraphrased: r.paraphrased, t: r.t }));
console.log('ledger:', log.ledger.map((r) => r.label).join(' | '));
if (outPath) fs.writeFileSync(outPath, JSON.stringify(log, null, 1));
app.server.close();
process.exit(0);
