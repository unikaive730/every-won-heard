import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reconcile, reconcileTurns } from '../lib/brief.js';
import { createLedger } from '../lib/ledger.js';
import { createApp } from '../index.js';
import { createMcpClient } from '../lib/mcp.js';
import { createAssemblyAI } from '../lib/assemblyai.js';

// timeline shape from the Sessions API docs (session-history): empty arrays are omitted
const timeline = {
  session_id: 'sess_test123',
  started_at_unix_ms: 1768413867285,
  turns: [
    { turn_id: 'resp_0', item_id: 'msg_0', status: 'completed', trigger: 'greeting', user_transcript: null, agent_text: 'Hi, what kind of shop do you run?', time_to_first_audio_ms: 900 },
    { turn_id: 'resp_1', item_id: 'msg_1', status: 'completed', trigger: 'user_speech', user_transcript: 'Maybe four or five hundred thousand won a month.', user_confidence: 0.93, agent_text: 'Which one should I plan for?', time_to_first_audio_ms: 1300,
      tool_calls: [{ call_id: 'call_a', name: 'record_budget', arguments: { amount_krw: 400000, owner_words: 'four or five hundred thousand', period: 'monthly' }, result: '{"error":"ambiguous_amount"}', is_error: true, duration_ms: 40 }] },
    { turn_id: 'resp_2', item_id: 'msg_2', status: 'completed', trigger: 'user_speech', user_transcript: 'Four hundred eighty thousand.', user_confidence: 0.97, agent_text: 'Four hundred eighty thousand won a month, is that right?', time_to_first_audio_ms: 1100,
      tool_calls: [{ call_id: 'call_b', name: 'record_budget', arguments: { amount_krw: 480000, owner_words: 'four hundred eighty thousand', period: 'monthly' }, result: '{"ok":true}', is_error: false, duration_ms: 35 }] },
    { turn_id: 'resp_3', item_id: 'msg_3', status: 'completed', trigger: 'user_speech', user_transcript: "Yes, that's right.", user_confidence: 0.99, agent_text: 'Great.', time_to_first_audio_ms: 1500 },
    { turn_id: 'resp_4', item_id: 'msg_4', status: 'interrupted', trigger: 'user_speech' },
  ],
};

function ledgerWith(values) {
  const l = createLedger({ lang: 'en' });
  l.addRejected({ reason: 'range', options: [400000, 500000] });
  for (const [v, status, item] of values) {
    const r = l.addHeard({ value_krw: v, item_id: item });
    if (status === 'confirmed') l.confirm(r.id);
  }
  return l.snapshot();
}

test('reconcile: confirmed amounts are matched to the AssemblyAI timeline, rejected tool calls counted', () => {
  const rows = ledgerWith([[480000, 'confirmed', 'item_x']]);
  const r = reconcile(rows, timeline);
  assert.equal(r.record, 'assemblyai_session');
  assert.equal(r.session_id, 'sess_test123');
  assert.equal(r.confirmed_amounts, 1);
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].turn_id, 'resp_2');
  assert.equal(r.matched[0].tool_call_id, 'call_b');
  assert.equal(r.matched[0].user_confidence, 0.97);
  assert.equal(r.unmatched.length, 0);
  assert.equal(r.rejected_calls, 1);
  assert.equal(r.tool_calls, 2);
  assert.equal(r.turns, 5);
  assert.equal(r.median_time_to_first_audio_ms, 1200);
});

test('reconcile: an amount the timeline never heard is unmatched; item_id match is preferred', () => {
  const rows = ledgerWith([[480000, 'confirmed', 'msg_2'], [380000, 'confirmed', 'msg_9']]);
  const r = reconcile(rows, timeline);
  assert.equal(r.matched[0].matched_by, 'item_id');
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0].value_krw, 380000);
  assert.equal(r.unmatched[0].reason, 'not_in_timeline');
  const empty = reconcile(rows, { session_id: 's' }); // no one spoke: no `turns` key at all
  assert.equal(empty.turns, 0);
  assert.equal(empty.median_time_to_first_audio_ms, null);
});

