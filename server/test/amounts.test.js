import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickAmount, parseAmounts, moneyValues, koreanWords, koreanShort, englishWords, readBack, spokenAmount } from '../lib/amounts.js';

const ok = (text, value) => {
  const r = pickAmount(text);
  assert.equal(r.status, 'ok', `${text} -> ${JSON.stringify(r.status)} ${JSON.stringify(r.options || '')}`);
  assert.equal(r.value, value, text);
};
const ambiguous = (text, options) => {
  const r = pickAmount(text);
  assert.equal(r.status, 'ambiguous', `${text} -> ${r.status} ${r.value ?? ''}`);
  if (options) assert.deepEqual(r.options, options, text);
};
const none = (text) => assert.equal(pickAmount(text).status, 'none', text);

test('English number words, digits and shorthand', () => {
  ok('four hundred eighty thousand', 480_000);
  ok('four hundred and eighty thousand won', 480_000);
  ok('480k', 480_000);
  ok('480,000 won a month', 480_000);
  ok('half a million', 500_000);
  ok('a million won', 1_000_000);
  ok('fifty man won', 500_000);
  ok('three hundred eighty thousand', 380_000);
});

test('malformed or unit-less English amounts are not budgets', () => {
  none('3.8 hundred thousand');
  none('three eighty');
  none('twenty percent off and ten posts');
  none('We have 30,000 followers');
  none('$500 a month'); // budgets are in won; the agent asks again
});

test('a pause inside a spoken number still reads as one amount', () => {
  ok('Four hundred... eighty thousand.', 480_000);
  ok('Four hundred. Eighty thousand.', 480_000);
});

test('corrections: the last amount after the marker wins', () => {
  ok('four hundred, no, four eighty thousand', 480_000);
  ok('three hundred thousand, sorry, three hundred eighty thousand', 380_000);
  ok('make that three hundred eighty thousand', 380_000);
  ok('500,000 won. Actually 450,000.', 450_000);
  ok('Wait. Cut it to three hundred eighty thousand. And can you take twenty percent off?', 380_000);
});

test('ranges and two amounts without a correction are ambiguous', () => {
  ambiguous('Maybe four or five hundred thousand won a month.', [400_000, 500_000]);
  ambiguous('between 300,000 and 400,000', [300_000, 400_000]);
  ambiguous('300 to 400 thousand won', [300_000, 400_000]);
  ambiguous('480,000 or 500,000 won', [480_000, 500_000]);
});

test('Korean: numerals, digits with units, and the K2 correction', () => {
  ok('사십팔만 원', 480_000);
  ok('48만 원', 480_000);
  ok('예산은 한 달에 오십, 아니 사십팔만 원 정도요.', 480_000);
  ok('예산은 한 달에 50, 아니 48만 원 정도요.', 480_000);
  ok('한 달에 50만 원, 아니 48만 원이요', 480_000);
  ok('월 30만', 300_000);
  ok('백만 원', 1_000_000);
  ok('만 원', 10_000);
  ok('48만 5천 원', 485_000);
  ok('사십팔만 오천 원', 485_000);
  ok('오십만이요', 500_000);
  ok('1억 2천만 원', 120_000_000);
  ok('한 달에 50만 원 정도 마케팅 했을 수 있어요.', 500_000);
});

test('Korean ranges are ambiguous', () => {
  ambiguous('사오십만 원 정도', [400_000, 500_000]);
  ambiguous('40에서 50만 원', [400_000, 500_000]);
  ambiguous('40~50만 원', [400_000, 500_000]);
  ambiguous('사, 오십만 원', [400_000, 500_000]);
});

test('Korean words that contain numeral characters are not money', () => {
  none('만약에 사장님이 백화점 가면 천천히 오늘 구청');
  none('삼겹살 이번 일주일');
  none('리뷰가 30개밖에 없어요');
  none('팔로워 10만 명');
  none('천만에요');
  none('오십'); // a bare small number is not a budget
  none('네, 맞아요.');
});

test('parseAmounts reports the correction and the phrase span', () => {
  const r = parseAmounts('오십, 아니 사십팔만 원');
  assert.equal(r.corrected, true);
  const money = r.items.filter((i) => i.money);
  assert.equal(money.length, 1);
  assert.equal(money[0].text, '사십팔만');
  assert.deepEqual(moneyValues('I said 480,000 won, and the rent is 2,000,000.'), [480_000, 2_000_000]);
});

test('saying amounts back: Korean words, Korean short form, English words', () => {
  assert.equal(koreanWords(480_000), '사십팔만 원');
  assert.equal(koreanWords(1_000_000), '백만 원');
  assert.equal(koreanWords(10_000), '만 원');
  assert.equal(koreanWords(485_000), '사십팔만 오천 원');
  assert.equal(koreanShort(480_000), '48만 원');
  assert.equal(koreanShort(485_000), '48만 5천 원');
  assert.equal(englishWords(480_000), 'four hundred eighty thousand');
  assert.equal(englishWords(1_500_000), 'one million five hundred thousand');
  assert.equal(readBack(380_000, 'en'), 'three hundred eighty thousand won a month');
  assert.equal(readBack(480_000, 'ko'), '월 48만 원');
  assert.equal(spokenAmount(480_000, 'ko'), '사십팔만 원');
  // round trip: what we say back parses to the same number
  for (const v of [10_000, 90_000, 380_000, 480_000, 1_000_000, 2_500_000]) {
    assert.equal(pickAmount(`${englishWords(v)} won`).value, v, englishWords(v));
    assert.equal(pickAmount(koreanWords(v)).value, v, koreanWords(v));
  }
});
