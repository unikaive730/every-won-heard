/**
 * The priced plan the Voice Agent reads out (design 6-9). Deterministic: the only input is the confirmed budget.
 *
 * Products come from a short allowlist with generic English names (no platform or brand names, so the agent
 * can say them). Unit prices come from the catalog (live MarketPilot MCP or the mock snapshot) by product ID,
 * never from the model. Fixed-price items go in first, each only if the rest still covers the blog-post
 * minimum; the rest buys blog posts; a leftover of 3,000 won or more buys photo retouching.
 *
 *   480,000 -> audit 100,000 + press 90,000 + flyer 99,000 + 21 blog posts 189,000 = 478,000
 *   380,000 -> audit 100,000 + press 90,000 + flyer 99,000 + 10 blog posts  90,000 = 379,000
 */
import { englishWords } from './amounts.js';

// id, generic English name, how to say one / many, and the Korean name for the realtime path
export const ALLOWLIST = [
  { id: 282, role: 'fixed', en: 'Map listing audit report', one: 'map listing audit report', many: 'map listing audit reports', ko: '지도 매장정보 진단 보고서' },
  { id: 142, role: 'fixed', en: 'Press release, basic', one: 'basic press release', many: 'basic press releases', ko: '보도자료 배포(베이직)' },
  { id: 251, role: 'fixed', en: 'Flyer design and print', one: 'flyer design and print', many: 'flyer designs and prints', ko: '전단지 제작' },
  { id: 249, role: 'fixed_alt', en: 'Poster design and print', one: 'poster design and print', many: 'poster designs and prints', ko: '포스터 제작' },
  { id: 106, role: 'fill', en: 'Sponsored blog post by a recruited blogger', one: 'sponsored blog post', many: 'sponsored blog posts', ko: '블로거 섭외 후기 글' },
  { id: 112, role: 'leftover', en: 'Photo retouching, per image', one: 'retouched photo', many: 'retouched photos', ko: '사진 보정' },
];

const RETOUCH_MAX = 30;

function priced(catalog, entry) {
  const p = (catalog || []).find((x) => x.productId === entry.id);
  if (!p || !p.aiOrderable || !(p.unitPrice > 0)) return null;
  return { ...entry, unit: p.unitPrice, min: p.minOrderUnit || 1, max: p.maxOrderUnit || Infinity, catalogName: p.productName };
}

function spokenLine(e, qty) {
  return `${englishWords(qty)} ${qty === 1 ? e.one : e.many}`;
}

/**
 * @param {number} budgetKrw  the confirmed budget (ledger)
 * @param {Array} catalog     products (MCP list_products shape)
 * @returns {{budget_krw, total_krw, lines:Array<{product_id,name,name_ko,qty,unit_krw,cost_krw,spoken}>, spoken_total, spoken_budget}}
 */
export function planForBudget(budgetKrw, catalog) {
  const budget = Math.floor(Number(budgetKrw));
  if (!(budget > 0)) throw Object.assign(new Error('budget required'), { code: 'no_budget' });
  const items = ALLOWLIST.map((e) => priced(catalog, e)).filter(Boolean);
  const fill = items.find((e) => e.role === 'fill');
  const reserve = fill ? fill.min * fill.unit : 0; // keep room for the minimum blog order
  const lines = [];
  let left = budget;
  const add = (e, qty) => {
    lines.push({ product_id: e.id, name: e.en, name_ko: e.ko, qty, unit_krw: e.unit, cost_krw: qty * e.unit, spoken: spokenLine(e, qty) });
    left -= qty * e.unit;
  };
  let flyerIn = false;
  for (const e of items.filter((x) => x.role === 'fixed' || x.role === 'fixed_alt')) {
    if (e.role === 'fixed_alt' && flyerIn) continue; // the poster only stands in for a flyer that did not fit
    if (e.min * e.unit <= left - reserve) {
      add(e, e.min);
      if (e.id === 251) flyerIn = true;
    }
  }
  if (fill) {
    const qty = Math.min(Math.floor(left / fill.unit), fill.max);
    if (qty >= fill.min) add(fill, qty);
  }
  const retouch = items.find((e) => e.role === 'leftover');
  if (retouch) {
    const qty = Math.min(Math.floor(left / retouch.unit), RETOUCH_MAX, retouch.max);
    if (qty >= retouch.min) add(retouch, qty);
  }
  const total = budget - left;
  return { budget_krw: budget, total_krw: total, lines, spoken_total: `${englishWords(total)} won`, spoken_budget: `${englishWords(budget)} won a month` };
}

/**
 * The same plan in the planner.js shape (channels -> items), so the existing plan card, the text export and
 * checkoutItems() work unchanged. One channel per line.
 */
export function asPlannerPlan(p, { catalogSource = 'unknown' } = {}) {
  const channels = p.lines.map((l) => ({
    key: `p${l.product_id}`,
    label: l.name,
    why: '',
    share: p.total_krw ? l.cost_krw / p.total_krw : 0,
    items: [{ productId: l.product_id, name: l.name, unitPrice: l.unit_krw, qty: l.qty, cost: l.cost_krw }],
    cost: l.cost_krw,
  }));
  return {
    language: 'en',
    horizon_days: 30,
    budget_krw: p.budget_krw,
    total_cost: p.total_krw,
    channels,
    inquiry_items: [],
    assumptions: [],
    checklist: [],
    summary: `${p.lines.map((l) => l.spoken).join(', ')}. Total ${p.spoken_total}.`,
    catalog_source: catalogSource,
    source: 'voice-plan',
  };
}
