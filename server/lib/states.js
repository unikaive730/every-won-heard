/**
 * The five stages of a Voice Agent call (design 6-3, progressive tool reveal).
 *
 *   s0 intake   shop type, neighborhood, main problem   tools: record_shop, end_call
 *   s1 budget   the monthly budget                       tools: record_budget, record_shop, end_call
 *   s2 confirm  read back and yes / no                   tools: confirm_budget, record_budget, end_call
 *   s3 plan     build the plan from the confirmed budget tools: build_plan, record_budget, end_call
 *   s4 commit   read the plan, checkout link             tools: create_checkout_link, record_budget, build_plan, end_call
 *
 * Each stage owns a narrow system prompt, a small tool list and a listening setting (input.keyterms,
 * input.transcription_prompt, input.transcription_mode). sessionUpdateFor(state) is the `session` object the
 * browser sends as {type: 'session.update', session}. The prompt and the tools always change together: the docs
 * warn that a prompt naming a hidden tool makes the model stall.
 *
 * No tool takes a number. Measured 2026-09-28 (docs/hackathon/23): a numeric amount argument makes the Voice Agent
 * API drop the tool call silently, whatever its JSON type. So record_budget takes the owner's words and the server
 * reads the amount (grounding.js); confirm_budget takes the owner's answer word; prices and totals come from the
 * catalog through build_plan.
 */
import { listenFor } from './listen.js';
import { greeting } from './agent.js';

export const STATE_IDS = ['s0', 's1', 's2', 's3', 's4'];

// the realtime path's step names (listen.js), so both paths show the same "Listening for" label
export const STEP_OF = { s0: 'intake', s1: 'budget', s2: 'confirm', s3: 'plan', s4: 'commit' };

export const BUSINESS_TYPES = ['cafe', 'restaurant', 'salon', 'clinic', 'fitness', 'academy', 'retail', 'lodging'];
export const MAIN_PROBLEMS = ['new_open', 'low_traffic', 'reviews', 'map_visibility', 'social_growth', 'repeat', 'press'];

export const TOOLS = {
  record_shop: {
    type: 'function',
    name: 'record_shop',
    description: "Call this as soon as the owner has said what kind of shop they run and which neighborhood it's in. Include the most urgent problem if they mentioned one. Do not call it for money.",
    parameters: {
      type: 'object',
      properties: {
        business_type: { type: 'string', enum: BUSINESS_TYPES, description: 'The kind of shop. A ramen, noodle or barbecue place is a restaurant.' },
        neighborhood: { type: 'string', description: 'The neighborhood or area, as the owner said it.', examples: ['Mangwon', 'Seongsu', 'Yeonnam'] },
        main_problem: { type: 'string', enum: MAIN_PROBLEMS, description: 'The most urgent problem. low_traffic: not enough customers or empty hours. new_open: opened recently. reviews: few reviews. map_visibility: hard to find on maps or search. social_growth: the photo social account. repeat: regulars do not come back. press: credibility.' },
      },
      required: ['business_type', 'neighborhood'],
    },
    execution_mode: 'interactive',
    timeout_seconds: 10,
  },
  record_budget: {
    type: 'function',
    name: 'record_budget',
    description: 'Call this right after the owner says any monthly marketing budget, including a corrected one or a range. Pass only the owner\'s words; the tool reads the amount and tells you what to say. Do not call it for prices, totals or discounts.',
    parameters: {
      type: 'object',
      properties: {
        owner_words: { type: 'string', description: "The owner's words for the amount, copied exactly as you heard them." },
        period: { type: 'string', enum: ['monthly', 'one_time'], description: 'monthly unless the owner says it is a one-time amount.' },
      },
      required: ['owner_words', 'period'],
    },
    execution_mode: 'interactive',
    timeout_seconds: 10,
  },
  confirm_budget: {
    type: 'function',
    name: 'confirm_budget',
    description: 'Call this when the owner answers your read-back of the budget with yes or no. Do not call it before you have read the amount back.',
    parameters: {
      type: 'object',
      properties: {
        answer: { type: 'string', enum: ['yes', 'no'], description: "The owner's answer to the read-back." },
      },
      required: ['answer'],
    },
    execution_mode: 'interactive',
    timeout_seconds: 10,
  },
  build_plan: {
    type: 'function',
    name: 'build_plan',
    description: 'Call this once the budget is confirmed, to get the priced 30-day plan from the catalog. It takes no input. Never describe a plan without its result.',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'interactive',
    timeout_seconds: 10,
  },
  create_checkout_link: {
    type: 'function',
    name: 'create_checkout_link',
    description: 'Call this when the owner says go ahead, yes, or asks to pay for the plan you read. It puts a card checkout link on their screen. It takes no input.',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'interactive',
    timeout_seconds: 10,
  },
  end_call: {
    type: 'function',
    name: 'end_call',
    description: 'Call this when the owner says goodbye or wants to stop, after your short goodbye.',
    parameters: { type: 'object', properties: {} },
    execution_mode: 'interactive',
    timeout_seconds: 10,
  },
};

const TOOLS_BY_STATE = {
  s0: ['record_shop', 'end_call'],
  s1: ['record_budget', 'record_shop', 'end_call'],
  s2: ['confirm_budget', 'record_budget', 'end_call'],
  s3: ['build_plan', 'record_budget', 'end_call'],
  s4: ['create_checkout_link', 'record_budget', 'build_plan', 'end_call'],
};

