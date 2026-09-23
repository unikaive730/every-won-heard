import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgent, greeting } from '../lib/agent.js';

const mock = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8'));
const getCatalog = async () => ({ source: 'mock', products: mock.products });

test('rule-based Korean call: greeting -> slot questions -> priced plan -> confirmation', async () => {
  const agent = createAgent({ llm: null, getCatalog, searchPlaces: async () => ({ places: [{ placeId: '1', name: '테스트 카페', roadAddress: '강남대로 1' }] }), logger: { warn() {} } });
  const s = agent.createSession({ lang: 'ko' });
  assert.equal(s.history[0].text, greeting('ko'));

  let r = await agent.handleUtterance(s.id, '강남에서 카페를 하고 있어요');
  assert.equal(r.source, 'rules');
  assert.equal(r.profile.business_type, 'cafe');
  assert.equal(r.profile.location, '강남');
  assert.match(r.reply, /예산/);

  r = await agent.handleUtterance(s.id, '한 달에 50만원 정도요');
  assert.equal(r.profile.budget_krw, 500_000);
  assert.match(r.reply, /고민/);

  r = await agent.handleUtterance(s.id, '리뷰가 거의 없어서 검색에 안 떠요');
  assert.equal(r.stage, 'plan');
  assert.equal(r.planJustMade, true);
  assert.ok(r.plan.total_cost <= 500_000);
  assert.match(r.reply, /30일 계획/);
  assert.ok(r.placeCandidates.length === 1, 'Naver Place lookup ran once location + type were known');

  r = await agent.handleUtterance(s.id, '네 진행할게요');
  assert.equal(r.stage, 'confirmed');
  assert.match(r.reply, /결제 링크/);
});

test('rule-based English call: unknown utterance re-prompts, budget change re-plans', async () => {
  const agent = createAgent({ llm: null, getCatalog, logger: { warn() {} } });
  const s = agent.createSession({ lang: 'en' });
  let r = await agent.handleUtterance(s.id, 'hmm hello');
  assert.match(r.reply, /didn't catch/);
  r = await agent.handleUtterance(s.id, 'I sell skincare on my online store, about $500 a month, not showing up in search');
  assert.equal(r.stage, 'plan', 'online store needs no location, so one sentence is enough');
  assert.equal(r.plan.budget_krw, 675_000);
  r = await agent.handleUtterance(s.id, 'actually make it 1 million won');
  assert.equal(r.planJustMade, true);
  assert.equal(r.plan.budget_krw, 1_000_000);
  assert.match(r.reply, /re-planned/);
});

test('with an LLM: its reply is used, its profile merged, plan attached when ready; LLM failure falls back to rules', async () => {
  let ready = false;
  const llm = {
    agentTurn: async ({ history }) => {
      if (history.at(-1).text === 'fail') return null;
      return { reply: 'LLM says hi.', profile: { business_type: 'restaurant', location: '홍대', budget_krw: 400_000, problems: ['low_traffic'], store_name: null }, ready_for_plan: ready, owner_confirmed_plan: false };
    },
  };
  const agent = createAgent({ llm, getCatalog, logger: { warn() {} } });
  const s = agent.createSession({ lang: 'ko' });
  let r = await agent.handleUtterance(s.id, '홍대 식당이에요');
  assert.equal(r.source, 'llm');
  assert.equal(r.profile.business_type, 'restaurant');
  assert.equal(r.profile.budget_krw, 400_000);
  // all slots now known -> planner runs even though the LLM did not flag ready_for_plan
  assert.equal(r.stage, 'plan');
  assert.match(r.reply, /^LLM says hi\./);
  assert.match(r.reply, /30일 계획/);
  ready = true;
  r = await agent.handleUtterance(s.id, 'fail');
  assert.equal(r.source, 'rules');
});
