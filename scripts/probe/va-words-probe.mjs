// "The model never passes a number": one short Voice Agent call with record_budget taking only the owner's
// words (string) and a period (enum). The probe plays the server: it reads the amount from owner_words and from
// the transcript.user it received, with the same parser as the app (server/lib/amounts.js), and answers with
// is_error for a range and the read-back for one amount.
//
//   node scripts/probe/va-words-probe.mjs [--out result.json]
//
// Caller lines C2a ("Maybe four or five hundred thousand won a month.") and C2b ("Four hundred eighty thousand
// won a month."), Windows Zira 24 kHz, from make-voice-lines.ps1 (not committed).
// Cost: about 40 s of Voice Agent API time ($4.50/hour, about $0.05). Token capped at 90 s, session.end on every
// exit path, hard stop at 80 s. Stops without retrying on 401/403/429.
import fs from 'node:fs';
import { pickAmount, englishWords, readBack } from '../../server/lib/amounts.js';

const args = process.argv.slice(2);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const env = fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const KEY = (env.match(/^ASSEMBLYAI_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!KEY) { console.log('ASSEMBLYAI_API_KEY missing in .env'); process.exit(2); }

const tokRes = await fetch('https://agents.assemblyai.com/v1/token?expires_in_seconds=60&max_session_duration_seconds=90', { headers: { Authorization: `Bearer ${KEY}` } });
if ([401, 403, 429].includes(tokRes.status)) { console.log(`STOP: token HTTP ${tokRes.status}`); process.exit(2); }
const tok = await tokRes.json();
if (!tok.token) { console.log('token failed', tokRes.status); process.exit(2); }

// the tool exactly as the app declares it: words and an enum, no number
const recordBudget = {
  type: 'function',
  name: 'record_budget',
  description: "Call this right after the owner says any monthly marketing budget, including a corrected one or a range. Pass only the owner's words; the tool reads the amount and tells you what to say. Do not call it for prices, totals or discounts.",
  parameters: {
    type: 'object',
    properties: {
      owner_words: { type: 'string', description: "The owner's words for the amount, copied exactly as you heard them." },
      period: { type: 'string', enum: ['monthly', 'one_time'], description: 'monthly unless the owner says it is a one-time amount.' },
    },
    required: ['owner_words', 'period'],
  },
};
const session = {
  system_prompt: [
    'You are a marketing consultant from MarketPilot on a voice call with a small shop owner in Korea.',
    'Keep every reply to one or two short sentences. Ask one question at a time.',
    'NEVER say a price, total, quantity or budget unless that exact value came from a tool result in this call.',
    'Ask for the monthly marketing budget in won. Whenever the owner says any amount, even a range, call record_budget with the owner\'s words. The tool decides whether the amount is usable.',
  ].join('\n'),
  greeting: 'Hi, this is MarketPilot. What monthly marketing budget should I plan for?',
  tools: [recordBudget],
};

const lines = ['C2a', 'C2b'].map((id) => ({ id, pcm: fs.readFileSync(new URL(`./${id}.wav`, import.meta.url)).subarray(44) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => +((Date.now() - t0) / 1000).toFixed(2);
const log = { at: new Date().toISOString(), session_id: null, events: {}, user: [], agent: [], tool_calls: [], errors: [], ended: null, close: null };
const heard = [];
let judgedUpTo = 0; // like grounding.js: only the owner turns since the last judgment
let pending = [];
let replyDone = 0;
let ended = false;

const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${tok.token}`);
const send = (m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
function end(reason) {
  if (ended) return;
  ended = true;
  log.end_reason = reason;
  send({ type: 'session.end' });
  setTimeout(() => { try { ws.close(); } catch {} }, 2500);
}
const hardStop = setTimeout(() => end('hard stop 80 s'), 80_000);

// the server's side of record_budget: amounts come from the owner's words and the transcript, never from the model
function judge(args) {
  const words = String(args.owner_words || '');
  const fromWords = pickAmount(words);
  const fromTranscript = pickAmount(heard.slice(Math.max(judgedUpTo, heard.length - 2)).join(' '));
  judgedUpTo = heard.length;
  const r = fromTranscript.status !== 'none' ? fromTranscript : fromWords;
  if (r.status === 'ambiguous') return { is_error: true, body: { error: 'ambiguous_amount', options_spoken: r.options.map((v) => `${englishWords(v)} won`), ask: 'Ask which one to plan for.' }, server: { words: fromWords, transcript: fromTranscript } };
  if (r.status === 'ok') return { is_error: false, body: { ok: true, read_back: readBack(r.value, 'en'), next_step: "Read back read_back word for word and ask if it's right." }, server: { words: fromWords, transcript: fromTranscript, amount_krw: r.value } };
  return { is_error: true, body: { error: 'no_amount_heard', ask: 'Ask for the monthly budget as a number.' }, server: { words: fromWords, transcript: fromTranscript } };
}

async function speak(line) {
  for (let i = 0; i < line.pcm.length; i += 2400) { // 50 ms at 24 kHz, real time (faster is audio_rate_violation)
    let chunk = line.pcm.subarray(i, i + 2400);
    if (chunk.length < 2400) { const pad = Buffer.alloc(2400); chunk.copy(pad); chunk = pad; }
    send({ type: 'input.audio', audio: chunk.toString('base64') });
    await sleep(50);
  }
}
async function silenceUntil(cond, ms) {
  const until = Date.now() + ms;
  while (!cond() && Date.now() < until && ws.readyState === 1) { send({ type: 'input.audio', audio: Buffer.alloc(2400).toString('base64') }); await sleep(50); }
}

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  log.events[m.type] = (log.events[m.type] || 0) + 1;
  if (m.type === 'session.ready') log.session_id = m.session_id;
  if (m.type === 'transcript.user') { heard.push(m.text); log.user.push({ t: at(), text: m.text, item_id: m.item_id }); }
  if (m.type === 'transcript.agent') log.agent.push({ t: at(), text: m.text, interrupted: Boolean(m.interrupted) });
  if (m.type === 'tool.call') {
    const args = typeof m.arguments === 'string' ? JSON.parse(m.arguments) : m.arguments;
    const j = judge(args);
    const rec = { t: at(), name: m.name, arguments: args, server: j.server, is_error: j.is_error, result: j.body };
    log.tool_calls.push(rec);
    pending.push({ call_id: m.call_id, result: JSON.stringify(j.body), is_error: j.is_error });
  }
  if (m.type === 'reply.done') {
    replyDone += 1;
    if (m.status === 'interrupted') pending = [];
    for (const p of pending) send({ type: 'tool.result', ...p });
    pending = [];
  }
  if (m.type === 'session.ended') log.ended = { t: at() };
  if (/error/.test(m.type)) log.errors.push(m);
};
ws.onclose = (e) => {
  clearTimeout(hardStop);
  log.close = { code: e.code, reason: e.reason, t: at() };
  log.seconds = at();
  const calls = log.tool_calls.map((c) => ({ args: c.arguments, amount: c.server.amount_krw ?? null, error: c.result.error || null }));
  console.log(JSON.stringify({ session_id: log.session_id, seconds: log.seconds, user: log.user.map((u) => u.text), agent: log.agent.map((a) => a.text), tool_calls: calls, errors: log.errors.map((x) => x.type), ended: Boolean(log.ended) }, null, 1));
  if (outPath) fs.writeFileSync(outPath, JSON.stringify(log, null, 1));
  process.exit(0);
};
ws.onerror = () => {};
ws.onopen = async () => {
  send({ type: 'session.update', session });
  // greeting
  await silenceUntil(() => log.session_id && replyDone >= 1, 12_000);
  for (const line of lines) {
    const doneBefore = replyDone;
    const callsBefore = log.tool_calls.length;
    await speak(line);
    // wait for the tool call, its result and the spoken answer to it
    await silenceUntil(() => log.tool_calls.length > callsBefore && replyDone >= doneBefore + 2, 15_000);
    await silenceUntil(() => false, 1500);
  }
  end('done');
};
