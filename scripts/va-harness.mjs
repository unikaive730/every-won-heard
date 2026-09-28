// Node plays the browser for one Voice Agent call through our server (design 6-7 voice-agent.js + demo-caller.js):
//
//   token      GET  /api/voice-agent/token (the server holds the key; Bearer to AssemblyAI)
//   connect    wss://agents.assemblyai.com/v1/ws?token=..., first session.update from POST /api/session
//   heard      every transcript.user -> POST /api/session/:id/heard (transcript.agent too, role 'agent')
//   tools      tool.call is held until reply.done; then POST /api/session/:id/tool, the server's session_update
//              when the stage changed, then tool.result with the server's result string (--result-first flips the
//              order to reproduce run 1: the reply then uses the old stage). reply.done interrupted drops the
//              held calls. end_call -> session.end after the goodbye.
//   caller     design 8 lines C1-C7 as 24 kHz PCM16 WAV (make-voice-lines.ps1), streamed at real-time pace in
//              50 ms frames with silence between lines. C4 barges in 2.5 s after the plan reply starts.
//
//   node scripts/va-harness.mjs [--base http://127.0.0.1:8787] [--lines C1,C2b,C3] [--inline] [--result-first]
//                               [--max-seconds 200] [--out run.json]
//
// Without --base it starts server/index.js itself on a free port with DEMO_MODE=1 and no LLM key (the child
// reads .env for the AssemblyAI key and VOICE_AGENT_ID; this script never sees the key).
// Cost guard: the server's token caps the session (VA_MAX_SESSION_SECONDS, 240 s), a watchdog sends session.end,
// every exit path sends session.end (a closed socket alone bills a 30 s grace window). 401/403/429 stop the run.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const LINES = (opt('lines') || 'C1,C2a,C2b,C3,C4,C5,C6,C7').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_SECONDS = Number(opt('max-seconds', 200));
const OUT = opt('out');
const UPDATE_FIRST = !flag('result-first');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- caller lines ----------
const CHUNK = 2400; // 50 ms at 24 kHz, 16-bit mono
function pcmOf(id) {
  const file = path.join(root, 'scripts', 'probe', `${id}.wav`);
  if (!fs.existsSync(file)) throw new Error(`${file} missing: run powershell -ExecutionPolicy Bypass -File scripts/probe/make-voice-lines.ps1`);
  const buf = fs.readFileSync(file);
  const rate = buf.readUInt32LE(24);
  if (rate !== 24000 || buf.readUInt16LE(22) !== 1) throw new Error(`${id}.wav must be 24 kHz mono (got ${rate} Hz)`);
  let off = 12;
  while (off < buf.length - 8) { // find the data chunk
    const idStr = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (idStr === 'data') return buf.subarray(off + 8, off + 8 + size);
    off += 8 + size;
  }
  throw new Error(`${id}.wav has no data chunk`);
}
const PLAN = {
  C1: { when: () => true },
  C2a: { when: (h) => h.state === 's1' },
  C2b: { when: (h) => h.state === 's1' },
  C3: { when: (h) => h.state === 's2' },
  C4: { bargeInMs: 2500 },
  C5: { when: (h) => h.state === 's2' },
  C6: { when: (h) => h.state === 's4' },
  C7: { when: (h) => Boolean(h.checkout) },
};
const audio = Object.fromEntries(LINES.map((id) => [id, pcmOf(id)]));

