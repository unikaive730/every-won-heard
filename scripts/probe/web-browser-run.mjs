// Runs "Watch a demo call" in headless Chrome at 1920x1080 against web-contract-stub.mjs and records what the
// page did: the client's event log (window.__ewh.log), the stub's request log, the ledger, and screenshots.
//
//   npm run build && node scripts/probe/web-browser-run.mjs --fake            # scripted socket, no cost
//   npm run build && node scripts/probe/web-browser-run.mjs --live --out DIR  # real Voice Agent API (paid)
//
// Puppeteer is not a dependency of this repo; point PUPPETEER_DIR at an installed copy
// (default: ../marketing-monorepo/node_modules/puppeteer). No window opens (headless).
// Hard limits: one call per run, the page ends the demo by itself, and this script sends session.end through
// the page (End call) at --max seconds (default 200) whatever happens.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStub, readKey } from './web-contract-stub.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const live = args.includes('--live');
const fake = !live;
const port = Number(opt('--port', 8799));
const maxSeconds = Number(opt('--max', 200));
const out = path.resolve(opt('--out', path.join(root, '.probe-out', live ? 'live' : 'fake')));
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
const puppeteer = require(process.env.PUPPETEER_DIR || path.resolve(root, '..', 'marketing-monorepo', 'node_modules', 'puppeteer'));

const stub = createStub({ live, apiKey: live ? readKey() : '', port, maxTokens: 1 });
await stub.listen();
const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1);
console.log(`[run] stub on ${port} (${live ? 'LIVE token, 1 max' : 'fake socket'}), out ${out}`);

const browser = await puppeteer.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--window-size=1920,1080'] });
let page;
const shots = [];
try {
  page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log(`[page ${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  if (fake) await page.evaluateOnNewDocument(readFileSync(path.join(here, 'fake-va-ws.js'), 'utf8'));
  await page.goto(`http://localhost:${port}/?lang=en`, { waitUntil: 'networkidle0' });
  await snap('0-idle');
  await page.click('#btn-demo');

  let lastRows = -1;
  let lastLines = 0;
  const deadline = Date.now() + maxSeconds * 1000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 500));
    const st = await page.evaluate(() => ({
      log: window.__ewh.log.length,
      finished: window.__ewh.log.some((e) => e.type === 'finished'),
      failed: window.__ewh.log.find((e) => e.type === 'start-failed') || null,
      receipt: window.__ewh.log.some((e) => e.type === 'receipt'),
      rows: document.querySelectorAll('#ledger .lrow').length,
      lines: window.__ewh.log.filter((e) => e.type === 'demo-line').length,
      state: document.querySelector('#call-state').textContent,
    }));
    if (st.failed) { console.log(`[run ${at()}] start failed: ${JSON.stringify(st.failed)}`); break; }
    if (st.rows !== lastRows) { lastRows = st.rows; await snap(`ledger-${st.rows}`); }
    if (st.lines !== lastLines) { lastLines = st.lines; console.log(`[run ${at()}] caller line ${st.lines} · ${st.state}`); if (st.lines === 5) setTimeout(() => snap('barge-in').catch(() => {}), 1500); }
    if (st.finished && st.receipt) { await new Promise((r) => setTimeout(r, 800)); await snap('end'); break; }
    if (st.finished && Date.now() > deadline + 40000) break;
    if (!st.finished && Date.now() > deadline) {
      console.log(`[run ${at()}] max ${maxSeconds}s reached, ending the call from the page`);
      await page.evaluate(() => document.querySelector('#btn-end')?.click());
    }
  }
} finally {
  try {
    if (page) {
      const dump = await page.evaluate(() => ({ log: window.__ewh.log, ledger: [...document.querySelectorAll('#ledger .lrow')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()), receipt: document.querySelector('#receipt')?.innerText || '', wire: [...document.querySelectorAll('#wire li')].map((li) => li.innerText.replace(/\s+/g, ' ')) }));
      // make sure no paid session is left open
      await page.evaluate(() => window.__ewh.app.va && !window.__ewh.app.va.closed && window.__ewh.app.va.end('runner_exit')).catch(() => {});
      writeFileSync(path.join(out, 'page.json'), JSON.stringify(dump, null, 2));
      writeFileSync(path.join(out, 'stub.json'), JSON.stringify({ requests: stub.log, sessions: [...stub.sessions.values()].map((s) => ({ id: s.id, stage: s.stage, aai: s.aaiSessionId, heard: s.grounding.heard, tools: s.tools, ledger: s.ledger.snapshot(), timeline: s.timeline || null })) }, null, 2));
      console.log(`[run ${at()}] ledger:\n  ${dump.ledger.join('\n  ')}\n[run] receipt: ${dump.receipt.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  } finally {
    await browser.close();
    stub.server.close();
    console.log(`[run] done in ${at()} s, tokens used ${stub.tokens}, shots ${shots.length}`);
  }
}

async function snap(name) {
  const f = path.join(out, `${String(shots.length).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: f });
  shots.push(f);
}
