/**
 * Turn an AssemblyAI pre-recorded transcript (with speaker labels, sentiment, key phrases,
 * entities) into an "owner brief": who spoke, what the owner actually complained about,
 * the key phrases they used, and the concrete facts (places, money, organizations) they named.
 *
 * Works with partial data: sentiment / key phrases are English-only on AssemblyAI, so for
 * Korean sessions we fall back to keyword rules and frequency-based phrases.
 */
import { extractProblems, problemLabel, detectLanguage } from './extract.js';

const KO_STOP = new Set(['그리고', '그런데', '근데', '저는', '제가', '저희', '우리', '이제', '지금', '좀', '많이', '너무', '진짜', '정말', '그냥', '이거', '그거', '거기', '여기', '있어요', '없어요', '해요', '했어요', '하는데', '해서', '그래서', '근데요', '네', '예', '아니', '음', '어', '이게', '그게', '뭐', '것', '수', '등', '더', '또', '한', '그', '이', '저', '안', '못', '요', '입니다', '있습니다', '합니다', '싶어요', '같아요', '거예요', '건데', '이에요', '예요']);
const EN_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'so', 'i', 'we', 'you', 'it', 'is', 'are', 'was', 'were', 'be', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'my', 'our', 'your', 'this', 'that', 'these', 'those', 'have', 'has', 'had', 'do', 'does', 'did', 'not', 'just', 'like', 'really', 'very', 'um', 'uh', 'yeah', 'okay', 'ok', 'about', 'there', 'here', 'from', 'as', 'me', 'us', 'they', 'them', 'its', "it's", "i'm", "we're", "don't", 'can', 'get', 'got', 'also', 'more', 'some', 'any', 'want', 'need', 'think', 'know']);

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

/** Frequency-based phrases when AssemblyAI key phrases are not available (Korean). */
export function fallbackKeyPhrases(text, lang, limit = 8) {
  const stop = lang === 'ko' ? KO_STOP : EN_STOP;
  const tokens = String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stop.has(w) && !/^\d+$/.test(w));
  const counts = new Map();
  for (const w of tokens) counts.set(w, (counts.get(w) || 0) + 1);
  // bigrams too
  for (let i = 0; i < tokens.length - 1; i++) {
    const bg = `${tokens[i]} ${tokens[i + 1]}`;
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([w, c]) => c >= 2 || w.includes(' ') === false)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([text, count]) => ({ text, count, rank: count }));
}

/**
 * @param {object} transcript AssemblyAI transcript JSON (status 'completed')
 * @param {{lang?:string, agentTexts?:string[]}} opts agentTexts: what our TTS said, to filter echo
 */
export function buildBrief(transcript, { lang, agentTexts = [] } = {}) {
  const text = transcript?.text || '';
  const language = lang || transcript?.language_code?.slice(0, 2) || detectLanguage(text);
  const utterances = Array.isArray(transcript?.utterances) && transcript.utterances.length
    ? transcript.utterances
    : text ? [{ speaker: 'A', text, start: 0, end: transcript?.audio_duration ? transcript.audio_duration * 1000 : 0 }] : [];

  // speakers by word share
  const bySpeaker = new Map();
  for (const u of utterances) {
    const s = u.speaker || 'A';
    const cur = bySpeaker.get(s) || { label: s, words: 0, turns: 0 };
    cur.words += wordCount(u.text);
    cur.turns += 1;
    bySpeaker.set(s, cur);
  }
  const totalWords = [...bySpeaker.values()].reduce((a, b) => a + b.words, 0) || 1;
  const agentSet = new Set(agentTexts.map((t) => t.trim().toLowerCase()).filter(Boolean));
  // a speaker whose utterances mostly match our TTS lines is the agent echo, not the owner
  const echoScore = new Map();
  for (const u of utterances) {
    const s = u.speaker || 'A';
    const hit = agentSet.has(String(u.text || '').trim().toLowerCase()) ? 1 : 0;
    echoScore.set(s, (echoScore.get(s) || 0) + hit);
  }
  const speakers = [...bySpeaker.values()]
    .map((s) => ({ ...s, share: s.words / totalWords, likely_agent_echo: (echoScore.get(s.label) || 0) >= Math.max(1, s.turns / 2) }))
    .sort((a, b) => b.words - a.words);
  const owner = speakers.find((s) => !s.likely_agent_echo) || speakers[0] || null;
  const ownerLabel = owner ? owner.label : null;
  const ownerUtterances = utterances.filter((u) => (u.speaker || 'A') === ownerLabel);

  // sentiment (English only on AssemblyAI) -> concerns; otherwise keyword rules
  const sentiment = Array.isArray(transcript?.sentiment_analysis_results) ? transcript.sentiment_analysis_results : [];
  const mood = { positive: 0, neutral: 0, negative: 0 };
  for (const s of sentiment) {
    const k = String(s.sentiment || '').toLowerCase();
    if (k in mood) mood[k] += 1;
  }
  const concerns = [];
  if (sentiment.length) {
    for (const s of sentiment) {
      if (ownerLabel && s.speaker && s.speaker !== ownerLabel) continue;
      if (String(s.sentiment).toUpperCase() === 'NEGATIVE' && s.confidence >= 0.5) {
        concerns.push({ text: s.text, start: s.start, source: 'sentiment', confidence: s.confidence, problems: extractProblems(s.text) });
      }
    }
  }
  for (const u of ownerUtterances) {
    const probs = extractProblems(u.text);
    if (probs.length && !concerns.some((c) => c.text === u.text)) {
      concerns.push({ text: u.text, start: u.start, source: 'keywords', confidence: null, problems: probs });
    }
  }
  concerns.sort((a, b) => (a.start || 0) - (b.start || 0));

  // key phrases
  const hl = transcript?.auto_highlights_result?.results;
  const key_phrases = Array.isArray(hl) && hl.length
    ? [...hl].sort((a, b) => b.rank - a.rank).slice(0, 8).map((h) => ({ text: h.text, count: h.count, rank: h.rank }))
    : fallbackKeyPhrases(ownerUtterances.map((u) => u.text).join(' ') || text, language);

  // entities grouped by type
  const entities = {};
  for (const e of Array.isArray(transcript?.entities) ? transcript.entities : []) {
    const type = e.entity_type || 'other';
    (entities[type] = entities[type] || []).push(e.text);
  }
  for (const k of Object.keys(entities)) entities[k] = [...new Set(entities[k])];

  const problemKeys = [...new Set(concerns.flatMap((c) => c.problems))];
  return {
    language,
    duration_seconds: transcript?.audio_duration ?? null,
    speakers,
    owner_speaker: ownerLabel,
    owner_word_share: owner ? Number(owner.share.toFixed(2)) : null,
    concerns: concerns.slice(0, 6),
    problem_keys: problemKeys,
    problem_labels: problemKeys.map((k) => problemLabel(k, language)),
    key_phrases,
    entities,
    mood,
    features_used: {
      speaker_labels: Array.isArray(transcript?.utterances) && transcript.utterances.length > 0,
      sentiment_analysis: sentiment.length > 0,
      auto_highlights: Array.isArray(hl) && hl.length > 0,
      entity_detection: Array.isArray(transcript?.entities) && transcript.entities.length > 0,
    },
  };
}
