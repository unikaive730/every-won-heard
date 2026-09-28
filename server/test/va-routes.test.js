import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../index.js';
import { createMcpClient } from '../lib/mcp.js';
import { createAssemblyAI } from '../lib/assemblyai.js';
import { reconcile } from '../lib/brief.js';

const mock = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8'));
const quiet = { warn() {}, error() {}, log() {} };
const mcpDown = () => createMcpClient({ fetchImpl: async () => { throw new Error('down'); }, mock, logger: quiet });

const tokenCalls = [];
let tokenStatus = 200;
const fakeAai = createAssemblyAI({
  apiKey: 'fake-key',
  sleep: async () => {},
  fetchImpl: async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://agents.assemblyai.com/v1/token')) {
      tokenCalls.push({ url: new URL(u), auth: init.headers?.Authorization });
      if (tokenStatus !== 200) return { ok: false, status: tokenStatus, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ token: 'va-tmp', expires_in_seconds: 60 }) };
    }
    throw new Error(`unexpected ${u}`);
  },
});

const servers = [];
async function listen(app) {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  servers.push(app.server);
  return `http://127.0.0.1:${app.server.address().port}`;
}
after(() => { for (const s of servers) s.close(); });

const stored = await listen(createApp({ assemblyai: fakeAai, mcp: mcpDown(), llm: null, gateway: null, voiceAgentId: 'agent-123', demoMode: true, logger: quiet }));
const inline = await listen(createApp({ assemblyai: fakeAai, mcp: mcpDown(), llm: null, gateway: null, voiceAgentId: 'agent-123', vaConnect: 'inline', demoMode: true, logger: quiet }));
const noKey = await listen(createApp({ assemblyai: createAssemblyAI({ apiKey: '' }), mcp: mcpDown(), llm: null, gateway: null, logger: quiet }));

