import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTranscriptState, reduceTurn, flushPending, buildStreamingUrl, sttModeFor, fullText, detectLanguage, updateConfigMessage } from '../../web/src/lib/transcript.js';

test('sttModeFor: both languages stream (Korean on Universal-3.6 Pro)', () => {
  assert.equal(sttModeFor('ko'), 'stream');
  assert.equal(sttModeFor('en'), 'stream');
});

test('buildStreamingUrl (ko): 3.6 Pro, no retired parameters, JSON language_codes and keyterms, greeting as agent_context', () => {
  const url = buildStreamingUrl({ token: 't', lang: 'ko', agentContext: '안녕하세요, 어떤 가게를 하세요?', keyterms: ['망원', '성수', 'x'.repeat(51)], mode: 'balanced', languageCodes: ['ko', 'en'] });
  const q = new URL(url).searchParams;
  assert.equal(q.get('speech_model'), 'universal-3-6-pro');
  assert.equal(q.get('language_detection'), 'true');
  assert.equal(q.get('format_turns'), null);
  assert.equal(q.get('end_of_turn_confidence_threshold'), null);
  assert.equal(q.get('language_codes'), '["ko","en"]', 'a comma list is rejected by the API (measured), a JSON list works');
  assert.deepEqual(JSON.parse(q.get('keyterms_prompt')), ['망원', '성수'], 'terms over 50 characters are dropped');
  assert.equal(q.get('agent_context'), '안녕하세요, 어떤 가게를 하세요?');
  assert.equal(q.get('mode'), 'balanced');
  assert.equal(q.get('token'), 't');
});

test('updateConfigMessage: validates before sending (an invalid value closes the session)', () => {
  const m = updateConfigMessage({ agent_context: 'a'.repeat(2000), keyterms_prompt: Array.from({ length: 120 }, (_, i) => `t${i}`), mode: 'max_accuracy' });
  assert.equal(m.type, 'UpdateConfiguration');
  assert.equal(m.agent_context.length, 1750);
  assert.equal(m.keyterms_prompt.length, 100);
  assert.equal(m.mode, 'max_accuracy');
  assert.equal(updateConfigMessage({ mode: 'bogus_mode' }), null, 'unknown mode is dropped, not sent');
  assert.equal(updateConfigMessage({}), null);
});

test('reduceTurn (3.6 Pro, formatTurns=false): a formatted end_of_turn is final right away', () => {
  let s = createTranscriptState();
  s = reduceTurn(s, { type: 'Turn', turn_order: 0, transcript: '네.', end_of_turn: false, turn_is_formatted: true }, { formatTurns: false }).state;
  const r = reduceTurn(s, { type: 'Turn', turn_order: 0, transcript: '네, 맞아요.', end_of_turn: true, turn_is_formatted: true, language_code: 'ko' }, { formatTurns: false });
  assert.equal(r.event.type, 'final');
  assert.equal(r.event.languageCode, 'ko');
});

test('buildStreamingUrl puts only the temporary token in the query, never an API key', () => {
  const url = buildStreamingUrl({ token: 'tmp123', lang: 'en', prompt: 'marketing call' });
  const u = new URL(url);
  assert.equal(u.protocol, 'wss:');
  assert.equal(u.host, 'streaming.assemblyai.com');
  assert.equal(u.pathname, '/v3/ws');
  assert.equal(u.searchParams.get('token'), 'tmp123');
  assert.equal(u.searchParams.get('sample_rate'), '16000');
  assert.equal(u.searchParams.get('encoding'), 'pcm_s16le');
  assert.equal(u.searchParams.get('format_turns'), 'true');
  assert.equal(u.searchParams.get('speech_model'), 'universal-3-5-pro');
  assert.ok(!url.includes('Authorization'));
  assert.throws(() => buildStreamingUrl({}), /token is required/);
});

test('reduceTurn: partials update, formatted final is emitted once', () => {
  let s = createTranscriptState();
  let r = reduceTurn(s, { type: 'Turn', turn_order: 0, transcript: 'i run a', end_of_turn: false, turn_is_formatted: false });
  s = r.state;
  assert.deepEqual(r.event, { type: 'partial', text: 'i run a', order: 0 });
  assert.equal(s.partial, 'i run a');

  r = reduceTurn(s, { type: 'Turn', turn_order: 0, transcript: 'i run a cafe in gangnam', end_of_turn: true, turn_is_formatted: false });
  s = r.state;
  assert.equal(r.event.type, 'partial', 'unformatted end_of_turn is shown as partial while waiting for the formatted copy');
  assert.ok(s.pending);

  r = reduceTurn(s, { type: 'Turn', turn_order: 0, transcript: 'I run a cafe in Gangnam.', end_of_turn: true, turn_is_formatted: true, language_code: 'en' });
  s = r.state;
  assert.equal(r.event.type, 'final');
  assert.equal(r.event.text, 'I run a cafe in Gangnam.');
  assert.equal(r.event.languageCode, 'en');
  assert.equal(s.turns.length, 1);
  assert.equal(s.partial, '');
  assert.equal(s.pending, null);

  // duplicate final for the same turn_order is ignored
  r = reduceTurn(s, { type: 'Turn', turn_order: 0, transcript: 'I run a cafe in Gangnam.', end_of_turn: true, turn_is_formatted: true });
  assert.equal(r.event, null);
  assert.equal(r.state.turns.length, 1);
});

test('reduceTurn: non-Turn messages and empty transcripts are ignored', () => {
  const s = createTranscriptState();
  assert.equal(reduceTurn(s, { type: 'Begin', id: 'x' }).event, null);
  assert.equal(reduceTurn(s, { type: 'Turn', turn_order: 3, transcript: '   ', end_of_turn: false }).event, null);
});

test('flushPending finalizes an unformatted turn on close', () => {
  let s = createTranscriptState();
  s = reduceTurn(s, { type: 'Turn', turn_order: 5, transcript: 'budget is 500 dollars', end_of_turn: true, turn_is_formatted: false }).state;
  const r = flushPending(s);
  assert.equal(r.event.type, 'final');
  assert.equal(r.state.turns[0].text, 'budget is 500 dollars');
  assert.equal(fullText(r.state), 'budget is 500 dollars');
  assert.equal(flushPending(r.state).event, null);
});

test('detectLanguage', () => {
  assert.equal(detectLanguage('강남에서 카페 해요'), 'ko');
  assert.equal(detectLanguage('I run a cafe'), 'en');
  assert.equal(detectLanguage(''), 'en');
});
