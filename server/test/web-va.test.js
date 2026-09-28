import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentWsUrl, firstUpdate, laterUpdate, int16ToBase64, base64ToInt16, createResampler, createToolGate, createLatencyMeter, listeningFrom, stepOf, pauseReason, FRAME_SAMPLES } from '../../web/src/lib/va.js';

test('agentWsUrl: token in the query, nothing else', () => {
  assert.equal(agentWsUrl('a/b+c'), 'wss://agents.assemblyai.com/v1/ws?token=a%2Fb%2Bc');
  assert.throws(() => agentWsUrl(''));
  assert.equal(FRAME_SAMPLES, 1200, '50 ms at 24 kHz');
});

test('firstUpdate: server inline session wins; a stored agent goes alone (agent_id_not_first)', () => {
  const inline = { system_prompt: 'p', tools: [{ type: 'function', name: 'record_shop' }] };
  assert.deepEqual(firstUpdate({ session_update: inline, agentId: 'ag1' }), { type: 'session.update', session: inline });
  assert.deepEqual(firstUpdate({ session_update: { type: 'session.update', session: inline } }), { type: 'session.update', session: inline });
  assert.deepEqual(firstUpdate({ agentId: 'ag1' }), { type: 'session.update', session: { agent_id: 'ag1' } });
  assert.deepEqual(firstUpdate({ session_update: { agent_id: 'ag2', tools: [] } }), { type: 'session.update', session: { agent_id: 'ag2' } }, 'inline fields next to agent_id are dropped');
  assert.equal(firstUpdate({}), null);
});

test('laterUpdate: strips fields that raise immutable_field after session.ready', () => {
  const u = laterUpdate({ agent_id: 'x', greeting: 'hi', system_prompt: 'p', output: { voice: 'anna', format: { encoding: 'audio/pcm' }, volume: 80 }, input: { keyterms: ['won'] } });
  assert.deepEqual(u, { type: 'session.update', session: { system_prompt: 'p', output: { volume: 80 }, input: { keyterms: ['won'] } } });
  assert.equal(laterUpdate({ greeting: 'hi', output: { voice: 'anna' } }), null, 'nothing mutable left');
  assert.equal(laterUpdate(null), null);
  assert.equal(laterUpdate({ type: 'tool.result' }), null, 'not a session.update');
});

test('PCM16 base64 round trip keeps negative samples and little-endian order', () => {
  const pcm = new Int16Array([0, 1, -1, 32767, -32768, 12345, -12345]);
  const b64 = int16ToBase64(pcm);
  assert.equal(b64, Buffer.from(pcm.buffer).toString('base64'));
  assert.deepEqual(Array.from(base64ToInt16(b64)), Array.from(pcm));
  const big = new Int16Array(FRAME_SAMPLES * 30).map((_, i) => (i * 37) % 65536 - 32768);
  assert.deepEqual(Array.from(base64ToInt16(int16ToBase64(big))), Array.from(big), 'large buffers go through in pieces');
});

test('resampler: 24 kHz -> 48 kHz doubles the length and chunking does not change the output', () => {
  const src = Float32Array.from({ length: 2400 }, (_, i) => Math.sin(i / 7));
  const whole = createResampler(24000, 48000).process(src);
  const r = createResampler(24000, 48000);
  const parts = [];
  for (let i = 0; i < src.length; i += 1200) parts.push(...r.process(src.subarray(i, i + 1200)));
  assert.ok(Math.abs(whole.length - 4800) <= 2, `length ${whole.length}`);
  assert.equal(parts.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(parts[i] - whole[i]) < 1e-6, `sample ${i}`);
});

test('resampler: 48 kHz -> 24 kHz halves, equal rates copy, reset forgets the last reply', () => {
  const src = Float32Array.from({ length: 4800 }, (_, i) => (i % 2 ? 0.5 : -0.5));
  assert.ok(Math.abs(createResampler(48000, 24000).process(src).length - 2400) <= 1);
  const same = createResampler(24000, 24000);
  assert.deepEqual(Array.from(same.process(new Float32Array([0.1, 0.2]))).map((x) => +x.toFixed(3)), [0.1, 0.2]);
  const r = createResampler(24000, 44100);
  r.process(new Float32Array(100).fill(1));
  r.reset();
  const out = r.process(new Float32Array(100).fill(0));
  assert.equal(out[0], 0, 'no interpolation from the previous reply after reset');
});

/** A fake /tool server and socket for the gate. */
function harness({ slowMs = 0 } = {}) {
  const sent = [];
  const ran = [];
  const dropped = [];
  let release = null;
  const gate = createToolGate({
    runTool: async (call) => {
      ran.push(call.name);
      if (slowMs) await new Promise((r) => { release = r; });
      return { result: JSON.stringify({ ok: true, name: call.name }), is_error: call.name === 'bad', state: 's1', session_update: { tools: [{ name: `after_${call.name}` }], greeting: 'x' } };
    },
    send: (m) => sent.push(m),
    onDropped: (calls, why) => dropped.push(...calls.map((c) => `${c.name}:${why}`)),
  });
  return { gate, sent, ran, dropped, release: () => release && release() };
}

test('tool gate: collect on tool.call, relay on reply.done, then tool.result and the next stage update', async () => {
  const h = harness();
  h.gate.onTurnEvent('reply.started');
  h.gate.onToolCall({ call_id: 'c1', name: 'record_budget', arguments: { owner_words: 'four eighty' } });
  assert.deepEqual(h.ran, [], 'nothing reaches our server before reply.done');
  await h.gate.onReplyDone('completed');
  assert.deepEqual(h.ran, ['record_budget']);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[0], { type: 'tool.result', call_id: 'c1', result: '{"ok":true,"name":"record_budget"}', is_error: false });
  assert.deepEqual(h.sent[1], { type: 'session.update', session: { tools: [{ name: 'after_record_budget' }] } }, 'greeting stripped');
});

