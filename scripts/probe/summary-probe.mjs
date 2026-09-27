// LLM Gateway probe: post-call summary quality on qwen3.5-4b-32k-fast, plus what the model accepts
// (stream, response_format, json-repair post-processing).
//   node scripts/probe/summary-probe.mjs [out.json]
// About 9 small calls (under a cent). Stops on 401/403/429.
import fs from 'node:fs';
import { createAgent } from '../../server/lib/agent.js';
import { createGateway, GATEWAY_URL, DEFAULT_SUMMARY_MODEL } from '../../server/lib/gateway.js';

const env = Object.fromEntries(fs.readFileSync(new URL('../../.env', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const KEY = env.ASSEMBLYAI_API_KEY;
const outPath = process.argv[2] || null;
const quiet = { warn() {}, error() {}, log() {} };
const mock = JSON.parse(fs.readFileSync(new URL('../../server/data/products.mock.json', import.meta.url), 'utf8'));
const agent = createAgent({ getCatalog: async () => ({ source: 'mock', products: mock.products }), logger: quiet });
const gw = createGateway({ apiKey: KEY, enabled: true, logger: { warn: (m) => console.log('gateway:', m) } });
const out = { at: new Date().toISOString(), model: DEFAULT_SUMMARY_MODEL, summaries: [], capabilities: {} };

// what 3.6 Pro actually returned in the live Korean run (probe_ko_call_a.json), plus two more calls
const calls = [
  { name: 'ko K1-K3 (live transcript)', lang: 'ko', turns: ['망원시장 근처에서 라멘집 하는데요. 평일 점심이 너무 비어요.', '블로그 체험단은 해봤고요. 예산은 한 달에 50, 아니 48만 원 정도요.', '네, 맞아요.'] },
  { name: 'en C1-C3', lang: 'en', turns: ['Hi. I run a small ramen place near Mangwon Market. We opened in the spring. Weekends are fine, but weekday lunch is empty.', 'Maybe four or five hundred thousand won a month.', 'Four hundred eighty thousand.', "Yes, that's right."] },
  { name: 'ko salon, range then correction', lang: 'ko', turns: ['성수동에서 미용실 하는데 네이버 플레이스 리뷰가 너무 적어요.', '한 달에 사오십만 원이요.', '40만 원이요.', '아니요.', '30만 원으로 할게요.', '네 맞아요.'] },
];

async function stopIfAuth(status, where) {
  if ([401, 403, 429].includes(status)) { console.log(`STOP: ${where} HTTP ${status}`); if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 1)); process.exit(2); }
}

for (const c of calls) {
  const s = agent.createSession({ lang: c.lang, engine: 'realtime' });
  for (const t of c.turns) await agent.handleUtterance(s.id, t);
  for (let rep = 0; rep < 2; rep++) {
    const r = await gw.summarizeCall(s);
    if (gw.state.disabled) { console.log('gateway error:', gw.state.lastError); await stopIfAuth(Number((gw.state.lastError.match(/Gateway (d{3})/) || [])[1]) || 429, 'summary'); }
    out.summaries.push({ call: c.name, rep, ...r });
    console.log(`\n[${c.name} #${rep + 1}] ${r.source}${r.reason ? ` (${r.reason})` : ''} ${r.latency_ms ?? ''}ms\n  ${r.text}\n  next: ${r.next_step}${r.raw ? `\n  raw: ${r.raw}` : ''}${r.template ? `\n  model wrote: ${r.template}` : ''}`);
  }
}

// capability checks on the same model
async function raw(body) {
  const t0 = Date.now();
  const res = await fetch(GATEWAY_URL, { method: 'POST', headers: { Authorization: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: DEFAULT_SUMMARY_MODEL, messages: [{ role: 'user', content: 'Reply with the JSON {"ok": true} only. /no_think' }], max_tokens: 60, ...body }) });
  await stopIfAuth(res.status, JSON.stringify(Object.keys(body)));
  return { res, t0 };
}
{
  const { res, t0 } = await raw({ stream: true });
  let first = null; let chunks = 0; let text = '';
  const reader = res.body.getReader(); const dec = new TextDecoder();
  for (;;) { const { value, done } = await reader.read(); if (done) break; if (first == null) first = Date.now() - t0; chunks++; text += dec.decode(value); }
  out.capabilities.stream = { status: res.status, content_type: res.headers.get('content-type'), first_chunk_ms: first, total_ms: Date.now() - t0, chunks, sample: text.slice(0, 300) };
}
{
  const { res } = await raw({ response_format: { type: 'json_schema', json_schema: { name: 'ok', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, strict: true } } });
  out.capabilities.response_format = { status: res.status, body: (await res.text()).slice(0, 300) };
}
{
  const { res } = await raw({ post_processing_steps: [{ type: 'json-repair' }] });
  out.capabilities.json_repair = { status: res.status, body: (await res.text()).slice(0, 300) };
}
console.log('\ncapabilities:', JSON.stringify(out.capabilities, null, 1));
console.log('gateway calls:', gw.state.calls + 3, 'rejected:', gw.state.rejected, 'failures:', gw.state.failures);
if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