const post = async (base, p, body) => {
  const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

test('GET /api/voice-agent/token: Bearer key, 60 s to connect, 240 s session cap; 503 without a key; 429 passes through', async () => {
  const r = await fetch(`${stored}/api/voice-agent/token`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.token, 'va-tmp');
  assert.equal(j.agent_id, 'agent-123');
  assert.equal(j.max_session_duration_seconds, 240);
  const c = tokenCalls.at(-1);
  assert.equal(c.auth, 'Bearer fake-key');
  assert.equal(c.url.searchParams.get('expires_in_seconds'), '60');
  assert.equal(c.url.searchParams.get('max_session_duration_seconds'), '240');
  assert.equal((await fetch(`${noKey}/api/voice-agent/token`)).status, 503);
  tokenStatus = 429;
  const limited = await fetch(`${stored}/api/voice-agent/token`);
  tokenStatus = 200;
  assert.equal(limited.status, 429);
  assert.ok(!JSON.stringify(await limited.json()).includes('fake-key'), 'the key never reaches the page');
});

test('POST /api/session engine voice-agent: English, s0, first session.update binds the stored agent or goes inline', async () => {
  const a = await post(stored, '/api/session', { lang: 'ko', engine: 'voice-agent' });
  assert.equal(a.body.lang, 'en');
  assert.equal(a.body.state, 's0');
  assert.equal(a.body.connect, 'stored');
  assert.deepEqual(a.body.session_update, { agent_id: 'agent-123' });
  const b = await post(inline, '/api/session', { engine: 'voice-agent' });
  assert.equal(b.body.connect, 'inline');
  assert.equal(b.body.agentId, null);
  assert.deepEqual(b.body.session_update.tools.map((t) => t.name), ['record_shop', 'end_call']);
  assert.match(b.body.session_update.greeting, /MarketPilot/);
  assert.equal(b.body.session_update.output.voice, 'alba');
});

test('POST /heard + /tool: result is a JSON string for tool.result, the next stage comes back as session_update', async () => {
  const { body: s } = await post(stored, '/api/session', { engine: 'voice-agent' });
  const id = s.sessionId;
  assert.equal((await post(stored, `/api/session/${id}/heard`, { item_id: 'u1', text: 'I run a ramen place near Mangwon Market.', at: 1, via: 'voice-agent' })).body.ok, true);
  let t = await post(stored, `/api/session/${id}/tool`, { call_id: 'c1', name: 'record_shop', arguments: { business_type: 'restaurant', neighborhood: 'Mangwon' }, last_item_id: 'u1' });
  assert.equal(t.status, 200);
  assert.equal(typeof t.body.result, 'string');
  assert.equal(JSON.parse(t.body.result).ok, true);
  assert.equal(t.body.state, 's1');
  assert.equal(t.body.state_changed, true);
  assert.equal(t.body.session_update.input.transcription_mode, 'max_accuracy');

  await post(stored, `/api/session/${id}/heard`, { item_id: 'u2', text: 'Maybe 4 or 500,000 won a month.' });
  t = await post(stored, `/api/session/${id}/tool`, { call_id: 'c2', name: 'record_budget', arguments: { owner_words: '4 or 500,000 won a month', period: 'monthly' }, last_item_id: 'u2' });
  assert.equal(t.body.is_error, true);
  assert.equal(JSON.parse(t.body.result).error, 'ambiguous_amount');

  await post(stored, `/api/session/${id}/heard`, { item_id: 'u3', text: '480,000 won a month.' });
  t = await post(stored, `/api/session/${id}/tool`, { call_id: 'c3', name: 'record_budget', arguments: { owner_words: '480,000 won a month', period: 'monthly' }, last_item_id: 'u3' });
  assert.equal(t.body.is_error, false);
  assert.equal(t.body.state, 's2');
  assert.deepEqual(t.body.session_update.tools.map((x) => x.name), ['confirm_budget', 'record_budget', 'end_call']);

  await post(stored, `/api/session/${id}/heard`, { item_id: 'u4', text: "Yes, that's right." });
  await post(stored, `/api/session/${id}/tool`, { call_id: 'c4', name: 'confirm_budget', arguments: { answer: 'yes' }, last_item_id: 'u4' });
  t = await post(stored, `/api/session/${id}/tool`, { call_id: 'c5', name: 'build_plan', arguments: {} });
  assert.equal(JSON.parse(t.body.result).total_krw, 478_000);
  assert.equal(t.body.plan.total_cost, 478_000);

  await post(stored, `/api/session/${id}/heard`, { item_id: 'u5', text: 'Okay. Go ahead.' });
  t = await post(stored, `/api/session/${id}/tool`, { call_id: 'c6', name: 'create_checkout_link', arguments: {}, last_item_id: 'u5' });
  const url = JSON.parse(t.body.result).url;
  assert.match(url, new RegExp(`^http://127\\.0\\.0\\.1:\\d+/demo-checkout/${id}$`));

  const ledger = await (await fetch(`${stored}/api/session/${id}/ledger`)).json();
  assert.deepEqual(ledger.rows.filter((r) => r.source === 'owner').map((r) => r.label), ['range · ₩400,000 / ₩500,000 · not accepted', 'four hundred eighty thousand won · ₩480,000 · confirmed']);
  const snap = await (await fetch(`${stored}/api/session/${id}`)).json();
  assert.deepEqual(snap.va, { state: 's4', calls: 6 });
});

test('POST /heard and /tool reject bad input and non voice-agent sessions', async () => {
  const { body: text } = await post(stored, '/api/session', { lang: 'en' });
  assert.equal((await post(stored, `/api/session/${text.sessionId}/tool`, { name: 'build_plan' })).status, 400);
  assert.equal((await post(stored, `/api/session/${text.sessionId}/heard`, { text: 'hi' })).status, 400);
  const { body: va } = await post(stored, '/api/session', { engine: 'voice-agent' });
  assert.equal((await post(stored, `/api/session/${va.sessionId}/heard`, { text: '' })).status, 400);
  assert.equal((await post(stored, `/api/session/${va.sessionId}/tool`, { arguments: {} })).status, 400);
  assert.equal((await post(stored, '/api/session/nope/tool', { name: 'end_call' })).status, 404);
});

test('receipt: a record_budget call with owner_words only still counts as evidence for the ledger row', () => {
  const rows = [{ id: 'r1', source: 'owner', value_krw: 480_000, status: 'confirmed', item_id: 'item_x' }];
  const timeline = { session_id: 'sess_1', turns: [
    { turn_id: 't1', item_id: '', user_transcript: '480,000 won a month.', tool_calls: [{ call_id: 'call_9', name: 'record_budget', arguments: { owner_words: '480,000 won a month', period: 'monthly' }, result: '{"ok":true,"heard_krw":480000}', is_error: false }] },
  ] };
  const rec = reconcile(rows, timeline);
  assert.equal(rec.matched.length, 1);
  assert.equal(rec.matched[0].tool_call_id, 'call_9');
});