test('tool gate: interrupted reply drops collected calls before they reach the server', async () => {
  const h = harness();
  h.gate.onTurnEvent('reply.started');
  h.gate.onToolCall({ call_id: 'c1', name: 'build_plan' });
  await h.gate.onReplyDone('interrupted');
  assert.deepEqual(h.ran, []);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.dropped, ['build_plan:interrupted']);
});

test('tool gate: owner starts talking during the relay -> hold the result until the next completed reply.done', async () => {
  const h = harness({ slowMs: 1 });
  h.gate.onTurnEvent('reply.started');
  h.gate.onToolCall({ call_id: 'c1', name: 'record_shop' });
  const p = h.gate.onReplyDone('completed');
  await new Promise((r) => setImmediate(r));
  h.gate.onTurnEvent('input.speech.started');
  h.release();
  await p;
  assert.deepEqual(h.sent, [], 'held: reply.done is no longer the latest event');
  await h.gate.onReplyDone('completed');
  assert.equal(h.sent[0].type, 'tool.result');
  assert.equal(h.sent[0].call_id, 'c1');
});

test('tool gate: interrupted while our server works -> result dropped, stage update still sent', async () => {
  const h = harness({ slowMs: 1 });
  h.gate.onTurnEvent('reply.started');
  h.gate.onToolCall({ call_id: 'c1', name: 'confirm_budget' });
  const p = h.gate.onReplyDone('completed');
  await new Promise((r) => setImmediate(r));
  h.gate.onTurnEvent('input.speech.started');
  h.gate.onReplyDone('interrupted');
  h.release();
  await p;
  assert.ok(!h.sent.some((m) => m.type === 'tool.result'), 'no stale tool.result');
  assert.equal(h.sent.filter((m) => m.type === 'session.update').length, 1, 'tools stay in step with our server stage');
  assert.deepEqual(h.dropped, ['confirm_budget:interrupted']);
});

test('tool gate: two calls in one reply go out in order; errors carry is_error; a failing server is an error result', async () => {
  const h = harness();
  h.gate.onTurnEvent('reply.started');
  h.gate.onToolCall({ call_id: 'a', name: 'confirm_budget' });
  h.gate.onToolCall({ call_id: 'b', name: 'bad' });
  await h.gate.onReplyDone('completed');
  assert.deepEqual(h.sent.filter((m) => m.type === 'tool.result').map((m) => [m.call_id, m.is_error]), [['a', false], ['b', true]]);
  assert.equal(h.sent.filter((m) => m.type === 'session.update').length, 1, 'one update, from the last call');

  const sent = [];
  const gate = createToolGate({ runTool: async () => { throw new Error('HTTP 502'); }, send: (m) => sent.push(m) });
  gate.onToolCall({ call_id: 'z', name: 'build_plan' });
  await gate.onReplyDone('completed');
  assert.equal(sent[0].is_error, true);
  assert.equal(JSON.parse(sent[0].result).error, 'tool_unavailable');
});

test('tool gate: a tool.call that lands after reply.done is relayed at once', async () => {
  const h = harness();
  await h.gate.onReplyDone('completed'); // previous reply
  await h.gate.onToolCall({ call_id: 'late', name: 'end_call' });
  assert.equal(h.sent[0].call_id, 'late');
});

test('latency meter: speech stopped -> first reply audio only, median of measured values', () => {
  const m = createLatencyMeter();
  assert.equal(m.replyAudio(100), null, 'no stop yet');
  m.speechStopped(1000);
  assert.equal(m.replyAudio(1420), 420);
  assert.equal(m.replyAudio(1500), null, 'only the first chunk counts');
  m.speechStopped(2000);
  m.speechStarted(); // the owner kept talking
  assert.equal(m.replyAudio(2600), null);
  m.speechStopped(3000);
  m.replyAudio(3800);
  m.speechStopped(4000);
  m.replyAudio(4500);
  assert.equal(m.median, 500);
  assert.equal(m.last, 500);
  assert.equal(m.count, 3);
});

test('listeningFrom: reads keyterms and mode from the config AssemblyAI echoed', () => {
  const cfg = { input: { keyterms: ['won', 'man won', 'thousand won', 'a month'], transcription_mode: 'max_accuracy', transcription_prompt: 'budget' } };
  assert.deepEqual(listeningFrom(cfg, 's1'), { step: 'budget', mode: 'max_accuracy', keyterms: 4, prompt: true });
  assert.deepEqual(listeningFrom({}, null), { step: null, mode: 'balanced', keyterms: 0, prompt: false });
  assert.equal(stepOf('s3_plan'), 'plan');
  assert.equal(stepOf('commit'), 'commit');
  assert.equal(stepOf('weird'), null);
});

test('pauseReason: switch off, spent credit and rate limits read differently', () => {
  assert.equal(pauseReason({ status: 503, code: 'voice_demo_paused' }), 'paused');
  assert.equal(pauseReason({ status: 402 }), 'paused');
  assert.equal(pauseReason({ status: 429 }), 'busy');
  assert.equal(pauseReason({ code: 'UNAUTHORIZED' }), 'paused');
  assert.equal(pauseReason({ status: 500, code: 'internal' }), null);
});
