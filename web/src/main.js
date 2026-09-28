/**
 * Every Won Heard - browser app.
 *
 * English (Voice Agent API, full duplex):
 *   Start call / Watch a demo call -> POST /api/session {engine:'voice-agent'} -> VoiceAgentClient
 *   (token, WebSocket, tool relay through our server, barge-in) with the mic, or with the synthesized demo
 *   caller. The ledger card shows every amount with its evidence; the listening line and the latency line are
 *   read from what AssemblyAI sends back. End -> session.end -> GET receipt (ledger vs AssemblyAI's record).
 * Korean (Universal-3.6 Pro streaming, half duplex, unchanged):
 *   StreamingSTT: greeting as agent_context at connect, each final turn -> POST utterance (grounding + ledger on
 *   the server) -> UpdateConfiguration with the reply as agent_context, this step's key terms and mode ->
 *   reply (browser TTS). End -> Terminate (wait for Termination) -> receipt -> whole-call analysis.
 * Typing in the composer works with no voice at all (text session), and inside a live English call it goes to
 * the agent as a user message.
 */
import { startMic, SAMPLE_RATE, VOICE_AGENT_CAPTURE, createCallContext } from './audio.js';
import { StreamingSTT, TurnVAD } from './stt.js';
import { encodeWav, durationSeconds } from './wav.js';
import { createTts } from './tts.js';
import { sttModeFor } from './lib/transcript.js';
import { stepOf } from './lib/va.js';
import { Player } from './player.js';
import { VoiceAgentClient } from './voice-agent.js';
import { DemoCaller } from './demo-caller.js';
import { I18N, $, applyI18n, setBadge, addBubble, agentCaption, setPartial, markMoney, renderBand, renderSlots, renderPlace, renderPlan, renderToolPlan, renderCheckoutLink, renderChecklist, renderCheckoutForm, renderCheckoutResult, renderAnalysis, summaryText, renderLedger, renderListening, renderLatency, renderWire, renderReceipt } from './ui.js';

const query = new URLSearchParams(location.search);

const app = {
  lang: query.get('lang') === 'ko' ? 'ko' : 'en',
  health: null,
  session: null, // {id, engine, profile, plan, brief, history}
  mic: null,
  stt: null,
  vad: null,
  mode: null, // 'stream' | 'turn' (Korean path)
  recording: [], // Int16Array frames of the whole call (Korean path; muted during TTS)
  speaking: false, // Korean TTS playing -> do not send audio
  busy: false, // waiting for the server
  startedAt: null,
  timer: null,
  tts: createTts(),
  ended: false,
  // English, Voice Agent API
  va: null,
  ctx: null,
  agentPlayer: null,
  callerPlayer: null,
  caller: null,
  demo: false,
  listen: null,
  wire: [],
  paused: null,
  levels: { mic: 0, agent: 0, caller: 0 },
};

// a small, capped event log for tests and for writing the video script from real values
const debug = { log: [], app };
globalThis.__ewh = debug;
const note = (type, data) => { if (debug.log.length < 3000) debug.log.push({ t: Math.round(performance.now()), type, ...data }); };

const els = {
  band: $('#band'), engine: $('#engine'),
  transcript: $('#transcript'), slots: $('#slots'), place: $('#place'), plan: $('#plan'), checkout: $('#checkout'), checklist: $('#checklist'), analysis: $('#analysis'),
  cardPlan: $('#card-plan'), cardChecklist: $('#card-checklist'), cardAnalysis: $('#card-analysis'),
  cardLedger: $('#card-ledger'), ledger: $('#ledger'), cardReceipt: $('#card-receipt'), receipt: $('#receipt'), listening: $('#listening'), latency: $('#latency'),
  cardWire: $('#card-wire'), wire: $('#wire'), paused: $('#paused'),
  btnCall: $('#btn-call'), btnCallLabel: $('#btn-call-label'), btnDemo: $('#btn-demo'), btnEnd: $('#btn-end'), state: $('#call-state'), meter: $('#meter'), mode: $('#call-mode'), timer: $('#call-timer'),
  composer: $('#composer'), input: $('#composer-input'), footCatalog: $('#foot-catalog'),
};

const t = () => I18N[app.lang];
const live = () => Boolean(app.session && !app.ended);

