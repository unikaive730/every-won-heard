/** DOM rendering helpers. Pure string templates + a few element updates. */

export const I18N = {
  ko: {
    tagline: '사장님이 말하면, 30일 마케팅 계획이 나옵니다',
    start: '상담 시작', end: '상담 종료', send: '보내기', typeHere: '말하기 대신 입력하기 (키 없이도 동작)',
    idle: '마이크를 켜고 말씀하시면 됩니다. 마이크가 없으면 아래에 입력하세요.',
    listening: '듣고 있어요…', speaking: '상담사가 말하는 중', thinking: '정리하는 중…', connecting: '연결 중…', transcribing: '받아쓰는 중 (AssemblyAI)…',
    heard: '들은 내용', plan: '30일 계획', checklist: '실행 체크리스트', analysis: '통화 분석',
    footNote: '브라우저에는 60초짜리 임시 토큰만 내려갑니다. API 키는 서버에만 있습니다.',
    slots: { business: '업종', location: '위치', budget: '월 예산', problems: '급한 고민', tried: '해본 것', store: '상호' },
    notYet: '아직', assumed: '가정', total: '합계', budgetLabel: '월 예산', ofBudget: '사용',
    inquiry: '문의형 상품(견적 후 진행)', checkoutTitle: '카드 결제 링크 만들기 (회원가입 없음)', namePh: '이름 또는 상호', phonePh: '휴대폰 (선택)', makeLink: '결제 링크 만들기',
    linkReady: '결제 링크가 준비됐습니다', linkFail: '결제 링크를 만들지 못했습니다', mockNote: '지금은 목업 카탈로그라 실제 결제 링크를 만들 수 없습니다.',
    analyzing: 'AssemblyAI가 통화 전체를 분석하는 중 (화자 분리·감정·키워드·개체)…', noKeyAnalyze: 'ASSEMBLYAI_API_KEY 가 없어 통화 분석을 건너뜁니다.',
    speakers: '화자', ownerTag: '사장님', concerns: '사장님이 실제로 말한 고민', phrases: '키워드', entities: '언급한 사실', mood: '감정 분포', none: '없음',
    agent: '상담사', owner: '사장님', copy: '요약 복사', copied: '복사됨', sourceLive: '실시간 카탈로그 (MCP)', sourceMock: '목업 카탈로그 (MCP 연결 안 됨)',
    micDenied: '마이크 권한이 없어요. 아래 입력창으로 계속할 수 있습니다.', noKey: 'AssemblyAI 키가 없어 음성은 꺼져 있어요. 입력창으로 상담을 이어갈 수 있습니다.',
    modeStream: 'AssemblyAI Universal-Streaming', modeTurn: 'AssemblyAI pre-recorded (턴 단위, 한국어)', ended: '상담이 끝났습니다. 오른쪽 계획과 체크리스트를 확인하세요.',
  },
  en: {
    tagline: 'You talk. A 30-day marketing plan comes out.',
    start: 'Start call', end: 'End call', send: 'Send', typeHere: 'Type instead of speaking (works without any key)',
    idle: 'Turn on the mic and talk. No mic? Type below.',
    listening: 'Listening…', speaking: 'Consultant speaking', thinking: 'Thinking…', connecting: 'Connecting…', transcribing: 'Transcribing (AssemblyAI)…',
    heard: 'What we heard', plan: '30-day plan', checklist: 'Action checklist', analysis: 'Call analysis',
    footNote: 'The browser only ever receives a 60-second temporary token. API keys stay on the server.',
    slots: { business: 'Business', location: 'Location', budget: 'Budget / mo', problems: 'Urgent problem', tried: 'Tried', store: 'Store' },
    notYet: 'not yet', assumed: 'assumed', total: 'Total', budgetLabel: 'Monthly budget', ofBudget: 'used',
    inquiry: 'Inquiry-only products (quote first)', checkoutTitle: 'Create card checkout link (no signup)', namePh: 'Name or store name', phonePh: 'Phone (optional)', makeLink: 'Create checkout link',
    linkReady: 'Checkout link is ready', linkFail: 'Could not create the checkout link', mockNote: 'Mock catalog in use, so a real checkout link cannot be created right now.',
    analyzing: 'AssemblyAI is analyzing the whole call (speakers, sentiment, key phrases, entities)…', noKeyAnalyze: 'No ASSEMBLYAI_API_KEY, skipping call analysis.',
    speakers: 'Speakers', ownerTag: 'owner', concerns: 'What the owner actually complained about', phrases: 'Key phrases', entities: 'Facts mentioned', mood: 'Sentiment', none: 'none',
    agent: 'Consultant', owner: 'Owner', copy: 'Copy summary', copied: 'Copied', sourceLive: 'live catalog (MCP)', sourceMock: 'mock catalog (MCP unreachable)',
    micDenied: 'Microphone permission denied. You can continue by typing below.', noKey: 'No AssemblyAI key on the server, so voice is off. You can continue by typing.',
    modeStream: 'AssemblyAI Universal-Streaming', modeTurn: 'AssemblyAI pre-recorded (per turn, Korean)', ended: 'Call ended. Check the plan and checklist on the right.',
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
    if (t[key] && key !== 'analysis') el.textContent = t[key];
  }
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) {
    const key = el.dataset.i18nPlaceholder;
    if (t[key]) el.placeholder = t[key];
  }
}

