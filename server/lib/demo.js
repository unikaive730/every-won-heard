/**
 * Public demo mode (DEMO_MODE=1, design 6-9).
 *
 * The public URL only ever shows a short allowlist of catalog products, under generic names
 * (server/data/display-names.json): no follower, like, review or traffic products, and no app or
 * platform names on screen or in speech. Prices still come from the catalog (live MCP or the
 * snapshot in products.mock.json); this module only decides which products may appear and what
 * they are called.
 */
import { readFileSync } from 'node:fs';

const NAMES = JSON.parse(readFileSync(new URL('../data/display-names.json', import.meta.url), 'utf8'));

/** productId -> { productId, group, en, ko, spoken_en: [one, many], unit_ko } */
export const DISPLAY_NAMES = new Map(NAMES.products.map((p) => [p.productId, p]));
export const ALLOWED_PRODUCT_IDS = Object.freeze(NAMES.products.map((p) => p.productId));

export function isDemoMode(env = process.env) {
  const v = String(env.DEMO_MODE ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function isAllowed(productId) {
  return DISPLAY_NAMES.has(Number(productId));
}

/** Generic name for a product, or the fallback (the catalog name) when it has none. */
export function displayName(productId, lang = 'en', fallback = null) {
  const d = DISPLAY_NAMES.get(Number(productId));
  if (!d) return fallback;
  return lang === 'ko' ? d.ko : d.en;
}

/** Only the allowlisted products of a catalog, in allowlist order. */
export function allowlistCatalog(products = []) {
  const byId = new Map(products.map((p) => [p.productId, p]));
  return ALLOWED_PRODUCT_IDS.map((id) => byId.get(id)).filter(Boolean);
}

/** True when a catalog holds nothing outside the allowlist (the committed snapshot is such a catalog). */
export function isAllowlistOnly(products = []) {
  return products.length > 0 && products.every((p) => isAllowed(p.productId));
}

// --- demo checkout (the public demo never creates a real payment link) ---

export const DEMO_CHECKOUT_TEXT = 'Demo checkout. No payment is taken.';
const SESSION_ID = /^[A-Za-z0-9_-]{4,80}$/;

/** Base URL for links the server hands out: PUBLIC_BASE_URL, else the request's own host. */
export function publicBaseUrl(req, env = process.env) {
  const fixed = String(env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (fixed) return fixed;
  const host = String(req?.headers?.host || 'localhost').replace(/[^A-Za-z0-9.:[\]-]/g, '');
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || req?.socket?.encrypted ? 'https' : 'http';
  return `${proto}://${host}`;
}

/**
 * What a checkout returns in demo mode. Same fields the web app reads from a real one
 * (checkoutUrl, amount) plus url/demo for the voice agent's create_checkout_link tool.
 */
export function demoCheckout(session, baseUrl = '') {
  const plan = session?.plan;
  if (!plan) return { ok: false, error: 'no_plan' };
  const url = `${baseUrl}/demo-checkout/${encodeURIComponent(session.id)}`;
  return { ok: true, demo: true, url, checkoutUrl: url, amount: plan.total_cost, message: DEMO_CHECKOUT_TEXT };
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const won = (n) => `₩${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

/** The page behind a demo checkout link: the plan's lines, the total, and no way to pay. */
export function renderDemoCheckoutPage(session, id = '') {
  const lang = session?.lang === 'ko' ? 'ko' : 'en';
  const ko = lang === 'ko';
  const plan = session?.plan || null;
  const lines = plan ? plan.channels.flatMap((c) => c.items) : [];
  let body;
  if (!session) {
    body = `<p>This demo call is no longer on the server. Calls are kept in memory only while the server runs.</p>`;
  } else if (!plan) {
    body = `<p>${ko ? '아직 계획이 없습니다.' : 'There is no plan for this call yet.'}</p>`;
  } else {
    const rows = lines.map((i) => `<tr><td>${esc(i.name)}</td><td class="n">${esc(i.qty)}</td><td class="n">${won(i.unitPrice)}</td><td class="n">${won(i.cost)}</td></tr>`).join('');
    body = `
    <table>
      <thead><tr><th>${ko ? '항목' : 'Item'}</th><th class="n">${ko ? '수량' : 'Qty'}</th><th class="n">${ko ? '단가' : 'Unit'}</th><th class="n">${ko ? '금액' : 'Amount'}</th></tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="3">${ko ? '합계' : 'Total'}</td><td class="n">${won(plan.total_cost)}</td></tr></tfoot>
    </table>
    <p class="sub">${ko ? `월 예산 ${won(plan.budget_krw)} · 가격은 카탈로그 단가` : `Monthly budget ${won(plan.budget_krw)} · prices from the catalog`}</p>
    <button type="button" disabled>${ko ? '결제 없음 (데모)' : 'No payment (demo)'}</button>`;
  }
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Demo checkout</title>
<style>
  :root { --bg: #f6f3ee; --ink: #1c1a17; --muted: #6b645a; --line: #d9d2c7; --accent: #c2410c; color-scheme: light dark; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1a17; --ink: #f1ece4; --muted: #a8a095; --line: #3a362f; --accent: #fb923c; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 32px 16px 48px; }
  .band { margin: 0 0 24px; padding: 12px 16px; border: 1px solid var(--accent); border-radius: 8px; color: var(--accent); font-weight: 600; }
  h1 { margin: 0 0 4px; font-size: 1.6rem; }
  .sub { color: var(--muted); margin: 8px 0 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; }
  th, td { padding: 8px 4px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
  .n { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; border-bottom: 0; }
  button { margin-top: 20px; padding: 10px 16px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--muted); font: inherit; }
  a { color: inherit; }
  .foot { margin-top: 32px; color: var(--muted); font-size: 0.9rem; }
</style>
</head>
<body>
<main>
  <p class="band">${esc(DEMO_CHECKOUT_TEXT)}${ko ? '<br>데모 결제 화면입니다. 실제 결제·주문은 일어나지 않습니다.' : ''}</p>
  <h1>${ko ? '데모 결제' : 'Demo checkout'}</h1>
  <p class="sub">${ko ? '가상의 가게 · 음성 상담으로 만든 30일 계획' : 'Fictional shop · a 30-day plan from a voice consultation'}${id ? ` · ${esc(id)}` : ''}</p>
  ${body}
  <p class="foot">${ko ? '해커톤 데모 페이지입니다. 아무것도 청구되지 않습니다.' : 'This page is part of a hackathon demo. Nothing is charged and no order is placed.'} <a href="/">${ko ? '데모로 돌아가기' : 'Back to the demo'}</a></p>
</main>
</body>
</html>
`;
}

export function isSessionId(id) {
  return SESSION_ID.test(String(id || ''));
}