test('reconcileTurns (Korean path): rows checked against the 3.6 Pro final turns', () => {
  const l = createLedger({ lang: 'ko' });
  l.addRejected({ reason: 'range', options: [400000, 500000] });
  const r1 = l.addHeard({ value_krw: 480000, item_id: 'turn_2' });
  l.confirm(r1.id);
  const rec = reconcileTurns(l.snapshot(), [{ item_id: 'turn_1', text: '사오십만 원이요' }, { item_id: 'turn_2', text: '예산은 한 달에 50, 아니 48만 원 정도요.' }]);
  assert.equal(rec.record, 'streaming_turns');
  assert.equal(rec.matched.length, 1);
  assert.equal(rec.matched[0].matched_by, 'item_id');
  assert.equal(rec.rejected_calls, 1);
});

// --- GET /api/session/:id/receipt with a fake Sessions API ---
const mock = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8'));
const quiet = { warn() {}, error() {}, log() {} };
let sessionPolls = 0;
const fakeAai = createAssemblyAI({
  apiKey: 'fake',
  sleep: async () => {},
  fetchImpl: async (url, init = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (u === 'https://agents.assemblyai.com/v1/sessions/sess_test123') {
      assert.equal(init.headers.Authorization, 'fake');
      sessionPolls += 1;
      // artifacts appear only after the session completes: empty on the first poll
      return ok(sessionPolls < 2 ? { id: 'sess_test123', status: 'active', artifacts: [] } : { id: 'sess_test123', status: 'completed', artifacts: [{ type: 'timeline', url: 'https://s3.example/timeline.json?sig=1', content_type: 'application/json' }] });
    }
    if (u === 'https://agents.assemblyai.com/v1/sessions/sess_missing') return { ok: false, status: 404, json: async () => ({}) };
    if (u.startsWith('https://s3.example/timeline.json')) {
      assert.equal(init.headers, undefined, 'pre-signed artifact URLs are fetched without the API key');
      return ok(timeline);
    }
    throw new Error(`unexpected ${u}`);
  },
});
const app = createApp({ assemblyai: fakeAai, mcp: createMcpClient({ fetchImpl: async () => { throw new Error('down'); }, mock, logger: quiet }), llm: null, gateway: null, receiptPoll: { intervalMs: 1, tries: 3 }, logger: quiet });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
after(() => app.server.close());
const post = async (p, body) => (await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

test('GET receipt: polls the Sessions API until the timeline exists, reconciles, adds a template summary', async () => {
  const s = await post('/api/session', { lang: 'en', engine: 'voice-agent' });
  const session = app.agent.getSession(s.sessionId);
  const row = session.ledger.addHeard({ value_krw: 480000, item_id: 'msg_2', via: 'voice-agent' });
  session.ledger.confirm(row.id);
  await post(`/api/session/${s.sessionId}/aai-session`, { aai_session_id: 'sess_test123' });
  const r = await (await fetch(`${base}/api/session/${s.sessionId}/receipt`)).json();
  assert.equal(r.polls, 2);
  assert.equal(r.matched.length, 1);
  assert.equal(r.rejected_calls, 1);
  assert.equal(r.summary.source, 'template');
  assert.match(r.summary.text, /₩480,000 a month/);
  const again = await (await fetch(`${base}/api/session/${s.sessionId}/receipt`)).json();
  assert.equal(again.polls, 2, 'cached: no second round of polling');
});

test('GET receipt: unknown AssemblyAI session is a 404; a Korean call uses its own turns', async () => {
  const s = await post('/api/session', { lang: 'en', engine: 'voice-agent' });
  await post(`/api/session/${s.sessionId}/aai-session`, { aai_session_id: 'sess_missing' });
  assert.equal((await fetch(`${base}/api/session/${s.sessionId}/receipt`)).status, 404);
  const k = await post('/api/session', { lang: 'ko', engine: 'realtime' });
  await post(`/api/session/${k.sessionId}/utterance`, { text: '망원시장 근처 라멘집인데 평일 점심이 비어요' });
  await post(`/api/session/${k.sessionId}/utterance`, { text: '예산은 한 달에 48만 원이요' });
  await post(`/api/session/${k.sessionId}/utterance`, { text: '네 맞아요' });
  const r = await (await fetch(`${base}/api/session/${k.sessionId}/receipt`)).json();
  assert.equal(r.record, 'streaming_turns');
  assert.equal(r.confirmed_amounts, 1);
  assert.equal(r.matched.length, 1);
  assert.match(r.summary.text, /월 48만 원/);
});
