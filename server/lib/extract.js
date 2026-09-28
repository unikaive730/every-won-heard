/**
 * Rule-based slot extraction from what the owner said (Korean or English).
 * Pure functions, no dependencies. Used as the always-available fallback when
 * no LLM key is configured, and as a cross-check when there is one.
 *
 * Profile shape (all optional until heard):
 * {
 *   business_type: 'cafe' | 'restaurant' | 'salon' | 'clinic' | 'fitness' | 'academy' | 'ecommerce' | 'app' | 'franchise' | 'lodging' | 'retail',
 *   business_label: string,           // label in the session language
 *   location: string,                 // e.g. '강남', 'Gangnam'
 *   budget_krw: number,               // monthly marketing budget in KRW
 *   budget_raw: string,
 *   problems: string[],               // problem keys, see PROBLEMS
 *   channels_tried: string[],
 *   language: 'ko' | 'en'
 * }
 */

export const LOCAL_TYPES = new Set(['cafe', 'restaurant', 'salon', 'clinic', 'fitness', 'academy', 'lodging', 'retail', 'franchise']);

export const BUSINESS_TYPES = [
  { key: 'cafe', ko: '카페', en: 'cafe', patterns: [/카페|커피|디저트|베이커리|빵집|브런치/, /\bcaf[eé]\b|coffee|bakery|dessert|brunch/i] },
  { key: 'restaurant', ko: '음식점', en: 'restaurant', patterns: [/음식점|식당|고깃집|삼겹살|치킨|피자|분식|횟집|국밥|맛집|주점|술집|포차|이자카야|파스타|초밥|라멘|족발|곱창|한식|중식|일식|양식/, /restaurant|diner|\bbbq\b|chicken|pizza|noodle|bistro|\bbar\b|\bpub\b|eatery|sushi|ramen|grill|kitchen/i] },
  { key: 'salon', ko: '미용실', en: 'hair salon', patterns: [/미용실|헤어|네일|속눈썹|왁싱|피부관리|에스테틱|이발/, /salon|hair|nail|lash|waxing|\bspa\b|esthetic|barber/i] },
  { key: 'clinic', ko: '병원', en: 'clinic', patterns: [/병원|의원|치과|피부과|한의원|성형|정형외과|안과|내과|소아과/, /clinic|hospital|dental|dentist|dermatolog|plastic surgery|doctor|medical/i] },
  { key: 'fitness', ko: '헬스장', en: 'gym', patterns: [/헬스|피트니스|필라테스|요가|\bPT\b|크로스핏|수영장|복싱|골프연습장/i, /\bgym\b|fitness|pilates|yoga|crossfit|personal training|boxing|golf/i] },
  { key: 'ecommerce', ko: '온라인 쇼핑몰', en: 'online store', patterns: [/쇼핑몰|스마트스토어|온라인|자사몰|쿠팡|셀러|온라인 ?판매|네이버 ?스토어|오픈마켓/, /online (store|shop|business)|e-?commerce|shopify|smart ?store|coupang|seller|marketplace|\bdtc\b/i] },
  // note: \b does not work next to Hangul (not \w), so Korean patterns avoid word boundaries
  { key: 'app', ko: '앱 서비스', en: 'app', patterns: [/앱|어플|플랫폼|스타트업|SaaS|서비스 ?런칭/i, /\bapps?\b|application|platform|startup|saas|software/i] },
  { key: 'academy', ko: '학원', en: 'academy', patterns: [/학원|과외|교습소|공부방|영어학원|수학학원|음악학원|어학원/, /academy|tutoring|\bschool\b|lesson|classes/i] },
  { key: 'franchise', ko: '프랜차이즈', en: 'franchise', patterns: [/프랜차이즈|가맹|본사/, /franchise/i] },
  { key: 'lodging', ko: '숙박업', en: 'lodging', patterns: [/펜션|숙소|호텔|게스트하우스|모텔|에어비앤비|민박/, /pension|hotel|guesthouse|airbnb|lodging|motel|\bstay\b/i] },
  { key: 'retail', ko: '매장', en: 'retail shop', patterns: [/꽃집|편의점|옷가게|의류|소품샵|문구|마트|매장|가게|공방|서점/, /flower|boutique|retail|\bstore\b|\bshop\b|grocery/i] },
];

