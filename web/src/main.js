/**
 * MarketPilot Voice Consultant - browser app.
 *
 * Flow: Start -> POST /api/session -> greeting (TTS) -> mic
 *   en : StreamingSTT (AssemblyAI Universal-Streaming, temp token) -> final turn -> POST utterance -> reply (TTS)
 *   ko : StreamingSTT on Universal-3.6 Pro (engine "realtime"): greeting as agent_context at connect, each final turn
 *        -> POST utterance (grounding + ledger on the server) -> UpdateConfiguration with the reply as agent_context,
 *        this step's key terms and mode -> reply (TTS). The ledger card shows every amount with its evidence.
 * End  -> Terminate (wait for Termination) -> GET receipt (ledger vs AssemblyAI's record + summary)
 *      -> whole-call WAV -> POST analyze (speaker labels, sentiment, key phrases, entities) -> brief
 * Typing in the composer works with no keys at all.
 */
import { startMic, SAMPLE_RATE } from './audio.js';
import { StreamingSTT, TurnVAD } from './stt.js';
import { encodeWav, durationSeconds } from './wav.js';
import { createTts } from './tts.js';
import { sttModeFor } from './lib/transcript.js';
import { I18N, $, applyI18n, setBadge, addBubble, setPartial, renderSlots, renderPlace, renderPlan, renderChecklist, renderCheckoutForm, renderCheckoutResult, renderAnalysis, summaryText, renderLedger, renderListening, renderReceipt } from './ui.js';

const PROMPT = 'Voice consultation between a Korean small business owner and a marketing consultant. Topics: Naver Place, Instagram, blog reviews, receipt reviews, press releases, monthly marketing budget in Korean won, neighborhoods in Seoul and Korea.';

const app = {
  lang: 'ko',
  health: null,
  session: null, // {id, profile, plan, brief, history}
  mic: null,
  stt: null,
  vad: null,
  mode: null, // 'stream' | 'turn'
  recording: [], // Int16Array frames of the whole call (owner audio only; muted during TTS)
  speaking: false, // TTS playing -> do not send audio
  busy: false, // waiting for the server
  startedAt: null,
  timer: null,
  tts: createTts(),
  ended: false,
};

const els = {
  transcript: $('#transcript'), slots: $('#slots'), place: $('#place'), plan: $('#plan'), checkout: $('#checkout'), checklist: $('#checklist'), analysis: $('#analysis'),
  cardPlan: $('#card-plan'), cardChecklist: $('#card-checklist'), cardAnalysis: $('#card-analysis'),
  cardLedger: $('#card-ledger'), ledger: $('#ledger'), cardReceipt: $('#card-receipt'), receipt: $('#receipt'), listening: $('#listening'),
  btnCall: $('#btn-call'), btnCallLabel: $('#btn-call-label'), btnEnd: $('#btn-end'), state: $('#call-state'), meter: $('#meter'), mode: $('#call-mode'), timer: $('#call-timer'),
  composer: $('#composer'), input: $('#composer-input'), footCatalog: $('#foot-catalog'),
};

const t = () => I18N[app.lang];

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
  setBadge('badge-aai', h.assemblyai.configured ? 'ok' : 'warn', h.assemblyai.configured ? 'key ok' : 'no key');
  setBadge('badge-llm', h.llm.configured ? 'ok' : 'warn', h.llm.configured ? h.llm.model : 'rules');
  setBadge('badge-mcp', h.mcp.reachable ? 'ok' : 'warn', h.mcp.reachable ? `live · ${h.mcp.products}` : 'mock');
  els.footCatalog.textContent = h.mcp.catalogSource === 'live' ? t().sourceLive : `${t().sourceMock}${h.mcp.capturedAt ? ` · ${h.mcp.capturedAt}` : ''}`;
  if (!h.assemblyai.configured) addBubble(els.transcript, 'system', t().noKey);
}

