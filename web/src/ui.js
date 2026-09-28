/** DOM rendering helpers. Pure string templates + a few element updates. */

export const I18N = {
  ko: {
    title: 'Every Won Heard', tagline: '사장님이 말한 금액마다 근거가 붙는 음성 마케팅 상담',
    start: '상담 시작', end: '상담 종료', send: '보내기', typeHere: '말하기 대신 입력하기 (키 없이도 동작)', demo: '데모 통화 보기',
    idle: '상담 시작을 누르고 말씀하시면 됩니다. 마이크가 없으면 아래에 입력하세요.',
    listening: '듣고 있어요…', speaking: '상담사가 말하는 중', thinking: '정리하는 중…', connecting: '연결 중…', transcribing: '받아쓰는 중 (AssemblyAI)…',
    heard: '들은 내용', plan: '30일 계획', checklist: '실행 체크리스트', analysis: '통화 분석',
    footNote: '브라우저에는 짧게 쓰고 버리는 토큰만 내려갑니다. API 키는 서버에만 있습니다.',
    slots: { business: '업종', location: '위치', budget: '월 예산', problems: '급한 고민', tried: '해본 것', store: '상호' },
    notYet: '아직', assumed: '가정', total: '합계', budgetLabel: '월 예산', ofBudget: '사용',
    inquiry: '문의형 상품(견적 후 진행)', checkoutTitle: '카드 결제 링크 만들기 (회원가입 없음)', namePh: '이름 또는 상호', phonePh: '휴대폰 (선택)', makeLink: '결제 링크 만들기',
    linkReady: '결제 링크가 준비됐습니다', linkFail: '결제 링크를 만들지 못했습니다', mockNote: '지금은 목업 카탈로그라 실제 결제 링크를 만들 수 없습니다.',
    analyzing: 'AssemblyAI가 통화 전체를 분석하는 중 (화자 분리·감정·키워드·개체)…', noKeyAnalyze: 'ASSEMBLYAI_API_KEY 가 없어 통화 분석을 건너뜁니다.',
    speakers: '화자', ownerTag: '사장님', concerns: '사장님이 실제로 말한 고민', phrases: '키워드', entities: '언급한 사실', mood: '감정 분포', none: '없음',
    agent: '상담사', owner: '사장님', copy: '요약 복사', copied: '복사됨', sourceLive: '실시간 카탈로그 (MCP)', sourceMock: '목업 카탈로그 (MCP 연결 안 됨)',
    micDenied: '마이크 권한이 없어요. 아래 입력창으로 계속할 수 있습니다.', noKey: 'AssemblyAI 키가 없어 음성은 꺼져 있어요. 입력창으로 상담을 이어갈 수 있습니다.',
    modeStream: 'Universal-3.6 Pro 스트리밍', modeTurn: 'AssemblyAI pre-recorded (턴 단위)', ended: '상담이 끝났습니다. 오른쪽 원장과 계획을 확인하세요.',
    engine: 'KO · Universal-3.6 Pro 스트리밍', band: ['가상 가게', '한국어는 Universal-3.6 Pro 스트리밍', '전사·금액 원장·가격은 실제로 동작합니다'],
    ledger: '금액 원장', receipt: '통화 영수증', listeningFor: '듣는 중', maxAccuracy: '최고 정확도', balanced: '기본 정확도', minLatency: '최저 지연', keyterms: '핵심어',
    steps: { intake: '가게·동네', budget: '금액', confirm: '금액 확인', plan: '서비스', commit: '서비스' },
    heardAt: '들음', readBackAt: '되읽음', confirmedAt: '확인', rejectedAt: '거절', ledgerEmpty: '사장님이 금액을 말하면 여기에 근거와 함께 남습니다.',
    statusWord: { heard: '들음', read_back: '되읽음', confirmed: '확인', rejected: '받지 않음' },
    checking: '통화 기록과 대조하는 중…', rConfirmed: (n) => `확정 금액 ${n}건`, rMatchedVa: (n) => `${n}건이 AssemblyAI 세션 기록과 일치`, rMatchedKo: (n) => `${n}건이 Universal-3.6 Pro 전사와 일치`, rMatchedTyped: (n) => `${n}건이 입력한 문장과 일치`,
    rRejectedVa: (n) => `툴 호출 거절 ${n}건`, rRejectedKo: (n) => `받지 않은 범위 ${n}건`, rUnmatched: '기록에서 찾지 못한 금액', rTtfa: '첫 음성까지 중앙값', summary: '통화 요약', nextStep: '다음 할 일', summaryTemplate: '템플릿(숫자는 원장에서)',
    latency: '말 끝 → 첫 음성', median: '중앙값', turns: (n) => `${n}턴`, wire: '이벤트', paused: '음성 데모가 잠시 멈춰 있습니다. 영상에서 전체 통화를 볼 수 있습니다.', pausedSub: '입력창은 계속 쓸 수 있습니다.', busy: '이 주소에서 통화가 너무 잦습니다. 1분 뒤 다시 해 주세요.',
    demoCheckout: '데모 결제 화면입니다. 결제는 일어나지 않습니다.', typing: '입력 상담입니다. 아래에 입력하세요.', planFrom: '카탈로그 가격으로 계산', interrupted: '끊김',
  },
  en: {
    title: 'Every Won Heard', tagline: 'A voice consultant that shows what it heard.',
    start: 'Start call', end: 'End call', send: 'Send', typeHere: 'Type instead of speaking', demo: 'Watch a demo call',
    idle: 'Start a call and talk, or watch a demo call.',
    listening: 'Listening', speaking: 'Consultant speaking', thinking: 'Thinking…', connecting: 'Connecting…', transcribing: 'Transcribing…',
    heard: 'What we heard', plan: '30-day plan', checklist: 'Action checklist', analysis: 'Call analysis',
    footNote: 'The browser only receives a single-use token. The API key stays on the server.',
    slots: { business: 'Business', location: 'Neighborhood', budget: 'Budget / mo', problems: 'Main problem', tried: 'Tried', store: 'Store' },
    notYet: 'not yet', assumed: 'assumed', total: 'Total', budgetLabel: 'Monthly budget', ofBudget: 'used',
    inquiry: 'Inquiry-only products (quote first)', checkoutTitle: 'Create card checkout link (no signup)', namePh: 'Name or store name', phonePh: 'Phone (optional)', makeLink: 'Create checkout link',
    linkReady: 'Checkout link is ready', linkFail: 'Could not create the checkout link', mockNote: 'Mock catalog in use, so a real checkout link cannot be created right now.',
    analyzing: 'AssemblyAI is analyzing the whole call…', noKeyAnalyze: 'No ASSEMBLYAI_API_KEY, skipping call analysis.',
    speakers: 'Speakers', ownerTag: 'owner', concerns: 'What the owner actually complained about', phrases: 'Key phrases', entities: 'Facts mentioned', mood: 'Sentiment', none: 'none',
    agent: 'Consultant', owner: 'Owner', copy: 'Copy summary', copied: 'Copied', sourceLive: 'live catalog (MCP)', sourceMock: 'catalog snapshot (MCP unreachable)',
    micDenied: 'Microphone permission denied. You can still type below.', noKey: 'No AssemblyAI key on the server, so voice is off. You can still type.',
    modeStream: 'Voice Agent API', modeTurn: 'pre-recorded (per turn)', ended: 'Call ended.',
    engine: 'EN · AssemblyAI Voice Agent API', band: ['Fictional shop', 'Caller voice synthesized for this demo', 'Agent, transcription, tools and prices are live'],
    bandMic: ['Fictional shop', 'You are the caller', 'Agent, transcription, tools and prices are live'],
    ledger: 'Money ledger', receipt: 'Call receipt', listeningFor: 'Listening for', maxAccuracy: 'max accuracy', balanced: 'balanced', minLatency: 'min latency', keyterms: 'key terms',
    steps: { intake: 'places', budget: 'money', confirm: 'money', plan: 'services', commit: 'services' },
    heardAt: 'heard', readBackAt: 'read back', confirmedAt: 'confirmed', rejectedAt: 'rejected', ledgerEmpty: 'Every amount the owner says lands here with its evidence.',
    statusWord: { heard: 'heard', read_back: 'read back', confirmed: 'confirmed', rejected: 'not accepted' },
    checking: 'Checking against the call record…', rConfirmed: (n) => `${n} confirmed amount${n === 1 ? '' : 's'}`, rMatchedVa: (n) => `${n} matched to the AssemblyAI session record`, rMatchedKo: (n) => `${n} matched to the Universal-3.6 Pro transcript`, rMatchedTyped: (n) => `${n} matched to the owner's typed words`,
    rRejectedVa: (n) => `${n} tool call${n === 1 ? '' : 's'} rejected`, rRejectedKo: (n) => `${n} range${n === 1 ? '' : 's'} not accepted`, rUnmatched: 'Amounts not found in the record', rTtfa: 'median time to first audio', summary: 'Call summary', nextStep: 'Next step', summaryTemplate: 'template (numbers from the ledger)',
    latency: 'Speech end → first agent audio', median: 'median', turns: (n) => `${n} turn${n === 1 ? '' : 's'}`, wire: 'Events', paused: 'The voice demo is paused. The video shows a full call.', pausedSub: 'Typing still works.', busy: 'Too many calls from this address. Try again in a minute.',
    demoCheckout: 'Demo checkout. No payment is taken.', typing: 'Text session. Type below; the voice call uses Start call.', planFrom: 'priced from the catalog', interrupted: 'interrupted',
  },
};

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function $(sel) {
  return document.querySelector(sel);
}

