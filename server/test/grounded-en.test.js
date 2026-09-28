// Typed English sessions run on the grounded path (engine 'realtime'), like Korean: an amount becomes the
// budget only after it is read back and the owner says yes. Turns carry via 'text', as the web app sends them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgent } from '../lib/agent.js';
import { reconcileTurns } from '../lib/brief.js';

const mock = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8'));
const getCatalog = async () => ({ source: 'mock', products: mock.products });
const quiet = { warn() {}, error() {}, log() {} };
const typed = { meta: { via: 'text' } };
const SHOP = 'I run a small ramen place near Mangwon Market. We just opened.';

async function englishSession() {
  const ag = createAgent({ getCatalog, logger: quiet });
  const s = ag.createSession({ lang: 'en', engine: 'realtime' });
  const say = (text) => ag.handleUtterance(s.id, text, typed);
  const r0 = await say(SHOP);
  assert.equal(r0.step, 'budget');
  return { ag, s, say };
}

test('typed English: a range is rejected with a question and no budget is set', async () => {
  const { say } = await englishSession();
  const r = await say('Maybe 400,000 or 500,000 won a month.');
  assert.match(r.reply, /^Which one should I plan for, four hundred thousand or five hundred thousand won\?$/);
  assert.equal(r.grounding.error, 'ambiguous_amount');
  assert.deepEqual(r.grounding.options, [400_000, 500_000]);
  assert.equal(r.profile.budget_krw, null);
  assert.equal(r.plan, null);
  assert.equal(r.ledger.length, 1);
  assert.equal(r.ledger[0].status, 'rejected');
  assert.equal(r.ledger[0].value_krw, null);
});

test('typed English: one amount is the budget only after the read-back and a yes', async () => {
  const { s, say } = await englishSession();
  const r1 = await say('About 480,000 won a month.');
  assert.equal(r1.step, 'confirm');
  assert.match(r1.reply, /four hundred eighty thousand won a month, is that right\?/i);
  assert.equal(r1.profile.budget_krw, null, 'heard and read back, not yet the budget');
  assert.equal(r1.plan, null);
  assert.equal(r1.ledger[0].status, 'read_back');
  assert.equal(r1.ledger[0].value_krw, 480_000);

  const r2 = await say('Yes, that is right.');
  assert.equal(r2.profile.budget_krw, 480_000);
  assert.equal(r2.ledger[0].status, 'confirmed');
  assert.ok(r2.plan, 'the plan is made after the yes');
  assert.ok(r2.plan.total_cost <= 480_000);

  // the receipt says it was checked against what the owner typed
  const rec = reconcileTurns(r2.ledger, s.grounding.heard);
  assert.equal(rec.record, 'typed_turns');
  assert.equal(rec.confirmed_amounts, 1);
  assert.equal(rec.matched.length, 1);
});

test('typed English: "$300 a month" is not converted; the agent asks for won and no budget is set', async () => {
  const { say } = await englishSession();
  const r = await say('$300 a month');
  assert.equal(r.reply, 'I plan in won. What is that per month in won?');
  assert.equal(r.step, 'budget');
  assert.equal(r.profile.budget_krw, null);
  assert.equal(r.plan, null);
  assert.equal(r.ledger.length, 0);

  const r2 = await say('300 dollars a month, I said.');
  assert.equal(r2.reply, 'I plan in won. What is that per month in won?');
  assert.equal(r2.profile.budget_krw, null);
});