export function setBadge(id, cls, text) {
  const el = document.getElementById(id);
  el.classList.remove('ok', 'warn', 'bad');
  if (cls) el.classList.add(cls);
  el.querySelector('em').textContent = text;
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const COLORS = ['#1f8a7a', '#e4572e', '#c9a227', '#4361ee', '#8338ec', '#ff8fab', '#2a9d8f'];

export function addBubble(container, role, text, { tag = '', lang = 'ko' } = {}) {
  const t = I18N[lang];
  const div = document.createElement('div');
  div.className = `bubble ${role}`;
  if (role === 'system') div.textContent = text;
  else div.innerHTML = `<span class="who">${role === 'agent' ? esc(t.agent) : esc(t.owner)}${tag ? `<span class="tag">${esc(tag)}</span>` : ''}</span>${esc(text)}`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div;
}

export function setPartial(container, text) {
  let el = container.querySelector('.bubble.partial');
  if (!text) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.className = 'bubble partial'; container.appendChild(el); }
  el.textContent = text;
  container.scrollTop = container.scrollHeight;
}

export function renderSlots(el, profile, lang, { problemLabels = null } = {}) {
  const t = I18N[lang];
  const chip = (v, cls = '') => (v ? `<span class="chip ${cls}">${esc(v)}</span>` : `<span class="chip empty">${esc(t.notYet)}</span>`);
  const problems = (profile.problems || []).map((k) => (problemLabels && problemLabels[k]) || k);
  el.innerHTML = `
    <dt>${esc(t.slots.business)}</dt><dd>${chip(profile.business_label)}</dd>
    <dt>${esc(t.slots.location)}</dt><dd>${chip(profile.location)}</dd>
    <dt>${esc(t.slots.budget)}</dt><dd>${profile.budget_krw ? chip(`${fmt(profile.budget_krw)} KRW${profile.budget_currency === 'USD' ? ' (≈USD)' : ''}`) : chip(null)}</dd>
    <dt>${esc(t.slots.problems)}</dt><dd>${problems.length ? problems.map((p) => chip(p, 'warn')).join('') : chip(null)}</dd>
    ${profile.channels_tried?.length ? `<dt>${esc(t.slots.tried)}</dt><dd>${profile.channels_tried.map((c) => chip(c)).join('')}</dd>` : ''}
    ${profile.store_name ? `<dt>${esc(t.slots.store)}</dt><dd>${chip(profile.store_name)}</dd>` : ''}
  `;
}

