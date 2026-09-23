import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAssemblyAI, STREAMING_TOKEN_URL, API_BASE } from '../lib/assemblyai.js';

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

test('no key: enabled=false and streamingToken throws code no_key', async () => {
  const aai = createAssemblyAI({ apiKey: '' });
  assert.equal(aai.enabled, false);
  await assert.rejects(aai.streamingToken(), (e) => e.code === 'no_key');
});

test('streamingToken calls the v3 token endpoint with the key in the Authorization header', async () => {
  let seen = null;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), init };
    return jsonResponse({ token: 'tmp-token', expires_in_seconds: 60 });
  };
  const aai = createAssemblyAI({ apiKey: 'secret-key', fetchImpl });
  const t = await aai.streamingToken({ expiresInSeconds: 60, maxSessionDurationSeconds: 900 });
  assert.equal(t.token, 'tmp-token');
  assert.ok(seen.url.startsWith(STREAMING_TOKEN_URL));
  const u = new URL(seen.url);
  assert.equal(u.searchParams.get('expires_in_seconds'), '60');
  assert.equal(u.searchParams.get('max_session_duration_seconds'), '900');
  assert.equal(seen.init.headers.Authorization, 'secret-key');
});

test('streamingToken maps 401 to bad_key', async () => {
  const aai = createAssemblyAI({ apiKey: 'wrong', fetchImpl: async () => jsonResponse({ error: 'unauthorized' }, 401) });
  await assert.rejects(aai.streamingToken(), (e) => e.code === 'bad_key' && e.status === 401);
});

test('transcribe: upload -> create -> poll until completed; Korean never requests English-only features', async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, init });
    if (u === `${API_BASE}/upload`) return jsonResponse({ upload_url: 'https://cdn.assemblyai.com/upload/1' });
    if (u === `${API_BASE}/transcript` && init.method === 'POST') {
      const body = JSON.parse(init.body);
      assert.equal(body.audio_url, 'https://cdn.assemblyai.com/upload/1');
      assert.equal(body.language_code, 'ko');
      assert.equal(body.speaker_labels, true);
      assert.equal(body.entity_detection, true);
      assert.equal('sentiment_analysis' in body, false, 'sentiment is English-only');
      assert.equal('auto_highlights' in body, false, 'key phrases are English-only');
      return jsonResponse({ id: 't1', status: 'queued' });
    }
    if (u === `${API_BASE}/transcript/t1`) {
      polls += 1;
      return jsonResponse(polls < 3 ? { id: 't1', status: 'processing' } : { id: 't1', status: 'completed', text: '성수동 카페예요', utterances: [] });
    }
    throw new Error(`unexpected ${u}`);
  };
  const aai = createAssemblyAI({ apiKey: 'k', fetchImpl, sleep: async () => {} });
  const t = await aai.transcribe(new Uint8Array([1, 2, 3]), { languageCode: 'ko', features: { speakerLabels: true, sentiment: true, highlights: true, entities: true } });
  assert.equal(t.status, 'completed');
  assert.equal(t.text, '성수동 카페예요');
  assert.equal(polls, 3);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/octet-stream');
});

test('transcribe: English requests sentiment + key phrases, and retries without features if the API errors', async () => {
  let creates = 0;
  let polls = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/upload')) return jsonResponse({ upload_url: 'https://cdn/x' });
    if (u.endsWith('/transcript') && init.method === 'POST') {
      creates += 1;
      const body = JSON.parse(init.body);
      if (creates === 1) {
        assert.equal(body.sentiment_analysis, true);
        assert.equal(body.auto_highlights, true);
        return jsonResponse({ id: 'bad', status: 'queued' });
      }
      assert.equal('sentiment_analysis' in body, false);
      return jsonResponse({ id: 'good', status: 'queued' });
    }
    if (u.endsWith('/transcript/bad')) return jsonResponse({ id: 'bad', status: 'error', error: 'feature not supported' });
    if (u.endsWith('/transcript/good')) { polls += 1; return jsonResponse({ id: 'good', status: 'completed', text: 'ok' }); }
    throw new Error(`unexpected ${u}`);
  };
  const warned = [];
  const aai = createAssemblyAI({ apiKey: 'k', fetchImpl, sleep: async () => {}, logger: { warn: (m) => warned.push(m) } });
  const t = await aai.transcribe(new Uint8Array(4), { languageCode: 'en', features: { sentiment: true, highlights: true } });
  assert.equal(t.status, 'completed');
  assert.equal(t.features_downgraded, true);
  assert.equal(creates, 2);
  assert.equal(warned.length, 1);
});
