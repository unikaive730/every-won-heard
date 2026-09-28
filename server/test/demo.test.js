// Public demo mode over HTTP: DEMO_MODE=1 is set before the app is created, as on the public deployment.
process.env.DEMO_MODE = '1';

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../index.js';
import { createMcpClient } from '../lib/mcp.js';
import { createAssemblyAI } from '../lib/assemblyai.js';
import { createGuard, PAUSED_MESSAGE, CAP_MESSAGE } from '../lib/guard.js';
import { ALLOWED_PRODUCT_IDS, DEMO_CHECKOUT_TEXT } from '../lib/demo.js';

const full = JSON.parse(await readFile(new URL('./fixtures/catalog-full.json', import.meta.url), 'utf8')).products;
const snapshot = JSON.parse(await readFile(new URL('../data/products.mock.json', import.meta.url), 'utf8'));
const quiet = { warn() {}, error() {}, log() {} };
const BRANDS = /네이버|인스타|카카오|구글|유튜브|쿠팡|당근|페이스북|플레이스|naver|instagram|kakao|google|youtube|coupang|facebook/i;

// a live MCP that returns the full catalog (the demo must still show only the allowlist); counts initialize calls
let initializeCalls = 0;
let placeCalls = 0;
function liveMcp() {
  return createMcpClient({
    mock: snapshot,
    logger: quiet,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const reply = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: body.id, result }) });
      if (body.method === 'initialize') { initializeCalls += 1; return reply({ serverInfo: { name: 'mcp', version: '1' } }); }
      if (body.params?.name === 'list_products') return reply({ content: [{ type: 'text', text: JSON.stringify(full) }] });
      if (body.params?.name === 'search_places') { placeCalls += 1; return reply({ content: [{ type: 'text', text: '[]' }] }); }
      if (body.params?.name === 'create_checkout') throw new Error('the demo must never create a real checkout');
      throw new Error(`unexpected ${body.method}`);
    },
  });
}

function aai(status = 200) {
  return createAssemblyAI({
    apiKey: 'fake',
    fetchImpl: async (url) => {
      if (String(url).startsWith('https://streaming.assemblyai.com/v3/token')) {
        if (status !== 200) return { ok: false, status, json: async () => ({ error: 'nope' }) };
        return { ok: true, status: 200, json: async () => ({ token: 'tmp', expires_in_seconds: 60 }) };
      }
      throw new Error(`unexpected ${url}`);
    },
  });
}

const servers = [];
async function listen(app) {
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  servers.push(app.server);
  return `http://127.0.0.1:${app.server.address().port}`;
}
after(() => { for (const s of servers) s.close(); });

const main = createApp({ assemblyai: aai(), mcp: liveMcp(), llm: null, gateway: null, logger: quiet });
const base = await listen(main);
const post = async (b, p, body) => fetch(`${b}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('health: demo mode on, allowlist only, voice limits shown, MCP status checked once for many page loads', async () => {
  initializeCalls = 0;
  const all = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}/api/health`).then((r) => r.json())));
  const j = all[0];
  assert.equal(j.demo.mode, true);
  assert.equal(j.mcp.catalogSource, 'live');
  assert.equal(j.mcp.products, ALLOWED_PRODUCT_IDS.length, 'the live catalog is filtered to the allowlist');
  assert.ok(j.mcp.checkedAt);
  assert.equal(j.voice_demo.enabled, true);
  assert.deepEqual(j.voice_demo.limits, { per_ip_minute: 3, per_ip_day: 10, daily_cap: 25 });
  await fetch(`${base}/api/health`);
  assert.equal(initializeCalls, 1, 'one MCP initialize for six health checks');
});