export function applyI18n(lang) {
  const t = I18N[lang];
  document.documentElement.lang = lang === 'ko' ? 'ko' : 'en';
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const key = el.dataset.i18n;
    if (typeof t[key] === 'string' && key !== 'analysis') el.textContent = t[key];
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.dataset.i18nPlaceholder;
    if (t[key]) el.placeholder = t[key];
  }
}

export function setBadge(id, cls, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('ok', 'warn', 'bad');
  if (cls) el.classList.add(cls);
  el.querySelector('em').textContent = text;
}

/** The top strip: what is real and what is staged, always on screen. */
export function renderBand(el, parts) {
  el.innerHTML = parts.map((p) => `<span>${esc(p)}</span>`).join('<i aria-hidden="true">·</i>');
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
// plan segments: shades of paper, no second accent color (the vermilion is kept for confirmed money)
const SHADES = ['#efe8da', '#cfc6b4', '#aea492', '#8f8676', '#736b5e', '#5c554b', '#48423a'];

export function addBubble(container, role, text, { tag = '', lang = 'ko', itemId = null } = {}) {
  const t = I18N[lang];
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  if (itemId) div.dataset.itemId = itemId;
  if (role === 'system') div.textContent = text;
  else div.innerHTML = `<span class="who">${role === 'agent' ? esc(t.agent) : esc(t.owner)}${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</span><span class="text">${esc(text)}</span>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

/** Live agent caption: words arrive aligned to the audio (transcript.agent.delta). */
export function agentCaption(container, replyId, lang, { delta = null, final = null, interrupted = false } = {}) {
  let el = container.querySelector(`.bubble.agent[data-reply-id="${CSS.escape(replyId)}"]`);
  if (!el) {
    if (final == null && delta == null) return null;
    el = addBubble(container, 'agent', '', { lang });
    el.dataset.replyId = replyId;
    el.classList.add('live');
  }
  const text = el.querySelector('.text');
  if (final != null) {
    text.textContent = final;
    el.classList.remove('live');
    if (interrupted) {
      el.classList.add('cut');
      el.querySelector('.who').insertAdjacentHTML('beforeend', `<span class="tag">${esc(I18N[lang].interrupted)}</span>`);
    }
  } else if (delta) {
    const cur = text.textContent;
    text.textContent = cur && !/^[,.!?;:]/.test(delta) ? `${cur} ${delta}` : `${cur}${delta}`;
  }
  container.scrollTop = container.scrollHeight;
  return el;
}

export function setPartial(container, text) {
  let el = container.querySelector('.bubble.partial');
  if (!text) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.className = 'bubble partial'; container.appendChild(el); }
  el.textContent = text;
  container.scrollTop = container.scrollHeight;
}

/**
 * Underline, in the owner's own bubble, the words the server read an amount from. The ledger row keeps the
 * transcript item_id, so the evidence points back at the exact turn.
 */
export function markMoney(container, rows) {
  for (const r of rows || []) {
    if (r.source !== 'owner' || !r.phrase || !r.item_id) continue;
    const b = container.querySelector(`.bubble.owner[data-item-id="${CSS.escape(r.item_id)}"] .text`);
    if (!b || b.querySelector(`mark[data-row="${CSS.escape(r.id || r.phrase)}"]`)) continue;
    const text = b.textContent;
    const i = text.toLowerCase().indexOf(String(r.phrase).toLowerCase());
    if (i < 0) continue;
    const cls = r.status === 'rejected' ? 'money is-rejected' : 'money';
    b.innerHTML = `${esc(text.slice(0, i))}<mark class="${cls}" data-row="${esc(r.id || r.phrase)}">${esc(text.slice(i, i + r.phrase.length))}</mark>${esc(text.slice(i + r.phrase.length))}`;
  }
}

export function renderSlots(el, profile, lang, { problemLabels = null } = {}) {
  const t = I18N[lang];
  const chip = (v, cls = '') => (v ? `<span class="chip ${cls}">${esc(v)}</span>` : `<span class="chip empty">${esc(t.notYet)}</span>`);
  const problems = (profile.problems || []).map((k) => (problemLabels && problemLabels[k]) || k);
  el.innerHTML = `
    <dt>${esc(t.slots.business)}</dt><dd>${chip(profile.business_label)}</dd>
    <dt>${esc(t.slots.location)}</dt><dd>${chip(profile.location)}</dd>
    <dt>${esc(t.slots.problems)}</dt><dd>${problems.length ? problems.map((p) => chip(p)).join('') : chip(null)}</dd>
    ${profile.budget_krw ? `<dt>${esc(t.slots.budget)}</dt><dd>${chip(`₩${fmt(profile.budget_krw)}`)}</dd>` : ''}
    ${profile.channels_tried?.length ? `<dt>${esc(t.slots.tried)}</dt><dd>${profile.channels_tried.map((c) => chip(c)).join('')}</dd>` : ''}
    ${profile.store_name ? `<dt>${esc(t.slots.store)}</dt><dd>${chip(profile.store_name)}</dd>` : ''}
  `;
}

export function renderPlace(el, place, candidates, lang) {
  if (!place && !candidates?.length) { el.hidden = true; return; }
  el.hidden = false;
  const label = lang === 'ko' ? '지도 매장정보' : 'Map listing';
  if (place) {
    el.innerHTML = `<b>${esc(label)}</b> ${esc(place.name)} · ${esc(place.category || '')}<br><small>${esc(place.roadAddress || '')}</small>`;
    return;
  }
  el.innerHTML = `<b>${esc(label)}</b> ${lang === 'ko' ? '이 근처에서 찾은 매장' : 'nearby listings'}<ul>${candidates.slice(0, 3).map((c) => `<li>${esc(c.name)} <small>${esc(c.roadAddress || '')}</small></li>`).join('')}</ul>`;
}

export function renderPlan(el, plan, lang) {
  const t = I18N[lang];
  const pct = plan.budget_krw ? Math.round((plan.total_cost / plan.budget_krw) * 100) : 0;
  el.innerHTML = `
    <div class="budget"><span>${esc(t.budgetLabel)} <b>₩${fmt(plan.budget_krw)}</b></span><span>${pct}% ${esc(t.ofBudget)}</span></div>
    <div class="bar">${plan.channels.map((c, i) => `<i style="width:${Math.max(2, (c.cost / plan.budget_krw) * 100)}%;background:${SHADES[i % SHADES.length]}" title="${esc(c.label)}"></i>`).join('')}</div>
    ${plan.channels.map((c, i) => `
      <div class="ch">
        <div class="ch-head"><span class="sw" style="background:${SHADES[i % SHADES.length]}"></span>${esc(c.label)}<span class="pct">${Math.round(c.share * 100)}% · ${fmt(c.cost)}</span></div>
        <div class="ch-why">${esc(c.why)}</div>
        <ul class="ch-items">${c.items.map((it) => `<li><span>${esc(it.name)} × ${fmt(it.qty)}</span><span>${fmt(it.cost)}</span></li>`).join('')}</ul>
      </div>`).join('')}
    <div class="total"><span>${esc(t.total)}</span><span>₩${fmt(plan.total_cost)}</span></div>
    ${plan.assumptions?.length ? `<div class="assume">${plan.assumptions.map(esc).join('<br>')}</div>` : ''}
    ${plan.inquiry_items?.length ? `<div class="inq"><b>${esc(t.inquiry)}</b><br>${plan.inquiry_items.map((i) => esc(i.name)).join(' · ')}</div>` : ''}
  `;
}

/**
 * The plan as build_plan returned it to the agent: {budget_krw, total_krw, lines:[{name, qty, unit_krw}]}.
 * Every price is a catalog price; the total is the server's sum, never the model's.
 */
export function renderToolPlan(el, r, lang) {
  const t = I18N[lang];
  const lines = Array.isArray(r?.lines) ? r.lines : [];
  const total = r.total_krw ?? lines.reduce((a, l) => a + (l.qty || 1) * (l.unit_krw || 0), 0);
  const budget = r.budget_krw || null;
  const pct = budget ? Math.min(100, (total / budget) * 100) : 0;
  el.innerHTML = `
    ${budget ? `<div class="budget"><span>${esc(t.budgetLabel)} <b>₩${fmt(budget)}</b></span><span>${Math.round(pct)}% ${esc(t.ofBudget)}</span></div><div class="bar"><i style="width:${pct}%;background:${SHADES[0]}"></i></div>` : ''}
    <ul class="plines">${lines.map((l) => `<li><span class="pname">${esc(l.name)}</span><span class="pqty">${fmt(l.qty || 1)} × ₩${fmt(l.unit_krw || 0)}</span><span class="psum">₩${fmt((l.qty || 1) * (l.unit_krw || 0))}</span></li>`).join('')}</ul>
    <div class="total"><span>${esc(t.total)} <small>${esc(t.planFrom)}</small></span><span>₩${fmt(total)}</span></div>
  `;
}

export function renderCheckoutLink(el, r, lang) {
  const t = I18N[lang];
  const url = r?.url || r?.checkoutUrl || '';
  el.innerHTML = `<div class="result"><b>${esc(r?.demo === false ? t.linkReady : t.demoCheckout)}</b>${url ? `<br><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a>` : ''}</div>`;
}

export function renderChecklist(el, list) {
  el.innerHTML = list.map((l) => `<li>${esc(l)}</li>`).join('');
}

export function renderCheckoutForm(el, lang, { onSubmit, disabled = false, note = '' }) {
  const t = I18N[lang];
  el.innerHTML = `
    <small>${esc(t.checkoutTitle)}</small>
    <div class="row">
      <input id="co-name" placeholder="${esc(t.namePh)}" ${disabled ? 'disabled' : ''} />
      <input id="co-phone" placeholder="${esc(t.phonePh)}" ${disabled ? 'disabled' : ''} />
      <button id="co-btn" type="button" ${disabled ? 'disabled' : ''}>${esc(t.makeLink)}</button>
    </div>
    ${note ? `<small>${esc(note)}</small>` : ''}
    <div id="co-result"></div>
  `;
  el.querySelector('#co-btn')?.addEventListener('click', () => {
    onSubmit({ customerName: el.querySelector('#co-name').value.trim(), customerPhone: el.querySelector('#co-phone').value.trim() });
  });
}

export function renderCheckoutResult(el, lang, result, ok) {
  const t = I18N[lang];
  const box = el.querySelector('#co-result');
  if (!box) return;
  if (ok) {
    box.className = 'result';
    box.innerHTML = `${esc(t.linkReady)}: <a href="${esc(result.checkoutUrl)}" target="_blank" rel="noopener">${esc(result.checkoutUrl)}</a>${result.amount ? ` · ₩${fmt(result.amount)}` : ''}`;
  } else {
    box.className = 'result err';
    box.textContent = `${t.linkFail}: ${result.message || result.error || ''}${result.mock ? ` ${t.mockNote}` : ''}`;
  }
}

export function renderAnalysis(el, brief, lang) {
  const t = I18N[lang];
  const spk = brief.speakers.map((s) => `<span class="spk ${s.label === brief.owner_speaker ? 'owner' : ''}">${esc(s.label)} ${Math.round(s.share * 100)}%${s.label === brief.owner_speaker ? ` ${esc(t.ownerTag)}` : ''}${s.likely_agent_echo ? ' (TTS)' : ''}</span>`).join('');
  const conc = brief.concerns.length ? brief.concerns.map((c) => `<blockquote class="quote">${esc(c.text)}<small>${c.source === 'sentiment' ? `NEGATIVE ${Math.round((c.confidence || 0) * 100)}%` : 'keyword'} · ${Math.round((c.start || 0) / 1000)}s</small></blockquote>`).join('') : `<span class="busy">${esc(t.none)}</span>`;
  const kp = brief.key_phrases.length ? brief.key_phrases.map((k) => `<span class="kp">${esc(k.text)}<b>×${k.count || 1}</b></span>`).join('') : `<span class="busy">${esc(t.none)}</span>`;
  const ent = Object.keys(brief.entities).length ? Object.entries(brief.entities).map(([k, v]) => `<div><b>${esc(k)}</b>: ${v.map(esc).join(', ')}</div>`).join('') : `<span class="busy">${esc(t.none)}</span>`;
  const mood = brief.features_used.sentiment_analysis ? `<div class="mood"><span>+ ${brief.mood.positive}</span><span>○ ${brief.mood.neutral}</span><span>− ${brief.mood.negative}</span></div>` : `<span class="busy">${lang === 'ko' ? '감정 분석은 영어 통화에서만 제공됩니다 (AssemblyAI)' : 'not available'}</span>`;
  el.innerHTML = `
    <div><h3>${esc(t.speakers)}</h3><div class="speakers">${spk}</div></div>
    <div><h3>${esc(t.concerns)}</h3>${conc}</div>
    <div><h3>${esc(t.phrases)}</h3>${kp}</div>
    <div><h3>${esc(t.entities)}</h3>${ent}</div>
    <div><h3>${esc(t.mood)}</h3>${mood}</div>
  `;
}

export function summaryText(session, lang) {
  const t = I18N[lang];
  const p = session.profile || {};
  const plan = session.plan;
  const lines = [];
  lines.push(lang === 'ko' ? '[음성 상담 요약]' : '[Voice consultation summary]');
  lines.push('');
  lines.push(`${t.slots.business}: ${p.business_label || '-'} / ${t.slots.location}: ${p.location || '-'} / ${t.slots.budget}: ${p.budget_krw ? fmt(p.budget_krw) + ' KRW' : '-'}`);
  if (p.problems?.length) lines.push(`${t.slots.problems}: ${p.problems.join(', ')}`);
  if (plan?.channels) {
    lines.push('');
    lines.push(`${t.plan} (${fmt(plan.total_cost)} / ${fmt(plan.budget_krw)} KRW)`);
    for (const c of plan.channels) {
      lines.push(`- ${c.label} ${Math.round(c.share * 100)}%: ${c.items.map((i) => `${i.name} x${i.qty}`).join(', ')} = ${fmt(c.cost)} KRW`);
    }
    if (plan.checklist?.length) {
      lines.push('');
      lines.push(t.checklist);
      plan.checklist.forEach((l, i) => lines.push(`${i + 1}. ${l}`));
    }
  }
  if (session.brief?.concerns?.length) {
    lines.push('');
    lines.push(t.concerns);
    for (const c of session.brief.concerns) lines.push(`- "${c.text}"`);
  }
  return lines.join('\n');
}

const mmss = (sec) => {
  if (sec == null) return null;
  const m = Math.floor(sec / 60);
  return `${String(m).padStart(2, '0')}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`;
};

/**
 * Money ledger: each owner amount with its evidence. The number is the headline; under it the owner's words
 * the server read it from, and the moments it was heard, read back and confirmed. Only confirmed is vermilion.
 */
export function renderLedger(el, rows, lang) {
  const t = I18N[lang];
  if (!rows?.length) { el.innerHTML = `<li class="lempty">${esc(t.ledgerEmpty)}</li>`; return; }
  el.innerHTML = rows.map((r) => {
    if (r.source !== 'owner') {
      const what = String(r.label || r.kind || '').split(' · ')[0]; // rowLabel: '<label> · ₩n · <source>'
      return `<li class="lrow is-computed"><div class="lmain"><span class="lnum">₩${fmt(r.value_krw || 0)}</span><span class="lwords">${esc(what)}</span><span class="lstat">${esc(r.source || '')}</span></div></li>`;
    }
    const [lblWords, lblNum] = String(r.label || '').split(' · ');
    const rejectedRange = r.status === 'rejected' && r.value_krw == null;
    const num = rejectedRange ? (r.options || []).map((o) => `₩${fmt(o)}`).join(' / ') || lblNum || '' : (r.value_krw != null ? `₩${fmt(r.value_krw)}` : lblNum || '');
    const words = rejectedRange ? (r.reason === 'range' ? (lang === 'ko' ? '범위' : 'range') : r.reason || lblWords || '') : (r.spoken || lblWords || '');
    const steps = [['heard', t.heardAt, r.t?.heard], ['read_back', t.readBackAt, r.t?.read_back], ['confirmed', t.confirmedAt, r.t?.confirmed]];
    const trail = r.status === 'rejected'
      ? `<span class="st on">${esc(t.heardAt)} <b>${mmss(r.t?.heard) ?? ''}</b></span><span class="st rej">${esc(t.rejectedAt)} <b>${mmss(r.t?.rejected) ?? ''}</b></span>`
      : steps.map(([k, label, v]) => `<span class="st ${v != null ? 'on' : ''} ${k === 'confirmed' && v != null ? 'ok' : ''}">${esc(label)} ${v != null ? `<b>${mmss(v)}</b>` : ''}</span>`).join('<i aria-hidden="true">→</i>');
    const phrase = r.phrase ? `<div class="lphrase">“${esc(r.phrase)}”${r.paraphrased ? ' <small>paraphrased</small>' : ''}</div>` : '';
    return `<li class="lrow is-${esc(r.status)}" title="${esc(r.label || '')}">
      <div class="lmain"><span class="lnum">${esc(num)}</span><span class="lwords">${esc(words)}</span><span class="lstat">${esc(t.statusWord[r.status] || r.status)}</span></div>
      ${phrase}
      <div class="ltrail">${trail}</div>
    </li>`;
  }).join('');
}

/** "Listening for · money · max accuracy · 4 key terms", from what AssemblyAI echoed back. */
export function renderListening(el, config, lang) {
  if (!config) { el.hidden = true; return; }
  const t = I18N[lang];
  el.hidden = false;
  const what = t.steps[config.step] || config.step || '';
  const mode = config.mode === 'max_accuracy' ? t.maxAccuracy : config.mode === 'min_latency' ? t.minLatency : t.balanced;
  const terms = config.keyterms ? (lang === 'ko' ? `${t.keyterms} ${config.keyterms}개` : `${config.keyterms} ${t.keyterms}`) : '';
  el.innerHTML = `<span class="k">${esc(t.listeningFor)}</span>${[what, mode, terms].filter(Boolean).map((x, i) => `<span class="${i === 0 ? 'v strong' : 'v'}">${esc(x)}</span>`).join('')}`;
}

/** Measured, per turn: the owner stops talking -> the first agent audio chunk arrives. */
export function renderLatency(el, m, lang) {
  if (!m || m.ms == null) { el.hidden = true; return; }
  const t = I18N[lang];
  el.hidden = false;
  el.innerHTML = `<span class="k">${esc(t.latency)}</span><span class="v strong">${fmt(m.ms)} ms</span>${m.count > 1 ? `<span class="v">${esc(t.median)} ${fmt(m.median)} ms · ${esc(t.turns(m.count))}</span>` : ''}`;
}

/** Protocol events worth seeing (no audio frames), newest last. */
export function renderWire(el, lines) {
  el.innerHTML = lines.map((l) => `<li class="${l.dir === 'up' ? 'up' : 'down'}${l.hot ? ' hot' : ''}"><span class="d">${l.dir === 'up' ? '↑' : '↓'}</span><span class="ty">${esc(l.type)}</span><span class="de">${esc(l.detail || '')}</span></li>`).join('');
  el.scrollTop = el.scrollHeight;
}

/** Call receipt: ledger checked against AssemblyAI's record of the call, plus the summary. */
export function renderReceipt(el, rc, lang) {
  const t = I18N[lang];
  if (!rc) { el.innerHTML = `<span class="busy">${esc(t.checking)}</span>`; return; }
  const va = rc.record === 'assemblyai_session';
  const matchedLabel = va ? t.rMatchedVa : rc.record === 'typed_turns' ? t.rMatchedTyped : t.rMatchedKo;
  const line = [t.rConfirmed(rc.confirmed_amounts), matchedLabel(rc.matched.length), (va ? t.rRejectedVa : t.rRejectedKo)(rc.rejected_calls)].join(' · ');
  const unmatched = rc.unmatched?.length ? `<div class="runm"><b>${esc(t.rUnmatched)}</b> ${rc.unmatched.map((u) => `₩${fmt(u.value_krw)}`).join(', ')}</div>` : '';
  const ttfa = rc.median_time_to_first_audio_ms != null ? `<small>${esc(t.rTtfa)} ${fmt(rc.median_time_to_first_audio_ms)} ms${rc.session_id ? ` · ${esc(rc.session_id)}` : ''}</small>` : '';
  const sm = rc.summary;
  const src = sm ? (sm.source === 'llm-gateway' ? `LLM Gateway · ${esc(sm.model)}` : esc(t.summaryTemplate)) : '';
  el.innerHTML = `
    <div class="rline">${esc(line)}</div>
    ${(rc.matched || []).map((m) => `<div class="rmatch">₩${fmt(m.value_krw)} ← “${esc(m.user_transcript)}”${m.user_confidence != null ? ` <small>${Math.round(m.user_confidence * 100)}%</small>` : ''}</div>`).join('')}
    ${unmatched}${ttfa}
    ${sm ? `<div class="rsum"><h3>${esc(t.summary)} <small>${src}</small></h3><p>${esc(sm.text)}</p>${sm.next_step ? `<p><b>${esc(t.nextStep)}</b> ${esc(sm.next_step)}</p>` : ''}</div>` : ''}
  `;
}
