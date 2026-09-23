import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPlan, chooseChannels, checkoutItems, DEFAULT_BUDGET_KRW } from '../lib/planner.js';
import { emptyProfile, mergeProfile, extractSlots } from '../lib/extract.js';

const mock = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8'));
const catalog = mock.products;

function profileFrom(lang, ...utterances) {
  let p = emptyProfile(lang);
  for (const u of utterances) p = mergeProfile(p, extractSlots(u));
  return p;
}

test('local cafe plan: total never exceeds budget, quantities respect min/max, checklist is concrete', () => {
  const p = profileFrom('ko', '강남 카페예요', '월 50만원', '리뷰가 없어요');
  const plan = buildPlan(p, catalog, { catalogSource: 'mock' });
  assert.equal(plan.language, 'ko');
  assert.equal(plan.budget_krw, 500_000);
  assert.ok(plan.total_cost <= plan.budget_krw, `total ${plan.total_cost} <= ${plan.budget_krw}`);
  assert.ok(plan.total_cost >= plan.budget_krw * 0.7, 'most of the budget is used');
  assert.ok(plan.channels.length >= 2);
  for (const ch of plan.channels) {
    for (const it of ch.items) {
      assert.ok(it.qty >= (it.minOrderUnit || 1), `${it.name} qty ${it.qty} >= min ${it.minOrderUnit}`);
      if (it.maxOrderUnit) assert.ok(it.qty <= it.maxOrderUnit);
      assert.equal(it.cost, it.qty * it.unitPrice);
    }
    assert.equal(ch.cost, ch.items.reduce((a, b) => a + b.cost, 0));
  }
  const sum = plan.channels.reduce((a, c) => a + c.cost, 0);
  assert.equal(sum, plan.total_cost);
  assert.ok(plan.channels.some((c) => c.key === 'naver_place'));
  assert.ok(plan.channels.some((c) => c.key === 'receipt_reviews'), 'review problem keeps receipt reviews in');
  assert.ok(plan.checklist.length >= 4);
  assert.ok(plan.checklist.some((l) => l.includes('강남')), 'checklist uses the location');
  assert.ok(plan.summary.includes('500,000원'));
  assert.equal(plan.assumptions.length, 0);
});

test('problems shift the mix: instagram problem raises instagram share', () => {
  const base = chooseChannels({ business_type: 'cafe', problems: [] });
  const insta = chooseChannels({ business_type: 'cafe', problems: ['instagram'] });
  const share = (arr) => arr.find((c) => c.key === 'instagram').share;
  assert.ok(share(insta) > share(base));
  const total = insta.reduce((a, c) => a + c.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('no budget: default assumed and reported in assumptions and summary (English)', () => {
  const p = profileFrom('en', 'we opened a pilates studio in Pangyo and need more members');
  const plan = buildPlan(p, catalog);
  assert.equal(plan.budget_krw, DEFAULT_BUDGET_KRW);
  assert.ok(plan.assumptions[0].includes('assumed'));
  assert.ok(plan.summary.includes('did not mention a budget'));
  assert.ok(plan.total_cost <= DEFAULT_BUDGET_KRW);
  assert.ok(plan.checklist.some((l) => /Naver Place/.test(l)));
});

test('app business uses installs/reviews/press, ecommerce lists inquiry-only products', () => {
  const app = buildPlan(profileFrom('en', 'we have a mobile app for tutoring, budget 2 million won, need downloads'), catalog);
  assert.ok(app.channels.some((c) => c.key === 'app_installs'));
  assert.ok(app.channels.some((c) => c.key === 'app_reviews'));
  const shop = buildPlan(profileFrom('ko', '스마트스토어에서 화장품 팔아요 월 100만원 검색에 안 떠요'), catalog);
  assert.ok(shop.channels.some((c) => c.key === 'search_traffic'));
  assert.ok(shop.inquiry_items.length >= 1, 'inquiry-only products are surfaced, not priced');
  assert.ok(shop.inquiry_items.every((i) => !('cost' in i)));
});

test('tiny budget still produces a valid plan and never goes negative', () => {
  const plan = buildPlan(profileFrom('ko', '홍대 술집 월 5만원 손님이 없어요'), catalog);
  assert.ok(plan.total_cost <= 50_000);
  assert.ok(plan.total_cost >= 0);
});

test('checkoutItems maps plan to MCP create_checkout items', () => {
  const plan = buildPlan(profileFrom('ko', '성수 카페 월 30만원 리뷰'), catalog);
  const items = checkoutItems(plan);
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.equal(typeof it.productId, 'number');
    assert.ok(it.quantity >= 1);
  }
});
