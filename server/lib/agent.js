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
import { createLedger } from './ledger.js';
import { createGrounding } from './grounding.js';
import { pickAmount, koreanShort, englishWords } from './amounts.js';
import { listenFor } from './listen.js';

export const CONFIRM = [/^(네|예|좋아요|좋습니다|진행|진행해|진행할게요|그렇게 해|해 ?주세요|오케이|콜|괜찮아요|괜찮네요|할게요|하겠습니다)/, /^(yes|yeah|yep|sure|ok|okay|go ahead|let'?s do it|sounds good|looks good|do it|proceed|great)\b/i];
// read-back answers on the grounded path ("맞아요", "that's right" as well as the plan confirmations above)
export const YES = [...CONFIRM, /^(맞아요|맞습니다|맞아|맞네요|그래요|그렇습니다|네네)/, /^(that'?s right|correct|right|exactly|that'?s it)\b/i];
export const NO = [/^(아니|아뇨|아니요|아니에요|틀려|틀렸|그게 아니)/, /^(no|nope|not quite|that'?s wrong|wrong)\b/i];
// words that make an amount in the intake step a budget (a menu price is not)
const BUDGET_CUE = /예산|마케팅|광고|한 ?달|월\s?\d|월\s?[일이삼사오육칠팔구십백]|매달|budget|marketing|spend|a month|per month|monthly/i;
// a budget said in dollars: the grounded path plans in won and never converts, so it asks again
const DOLLAR = /\$|\b(dollars?|usd|bucks)\b|달러/i;
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

  /**
   * engine: 'text' (typed or per-utterance voice, the original flow), 'realtime' (Universal-3.6 Pro streaming:
   * budgets go through the grounding check and the ledger), 'voice-agent' (the Voice Agent API path; its
   * tool relay writes to the same ledger).
   */
  function createSession({ lang = 'ko', id = null, engine = 'text' } = {}) {
    const sid = id || `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    const session = {
      id: sid,
      lang,
      engine,
      profile: emptyProfile(lang),
      history: [], // {role:'user'|'agent', text, at}
      stage: 'collect', // collect -> plan -> confirmed
      step: 'intake', // grounded path: intake -> budget -> confirm -> plan -> commit
      plan: null,
      llmTurns: 0,
      ruleTurns: 0,
      createdAt,
      placeLookupDone: false,
      ledger: createLedger({ t0: createdAt, lang }),
      grounding: createGrounding(),
      aaiSessionId: null,
    };
    const g = greeting(lang);
    session.history.push({ role: 'agent', text: g, at: Date.now() });
    session.listen = listenFor('intake', lang, g);
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
   * Grounded path (engine 'realtime'): the same rule policy, but a budget is only taken from the ledger.
   * Any amount goes through grounding.judge(); a single amount is read back ("월 48만 원, 맞으세요?"), and only
   * the owner's yes confirms it. Ranges are rejected with a question, "no" sends us back to the budget question.
   */
  async function handleGroundedTurn(session, clean, meta) {
    const lang = session.lang;
    const now = Date.now();
    const at = now; // server clock only: the 20 s grounding window must not depend on the browser clock
    const via = meta.via || 'realtime';
    session.history.push({ role: 'user', text: clean, at: now, meta });
    session.grounding.addHeard({ item_id: meta.item_id || null, text: clean, at, via });

    const slots = extractSlots(clean);
    const { budget_krw, budget_raw, budget_currency, ...rest } = slots; // the budget only comes from the ledger
    session.profile = mergeProfile(session.profile, rest);
    const ko = lang === 'ko';
    const L = (k, e) => (ko ? k : e);
    const won = (v) => (ko ? koreanShort(v) : `${englishWords(v)} won`);
    const pending = session.ledger.pending();
    const moneySaid = pickAmount(clean).status !== 'none';
    const moneyRelevant = moneySaid && (session.step !== 'intake' || BUDGET_CUE.test(clean));
    let reply = '';
    let planJustMade = false;
    let decision = null;

    const afterConfirmed = async (row) => {
      session.profile = mergeProfile(session.profile, { budget_krw: row.value_krw, budget_raw: row.phrase }, { overwrite: true });
      const missing = nextMissingSlot(session.profile);
      if (!missing || session.plan) {
        await maybeLookupPlace(session);
        const replan = Boolean(session.plan);
        await makePlan(session);
        session.ledger.addComputed({ kind: 'plan_total', value_krw: session.plan.total_cost, label: 'plan total', note: `budget ${row.value_krw}` });
        planJustMade = true;
        session.step = 'plan';
        return `${replan ? L('예산을 바꿔서 다시 짰습니다. ', 'I re-planned with the new budget. ') : ''}${session.plan.summary}`;
      }
      session.step = missing === 'budget' ? 'budget' : 'intake';
      return question(missing, session.profile, lang);
    };

    if (moneyRelevant) {
      decision = session.grounding.judge({ lang, at: now });
      if (decision.ok) {
        if (pending) { session.ledger.deny(pending.id, now); session.ledger.get(pending.id).reason = 'corrected'; }
        const row = session.ledger.addHeard({ value_krw: decision.amount_krw, phrase: decision.phrase, item_id: decision.item_id, heard_at: decision.heard_at, via: decision.via || via, lang });
        session.ledger.markReadBack(row.id, now);
        session.pendingRowId = row.id;
        session.step = 'confirm';
        reply = L(`${ack(session.profile, rest, lang)}월 ${koreanShort(row.value_krw)}, 맞으세요?`, `${ack(session.profile, rest, lang)}${englishWords(row.value_krw)} won a month, is that right?`.replace(/^([a-z])/, (c) => c.toUpperCase()));
      } else if (decision.error === 'ambiguous_amount') {
        session.ledger.addRejected({ reason: 'range', options: decision.options, phrase: decision.phrase, item_id: decision.item_id, heard_at: decision.heard_at, via, lang });
        const [a, b] = decision.options;
        session.step = 'budget';
        reply = L(`${won(a)}과 ${won(b)} 중 어느 쪽으로 계획할까요?`, `Which one should I plan for, ${englishWords(a)} or ${englishWords(b)} won?`);
      } else {
        session.step = 'budget';
        reply = L('한 달 예산을 금액으로 말씀해 주세요. 예를 들면 30만 원처럼요.', 'What monthly budget should I plan for, as a number in won?');
      }
    } else if (DOLLAR.test(clean) && (session.step !== 'intake' || BUDGET_CUE.test(clean))) {
      // "$300 a month": the parser does not read dollars as won, and the grounded path never converts
      if (!pending) session.step = 'budget';
      reply = L('원화로 계획해 드립니다. 한 달에 원으로 얼마인지 말씀해 주세요.', 'I plan in won. What is that per month in won?');
    } else if (pending) {
      if (YES.some((re) => re.test(clean))) {
        session.ledger.confirm(pending.id, now);
        reply = `${L(`네, 월 ${koreanShort(pending.value_krw)}으로 잡겠습니다. `, `Great, ${englishWords(pending.value_krw)} won a month. `)}${await afterConfirmed(pending)}`;
      } else if (NO.some((re) => re.test(clean))) {
        session.ledger.deny(pending.id, now);
        session.step = 'budget';
        reply = L('그럼 한 달 예산을 다시 말씀해 주시겠어요?', 'Okay. What monthly budget should I plan for?');
      } else {
        session.step = 'confirm';
        reply = L(`월 ${koreanShort(pending.value_krw)}으로 잡을까요? 맞으면 "네"라고 해 주세요.`, `Should I plan for ${englishWords(pending.value_krw)} won a month? Just say yes if that's right.`);
      }
    } else if (session.step === 'plan' && CONFIRM.some((re) => re.test(clean))) {
      session.stage = 'confirmed';
      session.step = 'commit';
      reply = planFollowUp(lang);
    } else if (session.step === 'plan' || session.step === 'commit') {
      reply = planQuestionAnswer(session, lang) || reprompt(lang);
    } else if (session.step === 'budget') {
      reply = `${ack(session.profile, rest, lang)}${question('budget', session.profile, lang)}`;
    } else {
      const missing = nextMissingSlot(session.profile);
      const heard = Object.values(rest).some((v) => (Array.isArray(v) ? v.length : v && v !== 'ko' && v !== 'en'));
      if (missing) {
        session.step = missing === 'budget' ? 'budget' : 'intake';
        reply = heard ? `${ack(session.profile, rest, lang)}${question(missing, session.profile, lang)}` : reprompt(lang);
      } else {
        reply = await afterConfirmed(session.ledger.budget());
      }
    }

    session.ruleTurns += 1;
    session.listen = listenFor(session.step, lang, reply);
    session.history.push({ role: 'agent', text: reply, at: Date.now(), source: 'rules' });
    return {
      reply,
      source: 'rules',
      stage: session.stage,
      step: session.step,
      profile: session.profile,
      slots: rest,
      plan: session.plan,
      planJustMade,
      placeCandidates: session.placeCandidates || [],
      ledger: session.ledger.snapshot(),
      grounding: decision ? { ok: decision.ok, error: decision.error || null, options: decision.options || null, amount_krw: decision.amount_krw ?? null, phrase: decision.phrase || null } : null,
      listen: session.listen,
    };
  }

  /**
   * Handle one owner utterance. Returns what to say and the updated state.
   */
  async function handleUtterance(sessionId, text, { meta = {} } = {}) {
    const session = getSession(sessionId);
    if (!session) throw Object.assign(new Error('unknown session'), { code: 'no_session' });
    const lang = session.lang;
    const clean = String(text || '').trim();
    if (session.engine === 'realtime') return handleGroundedTurn(session, clean, meta);
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
