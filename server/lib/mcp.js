/**
 * Minimal MCP (JSON-RPC over HTTP) client for the MarketPilot public MCP server.
 * Endpoint: https://api.marketpilot.it/mcp  (no auth needed for catalog / place search / checkout links)
 *
 * Falls back to server/data/products.mock.json when the endpoint is unreachable and
 * reports `source: 'mock'` so the UI and README can say so honestly.
 *
 * status() is cached for 60 s (concurrent callers share one request), so the public /api/health
 * does not call the production MCP server on every page load.
 */
import { readFile } from 'node:fs/promises';

export const DEFAULT_MCP_URL = 'https://api.marketpilot.it/mcp';
const MOCK_PATH = new URL('../data/products.mock.json', import.meta.url);

export function createMcpClient({ url = process.env.MARKETPILOT_MCP_URL || DEFAULT_MCP_URL, fetchImpl = globalThis.fetch, timeoutMs = 8000, mock = null, cacheMs = 10 * 60 * 1000, statusCacheMs = 60 * 1000, now = () => Date.now(), logger = console } = {}) {
  let nextId = 1;
  let productCache = null; // {at, value}
  let statusCache = null; // {at, value}
  let statusInflight = null;
  let lastError = null;

  async function rpc(method, params = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async function callTool(name, args = {}) {
    const result = await rpc('tools/call', { name, arguments: args });
    const textBlock = (result?.content || []).find((c) => c.type === 'text');
    const text = textBlock ? textBlock.text : '';
    if (result?.isError) throw new Error(`MCP tool ${name} failed: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  async function loadMock() {
    if (mock) return mock;
    const raw = await readFile(MOCK_PATH, 'utf8');
    return JSON.parse(raw);
  }

  /** @returns {Promise<{source:'live'|'mock', products:Array, fetchedAt:number, error?:string}>} */
  async function listProducts({ force = false } = {}) {
    if (!force && productCache && now() - productCache.at < cacheMs) return productCache.value;
    try {
      const products = await callTool('list_products', {});
      if (!Array.isArray(products)) throw new Error('list_products returned non-array');
      const value = { source: 'live', products, fetchedAt: now() };
      productCache = { at: now(), value };
      lastError = null;
      return value;
    } catch (err) {
      lastError = String(err?.message || err);
      logger?.warn?.(`[mcp] list_products failed, using mock: ${lastError}`);
      const m = await loadMock();
      const value = { source: 'mock', products: m.products, fetchedAt: now(), capturedAt: m._meta?.capturedAt, error: lastError };
      productCache = { at: now(), value };
      return value;
    }
  }

  async function getProduct(productId) {
    return callTool('get_product', { productId });
  }

  /** @returns {Promise<{source:'live'|'unavailable', places:Array, error?:string}>} */
  async function searchPlaces(keyword) {
    try {
      const places = await callTool('search_places', { keyword });
      return { source: 'live', places: Array.isArray(places) ? places : [] };
    } catch (err) {
      return { source: 'unavailable', places: [], error: String(err?.message || err) };
    }
  }

  /** Creates a card checkout link. Live only: never fake a payment URL. */
  async function createCheckout({ items, customerName, customerPhone, customerEmail, companyName, note }) {
    return callTool('create_checkout', {
      items,
      customerName,
      ...(customerPhone ? { customerPhone } : {}),
      ...(customerEmail ? { customerEmail } : {}),
      ...(companyName ? { companyName } : {}),
      ...(note ? { note } : {}),
      agentName: 'MarketPilot Voice Agent',
    });
  }

  async function getCheckoutStatus(checkoutToken) {
    return callTool('get_checkout_status', { checkoutToken });
  }

  async function submitInquiry(input) {
    return callTool('submit_inquiry', { ...input, agentName: 'MarketPilot Voice Agent' });
  }

  async function checkStatus() {
    try {
      const r = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'marketpilot-voice-agent', version: '0.1.0' } });
      return { ok: true, url, serverInfo: r?.serverInfo || null };
    } catch (err) {
      return { ok: false, url, error: String(err?.message || err) };
    }
  }

  /** Reachability of the MCP server, checked at most once per statusCacheMs. */
  async function status({ force = false } = {}) {
    if (!force && statusCache && now() - statusCache.at < statusCacheMs) return statusCache.value;
    if (!statusInflight) {
      statusInflight = checkStatus()
        .then((value) => {
          const at = now();
          const out = { ...value, checkedAt: new Date(at).toISOString() };
          statusCache = { at, value: out };
          return out;
        })
        .finally(() => { statusInflight = null; });
    }
    return statusInflight;
  }

  return { url, rpc, callTool, listProducts, getProduct, searchPlaces, createCheckout, getCheckoutStatus, submitInquiry, status, get lastError() { return lastError; } };
}
