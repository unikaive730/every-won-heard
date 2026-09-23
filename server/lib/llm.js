/**
 * Optional LLM layer (Anthropic SDK). Reads LLM_API_KEY (never the production MarketPilot key).
 * When there is no key, createLlm() returns null and the agent runs on rules only.
 *
 * One call per user turn, structured JSON output, low effort (a voice agent needs speed, not deliberation).
 * Prices and product names are never produced here; the planner takes them from the catalog.
 */
import Anthropic from '@anthropic-ai/sdk';
import { BUSINESS_TYPES, PROBLEMS } from './extract.js';

export const DEFAULT_MODEL = 'claude-opus-5';

export const AGENT_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'What the consultant says next, spoken style, 1-2 short sentences and at most one question. Same language as the owner.' },
    profile: {
      type: 'object',
      properties: {
        business_type: { type: ['string', 'null'], enum: [...BUSINESS_TYPES.map((b) => b.key), null] },
        location: { type: ['string', 'null'] },
        budget_krw: { type: ['integer', 'null'], description: 'Monthly marketing budget in KRW. Convert USD at 1350.' },
        problems: { type: 'array', items: { type: 'string', enum: PROBLEMS.map((p) => p.key) } },
        store_name: { type: ['string', 'null'] },
      },
      required: ['business_type', 'location', 'budget_krw', 'problems', 'store_name'],
      additionalProperties: false,
    },
    ready_for_plan: { type: 'boolean', description: 'true when business type, budget and the main problem are known (and location for a physical store), or the owner asks for the plan.' },
    owner_confirmed_plan: { type: 'boolean', description: 'true only if a plan was already presented and the owner just agreed to proceed.' },
  },
  required: ['reply', 'profile', 'ready_for_plan', 'owner_confirmed_plan'],
  additionalProperties: false,
};

export function buildSystemPrompt({ lang = 'ko', catalogSummary = '' } = {}) {
  const langLine = lang === 'ko'
    ? 'The owner speaks Korean. Reply in natural spoken Korean (존댓말, 사장님 호칭), short sentences that sound good when read aloud.'
    : 'The owner speaks English. Reply in natural spoken English, short sentences that sound good when read aloud.';
  return [
    'You are MarketPilot\'s voice marketing consultant for Korean small business owners (cafes, restaurants, salons, clinics, gyms, online sellers, apps).',
    'You are on a live voice call. Speech-to-text may contain small errors; interpret generously.',
    langLine,
    'Goal of the call: learn (1) business type, (2) location for physical stores, (3) monthly marketing budget, (4) the most urgent problem. Ask for ONE missing item per turn. Acknowledge what you just heard in a few words before asking.',
    'Never invent prices, product names or results. The planner attaches the priced plan from the real catalog after you set ready_for_plan=true; you may then say the plan is on screen and ask if it works.',
    'If the owner says the plan is fine ("진행", "go ahead", "yes"), set owner_confirmed_plan=true and tell them the checkout link button is on screen.',
    'Keep replies under 45 words. No lists, no markdown, no emojis.',
    catalogSummary ? `Channels available in the catalog: ${catalogSummary}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * @param {{apiKey?:string, model?:string, client?:object, logger?:object}} opts  client: injectable for tests
 */
export function createLlm({ apiKey = process.env.LLM_API_KEY || '', model = process.env.LLM_MODEL || DEFAULT_MODEL, client = null, logger = console } = {}) {
  if (!client && !(apiKey && apiKey.trim())) return null;
  const c = client || new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
  const state = { calls: 0, failures: 0, lastError: null, disabled: false };

  /**
   * @param {{lang:string, history:Array<{role:'user'|'agent', text:string}>, profile:object, catalogSummary?:string, planPresented?:boolean}} input
   * @returns {Promise<null|{reply:string, profile:object, ready_for_plan:boolean, owner_confirmed_plan:boolean}>}
   */
  async function agentTurn({ lang, history, profile, catalogSummary = '', planPresented = false }) {
    if (state.disabled) return null;
    const messages = [];
    for (const h of history) {
      const role = h.role === 'agent' ? 'assistant' : 'user';
      if (!messages.length && role === 'assistant') continue; // first message must be from the user
      messages.push({ role, content: h.text });
    }
    if (!messages.length) return null;
    const stateNote = `\n\n[state] known profile: ${JSON.stringify(profile)}; plan_presented: ${planPresented}`;
    const last = messages[messages.length - 1];
    if (last.role === 'user') last.content = `${last.content}${stateNote}`;
    else messages.push({ role: 'user', content: `(owner is silent)${stateNote}` });

    try {
      state.calls += 1;
      const res = await c.messages.create({
        model,
        max_tokens: 1024,
        system: buildSystemPrompt({ lang, catalogSummary }),
        messages,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: AGENT_OUTPUT_SCHEMA } },
      });
      if (res.stop_reason === 'refusal') {
        logger?.warn?.('[llm] refusal stop reason; falling back to rules');
        return null;
      }
      const text = (res.content || []).find((b) => b.type === 'text')?.text || '';
      const parsed = JSON.parse(text);
      if (typeof parsed.reply !== 'string' || typeof parsed.profile !== 'object') return null;
      return {
        reply: parsed.reply.trim(),
        profile: parsed.profile,
        ready_for_plan: Boolean(parsed.ready_for_plan),
        owner_confirmed_plan: Boolean(parsed.owner_confirmed_plan),
        usage: res.usage || null,
      };
    } catch (err) {
      state.failures += 1;
      state.lastError = String(err?.message || err);
      if (err instanceof Anthropic.AuthenticationError) {
        state.disabled = true; // a bad key will not get better; stop paying the latency
        logger?.error?.('[llm] authentication failed; LLM disabled for this process');
      } else if (err instanceof Anthropic.RateLimitError) {
        logger?.warn?.('[llm] rate limited; using rules for this turn');
      } else if (err instanceof Anthropic.APIError) {
        logger?.warn?.(`[llm] API error ${err.status}: ${err.message}`);
      } else {
        logger?.warn?.(`[llm] ${state.lastError}`);
      }
      return null;
    }
  }

  return { model, agentTurn, get state() { return { ...state }; } };
}