function updateSide(r) {
  if (r.ledger) {
    els.cardLedger.hidden = false;
    renderLedger(els.ledger, r.ledger, app.lang);
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
  // labels come from the server language; the plan/brief carry labels, but slots only carry keys -> local map
  const ko = { new_open: '신규 오픈', low_traffic: '손님·매출 부족', reviews: '리뷰 부족', place_rank: '플레이스·검색 노출', instagram: '인스타그램 성장', competition: '경쟁 심화', delivery: '배달 매출', repeat: '재방문·단골', press: '브랜드 신뢰', app_growth: '앱 다운로드·가입', foreign: '외국인 고객' };
  const en = { new_open: 'just opened', low_traffic: 'not enough customers', reviews: 'few reviews', place_rank: 'search / map visibility', instagram: 'Instagram growth', competition: 'competition', delivery: 'delivery orders', repeat: 'repeat customers', press: 'brand credibility', app_growth: 'app installs / signups', foreign: 'foreign customers' };
  return app.lang === 'ko' ? ko : en;
}

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
  addBubble(els.transcript, 'owner', text, { tag, lang: app.lang });
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

async function startCall() {
  if (app.session && !app.ended) return;
  resetUi();
  els.btnCall.disabled = true;
  setState(t().connecting);
  try {
    // Korean runs on the grounded path: amounts are read back and only a yes makes them the budget
    const s = await api('/api/session', { method: 'POST', json: { lang: app.lang, engine: app.lang === 'ko' ? 'realtime' : 'text' } });
    app.session = { id: s.sessionId, engine: s.engine, listen: s.listen || null, profile: {}, plan: null, brief: null, history: [{ role: 'agent', text: s.greeting }] };
    if (s.engine === 'realtime') { els.cardLedger.hidden = false; renderLedger(els.ledger, [], app.lang); }
    app.ended = false;
    app.startedAt = Date.now();
    app.timer = setInterval(tick, 1000);
    els.btnEnd.hidden = false;
    els.btnCall.setAttribute('aria-pressed', 'true');
    els.btnCallLabel.textContent = t().listening;
    renderSlots(els.slots, {}, app.lang);
    addBubble(els.transcript, 'agent', s.greeting, { lang: app.lang });

    const voiceOk = app.health?.assemblyai?.configured;
    if (voiceOk) {
      await startVoice();
    } else {
      setState(t().noKey);
      els.input.focus();
    }
    await speak(s.greeting);
  } catch (err) {
    addBubble(els.transcript, 'system', `could not start: ${err.message}`);
    setState(t().idle);
  } finally {
    els.btnCall.disabled = false;
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
    const ko = app.lang === 'ko';
    app.stt = new StreamingSTT({
      lang: app.lang,
      prompt: ko ? undefined : PROMPT,
      listen: ko ? app.session.listen : null, // greeting as agent_context, intake key terms
      languageCodes: ko ? ['ko', 'en'] : null, // owners mix in English words; measured format is a JSON list
      getToken: () => api('/api/assemblyai/token'),
      onEvent: (ev) => {
        if (ev.type === 'partial') setPartial(els.transcript, ev.text);
        if (ev.type === 'final') {
          setPartial(els.transcript, '');
          sendUtterance(ev.text, { tag: ev.languageCode || 'stream', meta: { item_id: 'turn_' + ev.order, via: ko ? 'realtime' : 'stream', language_code: ev.languageCode || null } });
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
      onState: ({ speaking }) => { if (!app.speaking && !app.busy) setState(speaking ? (app.lang === 'ko' ? '말씀 중…' : 'Speaking…') : t().listening, 'is-live'); },
    });
    setState(t().listening, 'is-live');
  }
}

function onFrame(pcm, rms) {
  if (app.ended) return;
  if (app.speaking) {
    // half-duplex: the mic is ignored while the consultant talks, but the stream keeps real-time pace with silence
    if (app.mode === 'stream') app.stt?.send(new Int16Array(pcm.length));
    return;
  }
  app.recording.push(pcm);
  if (app.mode === 'stream') app.stt?.send(pcm);
  else if (!app.busy) app.vad?.feed(pcm, rms);
}

async function endCall() {
  if (!app.session || app.ended) return;
  app.ended = true;
  app.tts.cancel();
  app.speaking = false;
  clearInterval(app.timer);
  els.btnEnd.hidden = true;
  els.btnCall.setAttribute('aria-pressed', 'false');
  els.btnCallLabel.textContent = t().start;
  setPartial(els.transcript, '');
  if (app.stt) { await app.stt.stop(); app.stt = null; } // waits up to 5 s for Termination
  els.listening.hidden = true;
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
  if (app.health?.assemblyai?.configured && seconds >= 2) {
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
  } else if (!app.health?.assemblyai?.configured) {
    els.cardAnalysis.hidden = false;
    els.analysis.innerHTML = `<span class="busy">${t().noKeyAnalyze}</span>`;
  }
}

async function loadReceipt() {
  if (!app.session) return;
  els.cardReceipt.hidden = false;
  renderReceipt(els.receipt, null, app.lang);
  try {
    const r = await api('/api/session/' + app.session.id + '/receipt');
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
  els.cardLedger.hidden = true;
  els.cardReceipt.hidden = true;
  els.listening.hidden = true;
  els.ledger.innerHTML = '';
  els.receipt.innerHTML = '';
  els.place.hidden = true;
  els.checkout.innerHTML = '';
  delete els.checkout.dataset.ready;
  app.recording = [];
  app.session = null;
  renderSlots(els.slots, {}, app.lang);
  els.timer.textContent = '00:00';
  els.mode.textContent = '';
}

// --- wiring ---
for (const b of document.querySelectorAll('.lang-btn')) {
  b.addEventListener('click', () => {
    if (app.session && !app.ended) return; // no language switch mid-call
    app.lang = b.dataset.lang;
    for (const x of document.querySelectorAll('.lang-btn')) x.classList.toggle('is-on', x === b);
    applyI18n(app.lang);
    renderSlots(els.slots, {}, app.lang);
    if (app.health) els.footCatalog.textContent = app.health.mcp.catalogSource === 'live' ? t().sourceLive : t().sourceMock;
  });
}
els.btnCall.addEventListener('click', () => { if (!app.session || app.ended) startCall(); else endCall(); });
els.btnEnd.addEventListener('click', endCall);
els.composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  if (!app.session || app.ended) await startCall();
  if (app.speaking) { app.tts.cancel(); app.speaking = false; }
  await sendUtterance(text);
});

applyI18n(app.lang);
renderSlots(els.slots, {}, app.lang);
loadHealth();
