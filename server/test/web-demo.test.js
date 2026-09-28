import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWav, createPacer, createDirector } from '../../web/src/lib/demo-script.js';
import { encodeWav } from '../../web/src/wav.js';

const LINES = JSON.parse(readFileSync(new URL('../../web/src/demo-lines.json', import.meta.url), 'utf8')).lines;

test('parseWav: reads what encodeWav writes, skips extra chunks, rejects non-WAV (SPA fallback HTML)', () => {
  const pcm = new Int16Array([0, 100, -100, 32767, -32768]);
  const w = parseWav(encodeWav([pcm], 24000));
  assert.equal(w.sampleRate, 24000);
  assert.equal(w.channels, 1);
  assert.deepEqual(Array.from(w.samples), Array.from(pcm));
  // a LIST chunk before data (Windows speech writes some)
  const base = new Uint8Array(encodeWav([pcm], 24000));
  const list = new Uint8Array(8 + 4);
  list.set([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 0x49, 0x4e, 0x46, 0x4f]);
  const withList = new Uint8Array(base.length + list.length);
  withList.set(base.subarray(0, 36), 0);
  withList.set(list, 36);
  withList.set(base.subarray(36), 36 + list.length);
  assert.deepEqual(Array.from(parseWav(withList).samples), Array.from(pcm));
  assert.throws(() => parseWav(new TextEncoder().encode('<!doctype html><html>'.padEnd(64, ' '))), /not a WAV/);
});

test('pacer: never ahead of the wall clock, catches up after a stall, drops a very long backlog', () => {
  const p = createPacer({ frameMs: 50, maxBurst: 40 });
  p.start(1000);
  assert.equal(p.due(1000), 0);
  assert.equal(p.due(1049), 0);
  assert.equal(p.due(1050), 1);
  assert.equal(p.due(1060), 0);
  assert.equal(p.due(1500), 9, 'a throttled timer catches up to exactly real time');
  assert.equal(p.sent, 10);
  for (let t = 1500; t <= 61000; t += 17) p.due(t);
  assert.ok(p.sent <= Math.floor((61000 - 1000) / 50), 'total sent never exceeds elapsed time');
  const q = createPacer({ frameMs: 50, maxBurst: 40 });
  q.start(0);
  assert.equal(q.due(10_000), 40, 'a 10 s stall sends at most 2 s at once');
});

test('demo lines: the design script C1..C7 in order, C4 is the barge-in on the plan', () => {
  assert.deepEqual(LINES.map((l) => l.id), ['C1', 'C2a', 'C2b', 'C3', 'C4', 'C5', 'C6', 'C7']);
  const c4 = LINES.find((l) => l.id === 'C4');
  assert.deepEqual(c4.bargeIn, { afterTool: 'build_plan', delayMs: 2500 });
  assert.ok(LINES.find((l) => l.id === 'C2b').parts.some((p) => p.pause_ms === 1200), 'C2b pauses 1.2 s in the middle');
  for (const l of LINES) assert.ok(!/naver|instagram|kakao|coupang|baemin/i.test(JSON.stringify(l)), 'no brand names');
});

/** Drive a director through agent events; returns the played ids. */
function run(events, lines = LINES) {
  const d = createDirector(lines, { settleMs: 1000, fallbackMs: 20000, endAfterMs: 8000 });
  const played = [];
  const take = (cmds) => { for (const c of cmds) played.push(c.cmd === 'play' ? `${c.id}${c.bargeIn ? '!' : ''}` : c.cmd); };
  for (const [t, type, data] of events) take(type === 'tick' ? d.tick(t) : d.on(type, data, t));
  return { played, d };
}

const spoken = (t, id = 'resp_1') => [[t, 'reply.started', {}], [t + 100, 'reply.audio', {}], [t + 900, 'reply.done', { status: 'completed', reply_id: id }]];

test('director: greeting -> C1 only after the agent audio finished playing and a settle pause', () => {
  const { played } = run([
    ...spoken(0),
    [1500, 'tick'], // reply.done came, audio still playing here
    [3000, 'playback.drained'],
    [3500, 'tick'],
    [4000, 'tick'],
  ]);
  assert.deepEqual(played, ['C1']);
});