test('token route: 3 calls a minute per IP, then 429 with Retry-After; health counts the calls', async () => {
  const app = createApp({ assemblyai: aai(), mcp: liveMcp(), llm: null, gateway: null, logger: quiet });
  const b = await listen(app);
  for (let i = 0; i < 3; i++) assert.equal((await fetch(`${b}/api/assemblyai/token`)).status, 200, `call ${i + 1}`);
  const r = await fetch(`${b}/api/assemblyai/token`);
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  const j = await r.json();
  assert.equal(j.error, 'rate_limited');
  assert.equal(j.scope, 'ip_minute');
  const h = await (await fetch(`${b}/api/health`)).json();
  assert.equal(h.voice_demo.used_today, 3);
  assert.equal(h.voice_demo.left_today, 22);
});

test('daily cap: calls stop for everyone, health tells the web app before anyone presses Start', async () => {
  const guard = createGuard({ limits: { voice: { perMinute: 10, perDay: 10, dailyCap: 2 } } });
  const app = createApp({ assemblyai: aai(), mcp: liveMcp(), llm: null, gateway: null, guard, logger: quiet });
  const b = await listen(app);
  assert.equal((await fetch(`${b}/api/assemblyai/token`)).status, 200);
  assert.equal((await fetch(`${b}/api/assemblyai/token`)).status, 200);
  const r = await fetch(`${b}/api/assemblyai/token`);
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'daily_cap');
  assert.equal(j.message, CAP_MESSAGE);
  const h = await (await fetch(`${b}/api/health`)).json();
  assert.equal(h.voice_demo.enabled, false);
  assert.equal(h.voice_demo.message, CAP_MESSAGE);
});

test('VOICE_DEMO_ENABLED=0: voice routes answer with the paused note, typing still works', async () => {
  const app = createApp({ assemblyai: aai(), mcp: liveMcp(), llm: null, gateway: null, guard: createGuard({ voiceEnabled: false }), logger: quiet });
  const b = await listen(app);
  const r = await fetch(`${b}/api/assemblyai/token`);
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.error, 'voice_paused');
  assert.equal(j.message, PAUSED_MESSAGE);
  const s = await (await post(b, '/api/session', { lang: 'en' })).json();
  const u = await post(b, `/api/session/${s.sessionId}/utterance`, { text: 'I run a cafe in Seongsu' });
  assert.equal(u.status, 200);
  const up = await fetch(`${b}/api/session/${s.sessionId}/voice-turn`, { method: 'POST', body: new Uint8Array(4000) });
  assert.equal(up.status, 503);
  assert.equal((await (await fetch(`${b}/api/health`)).json()).voice_demo.paused, true);
});

test('upstream out of credit or rate limited: paused note, no retry, and the failed call is given back', async () => {
  for (const status of [402, 429]) {
    const app = createApp({ assemblyai: aai(status), mcp: liveMcp(), llm: null, gateway: null, logger: quiet });
    const b = await listen(app);
    const r = await fetch(`${b}/api/assemblyai/token`);
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.error, 'voice_unavailable');
    assert.equal(j.upstream_status, status);
    assert.equal(j.message, PAUSED_MESSAGE);
    assert.equal((await (await fetch(`${b}/api/health`)).json()).voice_demo.used_today, 0, 'refunded');
  }
});

