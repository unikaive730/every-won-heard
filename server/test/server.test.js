import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../index.js';
import { createMcpClient } from '../lib/mcp.js';
import { createAssemblyAI } from '../lib/assemblyai.js';

const mock = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8'));
const quiet = { warn() {}, error() {}, log() {} };

// MCP that is "down" -> mock catalog; AssemblyAI without key
const mcpDown = createMcpClient({ fetchImpl: async () => { throw new Error('down'); }, mock, logger: quiet });
const noKey = createApp({ assemblyai: createAssemblyAI({ apiKey: '' }), mcp: mcpDown, llm: null, logger: quiet });

// AssemblyAI with a fake key and a fake API
const fakeAai = createAssemblyAI({
  apiKey: 'fake',
  sleep: async () => {},
  fetchImpl: async (url, init = {}) => {
    const u = String(url);
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (u.startsWith('https://streaming.assemblyai.com/v3/token')) return ok({ token: 'tmp-abc', expires_in_seconds: 60 });
    if (u.endsWith('/upload')) return ok({ upload_url: 'https://cdn/u' });
    if (u.endsWith('/transcript') && init.method === 'POST') return ok({ id: 'tx', status: 'queued' });
    if (u.endsWith('/transcript/tx')) return ok({ id: 'tx', status: 'completed', text: '강남에서 카페 해요 월 50만원 리뷰가 없어요', language_code: 'ko', utterances: [{ speaker: 'A', text: '강남에서 카페 해요 월 50만원 리뷰가 없어요', start: 0, end: 5000 }] });
    throw new Error(`unexpected ${u}`);
  },
});
const withKey = createApp({ assemblyai: fakeAai, mcp: mcpDown, llm: null, logger: quiet });

const servers = [];
async function listen(app) {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  servers.push(app.server);
  return `http://127.0.0.1:${app.server.address().port}`;
}
after(() => { for (const s of servers) s.close(); });

const base1 = await listen(noKey);
const base2 = await listen(withKey);

test('GET /api/health reports missing key, rules mode and mock catalog', async () => {
  const r = await fetch(`${base1}/api/health`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.assemblyai.configured, false);
  assert.equal(j.llm.configured, false);
  assert.equal(j.mcp.catalogSource, 'mock');
  assert.equal(j.mcp.reachable, false);
  assert.equal(j.mcp.products, 6, "the committed snapshot is the demo allowlist");
});

test('GET /api/assemblyai/token -> 503 no_key without a key, token with one', async () => {
  const r1 = await fetch(`${base1}/api/assemblyai/token`);
  assert.equal(r1.status, 503);
  assert.equal((await r1.json()).error, 'no_key');
  const r2 = await fetch(`${base2}/api/assemblyai/token`);
  assert.equal(r2.status, 200);
  const j = await r2.json();
  assert.equal(j.token, 'tmp-abc');
  assert.equal(j.expires_in_seconds, 60);
});

test('text session flow: create -> utterances -> plan -> snapshot; checkout fails honestly when MCP is down', async () => {
  const c = await fetch(`${base1}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'ko' }) });
  const { sessionId, greeting } = await c.json();
  assert.ok(sessionId);
  assert.match(greeting, /마켓파일럿/);
  const say = async (text) => (await fetch(`${base1}/api/session/${sessionId}/utterance`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })).json();
  await say('성수동 카페예요');
  await say('월 30만원');
  const r = await say('손님이 없어요');
  assert.equal(r.stage, 'plan');
  assert.ok(r.plan.total_cost <= 300_000);
  const snap = await (await fetch(`${base1}/api/session/${sessionId}`)).json();
  assert.equal(snap.plan.budget_krw, 300_000);
  assert.equal(snap.history.length, 7);
  const co = await fetch(`${base1}/api/session/${sessionId}/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customerName: '테스트' }) });
  assert.equal(co.status, 502);
  const cj = await co.json();
  assert.equal(cj.error, 'checkout_failed');
  assert.equal(cj.mock, true);
});

test('voice-turn (Korean turn mode) transcribes the WAV and answers; analyze builds a brief', async () => {
  const c = await fetch(`${base2}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lang: 'ko' }) });
  const { sessionId } = await c.json();
  const wav = new Uint8Array(4000);
  const vt = await fetch(`${base2}/api/session/${sessionId}/voice-turn`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: wav });
  assert.equal(vt.status, 200);
  const j = await vt.json();
  assert.match(j.transcript, /카페/);
  assert.equal(j.stage, 'plan', 'one rich sentence filled every slot');
  const an = await fetch(`${base2}/api/session/${sessionId}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: wav });
  assert.equal(an.status, 200);
  const a = await an.json();
  assert.equal(a.brief.owner_speaker, 'A');
  assert.ok(a.brief.problem_keys.includes('reviews'));
  const tooShort = await fetch(`${base2}/api/session/${sessionId}/voice-turn`, { method: 'POST', body: new Uint8Array(10) });
  assert.equal(tooShort.status, 400);
});

test('unknown session and unknown route are 404', async () => {
  assert.equal((await fetch(`${base1}/api/session/nope`)).status, 404);
  assert.equal((await fetch(`${base1}/api/whatever`)).status, 404);
});