// common part of every stage (design 6-3), then the stage focus
export const COMMON_PROMPT = [
  'You are a marketing consultant from MarketPilot on a voice call with a small shop owner in Korea.',
  'Keep every reply to one or two short sentences. Ask one question at a time.',
  'Never name apps or platforms. Say "map listing", "photo social account", "messenger channel".',
  'NEVER say a price, total, quantity or budget unless that exact value came from a tool result in this call.',
  "If you haven't seen a tool result, you don't have the number. Don't estimate. Don't say \"around\" a number.",
  'When in doubt, call the tool. A wasted call is fine. A wrong number is not.',
  "You can't give discounts. If asked, say you can only use catalog prices and can fit the plan to a smaller budget.",
  'When a tool result has an "ask" or "next_step", do that next.',
  'When the owner says goodbye, say a short goodbye and call end_call.',
].join('\n');

const STAGE_PROMPT = {
  s0: [
    'Stage: intake.',
    "Find out what kind of shop it is, which neighborhood it's in, and the most urgent problem.",
    'As soon as you know the kind of shop and the neighborhood, call record_shop. Include main_problem if the owner mentioned one.',
    "Don't ask about money yet.",
  ],
  s1: [
    'Stage: budget.',
    'Ask for the monthly marketing budget in won. Whenever the owner says any amount, even a range,',
    "call record_budget with the owner's words. The tool decides whether the amount is usable.",
    'If the tool returns options, ask which one to plan for, using the spoken options.',
    'Example:',
    'Owner: "Maybe 4 or 500,000 won a month."',
    'You: [call record_budget with owner_words "4 or 500,000 won a month"] (result: ambiguous_amount, options four hundred thousand and five hundred thousand won)',
    'You: "Which one should I plan for, four hundred thousand or five hundred thousand won?"',
    'Owner: "480,000 won a month."',
    'You: [call record_budget with owner_words "480,000 won a month"]',
  ],
  s2: [
    'Stage: confirm.',
    'Read back the read_back words from the last record_budget result, word for word, and ask if that is right.',
    'When the owner answers yes or no, call confirm_budget with the answer.',
    "If the owner says a different amount instead, call record_budget with the owner's words.",
  ],
  s3: [
    'Stage: plan.',
    'The budget is confirmed. Call build_plan now, then read the plan from its result.',
    "If the owner says a new amount, call record_budget with the owner's words.",
  ],
  s4: [
    'Stage: plan ready.',
    "Read the plan from the build_plan result: each line's spoken text, then the spoken total. Keep it short.",
    'Then ask if they want the card checkout link.',
    'If the owner says go ahead, yes, or asks to pay, call create_checkout_link. The link appears on their screen.',
    "If the owner gives a new budget amount at any point, call record_budget with the owner's words and read back the new amount. Don't read the old plan again.",
  ],
};

// what the owner is talking about at each step: context for speech-to-text, not instructions (max 1750 chars)
const TRANSCRIPTION_PROMPT = {
  intake: 'A small shop owner in Seoul describes the business: what kind of shop, the neighborhood (Korean place names such as Mangwon, Seongsu, Yeonnam, Hapjeong) and what is going wrong.',
  budget: 'The owner says a monthly marketing budget in Korean won, usually hundreds of thousands of won, sometimes in man won (ten thousand won). They may give a range or correct themselves.',
  confirm: 'The owner answers yes or no to a read-back of a monthly budget in Korean won, or corrects the amount.',
  plan: 'The owner reacts to a marketing plan: map listing audit, press release, flyer, blog posts, photo retouching. They may change the budget in won or ask for a discount.',
  commit: 'The owner decides whether to go ahead and pay for a marketing plan, or changes the budget in won.',
};

export function isState(s) {
  return STATE_IDS.includes(s);
}

export function toolNamesFor(state) {
  return [...(TOOLS_BY_STATE[state] || TOOLS_BY_STATE.s0)];
}

export function toolsFor(state) {
  return toolNamesFor(state).map((n) => TOOLS[n]);
}

export function systemPromptFor(state) {
  return `${COMMON_PROMPT}\n\n${(STAGE_PROMPT[state] || STAGE_PROMPT.s0).join('\n')}`;
}

/** Listening setting: key terms from listen.js (no brand names), a context prompt, max_accuracy while money is said. */
export function inputFor(state) {
  const step = STEP_OF[state] || 'intake';
  const l = listenFor(step, 'en');
  return { keyterms: l.keyterms_prompt, transcription_prompt: TRANSCRIPTION_PROMPT[step], transcription_mode: l.mode };
}

/** The `session` object of a mid-call session.update: tools, system prompt and listening setting together. */
export function sessionUpdateFor(state) {
  const s = isState(state) ? state : 's0';
  return { system_prompt: systemPromptFor(s), tools: toolsFor(s), input: inputFor(s) };
}

export const VOICE = 'alba';
export const AGENT_NAME = 'Every Won Heard';

/** First session.update for an inline (not stored) session: s0 plus the fields that are fixed once the session is ready. */
export function inlineSessionFor(state = 's0', { voice = VOICE } = {}) {
  return { ...sessionUpdateFor(state), greeting: greeting('en'), output: { voice } };
}

/**
 * Request body for POST /v1/agents (and PUT /v1/agents/{id}): the s0 stage. Stored tools carry no `type` and no
 * `http` block (a tool without `http` is client-handled). No keys in here: the file is committed.
 */
export function storedAgentBody({ name = AGENT_NAME, voice = VOICE } = {}) {
  const s = sessionUpdateFor('s0');
  return {
    name,
    system_prompt: s.system_prompt,
    greeting: greeting('en'),
    voice: { voice_id: voice },
    input: s.input,
    tools: s.tools.map(({ type, ...rest }) => rest),
  };
}

/**
 * The first session.update for a call. A stored agent is bound by {agent_id} alone (mutually exclusive with inline
 * fields); without one, the whole s0 config goes inline.
 */
export function firstSessionUpdate({ agentId = null, voice = VOICE } = {}) {
  return agentId ? { agent_id: agentId } : inlineSessionFor('s0', { voice });
}
