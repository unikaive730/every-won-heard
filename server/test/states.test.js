import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_IDS, TOOLS, toolNamesFor, sessionUpdateFor, inputFor, systemPromptFor, storedAgentBody, firstSessionUpdate, inlineSessionFor } from '../lib/states.js';
import { BRANDS } from '../lib/gateway.js';

test('states: each stage reveals only its tools (design 6-3)', () => {
  assert.deepEqual(toolNamesFor('s0'), ['record_shop', 'end_call']);
  assert.deepEqual(toolNamesFor('s1'), ['record_budget', 'record_shop', 'end_call']);
  assert.deepEqual(toolNamesFor('s2'), ['confirm_budget', 'record_budget', 'end_call']);
  assert.deepEqual(toolNamesFor('s3'), ['build_plan', 'record_budget', 'end_call']);
  assert.deepEqual(toolNamesFor('s4'), ['create_checkout_link', 'record_budget', 'build_plan', 'end_call']);
  for (const s of STATE_IDS) assert.ok(toolNamesFor(s).length <= 4, 'small tool sets per stage');
});

test('states: no tool takes a number (a numeric argument makes Voice Agent drop the call)', () => {
  const kinds = [];
  for (const t of Object.values(TOOLS)) {
    assert.equal(t.type, 'function');
    assert.equal(t.parameters.type, 'object');
    for (const [name, p] of Object.entries(t.parameters.properties)) kinds.push([`${t.name}.${name}`, p.type]);
    for (const r of t.parameters.required || []) assert.ok(t.parameters.properties[r], `${t.name}: required ${r} is declared`);
  }
  for (const [name, type] of kinds) assert.equal(type, 'string', `${name} is a string`);
  assert.deepEqual(Object.keys(TOOLS.record_budget.parameters.properties), ['owner_words', 'period']);
  assert.deepEqual(TOOLS.record_budget.parameters.properties.period.enum, ['monthly', 'one_time']);
});

test('states: prompts name no hidden tool, and all share the anti-fabrication clause', () => {
  const all = Object.keys(TOOLS);
  for (const s of STATE_IDS) {
    const prompt = systemPromptFor(s);
    const visible = toolNamesFor(s);
    for (const name of all) {
      if (!visible.includes(name)) assert.ok(!prompt.includes(name), `${s} prompt must not name hidden ${name}`);
    }
    assert.match(prompt, /NEVER say a price, total, quantity or budget/);
    assert.match(prompt, /can't give discounts/);
    assert.ok(!BRANDS.test(prompt), `${s} prompt has no brand names`);
  }
  assert.match(systemPromptFor('s1'), /call record_budget with owner_words "4 or 500,000 won a month"/, 'few-shot example in the budget stage');
});

test('states: listening setting per stage (keyterms, transcription prompt, accuracy mode)', () => {
  const s0 = inputFor('s0');
  assert.equal(s0.transcription_mode, 'balanced');
  assert.ok(s0.keyterms.includes('Mangwon'));
  for (const s of ['s1', 's2']) {
    assert.equal(inputFor(s).transcription_mode, 'max_accuracy');
    assert.ok(inputFor(s).keyterms.includes('man won'));
  }
  assert.ok(inputFor('s3').keyterms.includes('press release'));
  assert.equal(inputFor('s4').transcription_mode, 'balanced');
  for (const s of STATE_IDS) {
    const i = inputFor(s);
    assert.ok(i.transcription_prompt.length <= 1750);
    assert.ok(i.keyterms.length <= 100 && i.keyterms.every((k) => k.length <= 50));
    assert.ok(!BRANDS.test(JSON.stringify(i)), `${s} listening setting has no brand names`);
  }
});

test('states: sessionUpdateFor is the session object of a session.update (tools + prompt + input together)', () => {
  const u = sessionUpdateFor('s2');
  assert.deepEqual(Object.keys(u).sort(), ['input', 'system_prompt', 'tools']);
  assert.deepEqual(u.tools.map((t) => t.name), ['confirm_budget', 'record_budget', 'end_call']);
  assert.equal(u.input.transcription_mode, 'max_accuracy');
  assert.equal(sessionUpdateFor('nope').tools[0].name, 'record_shop', 'unknown state falls back to s0');
  assert.ok(!('greeting' in u) && !('output' in u), 'no immutable fields mid-session');
});

test('states: stored agent body is s0 without keys; first update binds agent_id alone or goes inline', () => {
  const b = storedAgentBody();
  assert.equal(b.name, 'Every Won Heard');
  assert.equal(b.voice.voice_id, 'alba');
  assert.match(b.greeting, /MarketPilot/);
  assert.deepEqual(b.tools.map((t) => t.name), ['record_shop', 'end_call']);
  assert.ok(b.tools.every((t) => !('type' in t) && !('http' in t)), 'client-handled tools on a stored agent');
  assert.equal(b.system_prompt, systemPromptFor('s0'));
  assert.ok(!/api_key|authorization|bearer/i.test(JSON.stringify(b)));
  assert.deepEqual(firstSessionUpdate({ agentId: 'agent-1' }), { agent_id: 'agent-1' });
  const inline = firstSessionUpdate({});
  assert.deepEqual(inline, inlineSessionFor('s0'));
  assert.equal(inline.output.voice, 'alba');
  assert.deepEqual(inline.tools.map((t) => t.name), ['record_shop', 'end_call']);
});
