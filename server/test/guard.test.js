import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGuard, clientIp, guardOptionsFromEnv, PAUSED_MESSAGE, CAP_MESSAGE } from '../lib/guard.js';

function clock(start = Date.parse('2026-09-29T10:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('voice: 3 per IP per minute, then 429 with Retry-After; the window slides', () => {
  const c = clock();
  const g = createGuard({ now: c.now });
  for (let i = 0; i < 3; i++) { assert.equal(g.take('1.1.1.1', 'voice').ok, true); c.advance(1000); }
  const r = g.take('1.1.1.1', 'voice');
  assert.equal(r.ok, false);
  assert.equal(r.status, 429);
  assert.equal(r.body.scope, 'ip_minute');
  assert.ok(r.retryAfter > 0 && r.retryAfter <= 60);
  assert.equal(g.take('2.2.2.2', 'voice').ok, true, 'another caller is not affected');
  c.advance(58_000); // 61 s after the first call
  assert.equal(g.take('1.1.1.1', 'voice').ok, true);
});

test('voice: 10 per IP per day', () => {
  const c = clock();
  const g = createGuard({ now: c.now });
  for (let i = 0; i < 10; i++) { assert.equal(g.take('1.1.1.1', 'voice').ok, true, `call ${i + 1}`); c.advance(61_000); }
  const r = g.take('1.1.1.1', 'voice');
  assert.equal(r.status, 429);
  assert.equal(r.body.scope, 'ip_day');
});

test('voice: DAILY_SESSION_CAP for everyone together, reset at 00:00 UTC', () => {
  const c = clock(Date.parse('2026-09-29T23:00:00Z'));
  const g = createGuard({ now: c.now, limits: { voice: { perMinute: 3, perDay: 10, dailyCap: 4 } } });
  for (let i = 0; i < 4; i++) assert.equal(g.take(`10.0.0.${i}`, 'voice').ok, true);
  const r = g.take('10.0.0.9', 'voice');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'daily_cap');
  assert.equal(r.body.message, CAP_MESSAGE);
  assert.equal(r.body.resets_at, '2026-09-30T00:00:00.000Z');
  const s = g.status();
  assert.equal(s.enabled, false);
  assert.equal(s.left_today, 0);
  assert.equal(s.message, CAP_MESSAGE);
  c.advance(60 * 60 * 1000 + 1);
  assert.equal(g.take('10.0.0.9', 'voice').ok, true, 'a new UTC day');
  assert.equal(g.status().used_today, 1);
});

test('refund gives a failed call back (upstream error spends nothing)', () => {
  const c = clock();
  const g = createGuard({ now: c.now, limits: { voice: { perMinute: 3, perDay: 10, dailyCap: 1 } } });
  const a = g.take('1.1.1.1', 'voice');
  assert.equal(g.take('1.1.1.1', 'voice').ok, false);
  g.refund(a.ticket);
  assert.equal(g.status().used_today, 0);
  assert.equal(g.take('1.1.1.1', 'voice').ok, true);
});

test('VOICE_DEMO_ENABLED=0 pauses voice and uploads, never new text sessions', () => {
  const g = createGuard({ voiceEnabled: false });
  const r = g.take('1.1.1.1', 'voice');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'voice_paused');
  assert.equal(r.body.message, PAUSED_MESSAGE);
  assert.equal(g.take('1.1.1.1', 'upload').body.error, 'voice_paused');
  assert.equal(g.take('1.1.1.1', 'session').ok, true);
  assert.equal(g.status().paused, true);
  assert.equal(g.status().enabled, false);
});

test('limits off (local development) still honours the pause switch', () => {
  const g = createGuard({ limitsOn: false });
  for (let i = 0; i < 50; i++) assert.equal(g.take('127.0.0.1', 'voice').ok, true);
  assert.equal(g.status().limits, null);
  assert.equal(createGuard({ limitsOn: false, voiceEnabled: false }).take('127.0.0.1', 'voice').ok, false);
});

test('buckets are separate: uploads and sessions do not use up calls', () => {
  const g = createGuard();
  for (let i = 0; i < 10; i++) g.take('1.1.1.1', 'upload');
  for (let i = 0; i < 10; i++) g.take('1.1.1.1', 'session');
  assert.equal(g.take('1.1.1.1', 'voice').ok, true);
  assert.equal(g.status().used_today, 1);
});

test('guardOptionsFromEnv: limits follow DEMO_MODE unless VOICE_GUARD forces them; other defaults', () => {
  assert.equal(guardOptionsFromEnv({}).limitsOn, false, 'a developer machine');
  assert.equal(guardOptionsFromEnv({ DEMO_MODE: '1' }).limitsOn, true, 'the public deployment');
  assert.equal(guardOptionsFromEnv({ DEMO_MODE: '1', VOICE_GUARD: '0' }).limitsOn, false);
  assert.equal(guardOptionsFromEnv({ VOICE_GUARD: '1' }).limitsOn, true);
  const d = guardOptionsFromEnv({ DEMO_MODE: '1' });
  assert.equal(d.limitsOn, true);
  assert.equal(d.voiceEnabled, true);
  assert.equal(d.limits.voice.dailyCap, 25);
  assert.equal(d.limits.voice.perMinute, 3);
  assert.equal(d.limits.voice.perDay, 10);
  assert.equal(d.trustProxyHops, 0);
  const o = guardOptionsFromEnv({ DAILY_SESSION_CAP: '40', VOICE_DEMO_ENABLED: '0', VOICE_GUARD: '0', TRUST_PROXY_HOPS: '1' });
  assert.equal(o.limits.voice.dailyCap, 40);
  assert.equal(o.voiceEnabled, false);
  assert.equal(o.limitsOn, false);
  assert.equal(o.trustProxyHops, 1);
  assert.equal(guardOptionsFromEnv({ DAILY_SESSION_CAP: 'lots' }).limits.voice.dailyCap, 25);
});

test('clientIp: socket address by default; behind n proxies, the n-th forwarded entry from the right', () => {
  const req = (xff, remote = '::ffff:10.1.2.3') => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('6.6.6.6')), '10.1.2.3', 'no proxy trusted: a forged header is ignored');
  assert.equal(clientIp(req('6.6.6.6, 203.0.113.7'), { trustProxyHops: 1 }), '203.0.113.7', 'the forged left entry is ignored');
  assert.equal(clientIp(req('203.0.113.7, 198.51.100.2'), { trustProxyHops: 2 }), '203.0.113.7');
  assert.equal(clientIp(req('203.0.113.7'), { trustProxyHops: 3 }), '203.0.113.7');
  assert.equal(clientIp(req(''), { trustProxyHops: 1 }), '10.1.2.3');
});
