import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLlm, AGENT_OUTPUT_SCHEMA, buildSystemPrompt } from '../lib/llm.js';

function fakeClient(handler) {
  return { messages: { create: handler } };
}

test('no key and no client -> null (rules-only mode)', () => {
  assert.equal(createLlm({ apiKey: '' }), null);
});

test('agentTurn sends structured-output config, the system prompt and a user-first history; parses JSON reply', async () => {
  let req = null;
  const client = fakeClient(async (params) => {
    req = params;
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify({ reply: '성수동 카페시군요. 월 예산은 얼마 정도 생각하세요?', profile: { business_type: 'cafe', location: '성수동', budget_krw: null, problems: [], store_name: null }, ready_for_plan: false, owner_confirmed_plan: false }) }],
      usage: { input_tokens: 500, output_tokens: 60 },
    };
  });
  const llm = createLlm({ client, model: 'claude-opus-5' });
  const out = await llm.agentTurn({
    lang: 'ko',
    history: [{ role: 'agent', text: '안녕하세요' }, { role: 'user', text: '성수동에서 카페 해요' }],
    profile: { business_type: null },
  });
  assert.equal(req.model, 'claude-opus-5');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.deepEqual(req.output_config.format.schema, AGENT_OUTPUT_SCHEMA);
  assert.equal(req.output_config.effort, 'low');
  assert.equal(req.messages[0].role, 'user', 'leading assistant greeting is dropped so the first message is from the user');
  assert.match(req.messages[0].content, /성수동에서 카페 해요/);
  assert.match(req.messages[0].content, /\[state\]/);
  assert.match(req.system, /Korean/);
  assert.equal(out.reply, '성수동 카페시군요. 월 예산은 얼마 정도 생각하세요?');
  assert.equal(out.profile.business_type, 'cafe');
  assert.equal(out.ready_for_plan, false);
  assert.equal(llm.state.calls, 1);
});

test('refusal stop reason and malformed JSON both return null so rules take over', async () => {
  const llm1 = createLlm({ client: fakeClient(async () => ({ stop_reason: 'refusal', content: [], stop_details: { type: 'refusal', category: null } })), logger: { warn() {} } });
  assert.equal(await llm1.agentTurn({ lang: 'en', history: [{ role: 'user', text: 'hi' }], profile: {} }), null);
  const llm2 = createLlm({ client: fakeClient(async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] })), logger: { warn() {} } });
  assert.equal(await llm2.agentTurn({ lang: 'en', history: [{ role: 'user', text: 'hi' }], profile: {} }), null);
  assert.equal(llm2.state.failures, 1);
});

test('API failures are swallowed and counted', async () => {
  const llm = createLlm({ client: fakeClient(async () => { throw new Error('boom'); }), logger: { warn() {}, error() {} } });
  assert.equal(await llm.agentTurn({ lang: 'en', history: [{ role: 'user', text: 'hi' }], profile: {} }), null);
  assert.equal(llm.state.failures, 1);
  assert.match(llm.state.lastError, /boom/);
});

test('system prompt switches language and forbids invented prices', () => {
  assert.match(buildSystemPrompt({ lang: 'en' }), /speaks English/);
  assert.match(buildSystemPrompt({ lang: 'ko' }), /Never invent prices/);
});
