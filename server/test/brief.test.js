import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBrief, fallbackKeyPhrases } from '../lib/brief.js';

const englishTranscript = {
  status: 'completed',
  language_code: 'en',
  audio_duration: 62,
  text: 'We opened a ramen shop in Hongdae two months ago. Weekdays are dead, nobody comes before six. We have maybe three reviews on Naver. Budget is around 400,000 won a month.',
  utterances: [
    { speaker: 'A', start: 0, end: 4000, text: 'Tell me about your business and where it is.' },
    { speaker: 'B', start: 4200, end: 12000, text: 'We opened a ramen shop in Hongdae two months ago.' },
    { speaker: 'B', start: 12100, end: 20000, text: 'Weekdays are dead, nobody comes before six.' },
    { speaker: 'B', start: 20100, end: 26000, text: 'We have maybe three reviews on Naver.' },
    { speaker: 'A', start: 26100, end: 29000, text: 'What is your monthly budget?' },
    { speaker: 'B', start: 29100, end: 34000, text: 'Budget is around 400,000 won a month.' },
  ],
  sentiment_analysis_results: [
    { text: 'We opened a ramen shop in Hongdae two months ago.', sentiment: 'NEUTRAL', confidence: 0.8, start: 4200, end: 12000, speaker: 'B' },
    { text: 'Weekdays are dead, nobody comes before six.', sentiment: 'NEGATIVE', confidence: 0.93, start: 12100, end: 20000, speaker: 'B' },
    { text: 'We have maybe three reviews on Naver.', sentiment: 'NEGATIVE', confidence: 0.61, start: 20100, end: 26000, speaker: 'B' },
    { text: 'Budget is around 400,000 won a month.', sentiment: 'NEUTRAL', confidence: 0.7, start: 29100, end: 34000, speaker: 'B' },
  ],
  auto_highlights_result: { status: 'success', results: [
    { text: 'ramen shop', count: 1, rank: 0.09, timestamps: [] },
    { text: 'weekdays', count: 1, rank: 0.07, timestamps: [] },
    { text: 'three reviews', count: 1, rank: 0.06, timestamps: [] },
  ] },
  entities: [
    { entity_type: 'location', text: 'Hongdae', start: 6000, end: 6500 },
    { entity_type: 'money_amount', text: '400,000 won', start: 30000, end: 31000 },
    { entity_type: 'organization', text: 'Naver', start: 24000, end: 24500 },
  ],
};

test('English brief: owner is the dominant speaker, negative sentences become concerns, entities grouped', () => {
  const b = buildBrief(englishTranscript, { lang: 'en', agentTexts: ['Tell me about your business and where it is.', 'What is your monthly budget?'] });
  assert.equal(b.owner_speaker, 'B');
  assert.ok(b.owner_word_share > 0.5);
  assert.equal(b.speakers.find((s) => s.label === 'A').likely_agent_echo, true);
  assert.equal(b.concerns.length, 2);
  assert.equal(b.concerns[0].source, 'sentiment');
  assert.ok(b.concerns[0].text.startsWith('Weekdays are dead'));
  assert.ok(b.problem_keys.includes('low_traffic'));
  assert.ok(b.problem_keys.includes('reviews'));
  assert.equal(b.key_phrases[0].text, 'ramen shop');
  assert.deepEqual(b.entities.location, ['Hongdae']);
  assert.deepEqual(b.entities.money_amount, ['400,000 won']);
  assert.deepEqual(b.mood, { positive: 0, neutral: 2, negative: 2 });
  assert.equal(b.features_used.sentiment_analysis, true);
  assert.equal(b.features_used.speaker_labels, true);
});

test('Korean brief: no sentiment/highlights from AssemblyAI -> keyword concerns and frequency phrases', () => {
  const ko = {
    status: 'completed',
    language_code: 'ko',
    audio_duration: 40,
    text: '성수동에서 카페를 하는데 손님이 너무 없어요. 리뷰도 거의 없고요. 월 30만원 정도 쓸 수 있어요. 리뷰가 제일 급해요.',
    utterances: [
      { speaker: 'A', start: 0, end: 9000, text: '성수동에서 카페를 하는데 손님이 너무 없어요.' },
      { speaker: 'A', start: 9100, end: 13000, text: '리뷰도 거의 없고요.' },
      { speaker: 'A', start: 13100, end: 18000, text: '월 30만원 정도 쓸 수 있어요.' },
      { speaker: 'A', start: 18100, end: 22000, text: '리뷰가 제일 급해요.' },
    ],
    entities: [{ entity_type: 'location', text: '성수동', start: 0, end: 500 }],
  };
  const b = buildBrief(ko, { lang: 'ko' });
  assert.equal(b.language, 'ko');
  assert.equal(b.owner_speaker, 'A');
  assert.ok(b.concerns.every((c) => c.source === 'keywords'));
  assert.ok(b.problem_keys.includes('low_traffic'));
  assert.ok(b.problem_keys.includes('reviews'));
  assert.ok(b.problem_labels.includes('리뷰 부족'));
  assert.ok(b.key_phrases.length > 0);
  assert.equal(b.features_used.sentiment_analysis, false);
  assert.equal(b.features_used.entity_detection, true);
});

test('brief tolerates a transcript with no utterances and no intelligence', () => {
  const b = buildBrief({ status: 'completed', text: 'hello there', language_code: 'en' });
  assert.equal(b.owner_speaker, 'A');
  assert.deepEqual(b.concerns, []);
  assert.deepEqual(b.entities, {});
});

test('fallbackKeyPhrases drops stopwords and prefers repeated terms', () => {
  const kp = fallbackKeyPhrases('리뷰가 없어요 리뷰가 급해요 그리고 손님이 없어요', 'ko', 3);
  assert.ok(kp.some((k) => k.text === '리뷰가'));
  assert.ok(!kp.some((k) => k.text === '그리고'));
});
