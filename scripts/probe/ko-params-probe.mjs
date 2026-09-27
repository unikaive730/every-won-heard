// Probe: which connection / UpdateConfiguration parameters Universal-3.6 Pro streaming accepts.
//   node scripts/probe/ko-params-probe.mjs [out.json]
// Each variant opens one short session, streams K3.wav (2 s of Korean) at real-time speed,
// sends Terminate and waits for Termination. Cost: a few seconds of streaming per variant.
// Stops on 401/403/429 without retrying.
import fs from 'node:fs';

const env = Object.fromEntries(fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.ASSEMBLYAI_API_KEY;
const outPath = process.argv[2] || null;
const wav = fs.readFileSync(new URL('./K3.wav', import.meta.url));
const pcm = wav.subarray(44);
const BASE = 'speech_model=universal-3-6-pro&sample_rate=16000&encoding=pcm_s16le&language_detection=true';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function token() {
  const r = await fetch('https://streaming.assemblyai.com/v3/token?expires_in_seconds=60&max_session_duration_seconds=60', { headers: { Authorization: KEY } });
  if ([401, 403, 429].includes(r.status)) { console.log(`STOP: token HTTP ${r.status}`); process.exit(2); }
  const j = await r.json();
  if (!j.token) throw new Error(`token failed ${r.status}`);
  return j.token;
}

/** Run one session. `updates` are UpdateConfiguration payloads sent right after Begin (300 ms apart). */
async function run(name, extra, updates = []) {
  const tok = await token();
  const url = `wss://streaming.assemblyai.com/v3/ws?${BASE}${extra ? `&${extra}` : ''}&token=${tok}`;
  const log = { name, query: extra, updates, begin: null, errors: [], other: [], finals: [], close: null, terminated: null };
  const t0 = Date.now();
  await new Promise((resolve) => {
    const ws = new WebSocket(url);
    let began = false;
    const done = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 25000);
    ws.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'Begin') {
        log.begin = m.configuration || m;
        began = true;
        for (const u of updates) { ws.send(JSON.stringify({ type: 'UpdateConfiguration', ...u })); await sleep(300); }
        for (let i = 0; i < pcm.length; i += 3200) { if (ws.readyState !== 1) break; ws.send(pcm.subarray(i, i + 3200)); await sleep(100); }
        for (let i = 0; i < 12 && ws.readyState === 1; i++) { ws.send(Buffer.alloc(3200)); await sleep(100); }
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'Terminate' }));
        return;
      }
      if (m.type === 'Turn') { if (m.end_of_turn) log.finals.push({ text: m.transcript, lang: m.language_code ?? null, formatted: m.turn_is_formatted ?? null }); return; }
      if (m.type === 'Termination') { log.terminated = { at_ms: Date.now() - t0, audio: m.audio_duration_seconds, session: m.session_duration_seconds }; return; }
      if (m.type === 'Error' || m.error) { log.errors.push(m); return; }
      if (m.type !== 'SpeechStarted') log.other.push(m);
    };
    ws.onclose = (e) => { log.close = { code: e.code, reason: e.reason, began }; clearTimeout(done); resolve(); };
    ws.onerror = () => {};
  });
  if (log.close && [1008, 4001, 4003, 4029].includes(log.close.code) && /unauth|forbidden|rate|quota|429|401|403/i.test(log.close.reason || '')) {
    console.log('STOP:', JSON.stringify(log.close)); console.log(JSON.stringify(log, null, 1)); process.exit(2);
  }
  console.log(`\n== ${name}\n${JSON.stringify(log, null, 1)}`);
  return log;
}

const results = [];
results.push(await run('A language_codes JSON list', `language_codes=${encodeURIComponent(JSON.stringify(['ko', 'en']))}`));
results.push(await run('B language_codes comma', 'language_codes=ko,en'));
results.push(await run('C language_codes repeated', 'language_codes=ko&language_codes=en'));
results.push(await run('D mode=max_accuracy at connect', 'mode=max_accuracy'));
results.push(await run('E mid-stream updates (valid)', '', [
  { mode: 'max_accuracy' },
  { agent_context: '한 달 마케팅 예산은 얼마 정도 생각하세요?' },
  { keyterms_prompt: ['만 원', '십만 원', '한 달', '부가세'] },
  { language_codes: ['ko'] },
]));
results.push(await run('F mid-stream updates (invalid, to see if updates are validated)', '', [
  { mode: 'bogus_mode' },
  { keyterms_prompt: Array.from({ length: 101 }, (_, i) => `term${i}`) },
]));
if (outPath) fs.writeFileSync(outPath, JSON.stringify({ at: new Date().toISOString(), results }, null, 1));