const KO_AREAS = ['강남', '서초', '송파', '잠실', '홍대', '합정', '마포', '성수', '건대', '신촌', '이태원', '용산', '종로', '명동', '을지로', '여의도', '영등포', '노원', '강북', '강서', '목동', '판교', '분당', '수원', '용인', '일산', '고양', '김포', '부천', '안양', '인천', '부산', '해운대', '서면', '대구', '대전', '광주', '울산', '세종', '제주', '서귀포', '천안', '청주', '전주', '창원', '포항', '춘천', '강릉', '속초', '경주', '여수', '순천', '구미', '서울', '동탄', '광교', '위례', '하남', '구리', '남양주', '의정부', '평택', '오산', '화성', '안산', '시흥', '성남', '역삼', '삼성동', '논현', '압구정', '청담', '신사', '가로수길', '연남', '망원', '상수', '문래', '익선동', '북촌', '서촌', '한남'];
export const EN_AREAS = { gangnam: '강남', seocho: '서초', songpa: '송파', jamsil: '잠실', hongdae: '홍대', hapjeong: '합정', mapo: '마포', seongsu: '성수', konkuk: '건대', sinchon: '신촌', itaewon: '이태원', yongsan: '용산', jongno: '종로', myeongdong: '명동', yeouido: '여의도', pangyo: '판교', bundang: '분당', suwon: '수원', yongin: '용인', ilsan: '일산', incheon: '인천', busan: '부산', haeundae: '해운대', daegu: '대구', daejeon: '대전', gwangju: '광주', ulsan: '울산', sejong: '세종', jeju: '제주', seoul: '서울', gangbuk: '강북', hannam: '한남', apgujeong: '압구정', cheongdam: '청담', yeonnam: '연남', mangwon: '망원' };

export const PROBLEMS = [
  { key: 'new_open', ko: '신규 오픈', en: 'just opened', patterns: [/오픈|개업|새로 (차|열|시작)|창업|런칭|출시/, /just opened|new(ly)? open|opening|launch(ed|ing)?|just started|brand new/i] },
  { key: 'low_traffic', ko: '손님·매출 부족', en: 'not enough customers', patterns: [/손님[이은도]?.{0,6}?(없|안 ?[와오]|적|줄)|매출[이은도]?.{0,6}?(떨어|줄|안 ?나|없)|한산|텅 ?비|사람[이은]?.{0,4}?없|장사가 ?안|(평일|주말|점심|저녁|오전|오후|낮|밤)[^.?!]{0,10}?(비어|비고|비는|비었|한가)/,/no customers|not enough (customers|traffic|people|foot traffic)|slow|empty|sales (are |have )?(down|drop|fall)|fewer customers|nobody comes|dead/i] },
  { key: 'reviews', ko: '리뷰 부족', en: 'few reviews', patterns: [/리뷰|후기|별점|평점|영수증/, /review|rating|stars/i] },
  { key: 'place_rank', ko: '지도·검색 노출', en: 'search / map visibility', patterns: [/플레이스|지도|노출|순위|검색(에|해도)? ?안|상위|랭킹|검색/, /naver place|google maps?|ranking|\brank\b|search results|visib|show(s|ing)? up|discover/i] },
  { key: 'instagram', ko: '사진 SNS 성장', en: 'photo social growth', patterns: [/인스타|팔로워|릴스|SNS|틱톡|유튜브/i, /instagram|followers|reels|social media|tiktok|youtube/i] },
  { key: 'competition', ko: '경쟁 심화', en: 'competition', patterns: [/경쟁|옆집|주변에 ?(많|생)|근처에 ?(많|생)/, /compet|rival|next door/i] },
  { key: 'delivery', ko: '배달 매출', en: 'delivery orders', patterns: [/배달|배민|쿠팡이츠|요기요/, /delivery|baemin|coupang eats|takeout/i] },
  { key: 'repeat', ko: '재방문·단골', en: 'repeat customers', patterns: [/단골|재방문|재구매|멤버십|카카오 ?채널|쿠폰/, /repeat|loyal|retention|regulars|come back|membership|coupon/i] },
  { key: 'press', ko: '브랜드 신뢰', en: 'brand credibility', patterns: [/기사|언론|보도|신뢰|브랜딩|인지도/, /press|news|article|\bpr\b|credib|brand(ing)?|awareness/i] },
  { key: 'app_growth', ko: '앱 다운로드·가입', en: 'app installs / signups', patterns: [/다운로드|설치|가입자|유저|사용자/, /download|install|sign-?ups?|users|mau|dau/i] },
  { key: 'foreign', ko: '외국인 고객', en: 'foreign customers', patterns: [/외국인|관광객|중국인|일본인/, /foreign|tourist|chinese|japanese/i] },
];