test('demo call: the plan uses only allowlisted products under generic names; checkout is a demo page', async () => {
  const s = await (await post(base, '/api/session', { lang: 'en' })).json();
  const say = async (text) => (await post(base, `/api/session/${s.sessionId}/utterance`, { text })).json();
  await say('I run a small ramen place near Mangwon Market');
  await say('480,000 won a month');
  const r = await say('weekday lunch is empty');
  assert.equal(r.stage, 'plan');
  assert.equal(r.plan.template, 'allowlist');
  assert.equal(r.plan.demo, true);
  assert.equal(r.plan.total_cost, 478_000);
  assert.equal(r.plan.spoken_total, 'four hundred seventy-eight thousand won');
  for (const l of r.plan.lines) assert.ok(ALLOWED_PRODUCT_IDS.includes(l.product_id));
  assert.doesNotMatch(JSON.stringify(r.plan), BRANDS);
  assert.equal(placeCalls, 0, 'no real store lookups from the public demo');

  // no name or phone needed, nothing sent to the checkout service
  const co = await post(base, `/api/session/${s.sessionId}/checkout`, {});
  assert.equal(co.status, 200);
  const cj = await co.json();
  assert.equal(cj.demo, true);
  assert.equal(cj.amount, 478_000);
  assert.equal(cj.message, DEMO_CHECKOUT_TEXT);
  assert.ok(cj.checkoutUrl.endsWith(`/demo-checkout/${s.sessionId}`));
  assert.ok(cj.checkoutUrl.startsWith('http://127.0.0.1:'), 'absolute link on the host that served the call');

  const page = await fetch(`${base}/demo-checkout/${s.sessionId}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html; charset=utf-8/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await page.text();
  assert.match(html, /^<!doctype html>/);
  assert.ok(html.includes(DEMO_CHECKOUT_TEXT));
  assert.ok(html.includes('Map listing audit report'));
  assert.ok(html.includes('₩478,000'));
  assert.doesNotMatch(html, BRANDS);
  assert.doesNotMatch(html, /<script|<form/i, 'nothing on the page can pay or run code');
});

test('demo checkout page: unknown or malformed call ids get the page with a 404, never a script', async () => {
  const miss = await fetch(`${base}/demo-checkout/s_missing123`);
  assert.equal(miss.status, 404);
  const t = await miss.text();
  assert.ok(t.includes(DEMO_CHECKOUT_TEXT));
  assert.ok(t.includes('no longer on the server'));
  const bad = await fetch(`${base}/demo-checkout/%3Cscript%3Ealert(1)%3C%2Fscript%3E`);
  assert.equal(bad.status, 404);
  assert.doesNotMatch(await bad.text(), /<script/i);
});

test('Korean demo page and a checkout before any plan', async () => {
  const s = await (await post(base, '/api/session', { lang: 'ko' })).json();
  const early = await post(base, `/api/session/${s.sessionId}/checkout`, {});
  assert.equal(early.status, 400);
  const html = await (await fetch(`${base}/demo-checkout/${s.sessionId}`)).text();
  assert.ok(html.includes('<html lang="ko">'));
  assert.ok(html.includes('실제 결제·주문은 일어나지 않습니다'));
  assert.ok(html.includes('아직 계획이 없습니다'));
});

test('products and place search in demo mode', async () => {
  const p = await (await fetch(`${base}/api/products`)).json();
  assert.equal(p.demo, true);
  assert.deepEqual(p.products.map((x) => x.productId), ALLOWED_PRODUCT_IDS.slice());
  assert.equal(p.products[0].productName, 'Map listing audit report');
  assert.equal(p.products[0].productNameKo, '지도 매장정보 진단 보고서');
  assert.doesNotMatch(JSON.stringify(p), BRANDS);
  const pl = await (await fetch(`${base}/api/places?keyword=${encodeURIComponent('망원 라멘')}`)).json();
  assert.equal(pl.source, 'disabled');
  assert.equal(placeCalls, 0);
});

test('upload size is capped in demo mode', async () => {
  const s = await (await post(base, '/api/session', { lang: 'ko' })).json();
  const big = await fetch(`${base}/api/session/${s.sessionId}/voice-turn`, { method: 'POST', body: new Uint8Array(3 * 1024 * 1024 + 1) });
  assert.equal(big.status, 413);
});

test('outside demo mode the demo checkout route does not exist', async () => {
  const app = createApp({ assemblyai: aai(), mcp: liveMcp(), llm: null, gateway: null, demoMode: false, logger: quiet });
  const b = await listen(app);
  const r = await fetch(`${b}/demo-checkout/s_anything1`);
  assert.equal(r.status, 404);
  assert.equal((await r.json()).error, 'not_found');
});
