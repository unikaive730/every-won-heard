/**
 * What the realtime (Universal-3.6 Pro streaming) path listens for at each step of the call (design 6-6).
 * The browser sends this as one UpdateConfiguration right before the agent reads its next line:
 *
 *   agent_context    the line the agent is about to say (the question the owner will answer), max 1750 chars
 *   keyterms_prompt  vocabulary for this step (max 100 terms, 50 chars each). No brand names.
 *   mode             max_accuracy while money is being said, balanced otherwise
 *
 * Measured 2026-09-28 (docs/hackathon/22_korean.md): 3.6 Pro accepts all three mid-session without an
 * acknowledgement message, and closes the session (error 3006) on an invalid value. So the limits are
 * enforced here and again in the browser before sending.
 */

export const STEPS = ['intake', 'budget', 'confirm', 'plan', 'commit'];

const KEYTERMS = {
  ko: {
    intake: ['망원', '망원시장', '성수', '성수동', '연남', '연남동', '합정', '상수', '홍대', '을지로', '익선동', '서촌', '문래', '한남', '연희동', '라멘집', '브런치 카페', '네일숍', '필라테스'],
    budget: ['만 원', '십만 원', '백만 원', '한 달', '월 예산', '부가세'],
    plan: ['체험단', '보도자료', '전단지', '포스터', '사진 보정', '진단 보고서', '지도 매장정보', '블로거'],
  },
  en: {
    intake: ['Mangwon', 'Mangwon Market', 'Seongsu', 'Yeonnam', 'Hapjeong', 'Hongdae', 'Euljiro', 'ramen', 'brunch'],
    budget: ['won', 'man won', 'thousand won', 'a month'],
    plan: ['press release', 'flyer', 'blog post', 'listing audit', 'retouching'],
  },
};

export const LIMITS = { agentContext: 1750, keyterms: 100, keytermChars: 50 };

function termsFor(step, lang) {
  const k = KEYTERMS[lang === 'ko' ? 'ko' : 'en'];
  if (step === 'budget' || step === 'confirm') return k.budget;
  if (step === 'plan' || step === 'commit') return k.plan;
  return k.intake;
}

/**
 * @param {string} step  one of STEPS
 * @param {'ko'|'en'} lang
 * @param {string} agentText  what the agent is about to say
 */
export function listenFor(step, lang, agentText = '') {
  const s = STEPS.includes(step) ? step : 'intake';
  const text = String(agentText || '').trim();
  return {
    step: s,
    agent_context: text.length > LIMITS.agentContext ? text.slice(-LIMITS.agentContext) : text,
    keyterms_prompt: termsFor(s, lang).filter((t) => t.length <= LIMITS.keytermChars).slice(0, LIMITS.keyterms),
    mode: s === 'budget' || s === 'confirm' ? 'max_accuracy' : 'balanced',
  };
}
