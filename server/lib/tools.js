/**
 * Tool relay for the Voice Agent API path (design 6-4). The browser receives tool.call, waits for reply.done,
 * posts the call here, and sends back what we return, in this order:
 *
 *   {type: 'session.update', session: session_update}     when state_changed (tools + system prompt + input)
 *   {type: 'tool.result', call_id, result, is_error}      result is already a JSON string
 *
 * The update goes first so the reply to the result already has the next stage's tools (measured: the other
 * order left the model without build_plan after confirm_budget).
 *
 * The server owns every number. The model only passes words:
 *   record_shop            enums + the neighborhood                      s0 -> s1
 *   record_budget          owner_words, period. grounding.js re-reads the owner's own transcript (POST /heard)
 *                          and decides: ambiguous_amount / no_amount_heard / amount_mismatch / ok      -> s2
 *   confirm_budget         answer yes|no, checked against the owner's last turn (YES / NO of agent.js)
 *                          yes -> confirmed -> s3, no -> s1
 *   build_plan             only from the confirmed budget in the ledger (voice-plan.js)               -> s4
 *   create_checkout_link   only after the plan and a go-ahead turn. DEMO_MODE=1: a demo URL, no payment
 *   end_call               the client sends session.end after the goodbye
 *
 * Errors go back with is_error: true and an "ask" the model reads verbatim (docs: name the failing field,
 * say what to ask next). Every call is logged on session.va.calls; the same call_id twice returns the same answer.
 */
import { pickAmount, readBack, englishWords, moneyValues } from './amounts.js';
import { YES, NO } from './agent.js';
import { sessionUpdateFor, toolNamesFor, STEP_OF, isState, BUSINESS_TYPES, MAIN_PROBLEMS } from './states.js';
import { mergeProfile, businessLabel } from './extract.js';
import { planForBudget, asPlannerPlan } from './voice-plan.js';
import { checkoutItems } from './planner.js';
import { listenFor } from './listen.js';

const PROBLEM_KEY = { map_visibility: 'place_rank', social_growth: 'instagram' }; // enum -> extract.js key
const DISCOUNT = /discount|\d+\s?%\s?off|percent off|cheaper|price cut|lower (the )?price|\bdeal\b/i;
const FILLER = /^(uh+|um+|er+|oh|well|so|hmm+)[\s,.!]+/i;

export function initVoiceAgent(session) {
  if (!session.va) {
    session.va = { state: 's0', calls: [], budgetIdx: null, planIdx: null, planRowId: null, plan: null, endRequested: false };
  }
  session.step = STEP_OF[session.va.state];
  session.listen = listenFor(session.step, 'en');
  return session.va;
}

function setState(session, state) {
  const va = session.va;
  const changed = va.state !== state;
  va.state = state;
  session.step = STEP_OF[state];
  session.listen = listenFor(session.step, 'en');
  return changed;
}

function answerText(turn) {
  return String(turn?.text || '').trim().replace(FILLER, '');
}

/** The owner's latest turn at or after heard index `from` (or the turn named by last_item_id). */
function answerTurn(session, lastItemId, from) {
  const heard = session.grounding.heard;
  const named = lastItemId ? session.grounding.find(lastItemId) : null;
  const turn = named || heard[heard.length - 1] || null;
  if (!turn) return null;
  return heard.indexOf(turn) >= (from ?? 0) ? turn : null;
}

/**
 * @param {{getCatalog:()=>Promise<{source,products}>, createCheckout?:Function|null, demoMode?:boolean,
 *          lateTranscriptMs?:number, sleep?:(ms)=>Promise, logger?:object}} deps
 */
