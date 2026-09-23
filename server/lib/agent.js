/**
 * Dialogue policy for the consultation call.
 *
 * Every owner utterance goes through extractSlots() (rules). If an LLM is configured it
 * writes the spoken reply and may refine the profile; otherwise a deterministic slot-filling
 * policy asks the next question. When enough is known, the planner builds the priced plan
 * from the catalog and the agent reads out its summary.
 */
import { extractSlots, mergeProfile, nextMissingSlot, emptyProfile, businessLabel, problemLabel, LOCAL_TYPES } from './extract.js';
import { buildPlan, CHANNELS } from './planner.js';

const CONFIRM = [/^(네|예|좋아요|좋습니다|진행|진행해|진행할게요|그렇게 해|해 ?주세요|오케이|콜|괜찮아요|괜찮네요|할게요|하겠습니다)/, /^(yes|yeah|yep|sure|ok|okay|go ahead|let'?s do it|sounds good|looks good|do it|proceed|great)\b/i];
const ASK_PLAN = [/추천|제안|계획|플랜|뭐부터|어떻게 해야|알려 ?줘|알려 ?주세요|해야 ?할까/, /recommend|suggest|plan|what should|where (do|should) i start|how do i|tell me/i];

export function greeting(lang) {
  return lang === 'ko'
    ? '안녕하세요, 마켓파일럿 마케팅 상담입니다. 어떤 가게를 하고 계신지, 어디에 있는지부터 편하게 말씀해 주세요.'
    : "Hi, this is MarketPilot's marketing consultant. Tell me what kind of business you run and where it is, and we'll go from there.";
}

function ack(profile, slots, lang) {
  const bits = [];
  if (slots.business_type) bits.push(lang === 'ko' ? `${slots.business_label || businessLabel(slots.business_type, 'ko')}` : `a ${slots.business_label || businessLabel(slots.business_type, 'en')}`);
  if (slots.location) bits.push(lang === 'ko' ? `${slots.location}` : `in ${slots.location}`);
  if (slots.budget_krw) bits.push(lang === 'ko' ? `월 ${slots.budget_krw.toLocaleString('en-US')}원` : `${slots.budget_krw.toLocaleString('en-US')} KRW a month`);
  if (slots.problems?.length) bits.push(lang === 'ko' ? `${problemLabel(slots.problems[0], 'ko')} 고민` : `${problemLabel(slots.problems[0], 'en')}`);
  if (!bits.length) return '';
  if (lang === 'ko') {
    const loc = slots.location && slots.business_type ? `${slots.location} ${slots.business_label || businessLabel(slots.business_type, 'ko')}` : bits.join(', ');
    return `${loc}, 알겠습니다. `;
  }
  return `Got it, ${bits.join(', ')}. `;
}

function question(slot, profile, lang) {
  const q = {
    business_type: { ko: '어떤 업종을 하고 계세요? 카페, 음식점, 미용실, 온라인몰처럼 말씀해 주시면 됩니다.', en: 'What kind of business is it? A cafe, restaurant, salon, online store, something else?' },
    location: { ko: '매장은 어느 동네에 있나요?', en: 'Which neighborhood or city is the store in?' },
    budget: { ko: '한 달 마케팅에 쓸 수 있는 예산은 얼마 정도 생각하세요?', en: 'Roughly how much can you spend on marketing per month?' },
    problem: { ko: '지금 제일 급한 고민은 뭐예요? 손님이 적다, 리뷰가 없다, 검색에 안 뜬다 같은 거요.', en: "What's the most urgent problem right now? Not enough customers, few reviews, not showing up in search, that kind of thing." },
  };
  return q[slot][lang];
}

function reprompt(lang) {
  return lang === 'ko'
    ? '잘 못 알아들었어요. 업종, 동네, 월 예산, 급한 고민 중 하나를 한 번 더 말씀해 주세요.'
    : "Sorry, I didn't catch that. Tell me the business type, the area, your monthly budget, or the main problem.";
}

function planFollowUp(lang) {
  return lang === 'ko'
    ? '네, 화면의 "카드 결제 링크 만들기" 버튼을 누르면 회원가입 없이 결제 링크가 만들어집니다. 다른 궁금한 점 있으세요?'
    : 'Great. Press "Create card checkout link" on screen and you get a payment link with no signup. Anything else you want to know?';
}

function planQuestionAnswer(session, lang) {
  const plan = session.plan;
  if (!plan) return null;
  const top = plan.channels[0];
  if (!top) return null;
  return lang === 'ko'
    ? `가장 큰 비중은 ${top.label}이고 ${top.why} 총액은 ${plan.total_cost.toLocaleString('en-US')}원입니다. 조정하고 싶은 부분을 말씀해 주세요.`
    : `The biggest share goes to ${top.label}. ${top.why} The total is ${plan.total_cost.toLocaleString('en-US')} KRW. Tell me what you want to change.`;
}

export function catalogSummaryText(lang) {
  return Object.values(CHANNELS).map((c) => c[lang === 'ko' ? 'ko' : 'en']).join('; ');
}

/**
 * @param {{llm?:object|null, getCatalog:()=>Promise<{source:string, products:Array}>, searchPlaces?:(kw:string)=>Promise<{places:Array}>, logger?:object}} deps
 */
export function createAgent({ llm = null, getCatalog, searchPlaces = null, logger = console }) {
  const sessions = new Map();

  function createSession({ lang = 'ko', id = null } = {}) {
    const sid = id || `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const session = {
      id: sid,
      lang,
      profile: emptyProfile(lang),
      history: [], // {role:'user'|'agent', text, at}
      stage: 'collect', // collect -> plan -> confirmed
      plan: null,
      llmTurns: 0,
      ruleTurns: 0,
      createdAt: Date.now(),
      placeLookupDone: false,
    };
    const g = greeting(lang);
    session.history.push({ role: 'agent', text: g, at: Date.now() });
    sessions.set(sid, session);
    return session;
  }

  function getSession(id) {
    return sessions.get(id) || null;
  }

  async function maybeLookupPlace(session) {
    if (!searchPlaces || session.placeLookupDone) return;
    const p = session.profile;
    if (!p.location || !p.business_type || !LOCAL_TYPES.has(p.business_type)) return;
    session.placeLookupDone = true;
    try {
      const kw = p.store_name ? `${p.location} ${p.store_name}` : `${p.location} ${businessLabel(p.business_type, 'ko')}`;
      const r = await searchPlaces(kw);
      if (r?.places?.length) {
        session.placeCandidates = r.places.slice(0, 5);
        if (p.store_name) {
          const hit = r.places.find((x) => x.name?.includes(p.store_name));
          if (hit) session.profile.place = hit;
        }
      }
    } catch (err) {
      logger?.warn?.(`[agent] place lookup failed: ${err?.message || err}`);
    }
  }

  async function makePlan(session) {
    const cat = await getCatalog();
    session.plan = buildPlan(session.profile, cat.products, { catalogSource: cat.source });
    session.stage = 'plan';
    return session.plan;
  }

  /**
   * Handle one owner utterance. Returns what to say and the updated state.
   */
  async function handleUtterance(sessionId, text, { meta = {} } = {}) {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('unknown session'), { code: 'no_session' });
    const lang = session.lang;
    const clean = String(text || '').trim();
    session.history.push({ role: 'user', text: clean, at: Date.now(), meta });

    const slots = extractSlots(clean);
    session.profile = mergeProfile(session.profile, slots);
    if (slots.language && slots.language !== session.profile.language) {
      // keep the session language stable; the owner may quote English words
    }

    let reply = null;
    let source = 'rules';
    let planJustMade = false;

    if (llm) {
      const out = await llm.agentTurn({ lang, history: session.history, profile: session.profile, catalogSummary: catalogSummaryText(lang), planPresented: session.stage !== 'collect' });
      if (out) {
        source = 'llm';
        session.llmTurns += 1;
        const p = out.profile || {};
        session.profile = mergeProfile(session.profile, {
          business_type: p.business_type || null,
          business_label: p.business_type ? businessLabel(p.business_type, lang) : null,
          location: p.location || null,
          budget_krw: p.budget_krw || null,
          problems: p.problems || [],
          store_name: p.store_name || null,
        });
        reply = out.reply;
        if (session.stage === 'collect' && (out.ready_for_plan || nextMissingSlot(session.profile) === null)) {
          await maybeLookupPlace(session);
          await makePlan(session);
          planJustMade = true;
          reply = `${reply} ${session.plan.summary}`.trim();
        } else if (session.stage === 'plan' && out.owner_confirmed_plan) {
          session.stage = 'confirmed';
        }
      }
    }

    if (!reply) {
      session.ruleTurns += 1;
      if (session.stage === 'collect') {
        const missing = nextMissingSlot(session.profile);
        const wantsPlan = ASK_PLAN.some((re) => re.test(clean)) && session.profile.business_type;
        if (missing && !wantsPlan) {
          const heard = Object.values(slots).some((v) => (Array.isArray(v) ? v.length : v && v !== 'ko' && v !== 'en'));
          reply = heard ? `${ack(session.profile, slots, lang)}${question(missing, session.profile, lang)}` : reprompt(lang);
        } else {
          await maybeLookupPlace(session);
          await makePlan(session);
          planJustMade = true;
          reply = `${ack(session.profile, slots, lang)}${session.plan.summary}`;
        }
      } else if (session.stage === 'plan') {
        if (CONFIRM.some((re) => re.test(clean))) {
          session.stage = 'confirmed';
          reply = planFollowUp(lang);
        } else if (slots.budget_krw && slots.budget_krw !== session.plan?.budget_krw) {
          session.profile = mergeProfile(session.profile, { budget_krw: slots.budget_krw, budget_raw: slots.budget_raw }, { overwrite: true });
          await makePlan(session);
          planJustMade = true;
          reply = (lang === 'ko' ? '예산을 바꿔서 다시 짰습니다. ' : 'I re-planned with the new budget. ') + session.plan.summary;
        } else {
          reply = planQuestionAnswer(session, lang) || reprompt(lang);
        }
      } else {
        reply = lang === 'ko' ? '결제 링크는 화면에서 만들 수 있습니다. 상담을 끝내려면 "종료"를 누르면 요약을 정리해 드립니다.' : 'You can create the checkout link on screen. Press "End" when you are done and I will write up the summary.';
      }
    }

    session.history.push({ role: 'agent', text: reply, at: Date.now(), source });
    return {
      reply,
      source,
      stage: session.stage,
      profile: session.profile,
      slots,
      plan: session.plan,
      planJustMade,
      placeCandidates: session.placeCandidates || [],
    };
  }

  return { createSession, getSession, handleUtterance, makePlan, sessions };
}
