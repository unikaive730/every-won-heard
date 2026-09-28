import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGrounding } from '../lib/grounding.js';
import { createLedger, rowLabel } from '../lib/ledger.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, tick: (ms) => { t += ms; return t; } };
}

test('grounding: a range is rejected with both options, then one number passes', () => {
  const c = clock();
  const g = createGrounding({ now: c.now });
  g.addHeard({ item_id: 'i1', text: 'Maybe four or five hundred thousand won a month.', at: c.tick(100) });
  const r1 = g.judge({ amount_krw: 400_000, owner_words: 'four or five hundred thousand' });
  assert.equal(r1.ok, false);
  assert.equal(r1.error, 'ambiguous_amount');
  assert.deepEqual(r1.options, [400_000, 500_000]);
  g.addHeard({ item_id: 'i2', text: 'Four hundred eighty thousand.', at: c.tick(3000) });
  const r2 = g.judge({ amount_krw: 480_000, owner_words: 'four hundred eighty thousand' });
  assert.equal(r2.ok, true);
  assert.equal(r2.amount_krw, 480_000);
  assert.equal(r2.item_id, 'i2', 'the range turn was consumed by the first decision');
  assert.equal(r2.read_back, 'four hundred eighty thousand won a month');
  assert.equal(r2.paraphrased, false);
});

test('grounding: no amount, and old turns outside the 20 s window are ignored', () => {
  const c = clock();
  const g = createGrounding({ now: c.now });
  g.addHeard({ text: '480,000 won', at: c.tick(0) });
  c.tick(25_000);
  const r = g.judge({ amount_krw: 480_000 });
  assert.equal(r.error, 'no_amount_heard');
  assert.match(r.ask, /number/);
});

test('grounding: a mismatch is rejected once, the second time the server reading wins', () => {
  const c = clock();
  const g = createGrounding({ now: c.now });
  g.addHeard({ item_id: 'a', text: 'four hundred eighty thousand', at: c.tick(10) });
  const r1 = g.judge({ amount_krw: 408_000, owner_words: 'four hundred eight thousand' });
  assert.equal(r1.error, 'amount_mismatch');
  assert.equal(r1.heard_krw, 480_000);
  g.addHeard({ item_id: 'b', text: 'four hundred eighty thousand', at: c.tick(2000) });
  const r2 = g.judge({ amount_krw: 408_000, owner_words: 'four hundred eight thousand' });
  assert.equal(r2.ok, true);
  assert.equal(r2.amount_krw, 480_000);
  assert.equal(r2.forced, true);
  assert.equal(r2.paraphrased, true, 'the model words are not in the transcript');
});

test('grounding: a number split across two turns by a pause reads as one', () => {
  const c = clock();
  const g = createGrounding({ now: c.now });
  g.addHeard({ item_id: 'x1', text: 'Four hundred...', at: c.tick(10) });
  g.addHeard({ item_id: 'x2', text: 'eighty thousand.', at: c.tick(1500) });
  const r = g.judge({ amount_krw: 480_000 });
  assert.equal(r.ok, true);
  assert.equal(r.amount_krw, 480_000);
});

test('grounding (Korean path, no model argument): K2 correction passes as 480,000', () => {
  const c = clock();
  const g = createGrounding({ now: c.now });
  g.addHeard({ item_id: 'turn_2', text: '블로그 체험단은 해 봤고요, 예산은 한 달에 50, 아니 48만 원 정도요.', at: c.tick(10), via: 'realtime' });
  const r = g.judge({ lang: 'ko' });
  assert.equal(r.ok, true);
  assert.equal(r.amount_krw, 480_000);
  assert.equal(r.phrase, '48만');
  assert.equal(r.via, 'realtime');
  assert.equal(r.read_back, '월 48만 원');
});

test('ledger: heard -> read back -> confirmed, label reads the same in both languages', () => {
  const c = clock(0);
  const l = createLedger({ now: c.now, t0: 0, lang: 'ko' });
  const row = l.addHeard({ value_krw: 480_000, phrase: '48만', item_id: 'turn_2', heard_at: c.tick(41_200), via: 'realtime' });
  assert.equal(l.pending().id, row.id);
  l.markReadBack(row.id, c.tick(1800));
  l.confirm(row.id, c.tick(1100));
  assert.equal(l.budget().value_krw, 480_000);
  assert.equal(l.pending(), null);
  const snap = l.snapshot()[0];
  assert.equal(snap.label, '사십팔만 원 · ₩480,000 · confirmed');
  assert.deepEqual(snap.t, { heard: 41.2, read_back: 43, confirmed: 44.1, rejected: null });
  const en = createLedger({ lang: 'en' });
  assert.equal(rowLabel(en.addHeard({ value_krw: 380_000 })), 'three hundred eighty thousand won · ₩380,000 · heard');
});

test('ledger: a range row, a denied read-back, and a newer confirmed budget', () => {
  const l = createLedger({ lang: 'en' });
  const range = l.addRejected({ reason: 'range', options: [400_000, 500_000] });
  assert.equal(rowLabel(range), 'range · ₩400,000 / ₩500,000 · not accepted');
  const a = l.addHeard({ value_krw: 480_000 });
  l.confirm(a.id);
  const b = l.addHeard({ value_krw: 400_000 });
  l.deny(b.id);
  assert.equal(l.get(b.id).status, 'rejected');
  assert.equal(l.budget().value_krw, 480_000, 'a denied amount never becomes the budget');
  const c2 = l.addHeard({ value_krw: 380_000 });
  l.confirm(c2.id);
  assert.equal(l.budget().value_krw, 380_000);
  l.addComputed({ value_krw: 379_000, label: 'plan total' });
  assert.equal(l.budget().value_krw, 380_000, 'computed rows never count as the budget');
  assert.equal(l.rows.filter((r) => r.status === 'confirmed' && r.source === 'owner').length, 2);
});

test('grounding: a number cut by a pause and transcribed in digits asks which one was meant', () => {
  const c = clock();
  const g = createGrounding({ now: c.now });
  g.addHeard({ item_id: 'p1', text: '400.', at: c.tick(10) });
  g.addHeard({ item_id: 'p2', text: '80,000 won.', at: c.tick(1300) });
  const r = g.judge({ owner_words: '80,000 won' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ambiguous_amount');
  assert.deepEqual(r.options, [80_000, 480_000]);
  assert.equal(r.item_id, 'p2');
  g.addHeard({ item_id: 'p3', text: 'Four hundred... 80,000 won.', at: c.tick(3000) });
  assert.deepEqual(g.judge({}).options, [80_000, 480_000], 'the same inside one turn');
  g.addHeard({ item_id: 'p4', text: 'Four hundred and eighty thousand won.', at: c.tick(3000) });
  assert.equal(g.judge({}).amount_krw, 480_000);
  g.addHeard({ item_id: 'p5', text: 'We sell 300 bowls a day. 80,000 won a month for marketing.', at: c.tick(3000) });
  assert.equal(g.judge({}).amount_krw, 80_000, 'a count with words in between is not a split number');
});