export function createToolRunner({ getCatalog, createCheckout = null, demoMode = process.env.DEMO_MODE === '1', lateTranscriptMs = 300, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), logger = console } = {}) {
  /** Wait up to lateTranscriptMs for a final transcript that is still on its way (design 6-5, rule 1). */
  async function waitForTranscript(session, ready) {
    const until = Date.now() + lateTranscriptMs;
    while (!ready() && Date.now() < until) await sleep(25);
  }

  const handlers = {
    async record_shop(session, args) {
      const bt = BUSINESS_TYPES.includes(args.business_type) ? args.business_type : null;
      const hood = String(args.neighborhood || '').trim().slice(0, 60);
      if (!bt || !hood) {
        return { error: true, body: { error: bt ? 'no_neighborhood' : 'no_business_type', ask: bt ? 'Ask which neighborhood the shop is in.' : 'Ask what kind of shop it is.' } };
      }
      const mp = MAIN_PROBLEMS.includes(args.main_problem) ? args.main_problem : null;
      session.profile = mergeProfile(session.profile, { business_type: bt, business_label: businessLabel(bt, 'en'), location: hood, problems: mp ? [PROBLEM_KEY[mp] || mp] : [] }, { overwrite: true });
      const next = session.va.state === 's0' ? 's1' : session.va.state;
      return {
        next,
        body: { ok: true, shop: `${businessLabel(bt, 'en')} in ${hood}`, next_step: mp ? 'Ask for the monthly marketing budget in won.' : 'Ask what the most urgent problem is, then ask for the monthly marketing budget in won.' },
      };
    },

    async record_budget(session, args, { lastItemId }) {
      const g = session.grounding;
      await waitForTranscript(session, () => (lastItemId ? Boolean(g.find(lastItemId)) : g.candidates().length > 0));
      const words = String(args.owner_words || '').trim().slice(0, 300);
      const period = args.period === 'one_time' ? 'one_time' : 'monthly';
      const modelPick = words ? pickAmount(words) : { status: 'none' };
      const modelKrw = modelPick.status === 'ok' ? modelPick.value : null;
      const discountAsked = g.candidates().some((t) => DISCOUNT.test(t.text));
      const d = g.judge({ amount_krw: modelKrw, owner_words: words, lang: 'en' });
      const ledger = session.ledger;
      const common = { owner_words: words || null, item_id: d.item_id || null, heard_at: d.heard_at || Date.now(), via: 'voice-agent', lang: 'en' };

      if (d.error === 'no_amount_heard') {
        return { error: true, body: { error: 'no_amount_heard', ask: 'Ask for the monthly budget as a number in won.' } };
      }
      if (d.error === 'ambiguous_amount') {
        ledger.addRejected({ reason: 'range', options: d.options, phrase: d.phrase || null, ...common });
        return { error: true, body: { error: 'ambiguous_amount', options: d.options, options_spoken: d.options.map((v) => `${englishWords(v)} won`), ask: 'Ask which one to plan for, saying the options_spoken.' } };
      }
      const pending = ledger.pending();
      if (pending) { ledger.deny(pending.id); ledger.get(pending.id).reason = 'corrected'; }
      let heardKrw = d.amount_krw;
      let body;
      if (d.error === 'amount_mismatch') {
        // the model's words carry a different amount than the owner's transcript: reject the model's number,
        // keep what the owner said (the server's reading) and have it read back
        ledger.addRejected({ reason: 'mismatch', value_krw: d.model_krw, options: [d.heard_krw], phrase: d.phrase || null, ...common });
        heardKrw = d.heard_krw;
        body = { error: 'amount_mismatch', heard_krw: heardKrw, read_back: readBack(heardKrw, 'en'), ask: "Your words don't match what the owner said. Read back read_back word for word and ask if it's right." };
      } else {
        body = { ok: true, heard_krw: heardKrw, read_back: d.read_back, period, next_step: "Read back read_back word for word and ask if it's right." };
      }
      const row = ledger.addHeard({ value_krw: heardKrw, phrase: d.phrase || null, paraphrased: Boolean(d.paraphrased), forced: Boolean(d.forced) || d.error === 'amount_mismatch', ...common });
      row.period = period;
      session.va.budgetIdx = g.heard.length; // the yes has to come after this
      if (discountAsked) body.note = "The owner also asked for a discount. Say you can't give discounts and can only use catalog prices.";
      return { error: d.error === 'amount_mismatch', next: 's2', body };
    },

    async confirm_budget(session, args, { lastItemId }) {
      if (lastItemId) await waitForTranscript(session, () => Boolean(session.grounding.find(lastItemId)));
      const ledger = session.ledger;
      const pending = ledger.pending();
      if (!pending) {
        const b = ledger.budget();
        if (b) return { next: session.va.plan ? session.va.state : 's3', body: { ok: true, status: 'already_confirmed', read_back: readBack(b.value_krw, 'en'), next_step: session.va.plan ? 'Go on with the plan.' : 'Call build_plan now.' } };
        return { error: true, next: 's1', body: { error: 'nothing_to_confirm', ask: "Ask for the monthly budget and call record_budget with the owner's words." } };
      }
      const turn = answerTurn(session, lastItemId, session.va.budgetIdx);
      const readBackText = readBack(pending.value_krw, 'en');
      if (!turn) return { error: true, next: 's2', body: { error: 'no_answer_yet', read_back: readBackText, ask: "Read back read_back and wait for the owner's yes or no." } };
      const text = answerText(turn);
      const saidYes = YES.some((re) => re.test(text));
      const saidNo = NO.some((re) => re.test(text));
      if (args.answer === 'yes' && saidYes && !saidNo) {
        ledger.confirm(pending.id);
        session.profile = mergeProfile(session.profile, { budget_krw: pending.value_krw, budget_raw: pending.phrase }, { overwrite: true });
        return { next: 's3', body: { ok: true, status: 'confirmed', budget: readBackText, next_step: 'Call build_plan now.' } };
      }
      if (args.answer === 'no' && saidNo) {
        ledger.deny(pending.id);
        return { next: 's1', body: { ok: true, status: 'not_confirmed', next_step: 'Ask for the monthly budget again.' } };
      }
      return { error: true, next: 's2', body: { error: 'answer_unclear', owner_said: turn.text.slice(0, 120), read_back: readBackText, ask: 'Ask the owner to answer yes or no to read_back.' } };
    },

    async build_plan(session) {
      const ledger = session.ledger;
      const pending = ledger.pending();
      if (pending) return { error: true, next: 's2', body: { error: 'new_budget_not_confirmed', read_back: readBack(pending.value_krw, 'en'), ask: 'Read back read_back and ask the owner to confirm it first.' } };
      const b = ledger.budget();
      if (!b) return { error: true, next: 's1', body: { error: 'budget_not_confirmed', ask: 'Ask for the monthly budget first.' } };
      const cat = await getCatalog();
      const p = planForBudget(b.value_krw, cat.products);
      if (!p.lines.length) return { error: true, next: 's1', body: { error: 'budget_too_small', ask: 'Say the budget is too small for any catalog service and ask if they can raise it.' } };
      if (session.va.planRowId !== b.id) ledger.addComputed({ kind: 'plan_total', value_krw: p.total_krw, label: 'plan total', note: `budget ${b.value_krw}` });
      session.plan = asPlannerPlan(p, { catalogSource: cat.source });
      session.stage = 'plan';
      session.va.plan = p;
      session.va.planRowId = b.id;
      session.va.planIdx = session.grounding.heard.length;
      return {
        next: 's4',
        body: {
          ok: true,
          budget: p.spoken_budget,
          lines: p.lines.map((l) => ({ name: l.name, qty: l.qty, unit_krw: l.unit_krw, spoken: l.spoken })),
          total_krw: p.total_krw,
          spoken_total: p.spoken_total,
          next_step: "Read each line's spoken text, then the spoken total, then ask if they want the card checkout link.",
        },
      };
    },

    async create_checkout_link(session, args, { lastItemId, origin }) {
      if (lastItemId) await waitForTranscript(session, () => Boolean(session.grounding.find(lastItemId)));
      const ledger = session.ledger;
      const b = ledger.budget();
      if (ledger.pending()) return { error: true, next: 's2', body: { error: 'new_budget_not_confirmed', ask: 'Confirm the new budget with the owner first.' } };
      if (!session.va.plan || !b || session.va.planRowId !== b.id) return { error: true, body: { error: 'no_current_plan', ask: 'Call build_plan first.' } };
      const turn = answerTurn(session, lastItemId, session.va.planIdx);
      if (!turn || !YES.some((re) => re.test(answerText(turn))) || NO.some((re) => re.test(answerText(turn)))) {
        return { error: true, body: { error: 'no_go_ahead', ask: 'Ask the owner if they want the card checkout link for this plan.' } };
      }
      const p = session.va.plan;
      if (demoMode || !createCheckout) {
        session.checkout = { demo: true, url: `${origin || ''}/demo-checkout/${encodeURIComponent(session.id)}`, total_krw: p.total_krw, items: checkoutItems(session.plan), at: Date.now() };
        return { body: { ok: true, demo: true, url: session.checkout.url, spoken_total: p.spoken_total, next_step: "Say the checkout link is on their screen and this demo takes no payment. Don't read the link aloud." } };
      }
      try {
        const r = await createCheckout({ items: checkoutItems(session.plan), customerName: 'Voice consultation', companyName: session.profile.store_name || undefined, note: `Voice consultation ${session.id}: ${session.profile.location || ''} ${session.profile.business_label || ''}`.trim() });
        session.checkout = r;
        return { body: { ok: true, demo: false, spoken_total: p.spoken_total, next_step: "Say the card checkout link is on their screen. Don't read the link aloud." } };
      } catch (err) {
        logger?.error?.(`[tools] checkout failed: ${err.message}`);
        return { error: true, body: { error: 'checkout_unavailable', ask: 'Say the checkout link could not be made right now and the plan stays on their screen.' } };
      }
    },

    async end_call(session) {
      session.va.endRequested = true;
      return { body: { ok: true, next_step: 'Say a short goodbye.' } };
    },
  };

  /**
   * @param {object} session  agent session (engine 'voice-agent')
   * @param {{call_id:string, name:string, arguments?:object, last_item_id?:string}} call
   * @param {{origin?:string}} ctx
   */
  async function run(session, { call_id, name, arguments: args = {}, last_item_id = null } = {}, { origin = '' } = {}) {
    const va = initVoiceAgent(session);
    const cached = call_id ? va.calls.find((c) => c.call_id === call_id) : null;
    if (cached) return cached.response;
    const before = va.state;
    const visible = toolNamesFor(before).includes(name);
    const h = handlers[name];
    let out;
    try {
      out = h ? await h(session, args && typeof args === 'object' ? args : {}, { lastItemId: last_item_id, origin }) : { error: true, body: { error: 'unknown_tool', ask: 'Carry on without that tool.' } };
    } catch (err) {
      logger?.error?.(`[tools] ${name}: ${err.stack || err}`);
      out = { error: true, body: { error: 'tool_failed', ask: 'Say something went wrong on our side and carry on.' } };
    }
    const changed = out.next && isState(out.next) ? setState(session, out.next) : false;
    const response = {
      result: JSON.stringify(out.body),
      is_error: Boolean(out.error),
      state: va.state,
      step: session.step,
      state_changed: changed,
      session_update: sessionUpdateFor(va.state),
      end_session: name === 'end_call',
      ledger: session.ledger.snapshot(),
      plan: session.plan || null,
      checkout: session.checkout || null,
      profile: session.profile,
    };
    va.calls.push({ call_id: call_id || null, name, arguments: args, last_item_id, visible, state_before: before, state_after: va.state, is_error: response.is_error, result: out.body, at: Date.now(), response });
    return response;
  }

  return { run, handlers };
}

/**
 * POST /heard: a final transcript. role 'owner' (default) is a transcript.user: it feeds the grounding check.
 * role 'agent' is a transcript.agent: if it says the pending amount, that row is marked read back.
 */
export function recordHeard(session, { item_id = null, text, at = null, via = 'voice-agent', role = 'owner' } = {}) {
  const clean = String(text || '').trim().slice(0, 2000);
  if (!clean) return { ok: false, error: 'text required' };
  const now = Date.now();
  if (role === 'agent') {
    session.history.push({ role: 'agent', text: clean, at: now, source: 'voice-agent', item_id });
    const pending = session.ledger.pending();
    if (pending && pending.status === 'heard' && moneyValues(clean).includes(pending.value_krw)) session.ledger.markReadBack(pending.id, now);
    return { ok: true, role: 'agent' };
  }
  if (item_id && session.grounding.find(item_id)) return { ok: true, duplicate: true };
  // server clock for the 20 s window; the browser's time is kept for display only
  const turn = session.grounding.addHeard({ item_id, text: clean, at: now, via });
  session.history.push({ role: 'user', text: clean, at: now, meta: { item_id: turn.item_id, via, client_at: at } });
  return { ok: true, item_id: turn.item_id, heard: session.grounding.heard.length };
}
