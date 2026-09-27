import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../index.js';
import { createMcpClient } from '../lib/mcp.js';
import { createAssemblyAI } from '../lib/assemblyai.js';
import { createAgent } from '../lib/agent.js';
import { listenFor } from '../lib/listen.js';

const mock = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8'));
const quiet = { warn() {}, error() {}, log() {} };
const catalog = async () => ({ source: 'mock', products: mock.products });

// K1-K3 from the demo script (design section 8), as 3.6 Pro formats them (numbers as digits)
const K1 = '망원시장 근처에서 라멘집 하는데요, 평일 점심이 너무 비어요.';
const K2 = '블로그 체험단은 해 봤고요, 예산은 한 달에 50, 아니 48만 원 정도요.';
const K3 = '네, 맞아요.';

test('Korean realtime path: K1-K3 end with 사십팔만 원 · ₩480,000 · confirmed and a plan within budget', async () => {
  const ag = createAgent({ getCatalog: catalog, logger: quiet });
  const s = ag.createSession({ lang: 'ko', engine: 'realtime' });
  assert.equal(s.listen.step, 'intake');
  assert.match(s.listen.agent_context, /마켓파일럿/, 'the greeting is the first agent_context');

  const r1 = await ag.handleUtterance(s.id, K1, { meta: { item_id: 'turn_0' } });
  assert.equal(r1.step, 'budget');
  assert.equal(r1.profile.business_type, 'restaurant');
  assert.equal(r1.profile.location, '망원');
  assert.ok(r1.profile.problems.includes('low_traffic'), '평일 점심이 비어요 is a traffic problem');
  assert.match(r1.reply, /예산/);
  assert.equal(r1.listen.mode, 'max_accuracy');
  assert.ok(r1.listen.keyterms_prompt.includes('만 원'));
  assert.equal(r1.listen.agent_context, r1.reply, 'the question about to be read is the next agent_context');

  const r2 = await ag.handleUtterance(s.id, K2, { meta: { item_id: 'turn_1' } });
  assert.equal(r2.step, 'confirm');
  assert.match(r2.reply, /월 48만 원, 맞으세요\?/);
  assert.equal(r2.grounding.amount_krw, 480_000);
  assert.equal(r2.ledger.length, 1);
  assert.equal(r2.ledger[0].status, 'read_back');
  assert.equal(r2.ledger[0].item_id, 'turn_1');
  assert.equal(r2.ledger[0].phrase, '48만');
  assert.equal(r2.profile.budget_krw, null, 'not the budget until the owner says yes');

  const r3 = await ag.handleUtterance(s.id, K3, { meta: { item_id: 'turn_2' } });
  assert.equal(r3.step, 'plan');
  assert.ok(r3.planJustMade);
  const row = r3.ledger.find((r) => r.source === 'owner');
  assert.equal(row.label, '사십팔만 원 · ₩480,000 · confirmed');
  assert.ok(row.t.heard <= row.t.read_back && row.t.read_back <= row.t.confirmed);
  assert.equal(r3.profile.budget_krw, 480_000);
  assert.ok(r3.plan.total_cost <= 480_000);
  assert.equal(r3.ledger.find((r) => r.kind === 'plan_total').value_krw, r3.plan.total_cost);
  assert.equal(r3.listen.step, 'plan');
  assert.ok(r3.listen.keyterms_prompt.includes('보도자료'));
});

test('Korean realtime path: a range is rejected and asked again, "아니요" sends the owner back', async () => {
  const ag = createAgent({ getCatalog: catalog, logger: quiet });
  const s = ag.createSession({ lang: 'ko', engine: 'realtime' });
  await ag.handleUtterance(s.id, '성수동에서 카페 해요. 리뷰가 없어요.');
  const r1 = await ag.handleUtterance(s.id, '한 달에 사오십만 원 정도요');
  assert.equal(r1.grounding.error, 'ambiguous_amount');
  assert.match(r1.reply, /40만 원과 50만 원 중 어느 쪽/);
  assert.equal(r1.ledger[0].label, 'range · ₩400,000 / ₩500,000 · not accepted');
  const r2 = await ag.handleUtterance(s.id, '40만 원이요');
  assert.match(r2.reply, /월 40만 원, 맞으세요/);
  const r3 = await ag.handleUtterance(s.id, '아니요');
  assert.equal(r3.step, 'budget');
  assert.equal(r3.ledger.find((r) => r.value_krw === 400_000).status, 'rejected');
  const r4 = await ag.handleUtterance(s.id, '30만 원으로 할게요');
  assert.match(r4.reply, /월 30만 원, 맞으세요/);
  const r5 = await ag.handleUtterance(s.id, '네 맞아요');
  assert.equal(r5.profile.budget_krw, 300_000);
  assert.ok(r5.plan.total_cost <= 300_000);
});