export function renderPlace(el, place, candidates, lang) {
  if (!place && !candidates?.length) { el.hidden = true; return; }
  el.hidden = false;
  if (place) {
    el.innerHTML = `<b>Naver Place</b> ${esc(place.name)} · ${esc(place.category || '')}<br><small>${esc(place.roadAddress || '')}</small>`;
    return;
  }
  el.innerHTML = `<b>Naver Place</b> ${lang === 'ko' ? '이 근처에서 찾은 매장 (MCP search_places)' : 'nearby listings found via MCP search_places'}<ul>${candidates.slice(0, 3).map((c) => `<li>${esc(c.name)} <small>${esc(c.roadAddress || '')}</small></li>`).join('')}</ul>`;
}

export function renderPlan(el, plan, lang) {
  const t = I18N[lang];
  const pct = plan.budget_krw ? Math.round((plan.total_cost / plan.budget_krw) * 100) : 0;
  el.innerHTML = `
    <div class="budget"><span>${esc(t.budgetLabel)} <b>${fmt(plan.budget_krw)} KRW</b></span><span>${pct}% ${esc(t.ofBudget)}</span></div>
    <div class="bar">${plan.channels.map((c, i) => `<i style="width:${Math.max(2, (c.cost / plan.budget_krw) * 100)}%;background:${COLORS[i % COLORS.length]}" title="${esc(c.label)}"></i>`).join('')}</div>
    ${plan.channels.map((c, i) => `
      <div class="ch">
        <div class="ch-head"><span class="sw" style="background:${COLORS[i % COLORS.length]}"></span>${esc(c.label)}<span class="pct">${Math.round(c.share * 100)}% · ${fmt(c.cost)}</span></div>
        <div class="ch-why">${esc(c.why)}</div>
        <ul class="ch-items">${c.items.map((it) => `<li><span>${esc(it.name)} × ${fmt(it.qty)}</span><span>${fmt(it.cost)}</span></li>`).join('')}</ul>
      </div>`).join('')}
    <div class="total"><span>${esc(t.total)}</span><span>${fmt(plan.total_cost)} KRW</span></div>
    ${plan.assumptions?.length ? `<div class="assume">${plan.assumptions.map(esc).join('<br>')}</div>` : ''}
    ${plan.inquiry_items?.length ? `<div class="inq"><b>${esc(t.inquiry)}</b><br>${plan.inquiry_items.map((i) => esc(i.name)).join(' · ')}</div>` : ''}
  `;
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
    box.innerHTML = `${esc(t.linkReady)}: <a href="${esc(result.checkoutUrl)}" target="_blank" rel="noopener">${esc(result.checkoutUrl)}</a>${result.amount ? ` · ${fmt(result.amount)} KRW` : ''}`;
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
  lines.push(lang === 'ko' ? '[마켓파일럿 음성 상담 요약]' : '[MarketPilot voice consultation summary]');
  lines.push('');
  lines.push(`${t.slots.business}: ${p.business_label || '-'} / ${t.slots.location}: ${p.location || '-'} / ${t.slots.budget}: ${p.budget_krw ? fmt(p.budget_krw) + ' KRW' : '-'}`);
  if (p.problems?.length) lines.push(`${t.slots.problems}: ${p.problems.join(', ')}`);
  if (plan) {
    lines.push('');
    lines.push(`${t.plan} (${fmt(plan.total_cost)} / ${fmt(plan.budget_krw)} KRW)`);
    for (const c of plan.channels) {
      lines.push(`- ${c.label} ${Math.round(c.share * 100)}%: ${c.items.map((i) => `${i.name} x${i.qty}`).join(', ')} = ${fmt(c.cost)} KRW`);
    }
    lines.push('');
    lines.push(t.checklist);
    plan.checklist.forEach((l, i) => lines.push(`${i + 1}. ${l}`));
  }
  if (session.brief?.concerns?.length) {
    lines.push('');
    lines.push(t.concerns);
    for (const c of session.brief.concerns) lines.push(`- "${c.text}"`);
  }
  return lines.join('\n');
}