async function api(path, { method = 'GET', json, body, headers = {} } = {}) {
  const res = await fetch(path, { method, headers: json ? { 'Content-Type': 'application/json', ...headers } : headers, body: json ? JSON.stringify(json) : body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || data.error || `HTTP ${res.status}`), { status: res.status, data });
  return data;
}

function setState(text, cls = '') {
  els.state.textContent = text;
  els.state.className = `call-state ${cls}`;
}

function tick() {
  if (!app.startedAt) return;
  const s = Math.floor((Date.now() - app.startedAt) / 1000);
  els.timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function startTimer() {
  app.startedAt = Date.now();
  clearInterval(app.timer);
  app.timer = setInterval(tick, 1000);
  tick();
}

function paintBand() {
  const tt = t();
  renderBand(els.band, app.lang === 'en' && app.va && !app.demo && live() ? tt.bandMic : tt.band);
  els.btnDemo.hidden = app.lang !== 'en';
}

/** 'idle' | 'connecting' | 'live' */
function setButtons(phase) {
  const paused = app.paused === 'paused';
  els.btnCall.disabled = phase === 'connecting' || (paused && app.lang === 'en');
  els.btnDemo.disabled = phase !== 'idle' || paused;
  els.btnEnd.hidden = phase !== 'live';
  els.btnCall.setAttribute('aria-pressed', phase === 'live' ? 'true' : 'false');
  els.btnCallLabel.textContent = phase === 'live' ? t().listening : t().start;
}

function showPaused(reason) {
  app.paused = reason;
  if (!reason) { els.paused.hidden = true; return; }
  els.paused.hidden = false;
  els.paused.innerHTML = reason === 'busy' ? `${t().busy}` : `${t().paused}<small>${t().pausedSub}</small>`;
  setButtons('idle');
}

async function loadHealth() {
  try {
    app.health = await api('/api/health');
  } catch (err) {
    setBadge('badge-aai', 'bad', 'server?');
    setBadge('badge-llm', 'bad', '-');
    setBadge('badge-mcp', 'bad', '-');
    addBubble(els.transcript, 'system', `API server not reachable: ${err.message}`);
    return;
  }
  const h = app.health;
  setBadge('badge-aai', h.assemblyai.configured ? 'ok' : 'warn', h.assemblyai.configured ? 'key on server' : 'no key');
  setBadge('badge-llm', h.llm.configured ? 'ok' : 'warn', h.llm.configured ? h.llm.model : 'rules');
  setBadge('badge-mcp', h.mcp.reachable ? 'ok' : 'warn', h.mcp.reachable ? `live · ${h.mcp.products}` : 'snapshot');
  els.footCatalog.textContent = h.mcp.capturedAt && h.mcp.catalogSource !== 'live' ? h.mcp.capturedAt : '';
  // the server may announce the switch or the daily cap (guard); do not offer a call that cannot start
  const va = h.voice_agent || h.voiceAgent || h.voice_demo || null;
  if (va && va.enabled === false) showPaused('paused');
  if (!h.assemblyai.configured) addBubble(els.transcript, 'system', t().noKey);
}

function updateSide(r) {
  if (r.ledger) {
    els.cardLedger.hidden = false;
    renderLedger(els.ledger, r.ledger, app.lang);
    markMoney(els.transcript, r.ledger);
  }
  if (r.profile) {
    app.session.profile = r.profile;
    renderSlots(els.slots, r.profile, app.lang, { problemLabels: problemLabelMap() });
    renderPlace(els.place, r.profile.place, r.placeCandidates, app.lang);
  }
  if (r.plan) {
    app.session.plan = r.plan;
    els.cardPlan.hidden = false;
    els.cardChecklist.hidden = false;
    renderPlan(els.plan, r.plan, app.lang);
    renderChecklist(els.checklist, r.plan.checklist);
    if (!els.checkout.dataset.ready) {
      els.checkout.dataset.ready = '1';
      const mock = r.plan.catalog_source === 'mock';
      renderCheckoutForm(els.checkout, app.lang, { note: mock ? t().mockNote : '', onSubmit: createCheckout });
    }
  }
}

function problemLabelMap() {
  // labels come from the server language; slots carry keys -> local map (generic names, no platform names)
  const ko = { new_open: '신규 오픈', low_traffic: '손님·매출 부족', reviews: '리뷰 부족', place_rank: '지도·검색 노출', map_visibility: '지도·검색 노출', instagram: '사진 SNS 성장', social_growth: '사진 SNS 성장', competition: '경쟁 심화', delivery: '배달 매출', repeat: '재방문·단골', press: '브랜드 신뢰', app_growth: '앱 다운로드·가입', foreign: '외국인 고객' };
  const en = { new_open: 'just opened', low_traffic: 'not enough customers', reviews: 'few reviews', place_rank: 'map visibility', map_visibility: 'map visibility', instagram: 'photo social growth', social_growth: 'photo social growth', competition: 'competition', delivery: 'delivery orders', repeat: 'repeat customers', press: 'credibility', app_growth: 'app installs', foreign: 'foreign customers' };
  return app.lang === 'ko' ? ko : en;
}

// ---------------------------------------------------------------------------------------------------------
// English: Voice Agent API
// ---------------------------------------------------------------------------------------------------------

const HOT = new Set(['session.updated', 'tool.call', 'tool.result', 'session.error']);

function pushWire(w) {
  const hot = HOT.has(w.type) || (w.type === 'reply.done' && w.detail === 'interrupted') || /is_error/.test(w.detail || '');
  app.wire.push({ ...w, hot });
  if (app.wire.length > 60) app.wire.shift();
  renderWire(els.wire, app.wire.slice(-12));
}

let ledgerBusy = null;
async function refreshLedger() {
  if (!app.session) return;
  if (ledgerBusy) return ledgerBusy;
  ledgerBusy = (async () => {
    try {
      const r = await api(`/api/session/${app.session.id}/ledger`);
      app.session.ledger = r.rows || [];
      renderLedger(els.ledger, app.session.ledger, app.lang);
      markMoney(els.transcript, app.session.ledger);
    } catch (err) {
      note('warn', { message: `ledger: ${err.message}` });
    } finally {
      ledgerBusy = null;
    }
  })();
  return ledgerBusy;
}

function meter() {
  const l = app.levels;
  els.meter.style.width = `${Math.min(100, Math.max(l.mic, l.agent, l.caller) * 500)}%`;
}

function onToolResult({ call, result, is_error, raw }) {
  const r = result && typeof result === 'object' ? result : {};
  if (call.name === 'record_shop' && !is_error) {
    const a = call.arguments || {};
    const p = raw.profile || { business_label: a.business_type || null, location: a.neighborhood || null, problems: a.main_problem ? [a.main_problem] : [] };
    app.session.profile = p;
    renderSlots(els.slots, p, app.lang, { problemLabels: problemLabelMap() });
  }
  if (call.name === 'build_plan' && !is_error) {
    els.cardPlan.hidden = false;
    if (raw.plan?.channels) { app.session.plan = raw.plan; renderPlan(els.plan, raw.plan, app.lang); } else renderToolPlan(els.plan, r, app.lang);
    els.checkout.innerHTML = '';
  }
  if (call.name === 'create_checkout_link' && !is_error) {
    els.cardPlan.hidden = false;
    renderCheckoutLink(els.checkout, r, app.lang);
  }
  if (app.listen) renderListening(els.listening, { ...app.listen, step: stepOf(app.va?.state) || app.listen.step }, app.lang);
  refreshLedger();
}

function onAgent(type, d) {
  if (type !== 'reply-audio' && type !== 'agent-partial' && type !== 'user-partial') note(type, type === 'wire' ? { dir: d.dir, ev: d.type, detail: d.detail } : d);
  switch (type) {
    case 'wire': pushWire(d); break;
    case 'ready':
      setState(t().listening, 'is-live');
      startTimer();
      break;
    case 'listening':
      app.listen = d;
      renderListening(els.listening, d, app.lang);
      break;
    case 'speech':
      if (d.started) setState(t().listening, 'is-live');
      break;
    case 'user-partial': setPartial(els.transcript, d.text); break;
    case 'user':
      setPartial(els.transcript, '');
      addBubble(els.transcript, 'owner', d.text, { lang: app.lang, itemId: d.item_id, tag: d.typed ? 'typed' : '' });
      markMoney(els.transcript, app.session?.ledger);
      break;
    case 'reply-started': setState(t().speaking, 'is-speaking'); break;
    case 'agent-partial': agentCaption(els.transcript, d.reply_id, app.lang, { delta: d.delta }); break;
    case 'agent':
      if (d.text) agentCaption(els.transcript, d.reply_id, app.lang, { final: d.text, interrupted: d.interrupted });
      break;
    case 'reply-done':
      if (!app.ended) setState(t().listening, 'is-live');
      break;
    case 'latency': renderLatency(els.latency, d, app.lang); break;
    case 'tool-result': onToolResult(d); break;
    case 'error':
      addBubble(els.transcript, 'system', `AssemblyAI ${d.code}: ${d.message || ''}`);
      break;
    case 'ending': setState(app.lang === 'ko' ? '끝내는 중…' : 'Ending…'); break;
    case 'closed': finishAgentCall(d.why); break;
    default: break;
  }
}

async function startAgentCall({ demo = false } = {}) {
  if (live()) return;
  resetUi();
  app.demo = demo;
  app.finishing = false;
  setButtons('connecting');
  setState(t().connecting);
  try {
    // audio starts inside the click, or some browsers keep it suspended
    app.ctx = await createCallContext();
    app.agentPlayer = await Player.create(app.ctx, { onState: (s) => { if (s.type === 'level') { app.levels.agent = s.rms; meter(); } if (s.type === 'drained') { app.levels.agent = 0; meter(); } } });
    if (demo) {
      app.callerPlayer = await Player.create(app.ctx, { gain: 0.9, onState: (s) => { if (s.type === 'level') { app.levels.caller = s.rms; meter(); } if (s.type === 'drained') { app.levels.caller = 0; meter(); } } });
      app.caller = new DemoCaller({ agentPlayer: app.agentPlayer, voice: app.callerPlayer, onEvent: (type, d) => {
        note(`demo-${type}`, d);
        if (type === 'done') setTimeout(() => app.va?.end('demo_done'), 1500);
      } });
      await app.caller.load(); // before any paid session
    } else {
      app.mic = await startMic({ ...VOICE_AGENT_CAPTURE, context: app.ctx, onLevel: (rms) => { app.levels.mic = rms; meter(); }, onFrame: (pcm) => app.va?.sendAudio(pcm) });
    }
    const s = await api('/api/session', { method: 'POST', json: { lang: 'en', engine: 'voice-agent' } });
    app.session = { id: s.sessionId, engine: 'voice-agent', profile: {}, plan: null, ledger: [], history: [] };
    app.ended = false;
    els.cardWire.hidden = false;
    renderLedger(els.ledger, [], app.lang);
    els.mode.textContent = t().modeStream;
    app.va = new VoiceAgentClient({ api, session: s, player: app.agentPlayer, maxSeconds: demo ? 210 : 240, WebSocketImpl: globalThis.__EWH_WS || WebSocket });
    app.va.subscribe(onAgent);
    paintBand();
    await app.va.connect();
    setButtons('live');
    if (demo) app.caller.start(app.va);
  } catch (err) {
    note('start-failed', { message: err.message, pause: err.pause || null, code: err.code || null });
    app.caller?.stop();
    app.mic?.stop();
    app.mic = null;
    teardownAudio();
    app.ended = true;
    els.cardWire.hidden = true;
    els.mode.textContent = '';
    if (err.pause) showPaused(err.pause);
    else if (err.name === 'NotAllowedError') addBubble(els.transcript, 'system', t().micDenied);
    else addBubble(els.transcript, 'system', `${app.lang === 'ko' ? '음성 통화를 시작하지 못했습니다' : 'Could not start the voice call'}: ${err.message}`);
    setButtons('idle');
    setState(t().idle);
    paintBand();
  }
}

function teardownAudio() {
  app.agentPlayer?.close();
  app.callerPlayer?.close();
  app.agentPlayer = app.callerPlayer = null;
  app.ctx?.close().catch(() => {});
  app.ctx = null;
  app.levels = { mic: 0, agent: 0, caller: 0 };
  meter();
}

async function finishAgentCall(why) {
  if (app.finishing) return;
  if (!app.va?.ready) return; // never connected: startAgentCall's catch shows why, there is nothing to reconcile
  app.finishing = true;
  app.ended = true;
  clearInterval(app.timer);
  app.caller?.stop();
  app.mic?.stop();
  app.mic = null;
  setTimeout(teardownAudio, 250);
  setPartial(els.transcript, '');
  for (const b of els.transcript.querySelectorAll('.bubble.agent.live')) b.classList.remove('live'); // a reply cut by the hang-up
  setButtons('idle');
  setState(t().ended);
  paintBand();
  note('finished',{ why, audioSeconds: app.va?.audioSeconds ?? null });
  addBubble(els.transcript, 'system', why === 'time_limit' ? `${t().ended} (time limit)` : t().ended);
  await refreshLedger();
  loadReceipt();
}

// ---------------------------------------------------------------------------------------------------------
// Korean (Universal-3.6 Pro streaming) and typed text sessions: unchanged flow
// ---------------------------------------------------------------------------------------------------------

async function speak(text) {
  app.speaking = true;
  setState(t().speaking, 'is-speaking');
  await app.tts.speak(text, app.lang);
  app.speaking = false;
  if (!app.ended && app.mic) setState(t().listening, 'is-live');
  else if (!app.ended) setState(t().idle);
}

async function sendUtterance(text, { tag = '', meta = null } = {}) {
  if (!app.session || app.busy) return;
  app.busy = true;
  addBubble(els.transcript, 'owner', text, { tag, lang: app.lang, itemId: meta?.item_id || null });
  setState(t().thinking);
  try {
    const r = await api(`/api/session/${app.session.id}/utterance`, { method: 'POST', json: { text, meta: meta || { via: tag || 'text' } } });
    app.session.history.push({ role: 'user', text }, { role: 'agent', text: r.reply });
    addBubble(els.transcript, 'agent', r.reply, { tag: r.source === 'llm' ? 'llm' : 'rules', lang: app.lang });
    updateSide(r);
    // tell Universal-3.6 Pro what the agent is about to ask and what to listen for next, before it is spoken
    if (r.listen && app.stt) app.stt.updateConfig(r.listen);
    app.busy = false;
    await speak(r.reply);
  } catch (err) {
    app.busy = false;
    addBubble(els.transcript, 'system', `error: ${err.message}`);
    setState(app.mic ? t().listening : t().idle, app.mic ? 'is-live' : '');
  }
}

async function sendVoiceTurn(frames) {
  if (!app.session || app.busy) return;
  app.busy = true;
  setState(t().transcribing);
  setPartial(els.transcript, app.lang === 'ko' ? '(받아쓰는 중)' : '(transcribing)');
  try {
    const wav = encodeWav(frames, SAMPLE_RATE);
    const r = await api(`/api/session/${app.session.id}/voice-turn?lang=${app.lang}`, { method: 'POST', body: wav, headers: { 'Content-Type': 'application/octet-stream' } });
    setPartial(els.transcript, '');
    app.busy = false;
    if (r.empty || !r.transcript) { setState(t().listening, 'is-live'); return; }
    addBubble(els.transcript, 'owner', r.transcript, { tag: `${durationSeconds(frames).toFixed(1)}s`, lang: app.lang });
    app.session.history.push({ role: 'user', text: r.transcript }, { role: 'agent', text: r.reply });
    addBubble(els.transcript, 'agent', r.reply, { tag: r.source === 'llm' ? 'llm' : 'rules', lang: app.lang });
    updateSide(r);
    await speak(r.reply);
  } catch (err) {
    setPartial(els.transcript, '');
    app.busy = false;
    addBubble(els.transcript, 'system', `transcribe error: ${err.message}`);
    setState(t().listening, 'is-live');
  }
}

/** Korean voice call, or a typed session in either language (no voice for English here). */
async function startCall() {
  if (live()) return;
  resetUi();
  setButtons('connecting');
  setState(t().connecting);
  try {
    // Korean runs on the grounded path: amounts are read back and only a yes makes them the budget
    const s = await api('/api/session', { method: 'POST', json: { lang: app.lang, engine: app.lang === 'ko' ? 'realtime' : 'text' } });
    app.session = { id: s.sessionId, engine: s.engine, listen: s.listen || null, profile: {}, plan: null, brief: null, history: [{ role: 'agent', text: s.greeting }] };
    renderLedger(els.ledger, [], app.lang);
    app.ended = false;
    startTimer();
    setButtons('live');
    renderSlots(els.slots, {}, app.lang);
    addBubble(els.transcript, 'agent', s.greeting, { lang: app.lang });

    const voiceOk = app.lang === 'ko' && app.health?.assemblyai?.configured;
    if (voiceOk) {
      await startVoice();
    } else {
      setState(app.lang === 'ko' ? t().noKey : t().typing);
      els.input.focus();
    }
    speak(s.greeting); // not awaited: a message typed during the greeting must not wait for (or be dropped behind) the TTS
  } catch (err) {
    addBubble(els.transcript, 'system', `could not start: ${err.message}`);
    setButtons('idle');
    setState(t().idle);
  }
}

async function startVoice() {
  app.mode = sttModeFor(app.lang);
  els.mode.textContent = app.mode === 'stream' ? t().modeStream : t().modeTurn;
  try {
    app.mic = await startMic({
      onLevel: (rms) => { els.meter.style.width = `${Math.min(100, rms * 600)}%`; },
      onFrame: (pcm, rms) => onFrame(pcm, rms),
    });
  } catch (err) {
    addBubble(els.transcript, 'system', `${t().micDenied} (${err.message})`);
    setState(t().micDenied);
    return;
  }
  if (app.mode === 'stream') {
    app.stt = new StreamingSTT({
      lang: app.lang,
      listen: app.session.listen, // greeting as agent_context, intake key terms
      languageCodes: ['ko', 'en'], // owners mix in English words; measured format is a JSON list
      getToken: () => api('/api/assemblyai/token'),
      onEvent: (ev) => {
        if (ev.type === 'partial') setPartial(els.transcript, ev.text);
        if (ev.type === 'final') {
          setPartial(els.transcript, '');
          sendUtterance(ev.text, { tag: ev.languageCode || 'stream', meta: { item_id: 'turn_' + ev.order, via: 'realtime', language_code: ev.languageCode || null } });
        }
      },
      onStatus: (st) => {
        if (st.type === 'begin') { setState(t().listening, 'is-live'); renderListening(els.listening, app.stt?.config, app.lang); }
        if (st.type === 'config') renderListening(els.listening, st.config, app.lang);
        if (st.type === 'error') addBubble(els.transcript, 'system', `AssemblyAI: ${st.message || 'socket error'}`);
        if (st.type === 'close' && !app.ended) addBubble(els.transcript, 'system', `AssemblyAI session closed (${st.code}${st.reason ? ` ${st.reason}` : ''})`);
      },
    });
    try {
      await app.stt.start();
    } catch (err) {
      addBubble(els.transcript, 'system', `AssemblyAI streaming failed: ${err.message}`);
      app.stt = null;
    }
  } else {
    app.vad = new TurnVAD({
      onUtterance: (frames) => sendVoiceTurn(frames),
      onState: ({ speaking }) => { if (!app.speaking && !app.busy) setState(speaking ? '말씀 중…' : t().listening, 'is-live'); },
    });
    setState(t().listening, 'is-live');
  }
}

function onFrame(pcm, rms) {
  if (app.ended) return;
  if (app.speaking) {
    // half-duplex (Korean only): the mic is ignored while the consultant talks, but the stream keeps real-time pace with silence
    if (app.mode === 'stream') app.stt?.send(new Int16Array(pcm.length));
    return;
  }
  app.recording.push(pcm);
  if (app.mode === 'stream') app.stt?.send(pcm);
  else if (!app.busy) app.vad?.feed(pcm, rms);
}

async function endCall() {
  if (!app.session || app.ended) return;
  if (app.va) { await app.va.end('hangup'); return; } // English: finishAgentCall runs on 'closed'
  app.ended = true;
  app.tts.cancel();
  app.speaking = false;
  clearInterval(app.timer);
  setButtons('idle');
  setPartial(els.transcript, '');
  if (app.stt) { await app.stt.stop(); app.stt = null; } // waits up to 5 s for Termination
  if (app.vad) { app.vad.reset(); app.vad = null; }
  if (app.mic) { app.mic.stop(); app.mic = null; }
  els.meter.style.width = '0%';

  if (!app.session.plan) {
    try {
      const r = await api(`/api/session/${app.session.id}/plan`, { method: 'POST' });
      updateSide({ profile: r.profile, plan: r.plan });
    } catch { /* no plan possible */ }
  }
  addBubble(els.transcript, 'system', t().ended);
  setState(t().ended);
  addActions();
  loadReceipt();

  const seconds = durationSeconds(app.recording, SAMPLE_RATE);
  if (app.lang === 'ko' && app.health?.assemblyai?.configured && seconds >= 2) {
    els.cardAnalysis.hidden = false;
    els.analysis.innerHTML = `<span class="busy">${t().analyzing} (${seconds.toFixed(0)}s)</span>`;
    try {
      const wav = encodeWav(app.recording, SAMPLE_RATE);
      const r = await api(`/api/session/${app.session.id}/analyze`, { method: 'POST', body: wav, headers: { 'Content-Type': 'application/octet-stream' } });
      app.session.brief = r.brief;
      renderAnalysis(els.analysis, r.brief, app.lang);
      updateSide({ profile: r.profile, plan: r.plan });
    } catch (err) {
      els.analysis.innerHTML = `<span class="busy">analysis failed: ${err.message}</span>`;
    }
  }
}

async function loadReceipt() {
  if (!app.session) return;
  const id = app.session.id;
  els.cardReceipt.hidden = false;
  renderReceipt(els.receipt, null, app.lang);
  try {
    const r = await api('/api/session/' + id + '/receipt');
    note('receipt', { receipt: r });
    if (app.session?.id !== id) return;
    if (r.pending) { els.receipt.textContent = r.message; return; }
    renderReceipt(els.receipt, r, app.lang);
  } catch (err) {
    els.receipt.textContent = 'receipt: ' + err.message;
  }
}

function addActions() {
  const div = document.createElement('div');
  div.className = 'actions';
  const copy = document.createElement('button');
  copy.textContent = t().copy;
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(summaryText(app.session, app.lang)); copy.textContent = t().copied; } catch { /* ignore */ }
  };
  div.appendChild(copy);
  els.transcript.appendChild(div);
  els.transcript.scrollTop = els.transcript.scrollHeight;
}