// ---------- server ----------
async function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
let child = null;
let base = opt('base');
if (!base) {
  const port = await freePort();
  child = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port), LLM_API_KEY: '', DEMO_MODE: '1', CALL_SUMMARY: '0', ...(flag('inline') ? { VA_CONNECT: 'inline' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  child.stderr.on('data', (d) => process.stdout.write(`  [server] ${d}`));
  base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${base}/api/session/ping`)).status === 404) break; } catch { /* not up yet */ }
    await sleep(100);
  }
}
const api = async (method, p, body) => {
  const r = await fetch(`${base}${p}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
function stopServer() { if (child) { child.kill(); child = null; } }

// ---------- log ----------
const t0 = Date.now();
const rel = () => Math.round((Date.now() - t0) / 100) / 10;
const log = { at: new Date().toISOString(), base, lines: LINES, update_first: UPDATE_FIRST, events: [], caller: [], user: [], agent: [], tools: [], updates: [], errors: [], latency_ms: [], barge_in: null, ready: null, ended: null };
const say = (s) => console.log(`[${rel().toFixed(1)}s] ${s}`);

const created = await api('POST', '/api/session', { lang: 'en', engine: 'voice-agent' });
if (created.status !== 200) { console.log('session create failed', created); stopServer(); process.exit(2); }
const sid = created.body.sessionId;
log.session = { id: sid, connect: created.body.connect, agent_id: created.body.agentId };
say(`server session ${sid} (${created.body.connect}${created.body.agentId ? ` ${created.body.agentId}` : ''})`);
const tok = await api('GET', '/api/voice-agent/token');
if (tok.status !== 200) { say(`STOP: token HTTP ${tok.status} ${JSON.stringify(tok.body)}`); stopServer(); process.exit(2); }

// ---------- call ----------
const h = { state: created.body.state, checkout: null };
const ws = new WebSocket(`wss://agents.assemblyai.com/v1/ws?token=${tok.body.token}`);
const queue = [];
const heardInflight = new Set();
let pending = [];
let aaiSession = null;
let ended = false;
let lastUserItem = null;
let lastEvent = null;
let replyAudio = false;
let speechStoppedAt = null;
let lineIdx = 0;
let planReplyNext = false;
let endAfterReply = false;
let fallback = null;
let doneTimer = null;
let bargeStartedAt = null;

function send(obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function end(reason) {
  if (ended) return;
  ended = true;
  log.end_reason = reason;
  say(`session.end (${reason})`);
  send({ type: 'session.end' });
  setTimeout(() => { try { ws.close(); } catch { /* gone */ } }, 3000);
}
const watchdog = setTimeout(() => end(`watchdog_${MAX_SECONDS}s`), MAX_SECONDS * 1000);

function play(id, why = 'turn') {
  clearTimeout(fallback);
  const pcm = audio[id];
  for (let i = 0; i < pcm.length; i += CHUNK) { const c = Buffer.alloc(CHUNK); pcm.subarray(i, i + CHUNK).copy(c); queue.push(c); }
  log.caller.push({ t: rel(), id, why, state: h.state });
  say(`caller ${id}${why !== 'turn' ? ` (${why})` : ''}`);
  lineIdx += 1;
}

/** A spoken reply finished and nothing is waiting on a tool: the caller answers with the next line. */
function onReplyFinished() {
  if (endAfterReply) { setTimeout(() => end('end_call'), 800); return; }
  const id = LINES[lineIdx];
  // after the last line, give the agent 8 s to call end_call (its goodbye ends the call) before hanging up
  if (!id) { clearTimeout(doneTimer); doneTimer = setTimeout(() => end('script_done'), 8000); return; }
  const p = PLAN[id] || { when: () => true };
  if (p.bargeInMs) return; // waits for the plan reply to start
  if (p.when(h)) { setTimeout(() => play(id), 700); return; }
  // unexpected stage: give the agent 6 s to say more, then the caller carries on anyway
  clearTimeout(fallback);
  fallback = setTimeout(() => play(id, `forced in ${h.state}`), 6000);
}

async function relay(calls) {
  await Promise.all([...heardInflight]);
  const done = [];
  for (const c of calls) {
    const r = await api('POST', `/api/session/${sid}/tool`, c);
    if (r.status !== 200) { log.errors.push({ t: rel(), tool: c.name, status: r.status, body: r.body }); say(`/tool ${c.name} HTTP ${r.status}`); continue; }
    done.push([c, r.body]);
    log.tools.push({ t: rel(), name: c.name, arguments: c.arguments, last_item_id: c.last_item_id, result: JSON.parse(r.body.result), is_error: r.body.is_error, state: r.body.state });
    say(`tool ${c.name} ${JSON.stringify(c.arguments)} -> ${r.body.is_error ? 'ERROR ' : ''}${r.body.result.slice(0, 160)} [${r.body.state}]`);
  }
  if (!done.length) return;
  if (lastEvent !== 'reply.done') say(`note: ${lastEvent} arrived while the tool ran`);
  const last = done[done.length - 1][1];
  const changed = done.some(([, r]) => r.state_changed);
  const update = () => { if (changed) { send({ type: 'session.update', session: last.session_update }); log.updates.push({ t: rel(), sent: last.state }); } };
  if (UPDATE_FIRST) update();
  for (const [c, r] of done) send({ type: 'tool.result', call_id: c.call_id, result: r.result, is_error: r.is_error });
  if (!UPDATE_FIRST) update();
  h.state = last.state;
  h.checkout = last.checkout;
  if (done.some(([, r]) => r.end_session)) {
    endAfterReply = true;
    // like the web client (armEnd): end 9 s after the end_call result even if no reply completes (merge run 1: the
    // reply to that result started and never finished, and the call ran on to the 200 s watchdog)
    setTimeout(() => end('end_call_timeout'), 9000);
  }
  if (done.some(([c, r]) => c.name === 'build_plan' && !r.is_error)) planReplyNext = true;
}

ws.onopen = () => send({ type: 'session.update', session: created.body.session_update });
ws.onmessage = async (e) => {
  const m = JSON.parse(e.data);
  const type = m.type;
  if (type === 'reply.audio') {
    if (!replyAudio && speechStoppedAt) { log.latency_ms.push(Date.now() - speechStoppedAt); speechStoppedAt = null; }
    replyAudio = true;
    return;
  }
  if (type === 'transcript.user.delta' || type === 'transcript.agent.delta') return;
  log.events.push({ t: rel(), type, ...(m.status ? { status: m.status } : {}), ...(m.item_id ? { item_id: m.item_id } : {}), ...(m.reply_id ? { reply_id: m.reply_id } : {}) });
  if (type === 'session.ready') {
    aaiSession = m.session_id;
    const c = m.config || {};
    log.ready = { t: rel(), session_id: m.session_id, voice: c.output?.voice ?? null, tools: (c.tools || []).map((t) => t.name), transcription_mode: c.input?.transcription_mode ?? null, keyterms: c.input?.keyterms?.length ?? null };
    say(`session.ready ${m.session_id} voice=${log.ready.voice} tools=${log.ready.tools.join(',')} mode=${log.ready.transcription_mode}`);
    await api('POST', `/api/session/${sid}/aai-session`, { aai_session_id: m.session_id });
  } else if (type === 'session.updated') {
    const c = m.config || {};
    const u = { t: rel(), tools: (c.tools || []).map((t) => t.name), transcription_mode: c.input?.transcription_mode ?? null, keyterms: c.input?.keyterms?.length ?? null, prompt_stage: (String(c.system_prompt || '').match(/Stage: [a-z ]+/) || [null])[0] };
    log.updates.push({ ...u, applied: true });
    say(`session.updated tools=${u.tools.join(',')} mode=${u.transcription_mode} ${u.prompt_stage}`);
  } else if (type === 'input.speech.started') {
    lastEvent = type;
    clearTimeout(fallback);
  } else if (type === 'input.speech.stopped') {
    speechStoppedAt = Date.now();
  } else if (type === 'transcript.user') {
    lastUserItem = m.item_id;
    log.user.push({ t: rel(), item_id: m.item_id, text: m.text });
    say(`owner: ${m.text}`);
    const p = api('POST', `/api/session/${sid}/heard`, { item_id: m.item_id, text: m.text, at: Date.now(), via: 'voice-agent' }).finally(() => heardInflight.delete(p));
    heardInflight.add(p);
  } else if (type === 'reply.started') {
    lastEvent = type;
    replyAudio = false;
    clearTimeout(fallback);
    clearTimeout(doneTimer);
    if (planReplyNext && PLAN[LINES[lineIdx]]?.bargeInMs) {
      planReplyNext = false;
      const id = LINES[lineIdx];
      setTimeout(() => { bargeStartedAt = Date.now(); play(id, 'barge-in'); }, PLAN[id].bargeInMs);
    } else planReplyNext = false;
  } else if (type === 'transcript.agent') {
    log.agent.push({ t: rel(), text: m.text, interrupted: Boolean(m.interrupted) });
    say(`agent${m.interrupted ? ' (interrupted)' : ''}: ${m.text}`);
    api('POST', `/api/session/${sid}/heard`, { item_id: m.item_id, text: m.text, via: 'voice-agent', role: 'agent' });
  } else if (type === 'tool.call') {
    pending.push({ call_id: m.call_id, name: m.name, arguments: m.arguments || {}, last_item_id: lastUserItem });
    say(`tool.call ${m.name} ${JSON.stringify(m.arguments)}`);
  } else if (type === 'reply.done') {
    lastEvent = type;
    if (m.status === 'interrupted') {
      if (bargeStartedAt && !log.barge_in) log.barge_in = { ms_after_caller_started: Date.now() - bargeStartedAt, dropped_tool_calls: pending.length };
      if (pending.length) say(`reply interrupted: dropped ${pending.map((c) => c.name).join(', ')}`);
      pending = [];
      return;
    }
    if (pending.length) {
      const calls = pending;
      pending = [];
      await relay(calls);
      return;
    }
    if (!replyAudio) log.events.push({ t: rel(), silent_reply: m.reply_id });
    onReplyFinished();
  } else if (type === 'session.ended') {
    log.ended = { t: rel(), session_duration_seconds: m.session_duration_seconds, audio_duration_seconds: m.audio_duration_seconds };
    say(`session.ended ${m.session_duration_seconds}s`);
  } else if (type === 'session.error') {
    log.errors.push({ t: rel(), code: m.code, message: m.message, param: m.param });
    say(`session.error ${m.code} ${m.message}`);
    if (/unauthor|forbidden/i.test(m.code) || !aaiSession) end(`error_${m.code}`);
  }
};
ws.onerror = () => {};
const closed = new Promise((r) => { ws.onclose = (e) => { log.close = { code: e.code, reason: e.reason, t: rel() }; r(); }; });

// audio pump: 50 ms frames at real-time pace (caller audio when queued, silence otherwise), only after session.ready
(async () => {
  let sent = 0;
  let start = null;
  while (!ended && ws.readyState <= 1) {
    if (ws.readyState === 1 && aaiSession) {
      if (start == null) start = Date.now();
      const due = Math.floor((Date.now() - start) / 50);
      while (sent < due) { send({ type: 'input.audio', audio: (queue.shift() || Buffer.alloc(CHUNK)).toString('base64') }); sent++; }
    }
    await sleep(20);
  }
})();

process.on('SIGINT', () => { end('sigint'); setTimeout(() => process.exit(1), 3500); });
await closed;
clearTimeout(watchdog);
clearTimeout(fallback);
if (!ended) { ended = true; log.end_reason = log.end_reason || 'closed_by_server'; }
say(`closed ${JSON.stringify(log.close)} end_reason=${log.end_reason}`);

// ---------- results ----------
const ledger = await api('GET', `/api/session/${sid}/ledger`);
log.ledger = (ledger.body.rows || []).map((r) => ({ label: r.label, status: r.status, source: r.source, reason: r.reason || null, item_id: r.item_id, phrase: r.phrase, owner_words: r.owner_words, paraphrased: r.paraphrased, t: r.t }));
const snap = await api('GET', `/api/session/${sid}`);
log.plan = snap.body.plan ? { budget_krw: snap.body.plan.budget_krw, total_cost: snap.body.plan.total_cost, lines: snap.body.plan.channels.map((c) => `${c.items[0].name} x${c.items[0].qty} = ${c.items[0].cost}`) } : null;
log.checkout = snap.body.checkout;
if (aaiSession) {
  say('receipt: waiting for the AssemblyAI session record (up to 30 s)');
  const rec = await api('GET', `/api/session/${sid}/receipt`);
  log.receipt = { status: rec.status, ...rec.body };
}
stopServer();

console.log('\n--- ledger');
for (const r of log.ledger) console.log(`  ${r.label}   t=${JSON.stringify(r.t)}${r.phrase ? `  phrase="${r.phrase}"` : ''}${r.owner_words ? `  owner_words="${r.owner_words}"` : ''}`);
if (log.plan) console.log(`--- plan ${log.plan.total_cost} / ${log.plan.budget_krw}: ${log.plan.lines.join(' · ')}`);
if (log.checkout) console.log(`--- checkout ${log.checkout.url}`);
if (log.receipt) console.log(`--- receipt HTTP ${log.receipt.status}: confirmed ${log.receipt.confirmed_amounts} · matched ${log.receipt.matched?.length} · unmatched ${log.receipt.unmatched?.length} · rejected calls ${log.receipt.rejected_calls} / ${log.receipt.tool_calls} · median first audio ${log.receipt.median_time_to_first_audio_ms} ms`);
console.log(`--- ${log.tools.length} tool calls, ${log.updates.filter((u) => u.applied).length} session.updated, latency speech-stopped -> first audio ms: ${log.latency_ms.join(', ')}`);
if (log.barge_in) console.log(`--- barge-in: reply interrupted ${log.barge_in.ms_after_caller_started} ms after the caller started`);
if (log.ended) console.log(`--- billed session ${log.ended.session_duration_seconds}s`);
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(log, null, 1)); console.log(`saved ${OUT}`); }
process.exit(0);
