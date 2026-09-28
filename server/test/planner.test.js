import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildPlan, chooseChannels, checkoutItems, spokenLine, placeName, DEFAULT_BUDGET_KRW, CHANNELS, DEMO_GROUPS } from '../lib/planner.js';
import { emptyProfile, mergeProfile, extractSlots } from '../lib/extract.js';
import { ALLOWED_PRODUCT_IDS, DISPLAY_NAMES, allowlistCatalog, isAllowlistOnly, isDemoMode, displayName } from '../lib/demo.js';

// the full channel mix needs more products than the committed snapshot holds: a fixture with generic names
const full = JSON.parse(await readFile(new URL('./fixtures/catalog-full.json', import.meta.url), 'utf8')).products;
const snapshot = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8')).products;
const catalog = full;

// app and platform names that must never reach the screen or speech (recognition regexes may still know them)
const BRANDS = /네이버|인스타|카카오|구글|유튜브|쿠팡|당근|페이스북|스레드|플레이스|naver|instagram|kakao|google|youtube|coupang|karrot|facebook|threads|reels|릴스/i;

function profileFrom(lang, ...utterances) {
  let p = emptyProfile(lang);
  for (const u of utterances) p = mergeProfile(p, extractSlots(u));
  return p;
}

function spokenText(plan) {
  return [plan.summary, plan.spoken_total, plan.spoken_budget, ...plan.checklist, ...plan.channels.flatMap((c) => [c.label, c.why]), ...plan.lines.flatMap((l) => [l.spoken, l.spoken_cost])].join('\n');
}

function assertConsistent(plan) {
  assert.ok(plan.total_cost <= plan.budget_krw, `total ${plan.total_cost} <= ${plan.budget_krw}`);
  for (const ch of plan.channels) {
    for (const it of ch.items) {
      assert.ok(it.qty >= (it.minOrderUnit || 1), `${it.name} qty ${it.qty} >= min ${it.minOrderUnit}`);
      if (it.maxOrderUnit) assert.ok(it.qty <= it.maxOrderUnit);
      assert.equal(it.cost, it.qty * it.unitPrice);
    }
    assert.equal(ch.cost, ch.items.reduce((a, b) => a + b.cost, 0));
  }
  assert.equal(plan.channels.reduce((a, c) => a + c.cost, 0), plan.total_cost);
  assert.equal(plan.lines.reduce((a, l) => a + l.cost_krw, 0), plan.total_cost);
  assert.equal(plan.total_krw, plan.total_cost);
  assert.equal(plan.unspent_krw, plan.budget_krw - plan.total_cost);
}

// --- channel mix (full catalog) ---

test('local cafe plan: total never exceeds budget, quantities respect min/max, checklist is concrete', () => {
  const p = profileFrom('ko', '강남 카페예요', '월 50만원', '리뷰가 없어요');
  const plan = buildPlan(p, catalog, { catalogSource: 'mock', demo: false });
  assert.equal(plan.template, 'channel_mix');
  assert.equal(plan.language, 'ko');
  assert.equal(plan.budget_krw, 500_000);
  assertConsistent(plan);
  assert.ok(plan.total_cost >= plan.budget_krw * 0.7, 'most of the budget is used');
  assert.ok(plan.channels.length >= 2);
  assert.ok(plan.channels.some((c) => c.key === 'map_listing'));
  assert.ok(plan.channels.some((c) => c.key === 'receipt_reviews'), 'review problem keeps receipt reviews in');
  assert.ok(plan.checklist.length >= 4);
  assert.ok(plan.checklist.some((l) => l.includes('강남')), 'checklist uses the location');
  assert.ok(plan.summary.includes('500,000원'));
  assert.equal(plan.assumptions.length, 0);
});

