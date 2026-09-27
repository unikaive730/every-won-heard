import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, rejectReason, fillPlaceholders, parseSummaryReply, maskQuote, buildSummaryMessages, summaryFacts, GATEWAY_URL } from '../lib/gateway.js';
import { createLedger } from '../lib/ledger.js';

function fakeSession() {
  const ledger = createLedger({ lang: 'ko' });
  const r = ledger.addHeard({ value_krw: 480000 });
  ledger.confirm(r.id);
  ledger.addComputed({ kind: 'plan_total', value_krw: 478000 });
  return {
    lang: 'ko',
    profile: { business_type: 'restaurant', location: '망원', problems: ['low_traffic', 'place_rank'], channels_tried: ['blog'] },
    plan: { total_cost: 478000, channels: [{ items: [{}, {}] }, { items: [{}] }] },
    ledger,
    history: [{ role: 'agent', text: '안녕하세요' }, { role: 'user', text: '네이버 플레이스 리뷰가 30개밖에 없어요' }, { role: 'user', text: '예산은 한 달에 50, 아니 48만 원 정도요.' }],
  };
}

function fakeFetch(content, status = 200, seen = []) {
  return async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
    return { ok: status === 200, status, json: async () => (status === 200 ? { choices: [{ message: { content } }], usage: { total_tokens: 300 }, request_id: 'req_1' } : { error: 'nope' }) };
  };
}

test('facts sent to the model carry no amounts and no platform names', () => {
  const facts = summaryFacts(fakeSession());
  assert.deepEqual(facts.values, { budget: 480000, plan_total: 478000, line_count: 3 });
  const msgs = buildSummaryMessages(facts);
  const user = msgs[1].content;
  assert.ok(!/\d/.test(user.replace(/\{[a-z_]+\}/g, '')), user);
  assert.ok(!/네이버|naver/i.test(user));
  assert.match(user, /\{budget\}/);
  assert.equal(maskQuote('예산은 한 달에 50, 아니 48만 원 정도요.'), '예산은 한 달에 [n], 아니 [amount] 정도요.');
});

test('a clean model reply is filled from the ledger (the model never writes the number)', async () => {
  const seen = [];
  const gw = createGateway({ apiKey: 'k', enabled: true, fetchImpl: fakeFetch('<think></think>{"summary": "망원 음식점 사장님은 평일 점심 손님이 부족합니다. 확인한 예산은 {budget}이고 계획 합계는 {plan_total}입니다.", "next_step": "서비스 {line_count}개 계획서를 보냅니다."}', 200, seen), logger: { warn() {} } });
  const r = await gw.summarizeCall(fakeSession());
  assert.equal(r.source, 'llm-gateway');
  assert.equal(r.model, 'qwen3.5-4b-32k-fast');
  assert.match(r.text, /월 48만 원/);
  assert.match(r.text, /47만 8천 원/);
  assert.equal(r.next_step, '서비스 3개 계획서를 보냅니다.');
  assert.equal(seen[0].url, GATEWAY_URL);
  assert.equal(seen[0].auth, 'k');
  assert.equal(seen[0].body.model, 'qwen3.5-4b-32k-fast');
});

test('a reply with a number, a platform name or an unknown placeholder falls back to the template', async () => {
  for (const [content, reason] of [
    ['{"summary": "예산은 48만 원입니다.", "next_step": "연락"}', 'digit'],
    ['{"summary": "예산은 사십팔만 원입니다.", "next_step": "연락"}', 'number_word'],
    ['{"summary": "지도 노출이 약합니다. 네이버에 집중합니다.", "next_step": "연락"}', 'brand_name'],
    ['{"summary": "예산은 {price}입니다.", "next_step": "연락"}', 'unknown_placeholder'],
    ['I cannot help with that.', 'unparsable'],
  ]) {
    const gw = createGateway({ apiKey: 'k', enabled: true, fetchImpl: fakeFetch(content), logger: { warn() {} } });
    const r = await gw.summarizeCall(fakeSession());
    assert.equal(r.source, 'template', content);
    assert.equal(r.reason, reason, content);
    assert.match(r.text, /월 48만 원/);
  }
});

test('401/403/429 turn the model off without retrying; the model is off by default', async () => {
  const seen = [];
  const gw = createGateway({ apiKey: 'k', enabled: true, fetchImpl: fakeFetch('', 429, seen), logger: { warn() {} } });
  const r1 = await gw.summarizeCall(fakeSession());
  assert.equal(r1.reason, 'http_429');
  const r2 = await gw.summarizeCall(fakeSession());
  assert.equal(r2.reason, 'model_off');
  assert.equal(seen.length, 1);
  const off = createGateway({ apiKey: 'k', enabled: false, fetchImpl: () => { throw new Error('should not be called'); } });
  assert.equal((await off.summarizeCall(fakeSession())).reason, 'model_off');
  assert.equal(createGateway({ apiKey: '' }), null);
  assert.equal(createGateway({ apiKey: 'k' }).state.disabled, true, 'off unless CALL_SUMMARY=1');
});

test('helpers: rejectReason, fillPlaceholders, parseSummaryReply', () => {
  assert.equal(rejectReason('확인한 예산은 {budget}입니다.'), null);
  assert.equal(rejectReason('budget is four hundred thousand'), 'number_word');
  assert.equal(fillPlaceholders('{budget} / {plan_total}', { budget: 380000, plan_total: 379000 }, 'en'), '₩380,000 a month / ₩379,000');
  assert.equal(fillPlaceholders('{plan_total}', { plan_total: null }, 'en'), null);
  assert.deepEqual(parseSummaryReply('```json\n{"summary":"a","next_step":"b"}\n```'), { summary: 'a', next_step: 'b' });
  assert.equal(parseSummaryReply('no json'), null);
});