async function createCheckout({ customerName, customerPhone }) {
  if (!customerName) { els.checkout.querySelector('#co-name')?.focus(); return; }
  const btn = els.checkout.querySelector('#co-btn');
  btn.disabled = true;
  try {
    const r = await api(`/api/session/${app.session.id}/checkout`, { method: 'POST', json: { customerName, customerPhone } });
    renderCheckoutResult(els.checkout, app.lang, r, true);
  } catch (err) {
    renderCheckoutResult(els.checkout, app.lang, { ...(err.data || {}), message: err.message }, false);
  } finally {
    btn.disabled = false;
  }
}

function resetUi() {
  els.transcript.innerHTML = '';
  els.cardPlan.hidden = true;
  els.cardChecklist.hidden = true;
  els.cardAnalysis.hidden = true;
  els.cardReceipt.hidden = true;
  els.cardWire.hidden = true;
  els.listening.hidden = true;
  els.latency.hidden = true;
  renderLedger(els.ledger, [], app.lang);
  els.receipt.innerHTML = '';
  els.wire.innerHTML = '';
  els.place.hidden = true;
  els.plan.innerHTML = '';
  els.checkout.innerHTML = '';
  delete els.checkout.dataset.ready;
  app.recording = [];
  app.session = null;
  app.va = null;
  app.caller = null;
  app.listen = null;
  app.wire = [];
  renderSlots(els.slots, {}, app.lang);
  els.timer.textContent = '00:00';
  els.mode.textContent = '';
}

function setLang(lang) {
  app.lang = lang;
  for (const x of document.querySelectorAll('.lang-btn')) x.classList.toggle('is-on', x.dataset.lang === lang);
  applyI18n(app.lang);
  renderSlots(els.slots, {}, app.lang);
  renderLedger(els.ledger, [], app.lang);
  paintBand();
  if (app.paused) showPaused(app.paused);
}

// --- wiring ---
for (const b of document.querySelectorAll('.lang-btn')) {
  b.addEventListener('click', () => {
    if (live()) return; // no language switch mid-call
    setLang(b.dataset.lang);
  });
}
els.btnCall.addEventListener('click', () => {
  if (live()) { endCall(); return; }
  if (app.lang === 'en') startAgentCall({ demo: false });
  else startCall();
});
els.btnDemo.addEventListener('click', () => { if (!live() && app.lang === 'en') startAgentCall({ demo: true }); });
els.btnEnd.addEventListener('click', endCall);
els.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  if (app.va && app.va.ready && live()) { app.va.sendText(text); return; }
  if (!live()) await startCall();
  if (app.speaking) { app.tts.cancel(); app.speaking = false; }
  await sendUtterance(text);
});

setLang(app.lang);
setButtons('idle');
loadHealth();