test('problems shift the mix: photo social problem raises that share', () => {
  const base = chooseChannels({ business_type: 'cafe', problems: [] });
  const social = chooseChannels({ business_type: 'cafe', problems: ['instagram'] });
  const share = (arr) => arr.find((c) => c.key === 'photo_social').share;
  assert.ok(share(social) > share(base));
  const total = social.reduce((a, c) => a + c.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test('no budget: default assumed and reported in assumptions and summary (English, amounts in words)', () => {
  const p = profileFrom('en', 'we opened a pilates studio in Pangyo and need more members');
  const plan = buildPlan(p, catalog, { demo: false });
  assert.equal(plan.budget_krw, DEFAULT_BUDGET_KRW);
  assert.ok(plan.assumptions[0].includes('assumed'));
  assert.ok(plan.summary.includes('did not mention a budget'));
  assert.ok(plan.summary.includes('three hundred thousand won'), plan.summary);
  assert.ok(plan.summary.includes('Pangyo'), 'English plans say the area in English');
  assert.ok(plan.total_cost <= DEFAULT_BUDGET_KRW);
  assert.ok(plan.checklist.some((l) => /map listing/.test(l)));
});

test('app business uses installs/reviews/press, ecommerce lists inquiry-only products', () => {
  const app = buildPlan(profileFrom('en', 'we have a mobile app for tutoring, budget 2 million won, need downloads'), catalog, { demo: false });
  assert.ok(app.channels.some((c) => c.key === 'app_installs'));
  assert.ok(app.channels.some((c) => c.key === 'app_reviews'));
  const shop = buildPlan(profileFrom('ko', '스마트스토어에서 화장품 팔아요 월 100만원 검색에 안 떠요'), catalog, { demo: false });
  assert.ok(shop.channels.some((c) => c.key === 'search_traffic'));
  assert.ok(shop.inquiry_items.length >= 1, 'inquiry-only products are surfaced, not priced');
  assert.ok(shop.inquiry_items.every((i) => !('cost' in i)));
  assert.ok(shop.checklist.some((l) => /문의형 상품 2개/.test(l)), 'the checklist counts inquiry items instead of naming them');
});

test('tiny budget still produces a valid plan and never goes negative', () => {
  const plan = buildPlan(profileFrom('ko', '홍대 술집 월 5만원 손님이 없어요'), catalog, { demo: false });
  assert.ok(plan.total_cost <= 50_000);
  assert.ok(plan.total_cost >= 0);
});

test('checkoutItems maps plan to MCP create_checkout items', () => {
  const plan = buildPlan(profileFrom('ko', '성수 카페 월 30만원 리뷰'), catalog, { demo: false });
  const items = checkoutItems(plan);
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.equal(typeof it.productId, 'number');
    assert.ok(it.quantity >= 1);
  }
});

test('channel labels, reasons and checklists carry no app or platform names (both languages)', () => {
  for (const c of Object.values(CHANNELS)) {
    for (const s of [c.ko, c.en, c.why.ko, c.why.en]) assert.doesNotMatch(s, BRANDS, s);
  }
  const cases = [
    ['ko', '강남 카페예요 월 50만원 리뷰가 없어요 단골이 없어요 외국인 손님'],
    ['en', 'I run a salon in Gangnam, 800,000 won a month, not showing up in search, no followers, tourists, regulars'],
    ['ko', '스마트스토어 화장품 월 100만원 검색에 안 떠요'],
    ['en', 'we have a mobile app, budget 2 million won, need downloads and reviews'],
  ];
  for (const [lang, text] of cases) {
    const plan = buildPlan(profileFrom(lang, text), catalog, { demo: false });
    assert.doesNotMatch(plan.summary, BRANDS, plan.summary);
    for (const l of plan.checklist) assert.doesNotMatch(l, BRANDS, l);
    for (const c of plan.channels) assert.doesNotMatch(c.label, BRANDS, c.label);
  }
});

// --- allowlist template (public demo, design 6-9) ---

test('display names: six allowlisted products, generic English and Korean names, no brands', () => {
  assert.deepEqual([...ALLOWED_PRODUCT_IDS].sort((a, b) => a - b), [106, 112, 142, 249, 251, 282]);
  for (const d of DISPLAY_NAMES.values()) {
    assert.ok(d.en && d.ko && d.unit_ko && d.spoken_en.length === 2);
    assert.ok(DEMO_GROUPS[d.group], `${d.productId} group ${d.group}`);
    for (const s of [d.en, d.ko, ...d.spoken_en]) assert.doesNotMatch(s, BRANDS, s);
  }
  assert.equal(displayName(282, 'en'), 'Map listing audit report');
  assert.equal(displayName(282, 'ko'), '지도 매장정보 진단 보고서');
  assert.equal(displayName(2, 'en', 'fallback'), 'fallback');
});

test('committed catalog snapshot holds only the allowlist, with catalog prices', () => {
  assert.equal(snapshot.length, ALLOWED_PRODUCT_IDS.length);
  assert.ok(isAllowlistOnly(snapshot));
  assert.ok(!isAllowlistOnly(full));
  const price = Object.fromEntries(snapshot.map((p) => [p.productId, p.unitPrice]));
  assert.deepEqual(price, { 282: 100_000, 142: 90_000, 251: 99_000, 106: 9_000, 249: 66_000, 112: 3_000 });
  assert.deepEqual(allowlistCatalog(full).map((p) => p.productId), ALLOWED_PRODUCT_IDS.slice());
});

test('demo plan at 480,000: audit + press + flyer + 21 blog posts = 478,000 (design 6-9), spoken numbers', () => {
  const p = profileFrom('en', 'I run a small ramen place near Mangwon Market, weekday lunch is empty');
  p.budget_krw = 480_000;
  const plan = buildPlan(p, full, { demo: true });
  assert.equal(plan.template, 'allowlist');
  assert.equal(plan.demo, true);
  assertConsistent(plan);
  assert.deepEqual(plan.lines.map((l) => [l.product_id, l.qty]), [[282, 1], [142, 1], [251, 1], [106, 21]]);
  assert.equal(plan.total_cost, 478_000);
  assert.equal(plan.spoken_total, 'four hundred seventy-eight thousand won');
  assert.equal(plan.spoken_budget, 'four hundred eighty thousand won a month');
  assert.equal(plan.lines[0].name, 'Map listing audit report');
  assert.equal(plan.lines[3].spoken, 'twenty-one sponsored blog posts');
  assert.equal(plan.lines[3].spoken_cost, 'one hundred eighty-nine thousand won');
  assert.deepEqual(plan.channels.map((c) => c.key), ['listing', 'press', 'print', 'blog']);
  assert.match(plan.summary, /Mangwon restaurant/);
  assert.match(plan.summary, /for a total of four hundred seventy-eight thousand won/);
  assert.doesNotMatch(plan.summary.replace('30-day', ''), /\d/, 'the English summary has no digits for the voice to mangle');
  assert.equal(plan.inquiry_items.length, 0);
  assert.ok(plan.checklist.at(-1).includes('no payment is taken'));
});

test('demo plan at 380,000: 10 blog posts, total 379,000; Korean names and spoken total', () => {
  const p = profileFrom('ko', '망원시장 라멘집이에요', '평일 점심이 비어요');
  p.budget_krw = 380_000;
  const plan = buildPlan(p, snapshot, { demo: true });
  assertConsistent(plan);
  assert.equal(plan.total_cost, 379_000);
  assert.deepEqual(plan.lines.map((l) => [l.product_id, l.qty]), [[282, 1], [142, 1], [251, 1], [106, 10]]);
  assert.equal(plan.spoken_budget, '월 38만 원');
  assert.equal(plan.spoken_total, '37만 9천 원');
  assert.deepEqual(plan.lines.map((l) => l.name), ['지도 매장정보 진단 보고서', '보도자료 배포(베이직)', '전단지 제작', '블로거 섭외 후기 글']);
  assert.equal(plan.lines[3].spoken, '블로거 섭외 후기 글 10건');
  assert.match(plan.summary, /블로거 섭외 후기 글 10건을 넣었고 총 379,000원입니다/);
  assert.ok(plan.checklist.at(-1).includes('실제 결제 없음'));
});

test('demo plan: total <= budget for every budget from 10,000 to 3,000,000, only allowlisted products', () => {
  for (let b = 10_000; b <= 3_000_000; b += 7_000) {
    for (const lang of ['ko', 'en']) {
      const p = profileFrom(lang, lang === 'ko' ? '연남동 카페' : 'a cafe in Yeonnam');
      p.budget_krw = b;
      const plan = buildPlan(p, full, { demo: true });
      assertConsistent(plan);
      for (const l of plan.lines) assert.ok(DISPLAY_NAMES.has(l.product_id), `${l.product_id} is allowlisted`);
      assert.doesNotMatch(spokenText(plan), BRANDS);
    }
  }
});

test('demo plan: fixed items only while the minimum blog order still fits; poster stands in for the flyer; leftovers buy retouching', () => {
  const plan = (b) => buildPlan(Object.assign(profileFrom('en', 'a cafe in Seongsu'), { budget_krw: b }), snapshot, { demo: true });
  const at = (b) => plan(b).lines.map((l) => [l.product_id, l.qty]);
  assert.deepEqual(at(300_000), [[282, 1], [142, 1], [106, 12]], 'the flyer would leave no room for 10 posts');
  assert.equal(plan(300_000).total_cost, 298_000);
  assert.deepEqual(at(356_000), [[282, 1], [142, 1], [249, 1], [106, 11]], 'the poster fits where the flyer did not');
  assert.deepEqual(at(50_000), [[112, 16]], 'below the blog minimum only retouching fits');
  assert.equal(plan(50_000).lines[0].spoken, 'sixteen retouched photos');
  assert.deepEqual(at(1_000_000), [[282, 1], [142, 1], [251, 1], [106, 79]]);
  assert.equal(plan(1_000_000).total_cost, 1_000_000);
  assert.deepEqual(at(492_000), [[282, 1], [142, 1], [251, 1], [106, 22], [112, 1]], '5,000 left buys one retouched photo');
});

test('template choice: DEMO_MODE env, explicit option, and an allowlist-only catalog', () => {
  const p = Object.assign(profileFrom('en', 'a cafe in Seongsu'), { budget_krw: 480_000 });
  assert.equal(isDemoMode({ DEMO_MODE: '1' }), true);
  assert.equal(isDemoMode({ DEMO_MODE: '0' }), false);
  assert.equal(isDemoMode({}), false);
  const prev = process.env.DEMO_MODE;
  try {
    process.env.DEMO_MODE = '1';
    assert.equal(buildPlan(p, full).template, 'allowlist', 'DEMO_MODE=1 limits a full catalog to the allowlist');
    process.env.DEMO_MODE = '0';
    assert.equal(buildPlan(p, full).template, 'channel_mix');
    assert.equal(buildPlan(p, snapshot).template, 'allowlist', 'the snapshot can only price the allowlist');
    assert.equal(buildPlan(p, snapshot).demo, false);
  } finally {
    if (prev === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = prev;
  }
});

test('spokenLine and placeName', () => {
  assert.equal(spokenLine({ productId: 282, name: 'Map listing audit report', qty: 1 }, 'en'), 'one map listing audit report');
  assert.equal(spokenLine({ productId: 251, name: 'Flyer design and print', qty: 2 }, 'en'), 'two flyer designs and prints');
  assert.equal(spokenLine({ productId: 112, name: '사진 보정', qty: 12 }, 'ko'), '사진 보정 12장');
  assert.equal(placeName('망원', 'en'), 'Mangwon');
  assert.equal(placeName('망원', 'ko'), '망원');
  assert.equal(placeName('어딘가', 'en'), '어딘가');
  assert.equal(placeName(null, 'en'), '');
});
