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
