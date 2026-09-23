import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSlots, extractBudget, extractLocation, extractBusinessType, mergeProfile, emptyProfile, nextMissingSlot } from '../lib/extract.js';

test('Korean: business type, location, budget and problem from one sentence', () => {
  const s = extractSlots('강남역 근처에서 카페를 하는데 손님이 너무 없어요. 한 달에 50만원 정도는 쓸 수 있어요.');
  assert.equal(s.language, 'ko');
  assert.equal(s.business_type, 'cafe');
  assert.equal(s.business_label, '카페');
  assert.equal(s.location, '강남');
  assert.equal(s.budget_krw, 500_000);
  assert.ok(s.problems.includes('low_traffic'));
});

test('Korean budget forms', () => {
  assert.equal(extractBudget('월 30만원이요').amount_krw, 300_000);
  assert.equal(extractBudget('300만 원 정도').amount_krw, 3_000_000);
  assert.equal(extractBudget('1,000,000원').amount_krw, 1_000_000);
  assert.equal(extractBudget('예산은 50만 정도').amount_krw, 500_000);
  assert.equal(extractBudget('1.5천만원').amount_krw, 15_000_000);
  assert.equal(extractBudget('월 예산'), null);
  assert.equal(extractBudget('월 30만원').period, 'monthly');
});

test('English budget forms including USD conversion', () => {
  assert.equal(extractBudget('about 300,000 won a month').amount_krw, 300_000);
  assert.equal(extractBudget('maybe 500k won').amount_krw, 500_000);
  assert.equal(extractBudget('1 million won').amount_krw, 1_000_000);
  const usd = extractBudget('I can spend $500 per month');
  assert.equal(usd.currency, 'USD');
  assert.equal(usd.usd, 500);
  assert.equal(usd.amount_krw, 675_000);
  assert.equal(extractBudget('2k dollars').amount_krw, 2_700_000);
});

test('English: business type, location and problems', () => {
  const s = extractSlots("We just opened a Korean BBQ restaurant in Hongdae and nobody comes on weekdays. We tried Instagram ads already.");
  assert.equal(s.language, 'en');
  assert.equal(s.business_type, 'restaurant');
  assert.equal(s.location, '홍대');
  assert.ok(s.problems.includes('new_open'));
  assert.ok(s.problems.includes('low_traffic'));
  assert.ok(s.channels_tried.includes('instagram'));
  assert.ok(s.channels_tried.includes('paid_ads'));
});

test('location fallbacks', () => {
  assert.equal(extractLocation('역삼동에 있어요'), '역삼동');
  assert.equal(extractLocation('the shop is in Pangyo'), '판교');
  assert.equal(extractLocation('no place here'), null);
});

test('business type priority and misses', () => {
  assert.equal(extractBusinessType('온라인 쇼핑몰이에요'), 'ecommerce');
  assert.equal(extractBusinessType('필라테스 스튜디오'), 'fitness');
  assert.equal(extractBusinessType('we run a dental clinic'), 'clinic');
  assert.equal(extractBusinessType('a mobile app for dog walkers'), 'app');
  assert.equal(extractBusinessType('안녕하세요'), null);
});

test('mergeProfile fills empties, unions lists, and nextMissingSlot follows the ask order', () => {
  let p = emptyProfile('ko');
  assert.equal(nextMissingSlot(p), 'business_type');
  p = mergeProfile(p, extractSlots('카페예요'));
  assert.equal(nextMissingSlot(p), 'location');
  p = mergeProfile(p, extractSlots('성수동이요'));
  assert.equal(nextMissingSlot(p), 'budget');
  p = mergeProfile(p, extractSlots('월 40만원'));
  assert.equal(nextMissingSlot(p), 'problem');
  p = mergeProfile(p, extractSlots('리뷰가 없어요'));
  assert.equal(nextMissingSlot(p), null);
  // existing scalar is kept unless overwrite
  p = mergeProfile(p, { budget_krw: 900_000 });
  assert.equal(p.budget_krw, 400_000);
  p = mergeProfile(p, { budget_krw: 900_000 }, { overwrite: true });
  assert.equal(p.budget_krw, 900_000);
  p = mergeProfile(p, { problems: ['reviews', 'instagram'] });
  assert.deepEqual(p.problems, ['reviews', 'instagram']);
});

test('online business does not require a location', () => {
  let p = emptyProfile('en');
  p = mergeProfile(p, extractSlots('I sell skincare on Coupang and my own online store'));
  assert.equal(p.business_type, 'ecommerce');
  assert.equal(nextMissingSlot(p), 'budget');
});
