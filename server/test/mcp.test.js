import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpClient } from '../lib/mcp.js';

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

const liveProducts = [{ productId: 2, productName: 'N플레이스 유입', category: 'N플레이스 > 트래픽', unitPrice: 60, aiOrderable: true }];
const mock = { _meta: { capturedAt: '2026-09-23' }, products: [{ productId: 999, productName: 'mock', unitPrice: 1, aiOrderable: true }] };

test('listProducts uses the live MCP result and caches it', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    assert.equal(body.method, 'tools/call');
    assert.equal(body.params.name, 'list_products');
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(liveProducts) }] } });
  };
  const mcp = createMcpClient({ fetchImpl, mock, logger: { warn() {} } });
  const a = await mcp.listProducts();
  assert.equal(a.source, 'live');
  assert.equal(a.products[0].productId, 2);
  const b = await mcp.listProducts();
  assert.equal(b.source, 'live');
  assert.equal(calls, 1, 'second call served from cache');
});

test('listProducts falls back to the mock snapshot when the endpoint fails, and says so', async () => {
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const warned = [];
  const mcp = createMcpClient({ fetchImpl, mock, logger: { warn: (m) => warned.push(m) } });
  const r = await mcp.listProducts();
  assert.equal(r.source, 'mock');
  assert.equal(r.products[0].productId, 999);
  assert.match(r.error, /ECONNREFUSED/);
  assert.equal(warned.length, 1);
});

test('tool errors (isError) surface as exceptions; searchPlaces degrades to empty', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { isError: true, content: [{ type: 'text', text: 'keyword required' }] } });
  };
  const mcp = createMcpClient({ fetchImpl, mock, logger: { warn() {} } });
  await assert.rejects(mcp.callTool('get_product', { productId: 1 }), /keyword required/);
  const p = await mcp.searchPlaces('x');
  assert.equal(p.source, 'unavailable');
  assert.deepEqual(p.places, []);
});

test('createCheckout passes items and customer name through and returns the parsed checkout', async () => {
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.params.name, 'create_checkout');
    assert.deepEqual(body.params.arguments.items, [{ productId: 2, quantity: 1000 }]);
    assert.equal(body.params.arguments.customerName, '홍길동');
    assert.equal(body.params.arguments.agentName, 'MarketPilot Voice Agent');
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify({ checkoutUrl: 'https://www.marketpilot.it/checkout/abc', checkoutToken: 'abcdefghijklmnop', amount: 60000 }) }] } });
  };
  const mcp = createMcpClient({ fetchImpl, mock });
  const r = await mcp.createCheckout({ items: [{ productId: 2, quantity: 1000 }], customerName: '홍길동' });
  assert.equal(r.checkoutUrl, 'https://www.marketpilot.it/checkout/abc');
});

test('status reports ok:false with the error when unreachable', async () => {
  const mcp = createMcpClient({ fetchImpl: async () => jsonResponse({}, 502), mock });
  const s = await mcp.status();
  assert.equal(s.ok, false);
  assert.match(s.error, /502/);
});

test('status is cached for 60 s and concurrent callers share one request', async () => {
  let calls = 0;
  let t = 1_000_000;
  const fetchImpl = async (url, init) => {
    calls += 1;
    const body = JSON.parse(init.body);
    assert.equal(body.method, 'initialize');
    return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'marketpilot', version: '1' } } });
  };
  const mcp = createMcpClient({ fetchImpl, mock, now: () => t });
  const [a, b, c] = await Promise.all([mcp.status(), mcp.status(), mcp.status()]);
  assert.equal(calls, 1, 'one request for three concurrent health checks');
  assert.equal(a.ok, true);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.ok(a.checkedAt);
  t += 59_000;
  await mcp.status();
  assert.equal(calls, 1, 'still cached at 59 s');
  t += 2_000;
  await mcp.status();
  assert.equal(calls, 2, 'checked again after 60 s');
  await mcp.status({ force: true });
  assert.equal(calls, 3);
});
