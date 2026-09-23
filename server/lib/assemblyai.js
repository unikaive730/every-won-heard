/**
 * AssemblyAI server-side helpers. The API key never leaves this process.
 *
 * 1. streamingToken()  GET https://streaming.assemblyai.com/v3/token  -> short-lived token for the browser WebSocket
 * 2. transcribe()      POST /v2/upload + POST /v2/transcript + poll     -> used for Korean "turn" mode and for the
 *                       end-of-call analysis (speaker_labels, sentiment_analysis, auto_highlights, entity_detection)
 *
 * Docs: https://www.assemblyai.com/docs/api-reference/streaming-api/generate-streaming-token
 *       https://www.assemblyai.com/docs/api-reference/transcripts/submit
 */

export const STREAMING_TOKEN_URL = 'https://streaming.assemblyai.com/v3/token';
export const API_BASE = 'https://api.assemblyai.com/v2';

export function createAssemblyAI({ apiKey = process.env.ASSEMBLYAI_API_KEY || '', fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), logger = console } = {}) {
  const enabled = Boolean(apiKey && apiKey.trim());

  function requireKey() {
    if (!enabled) {
      const err = new Error('ASSEMBLYAI_API_KEY is not set');
      err.code = 'no_key';
      throw err;
    }
  }

  async function streamingToken({ expiresInSeconds = 60, maxSessionDurationSeconds = 1800 } = {}) {
    requireKey();
    const u = new URL(STREAMING_TOKEN_URL);
    u.searchParams.set('expires_in_seconds', String(expiresInSeconds));
    u.searchParams.set('max_session_duration_seconds', String(maxSessionDurationSeconds));
    const res = await fetchImpl(u, { headers: { Authorization: apiKey } });
    if (!res.ok) {
      const err = new Error(`AssemblyAI token request failed (${res.status})`);
      err.code = res.status === 401 ? 'bad_key' : 'token_failed';
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    return { token: json.token, expires_in_seconds: json.expires_in_seconds ?? expiresInSeconds };
  }

  async function upload(bytes) {
    requireKey();
    const res = await fetchImpl(`${API_BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    if (!res.ok) throw new Error(`AssemblyAI upload failed (${res.status})`);
    const json = await res.json();
    return json.upload_url;
  }

  async function createTranscript(body) {
    const res = await fetchImpl(`${API_BASE}/transcript`, {
      method: 'POST',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`AssemblyAI transcript request failed (${res.status}): ${json.error || ''}`);
    return json;
  }

  async function getTranscript(id) {
    const res = await fetchImpl(`${API_BASE}/transcript/${id}`, { headers: { Authorization: apiKey } });
    if (!res.ok) throw new Error(`AssemblyAI transcript poll failed (${res.status})`);
    return res.json();
  }

  async function waitFor(id, { pollIntervalMs = 1000, maxWaitMs = 180_000 } = {}) {
    const start = Date.now();
    for (;;) {
      const t = await getTranscript(id);
      if (t.status === 'completed' || t.status === 'error') return t;
      if (Date.now() - start > maxWaitMs) throw new Error('AssemblyAI transcript timed out');
      await sleep(pollIntervalMs);
    }
  }

  /**
   * Transcribe an audio buffer (WAV/PCM or any container AssemblyAI accepts).
   * @param {Uint8Array|Buffer} bytes
   * @param {{languageCode?:string, features?:{speakerLabels?:boolean, sentiment?:boolean, highlights?:boolean, entities?:boolean}, keyterms?:string[], pollIntervalMs?:number, maxWaitMs?:number}} opts
   */
  async function transcribe(bytes, { languageCode = 'ko', features = {}, keyterms = [], pollIntervalMs, maxWaitMs } = {}) {
    requireKey();
    const uploadUrl = await upload(bytes);
    const base = { audio_url: uploadUrl, punctuate: true, format_text: true };
    if (languageCode) base.language_code = languageCode;
    else base.language_detection = true;
    if (keyterms.length) base.keyterms_prompt = keyterms.slice(0, 100);

    const isEnglish = !languageCode || languageCode.startsWith('en');
    const withFeatures = { ...base };
    if (features.speakerLabels) withFeatures.speaker_labels = true;
    if (features.entities) withFeatures.entity_detection = true;
    // sentiment analysis and key phrases are English-only on AssemblyAI
    if (features.sentiment && isEnglish) withFeatures.sentiment_analysis = true;
    if (features.highlights && isEnglish) withFeatures.auto_highlights = true;

    let created = await createTranscript(withFeatures);
    let done = await waitFor(created.id, { pollIntervalMs, maxWaitMs });
    if (done.status === 'error' && Object.keys(withFeatures).length > Object.keys(base).length) {
      // a feature was rejected for this language -> retry with plain transcription so the call still completes
      logger?.warn?.(`[assemblyai] transcript error with features (${done.error}); retrying without intelligence features`);
      created = await createTranscript(base);
      done = await waitFor(created.id, { pollIntervalMs, maxWaitMs });
      done.features_downgraded = true;
    }
    if (done.status === 'error') throw new Error(`AssemblyAI transcript error: ${done.error}`);
    return done;
  }

  return { enabled, streamingToken, upload, transcribe, getTranscript };
}
