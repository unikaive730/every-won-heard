// Korean call, end to end, with no browser: the real server (in-process) + Universal-3.6 Pro streaming.
// It does what web/src/main.js does for Korean: create a realtime session, open the stream with the greeting as
// agent_context, send each final turn to /utterance, then send the returned listen config as UpdateConfiguration
// before the "agent speaks". Caller audio is K1-K3 (Windows Heami voice, make-voice-lines.ps1).
//
//   node scripts/probe/ko-call.mjs [--no-lang-codes] [--no-updates] [--out result.json]
//
// Cost: about 20 s of Korean streaming per run. Stops on 401/403/429.
import fs from 'node:fs';
import { createApp } from '../../server/index.js';
import { createAssemblyAI } from '../../server/lib/assemblyai.js';
import { createMcpClient } from '../../server/lib/mcp.js';
import { buildStreamingUrl, updateConfigMessage } from '../../web/src/lib/transcript.js';

const args = process.argv.slice(2);
const useLangCodes = !args.includes('--no-lang-codes');
const useUpdates = !args.includes('--no-updates');
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1] : null;
const env = Object.fromEntries(fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const lines = JSON.parse(fs.readFileSync(new URL('./voice-lines.json', import.meta.url), 'utf8')).lines.filter((l) => l.id.startsWith('K'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = { warn() {}, error() {}, log() {} };

const mock = JSON.parse(fs.readFileSync(new URL('../../server/data/products.mock.json', import.meta.url), 'utf8'));
const app = createApp({
  assemblyai: createAssemblyAI({ apiKey: env.ASSEMBLYAI_API_KEY, logger: quiet }),
  mcp: createMcpClient({ fetchImpl: async () => { throw new Error('offline for the probe'); }, mock, logger: quiet }),
  llm: null,
  logger: quiet,
});
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const api = async (p, body) => {
  const r = await fetch(`${base}${p}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if ([401, 403, 429].includes(r.status)) { console.log(`STOP: ${p} HTTP ${r.status}`); process.exit(2); }
  return j;
};

const log = { at: new Date().toISOString(), options: { useLangCodes, useUpdates }, begin: null, turns: [], updates: [], errors: [], ledger: null, termination: null, close: null };
const session = await api('/api/session', { lang: 'ko', engine: 'realtime' });
const tok = await api('/api/assemblyai/token');
if (!tok.token) { console.log('token failed', tok); process.exit(2); }
const url = buildStreamingUrl({ token: tok.token, lang: 'ko', agentContext: session.listen.agent_context, keyterms: session.listen.keyterms_prompt, mode: session.listen.mode, languageCodes: useLangCodes ? ['ko', 'en'] : null });
log.url_params = [...new URL(url).searchParams.keys()].filter((k) => k !== 'token');

const ws = new WebSocket(url);

const finals = [];
let lastAudioAt = 0;
const t0 = Date.now();
const began = new Promise((resolve, reject) => {
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'Begin') { log.begin = m.configuration; resolve(); return; }
    if (m.type === 'Turn' && m.end_of_turn) {
      const f = { order: m.turn_order, text: m.transcript, lang: m.language_code ?? null, lang_conf: m.language_confidence ?? null, at: Date.now() };
      finals.push(f);

      return;
    }
    if (m.type === 'Termination') { log.termination = { ms_after_terminate: Date.now() - log.terminateSentAt, audio: m.audio_duration_seconds, session: m.session_duration_seconds }; return; }
    if (m.type === 'Error' || m.error) log.errors.push(m);
  };
  ws.onclose = (e) => { log.close = { code: e.code, reason: e.reason, at_s: (Date.now() - t0) / 1000 }; reject(new Error(`closed ${e.code} ${e.reason}`)); };
  ws.onerror = () => {};
});
await began;

async function stream(buf) {
  // every audio message must be 50-1000 ms (a 15 ms tail closes the session with error 3007), so pad the last one
  for (let i = 0; i < buf.length; i += 3200) {
    let chunk = buf.subarray(i, i + 3200);
    if (chunk.length < 3200) { const pad = Buffer.alloc(3200); chunk.copy(pad); chunk = pad; }
    ws.send(chunk);
    await sleep(100);
  }
  lastAudioAt = Date.now();
}
async function silence(ms) { for (let i = 0; i < ms / 100; i++) { if (ws.readyState !== 1) return; ws.send(Buffer.alloc(3200)); await sleep(100); } }

for (const line of lines) {
  const pcm = fs.readFileSync(new URL(`./${line.id}.wav`, import.meta.url)).subarray(44);
  const before = finals.length;
  await stream(pcm);
  // one silence pump at real-time speed until the turn ends; 3.6 Pro may split a line into several turns
  let deadline = Date.now() + 6000;
  let seen = before;
  while (Date.now() < deadline && ws.readyState === 1) {
    ws.send(Buffer.alloc(3200));
    await sleep(100);
    if (finals.length > seen) { seen = finals.length; deadline = Date.now() + 1200; }
  }
  const got = finals.slice(before);
  for (const f of got) { f.ms_after_line_audio = f.at - lastAudioAt; delete f.at; }
  const text = got.map((f) => f.text).join(' ');
  if (!text) { console.log(`${line.id}: no final turn (socket ${ws.readyState})`, JSON.stringify(log.errors), JSON.stringify(log.close)); log.turns.push({ id: line.id, said: line.text, heard: '', finals: [] }); continue; }
  const r = await api(`/api/session/${session.sessionId}/utterance`, { text, meta: { item_id: `turn_${got[0]?.order ?? 'x'}`, via: 'realtime' } });
  if (!r.reply) { console.log(`${line.id}: server error`, JSON.stringify(r)); break; }
  const turn = { id: line.id, said: line.text, heard: text, finals: got, reply: r.reply, step: r.step, grounding: r.grounding, listen: r.listen };
  log.turns.push(turn);
  console.log(`${line.id} said : ${line.text}\n   heard: ${text}  [${got.map((f) => `${f.lang}/${f.ms_after_line_audio}ms`).join(', ')}]\n   agent: ${r.reply.slice(0, 90)}${r.grounding ? `\n   grounding: ${JSON.stringify(r.grounding)}` : ''}`);
  if (useUpdates && r.listen) {
    const msg = updateConfigMessage(r.listen);
    if (msg) { ws.send(JSON.stringify(msg)); log.updates.push({ after: line.id, ...msg }); }
  }
  await silence(1500); // the agent is "speaking" (half-duplex: the mic sends silence)
}

const { rows } = await api(`/api/session/${session.sessionId}/ledger`);
log.ledger = rows.map((r) => ({ label: r.label, source: r.source, status: r.status, phrase: r.phrase, item_id: r.item_id, via: r.via, t: r.t }));
log.terminateSentAt = Date.now();
ws.send(JSON.stringify({ type: 'Terminate' }));
await new Promise((r) => { const t = setTimeout(r, 5000); ws.addEventListener('close', () => { clearTimeout(t); r(); }); });
delete log.terminateSentAt;
const target = rows.find((r) => r.source === 'owner' && r.status === 'confirmed');
log.result = { target_label: target?.label || null, pass: target?.label === '사십팔만 원 · ₩480,000 · confirmed' };
console.log('\nledger:', log.ledger.map((r) => r.label).join(' | '));
console.log('updates sent:', log.updates.length, 'errors:', JSON.stringify(log.errors), 'termination:', JSON.stringify(log.termination), 'close:', JSON.stringify(log.close));
console.log('RESULT', JSON.stringify(log.result));
if (outPath) fs.writeFileSync(outPath, JSON.stringify(log, null, 1));
app.server.close();
process.exit(0);