const CHANNELS_TRIED = [
  { key: 'blog', patterns: [/블로그/, /blog/i] },
  { key: 'instagram', patterns: [/인스타/, /instagram/i] },
  { key: 'paid_ads', patterns: [/광고/, /\bads?\b|advertis|paid/i] },
  { key: 'flyers', patterns: [/전단|현수막/, /flyer|banner|leaflet/i] },
  { key: 'naver_place', patterns: [/플레이스/, /naver place/i] },
  { key: 'delivery_apps', patterns: [/배민|쿠팡이츠|요기요/, /baemin|coupang eats/i] },
];
const TRIED_MARKERS = [/해 ?봤|해봤|했는데|했었|돌려 ?봤|써 ?봤|해 ?보고/, /tried|already|used to|did some|ran (some|a few)|been doing/i];

export const USD_TO_KRW = 1350; // rough conversion used only for estimates; the UI labels it as approximate

export function detectLanguage(text) {
  const s = String(text || '');
  const hangul = (s.match(/[가-힣]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (hangul === 0 && latin === 0) return 'en';
  return hangul >= latin ? 'ko' : 'en';
}

function matchAny(patterns, text) {
  return patterns.some((re) => re.test(text));
}

export function extractBusinessType(text) {
  for (const bt of BUSINESS_TYPES) {
    if (matchAny(bt.patterns, text)) return bt.key;
  }
  return null;
}

export function businessLabel(key, lang = 'ko') {
  const bt = BUSINESS_TYPES.find((b) => b.key === key);
  if (!bt) return key || '';
  return lang === 'ko' ? bt.ko : bt.en;
}

export function extractLocation(text) {
  const s = String(text || '');
  // generic: "XX동에", "XX역 근처", "XX구에서"
  const m = s.match(/([가-힣]{2,6}(?:역|동|구|시|읍|면))\s*(?:에서|에|근처|앞|쪽|이에요|입니다|이고|인데|이요)?/);
  for (const area of KO_AREAS) {
    if (s.includes(area)) {
      // "역삼동" is more useful than "역삼" for blog keywords; "강남역" stays "강남"
      if (m && m[1].startsWith(area) && m[1].endsWith('동')) return m[1];
      return area;
    }
  }
  const lower = s.toLowerCase();
  for (const [en, ko] of Object.entries(EN_AREAS)) {
    if (new RegExp(`\\b${en}\\b`).test(lower)) return ko;
  }
  if (m) return m[1];
  const em = s.match(/\bin\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
  if (em) return em[1];
  return null;
}

const KO_UNITS = { 억: 100_000_000, 천만: 10_000_000, 백만: 1_000_000, 십만: 100_000, 만: 10_000, 천: 1_000 };

/**
 * Parse a marketing budget. Returns { amount_krw, raw, currency, period } or null.
 * Handles: "월 30만원", "300만 원", "1,000,000원", "50만", "$500", "500 dollars", "300,000 won", "1 million won", "2k".
 */
export function extractBudget(text) {
  const s = String(text || '').replace(/\s+/g, ' ');
  const period = /월|매달|한 ?달|monthly|per month|a month|\/mo/i.test(s) ? 'monthly' : 'unspecified';

  // Korean units: 30만원 / 300만 원 / 1.5천만원 / 50만 (only when followed by 원 or a budget word nearby)
  let m = s.match(/(\d+(?:[.,]\d+)?)\s*(억|천만|백만|십만|만|천)\s*(원|정도|쯤|까지|이내|정도요)?/);
  if (m && (m[3] || /예산|비용|돈|쓸|투자|정도/.test(s))) {
    const n = parseFloat(m[1].replace(',', '.'));
    const amt = Math.round(n * KO_UNITS[m[2]]);
    if (amt >= 10_000) return { amount_krw: amt, raw: m[0].trim(), currency: 'KRW', period };
  }
  // Plain KRW with digits: 1,000,000원 / 300000 원 / 300,000 won / 300k won / 1 million won
  m = s.match(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*(원|won|krw)/i);
  if (m) return { amount_krw: parseInt(m[1].replace(/,/g, ''), 10), raw: m[0].trim(), currency: 'KRW', period };
  m = s.match(/(\d+(?:\.\d+)?)\s*(k|thousand|m|million)\s*(won|krw)/i);
  if (m) {
    const mult = /^(k|thousand)$/i.test(m[2]) ? 1_000 : 1_000_000;
    return { amount_krw: Math.round(parseFloat(m[1]) * mult), raw: m[0].trim(), currency: 'KRW', period };
  }
  // USD: $500 / 500 dollars / 1.2k dollars / $2k
  m = s.match(/\$\s?(\d+(?:[.,]\d+)?)\s*(k|thousand|m|million)?/i) || s.match(/(\d+(?:[.,]\d+)?)\s*(k|thousand|m|million)?\s*(dollars?|usd|bucks)/i);
  if (m) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) n *= /^(k|thousand)$/i.test(m[2]) ? 1_000 : 1_000_000;
    return { amount_krw: Math.round(n * USD_TO_KRW), raw: m[0].trim(), currency: 'USD', usd: n, period };
  }
  return null;
}

export function extractProblems(text) {
  const s = String(text || '');
  return PROBLEMS.filter((p) => matchAny(p.patterns, s)).map((p) => p.key);
}

export function problemLabel(key, lang = 'ko') {
  const p = PROBLEMS.find((x) => x.key === key);
  if (!p) return key;
  return lang === 'ko' ? p.ko : p.en;
}

export function extractChannelsTried(text) {
  const s = String(text || '');
  if (!matchAny(TRIED_MARKERS, s)) return [];
  return CHANNELS_TRIED.filter((c) => matchAny(c.patterns, s)).map((c) => c.key);
}

/** Extract every slot we can from one utterance. */
export function extractSlots(text) {
  const language = detectLanguage(text);
  const business_type = extractBusinessType(text);
  const budget = extractBudget(text);
  return {
    language,
    business_type,
    business_label: business_type ? businessLabel(business_type, language) : null,
    location: extractLocation(text),
    budget_krw: budget ? budget.amount_krw : null,
    budget_raw: budget ? budget.raw : null,
    budget_currency: budget ? budget.currency : null,
    problems: extractProblems(text),
    channels_tried: extractChannelsTried(text),
  };
}

export function emptyProfile(language = 'ko') {
  return {
    language,
    business_type: null,
    business_label: null,
    location: null,
    budget_krw: null,
    budget_raw: null,
    budget_currency: null,
    problems: [],
    channels_tried: [],
    store_name: null,
    place: null, // Naver Place match from MCP search_places
  };
}

/** Merge newly heard slots into the profile. Scalars fill empty fields only; lists are unioned. */
export function mergeProfile(profile, slots, { overwrite = false } = {}) {
  const out = { ...profile };
  for (const k of ['business_type', 'business_label', 'location', 'budget_krw', 'budget_raw', 'budget_currency', 'store_name']) {
    if (slots[k] != null && slots[k] !== '' && (overwrite || out[k] == null)) out[k] = slots[k];
  }
  if (slots.business_type && out.business_type === slots.business_type && !out.business_label) {
    out.business_label = businessLabel(slots.business_type, out.language);
  }
  for (const k of ['problems', 'channels_tried']) {
    const set = new Set([...(out[k] || []), ...((slots[k] || []).filter(Boolean))]);
    out[k] = [...set];
  }
  return out;
}

/** Which required slot is still missing, in the order we ask. */
export function nextMissingSlot(profile) {
  if (!profile.business_type) return 'business_type';
  if (LOCAL_TYPES.has(profile.business_type) && !profile.location) return 'location';
  if (!profile.budget_krw) return 'budget';
  if (!profile.problems || profile.problems.length === 0) return 'problem';
  return null;
}