test('director: a tool-call reply or an interrupted reply does not start the next line', () => {
  const { played } = run([
    [0, 'reply.started', {}], [10, 'tool.call', {}], [20, 'reply.done', { status: 'completed', reply_id: 'fc-call_1' }],
    [3000, 'tick'],
    [3100, 'reply.started', {}], [3200, 'reply.audio', {}], [3500, 'reply.done', { status: 'interrupted', reply_id: 'resp_2' }],
    [3600, 'playback.drained'], [9000, 'tick'],
  ]);
  assert.deepEqual(played, []);
});

test('director: the settle pause is cancelled if the agent starts another reply right away', () => {
  const { played } = run([
    ...spoken(0), [1000, 'playback.drained'],
    [1500, 'reply.started', {}], // "Let me note that." then a tool call
    [1600, 'tool.call', {}],
    [3000, 'tick'],
  ]);
  assert.deepEqual(played, []);
});

test('director: full script with the barge-in 2.5 s after the plan reading starts', () => {
  const ev = [];
  let t = 0;
  const agentSays = () => { ev.push(...spoken(t, `resp_${t}`)); ev.push([t + 1500, 'playback.drained', {}]); ev.push([t + 2600, 'tick', {}]); t += 3000; };
  const callerSays = () => { ev.push([t, 'line.ended', {}]); t += 500; };
  const tool = (name) => { ev.push([t, 'tool.call', {}], [t + 10, 'reply.done', { status: 'completed', reply_id: 'fc-x' }], [t + 200, 'tool.settled', { name, sent: true }]); t += 300; };
  agentSays(); callerSays(); // greeting, C1
  tool('record_shop'); agentSays(); callerSays(); // budget question, C2a
  tool('record_budget'); agentSays(); callerSays(); // which one?, C2b
  tool('record_budget'); agentSays(); callerSays(); // read back, C3
  tool('confirm_budget'); tool('build_plan');
  ev.push([t, 'reply.started', {}], [t + 100, 'reply.audio', {}], [t + 2400, 'tick', {}], [t + 2500, 'tick', {}]); // plan reading
  const bargeAt = t + 2500;
  t += 2600;
  ev.push([t, 'reply.done', { status: 'interrupted', reply_id: 'resp_plan' }], [t + 10, 'playback.drained', {}]);
  t += 100; callerSays(); // C4 ends
  tool('record_budget'); agentSays(); callerSays(); // read back 380k, C5
  tool('confirm_budget'); tool('build_plan'); agentSays(); callerSays(); // plan, C6
  tool('create_checkout_link'); agentSays(); callerSays(); // link, C7
  tool('end_call'); agentSays();
  ev.push([t + 100, 'tick', {}]);
  const { played } = run(ev);
  assert.deepEqual(played, ['C1', 'C2a', 'C2b', 'C3', 'C4!', 'C5', 'C6', 'C7', 'done']);
  assert.ok(bargeAt > 0);
});

test('director: the barge-in line falls back to a normal line when the plan reading never comes', () => {
  const lines = [{ id: 'A', text: 'a' }, { id: 'B', text: 'b', bargeIn: { afterTool: 'build_plan', delayMs: 2500 } }];
  const { played } = run([
    ...spoken(0), [1000, 'playback.drained'], [2500, 'tick'], // A
    [3000, 'line.ended', {}],
    ...spoken(4000), [5000, 'playback.drained'], [6000, 'tick'],
    [24000, 'tick'], [26000, 'tick'],
  ], lines);
  assert.deepEqual(played, ['A', 'B']);
});

test('director: finishes after the last line even if the agent stays quiet', () => {
  const lines = [{ id: 'A', text: 'a' }];
  const { played } = run([...spoken(0), [1000, 'playback.drained'], [2500, 'tick'], [3000, 'line.ended', {}], [5000, 'tick'], [11500, 'tick']], lines);
  assert.deepEqual(played, ['A', 'done']);
});
