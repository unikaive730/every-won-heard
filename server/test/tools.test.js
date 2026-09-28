import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAgent } from '../lib/agent.js';
import { createToolRunner, initVoiceAgent, recordHeard } from '../lib/tools.js';
import { planForBudget, asPlannerPlan } from '../lib/voice-plan.js';
import { checkoutItems } from '../lib/planner.js';
import { BRANDS } from '../lib/gateway.js';

const mock = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8'));
const getCatalog = async () => ({ source: 'mock', products: mock.products });
const quiet = { warn() {}, error() {}, log() {} };

function setup({ demoMode = true, createCheckout = null, lateTranscriptMs = 0 } = {}) {
  const agent = createAgent({ getCatalog, logger: quiet });
  const session = agent.createSession({ lang: 'en', engine: 'voice-agent' });
  initVoiceAgent(session);
  const runner = createToolRunner({ getCatalog, demoMode, createCheckout, lateTranscriptMs, logger: quiet });
  let n = 0;
  const say = (text) => recordHeard(session, { item_id: `item_${++n}`, text, via: 'voice-agent' }).item_id;
  const call = async (name, args = {}, extra = {}) => {
    const r = await runner.run(session, { call_id: `call_${name}_${++n}`, name, arguments: args, ...extra }, { origin: 'https://demo.example' });
    return { ...r, body: JSON.parse(r.result) };
  };
  return { session, runner, say, call };
}

test('voice plan: design 6-9 examples from catalog prices, generic names, total <= budget', () => {
  const p480 = planForBudget(480_000, mock.products);
  assert.equal(p480.total_krw, 478_000);
  assert.deepEqual(p480.lines.map((l) => [l.product_id, l.qty]), [[282, 1], [142, 1], [251, 1], [106, 21]]);
  assert.equal(p480.spoken_total, 'four hundred seventy-eight thousand won');
  assert.equal(p480.lines[3].spoken, 'twenty-one sponsored blog posts');
  const p380 = planForBudget(380_000, mock.products);
  assert.equal(p380.total_krw, 379_000);
  assert.equal(p380.lines.find((l) => l.product_id === 106).qty, 10);
  for (const b of [50_000, 99_000, 150_000, 250_000, 480_000, 1_000_000, 3_000_000]) {
    const p = planForBudget(b, mock.products);
    assert.ok(p.total_krw <= b, `total within ${b}`);
    assert.ok(p.lines.every((l) => !BRANDS.test(l.name) && !BRANDS.test(l.spoken)));
  }
  const noBlog = planForBudget(480_000, mock.products.filter((x) => x.productId !== 106));
  assert.ok(!noBlog.lines.some((l) => l.product_id === 106), 'a product missing from the catalog is skipped');
  const planner = asPlannerPlan(p480, { catalogSource: 'mock' });
  assert.equal(planner.total_cost, 478_000);
  assert.deepEqual(checkoutItems(planner), [{ productId: 282, quantity: 1 }, { productId: 142, quantity: 1 }, { productId: 251, quantity: 1 }, { productId: 106, quantity: 21 }]);
});