test('Korean realtime path: a menu price in the intake step is not taken as a budget', async () => {
  const ag = createAgent({ getCatalog: catalog, logger: quiet });
  const s = ag.createSession({ lang: 'ko', engine: 'realtime' });
  const r = await ag.handleUtterance(s.id, '망원동 라멘집인데 한 그릇에 12,000원 받아요');
  assert.equal(r.grounding, null);
  assert.equal(r.ledger.length, 0);
});

test('listenFor: steps map to key terms and accuracy mode, no brand names', () => {
  const b = listenFor('budget', 'ko', '예산은요?');
  assert.equal(b.mode, 'max_accuracy');
  assert.equal(listenFor('plan', 'ko').mode, 'balanced');
  for (const step of ['intake', 'budget', 'plan']) {
    for (const lang of ['ko', 'en']) {
      const terms = listenFor(step, lang).keyterms_prompt;
      assert.ok(terms.length > 0 && terms.length <= 100);
      assert.ok(terms.every((t) => t.length <= 50));
      assert.ok(!terms.some((t) => /네이버|인스타|카카오|naver|instagram|kakao|google/i.test(t)), `${step}/${lang} has a brand name`);
    }
  }
});

// --- over HTTP, the same calls the browser makes ---
const app = createApp({ assemblyai: createAssemblyAI({ apiKey: '' }), mcp: createMcpClient({ fetchImpl: async () => { throw new Error('down'); }, mock, logger: quiet }), llm: null, logger: quiet });
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
after(() => app.server.close());
const post = async (p, body) => (await fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();

test('HTTP: POST /api/session {engine:"realtime"} -> utterances -> GET ledger', async () => {
  const s = await post('/api/session', { lang: 'ko', engine: 'realtime' });
  assert.equal(s.engine, 'realtime');
  assert.equal(s.listen.step, 'intake');
  await post(`/api/session/${s.sessionId}/utterance`, { text: K1, meta: { item_id: 'turn_0', via: 'realtime' } });
  await post(`/api/session/${s.sessionId}/utterance`, { text: K2, meta: { item_id: 'turn_1', via: 'realtime' } });
  const r3 = await post(`/api/session/${s.sessionId}/utterance`, { text: K3, meta: { item_id: 'turn_2', via: 'realtime' } });
  assert.equal(r3.step, 'plan');
  const { rows } = await (await fetch(`${base}/api/session/${s.sessionId}/ledger`)).json();
  const owner = rows.filter((r) => r.source === 'owner');
  assert.equal(owner.length, 1);
  assert.equal(owner[0].label, '사십팔만 원 · ₩480,000 · confirmed');
  assert.equal(owner[0].via, 'realtime');
  const snap = await (await fetch(`${base}/api/session/${s.sessionId}`)).json();
  assert.equal(snap.engine, 'realtime');
  assert.equal(snap.ledger.length, rows.length);
});

test('HTTP: POST aai-session stores the Voice Agent session id and validates it', async () => {
  const s = await post('/api/session', { lang: 'en', engine: 'voice-agent' });
  const bad = await fetch(`${base}/api/session/${s.sessionId}/aai-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aai_session_id: 'x y' }) });
  assert.equal(bad.status, 400);
  const ok = await post(`/api/session/${s.sessionId}/aai-session`, { aai_session_id: 'sess_9a648a2ab75747a9' });
  assert.equal(ok.ok, true);
  const snap = await (await fetch(`${base}/api/session/${s.sessionId}`)).json();
  assert.equal(snap.aaiSessionId, 'sess_9a648a2ab75747a9');
});