test('tools: the demo call C1-C7 end to end (range rejected, 480,000, plan, barge-in 380,000, checkout, bye)', async () => {
  const { session, say, call } = setup();
  say("Hi. I run a small ramen place near Mangwon Market. We opened in the spring. Weekends are fine, but weekday lunch is empty.");
  let r = await call('record_shop', { business_type: 'restaurant', neighborhood: 'Mangwon', main_problem: 'low_traffic' });
  assert.equal(r.is_error, false);
  assert.equal(r.state, 's1');
  assert.equal(r.state_changed, true);
  assert.deepEqual(r.session_update.tools.map((t) => t.name), ['record_budget', 'record_shop', 'end_call']);
  assert.equal(session.profile.business_type, 'restaurant');
  assert.equal(session.profile.location, 'Mangwon');

  say('Maybe 4 or 500,000 won a month.');
  r = await call('record_budget', { owner_words: '4 or 500,000 won a month', period: 'monthly' });
  assert.equal(r.is_error, true);
  assert.equal(r.body.error, 'ambiguous_amount');
  assert.deepEqual(r.body.options, [400_000, 500_000]);
  assert.deepEqual(r.body.options_spoken, ['four hundred thousand won', 'five hundred thousand won']);
  assert.equal(r.state, 's1');
  assert.equal(r.state_changed, false);

  say('Four hundred... eighty thousand.');
  r = await call('record_budget', { owner_words: 'four hundred eighty thousand', period: 'monthly' });
  assert.equal(r.is_error, false);
  assert.equal(r.body.heard_krw, 480_000);
  assert.equal(r.body.read_back, 'four hundred eighty thousand won a month');
  assert.equal(r.state, 's2');

  say("Yes, that's right.");
  r = await call('confirm_budget', { answer: 'yes' });
  assert.equal(r.body.status, 'confirmed');
  assert.equal(r.body.next_step, 'Call build_plan now.');
  assert.equal(r.state, 's3');
  assert.equal(session.ledger.budget().value_krw, 480_000);

  r = await call('build_plan');
  assert.equal(r.is_error, false);
  assert.equal(r.body.total_krw, 478_000);
  assert.equal(r.state, 's4');
  assert.equal(session.plan.total_cost, 478_000);

  // barge-in while the plan is read: new amount plus a discount request
  say('Wait. Cut it to 380,000. And can you take 20% off?');
  r = await call('record_budget', { owner_words: '380,000', period: 'monthly' });
  assert.equal(r.body.heard_krw, 380_000);
  assert.match(r.body.note, /can't give discounts/);
  assert.equal(r.state, 's2');
  assert.equal(session.ledger.budget().value_krw, 480_000, 'not the budget until the owner says yes');
  const early = await call('build_plan');
  assert.equal(early.body.error, 'new_budget_not_confirmed');

  say('Yes.');
  r = await call('confirm_budget', { answer: 'yes' });
  assert.equal(r.state, 's3');
  r = await call('build_plan');
  assert.equal(r.body.total_krw, 379_000);
  assert.equal(r.state, 's4');

  say('Okay. Go ahead.');
  r = await call('create_checkout_link');
  assert.equal(r.is_error, false);
  assert.equal(r.body.demo, true);
  assert.equal(r.body.url, `https://demo.example/demo-checkout/${session.id}`);
  assert.equal(session.checkout.total_krw, 379_000);

  say('Thanks. Bye.');
  r = await call('end_call');
  assert.equal(r.end_session, true);

  const owner = session.ledger.rows.filter((x) => x.source === 'owner');
  assert.deepEqual(owner.map((x) => [x.status, x.value_krw ?? x.options]), [['rejected', [400_000, 500_000]], ['confirmed', 480_000], ['confirmed', 380_000]]);
  assert.ok(owner.every((x) => x.via === 'voice-agent' && x.item_id));
  assert.equal(session.ledger.rows.filter((x) => x.kind === 'plan_total').length, 2);
  assert.equal(session.va.calls.length, 11);
  assert.equal(session.va.calls.filter((c) => c.is_error).length, 2);
});

test('tools: no amount heard does not consume the turn; a pause-split number joins the next turn', async () => {
  const { say, call, session } = setup();
  let r = await call('record_budget', { owner_words: '480,000 won', period: 'monthly' });
  assert.equal(r.body.error, 'no_amount_heard', 'the model words alone are not evidence');
  say('Four hundred...');
  r = await call('record_budget', { owner_words: 'four hundred', period: 'monthly' });
  assert.equal(r.body.error, 'no_amount_heard');
  say('eighty thousand won.');
  r = await call('record_budget', { owner_words: 'four hundred eighty thousand won', period: 'monthly' });
  assert.equal(r.body.heard_krw, 480_000);
  assert.equal(session.ledger.pending().value_krw, 480_000);
});

test('tools: model words that disagree with the transcript are rejected, the owner amount is read back', async () => {
  const { say, call, session } = setup();
  say('480,000 won a month.');
  const r = await call('record_budget', { owner_words: '408,000 won', period: 'monthly' });
  assert.equal(r.is_error, true);
  assert.equal(r.body.error, 'amount_mismatch');
  assert.equal(r.body.heard_krw, 480_000);
  assert.equal(r.body.read_back, 'four hundred eighty thousand won a month');
  assert.equal(r.state, 's2');
  const [bad, good] = session.ledger.rows;
  assert.deepEqual([bad.status, bad.reason, bad.value_krw], ['rejected', 'mismatch', 408_000]);
  assert.deepEqual([good.status, good.value_krw], ['heard', 480_000]);
});

test('tools: confirm_budget needs the owner\'s own yes or no after the read-back', async () => {
  const { say, call, session } = setup();
  let r = await call('confirm_budget', { answer: 'yes' });
  assert.equal(r.body.error, 'nothing_to_confirm');
  say('Make it 300,000 won.');
  await call('record_budget', { owner_words: '300,000 won', period: 'monthly' });
  r = await call('confirm_budget', { answer: 'yes' });
  assert.equal(r.body.error, 'no_answer_yet', 'the model cannot confirm before the owner answers');
  assert.equal(r.body.read_back, 'three hundred thousand won a month');
  say('Hmm, let me think about it.');
  r = await call('confirm_budget', { answer: 'yes' });
  assert.equal(r.body.error, 'answer_unclear');
  assert.equal(r.state, 's2');
  say('Uh, no.');
  r = await call('confirm_budget', { answer: 'no' });
  assert.equal(r.body.status, 'not_confirmed');
  assert.equal(r.state, 's1');
  assert.equal(session.ledger.rows[0].status, 'rejected');
  assert.equal(session.ledger.budget(), null);
  r = await call('build_plan');
  assert.equal(r.body.error, 'budget_not_confirmed');
});

test('tools: checkout needs a go-ahead turn; without DEMO_MODE it goes through the MarketPilot checkout', async () => {
  const made = [];
  const { say, call, session } = setup({ demoMode: false, createCheckout: async (x) => { made.push(x); return { checkoutUrl: 'https://pay.example/c/1' }; } });
  say('500,000 won a month.');
  await call('record_budget', { owner_words: '500,000 won a month', period: 'monthly' });
  say('Correct.');
  await call('confirm_budget', { answer: 'yes' });
  let r = await call('create_checkout_link');
  assert.equal(r.body.error, 'no_current_plan');
  await call('build_plan');
  r = await call('create_checkout_link');
  assert.equal(r.body.error, 'no_go_ahead', 'no owner turn after the plan was built');
  say('What is a listing audit?');
  r = await call('create_checkout_link');
  assert.equal(r.body.error, 'no_go_ahead');
  say('Sounds good, go ahead.');
  r = await call('create_checkout_link');
  assert.equal(r.is_error, false);
  assert.equal(r.body.demo, false);
  assert.equal(made.length, 1);
  assert.deepEqual(made[0].items, checkoutItems(session.plan));
  assert.equal(session.checkout.checkoutUrl, 'https://pay.example/c/1');
});

test('tools: a repeated call_id returns the same answer without a second ledger row', async () => {
  const { session, runner, say } = setup();
  say('480,000 won.');
  const a = await runner.run(session, { call_id: 'c1', name: 'record_budget', arguments: { owner_words: '480,000 won', period: 'monthly' } });
  const b = await runner.run(session, { call_id: 'c1', name: 'record_budget', arguments: { owner_words: '480,000 won', period: 'monthly' } });
  assert.deepEqual(a, b);
  assert.equal(session.ledger.rows.length, 1);
  const u = await runner.run(session, { call_id: 'c2', name: 'charge_card', arguments: {} });
  assert.equal(u.is_error, true);
  assert.equal(JSON.parse(u.result).error, 'unknown_tool');
});

test('tools: a transcript that arrives after the tool call is waited for (up to lateTranscriptMs)', async () => {
  const { session, call } = setup({ lateTranscriptMs: 300 });
  setTimeout(() => recordHeard(session, { item_id: 'late_1', text: '480,000 won a month.' }), 60);
  const r = await call('record_budget', { owner_words: '480,000 won a month', period: 'monthly' }, { last_item_id: 'late_1' });
  assert.equal(r.is_error, false);
  assert.equal(r.body.heard_krw, 480_000);
  assert.equal(session.ledger.rows[0].item_id, 'late_1');
});

test('heard: duplicates are ignored, the agent\'s read-back marks the row read back', async () => {
  const { session, call } = setup();
  const greeting = session.history[0].text;
  recordHeard(session, { role: 'agent', text: greeting });
  assert.equal(session.history.filter((h) => h.role === 'agent').length, 1, 'the greeting transcript is not stored twice');
  assert.equal(recordHeard(session, { item_id: 'i1', text: '480,000 won.' }).ok, true);
  assert.equal(recordHeard(session, { item_id: 'i1', text: '480,000 won.' }).duplicate, true);
  assert.equal(recordHeard(session, { text: '   ' }).ok, false);
  await call('record_budget', { owner_words: '480,000 won', period: 'monthly' });
  recordHeard(session, { role: 'agent', text: 'Four hundred eighty thousand won a month, is that right?' });
  const row = session.ledger.rows[0];
  assert.equal(row.status, 'read_back');
  assert.ok(row.read_back_at >= row.heard_at);
  assert.equal(session.grounding.heard.length, 1, 'agent speech is not owner evidence');
});

test('tools: the model passing a fragment of a pause-split amount is not a mismatch (run 1: "Eighty thousand")', async () => {
  const { say, call, session } = setup();
  say('Four hundred.');
  let r = await call('record_budget', { owner_words: 'Four hundred', period: 'monthly' });
  assert.equal(r.body.error, 'no_amount_heard');
  say('Eighty thousand.');
  r = await call('record_budget', { owner_words: 'Eighty thousand', period: 'monthly' });
  assert.equal(r.is_error, false);
  assert.equal(r.body.heard_krw, 480_000);
  assert.equal(r.body.read_back, 'four hundred eighty thousand won a month');
  assert.equal(r.body.owner_said, 'Four hundred. Eighty thousand');
  assert.deepEqual(session.ledger.rows.map((x) => [x.status, x.value_krw]), [['heard', 480_000]], 'no rejected row for a fragment');
});

test('tools: when agent transcripts are relayed, a yes only confirms an amount that was read back', async () => {
  const { say, call, session } = setup();
  say('480,000 won a month.');
  await call('record_budget', { owner_words: '480,000 won a month', period: 'monthly' });
  recordHeard(session, { role: 'agent', text: "Sorry, I didn't catch that. What's your monthly budget?" });
  say("Yes, that's right.");
  let r = await call('confirm_budget', { answer: 'yes' });
  assert.equal(r.body.error, 'not_read_back');
  assert.equal(r.body.read_back, 'four hundred eighty thousand won a month');
  assert.equal(session.ledger.budget(), null);
  recordHeard(session, { role: 'agent', text: 'Four hundred eighty thousand won a month, is that right?' });
  say('Yes.');
  r = await call('confirm_budget', { answer: 'yes' });
  assert.equal(r.body.status, 'confirmed');
  const row = session.ledger.budget();
  assert.ok(row.heard_at <= row.read_back_at && row.read_back_at <= row.confirmed_at);
});
