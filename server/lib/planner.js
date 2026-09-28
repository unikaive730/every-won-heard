/**
 * Deterministic marketing planner.
 * profile + product catalog -> priced product picks grouped into channels, inquiry-only items,
 * an action checklist, a short spoken summary and the numbers in words for the voice agent.
 * Prices always come from the catalog (live MarketPilot MCP or the snapshot), never from a model,
 * and the total never exceeds the budget.
 *
 * Two templates:
 *   allowlist    the public demo (DEMO_MODE=1, design 6-9): only the products in
 *                server/data/display-names.json. Fixed-price items first, the rest goes to blog posts.
 *                Also used whenever the catalog itself holds nothing else (the committed snapshot).
 *   channel_mix  the full catalog: a channel mix by business type, nudged by the owner's problems.
 *
 * Screen and speech use generic names only ("map listing", "photo social account", "messenger
 * channel"), never app or platform names.
 */
import { LOCAL_TYPES, EN_AREAS, businessLabel, problemLabel } from './extract.js';
import { englishWords, koreanShort } from './amounts.js';
import { DISPLAY_NAMES, displayName, isAllowlistOnly, isDemoMode } from './demo.js';

export const DEFAULT_BUDGET_KRW = 300_000;

// Product IDs are MarketPilot catalog IDs.
export const CHANNELS = {
  map_listing: {
    ko: '지도 매장정보 유입', en: 'Map listing traffic',
    why: { ko: '동네 손님의 첫 검색은 지도 앱의 매장정보에서 시작합니다. 유입·저장·길찾기 신호가 순위를 올립니다.', en: 'Local customers find stores through map listings. Visits, saves and directions are the ranking signals.' },
    products: [{ id: 2, w: 0.5 }, { id: 1, w: 0.25 }, { id: 3, w: 0.25 }],
  },
  receipt_reviews: {
    ko: '방문자 영수증 리뷰', en: 'Receipt-verified visitor reviews',
    why: { ko: '영수증 인증 리뷰는 지도 앱이 가장 신뢰하는 리뷰 유형이라 신규 매장의 전환율을 가장 빨리 올립니다.', en: 'Receipt-verified reviews are the review type map apps trust most; they lift conversion fastest for a new store.' },
    products: [{ id: 104, w: 1 }],
  },
  blog: {
    ko: '블로그 기자단 리뷰', en: 'Blogger review posts',
    why: { ko: '"지역+업종" 키워드 검색 결과의 상단은 블로그가 차지합니다.', en: 'Blog posts own the top of "area + category" search results.' },
    products: [{ id: 106, w: 1 }],
  },
  photo_social: {
    ko: '사진 SNS 계정 (팔로워·좋아요)', en: 'Photo social account (followers + likes)',
    why: { ko: '매장 계정의 사회적 증거를 만들고 짧은 영상의 도달을 키웁니다.', en: 'Builds social proof on the store account and extends short-video reach.' },
    products: [{ id: 234, w: 0.6 }, { id: 5, w: 0.4 }],
  },
  messenger_channel: {
    ko: '메신저 채널 친구', en: 'Messenger channel friends',
    why: { ko: '재방문 쿠폰·소식을 보낼 단골 채널입니다.', en: 'A retention channel for coupons and news to regulars.' },
    products: [{ id: 109, w: 1 }],
  },
  second_map: {
    ko: '두 번째 지도 앱 유입', en: 'Second map app traffic',
    why: { ko: '국내에서 두 번째로 큰 지도 앱에서의 노출입니다.', en: 'Visibility on the second-largest map app in Korea.' },
    products: [{ id: 111, w: 1 }],
  },
  press: {
    ko: '언론 기사 배포', en: 'Press release',
    why: { ko: '검색 결과에 기사가 뜨면 신뢰가 생기고 블로그·SNS에 인용됩니다.', en: 'A news article in search results builds credibility and gets cited by blogs and social posts.' },
    products: [{ id: 142, w: 1 }],
  },
  press_clinic: {
    ko: '병원 전문 언론 배포', en: 'Medical press release',
    why: { ko: '의료 광고 규정에 맞춘 병원 보도 상품입니다.', en: 'Press product written to Korean medical-advertising rules.' },
    products: [{ id: 147, w: 1 }],
  },
  press_franchise: {
    ko: '창업·프랜차이즈 보도', en: 'Franchise press release',
    why: { ko: '가맹 문의는 검색에서 기사를 먼저 봅니다.', en: 'Prospective franchisees read the news first.' },
    products: [{ id: 211, w: 1 }],
  },
  search_traffic: {
    ko: '검색 유입', en: 'Search traffic',
    why: { ko: '스토어·자사몰의 검색 유입 신호를 만듭니다.', en: 'Creates search-visit signals for a store or website.' },
    products: [{ id: 172, w: 1 }],
  },
  app_installs: {
    ko: '앱 다운로드', en: 'App installs',
    why: { ko: '스토어 순위는 초기 설치 속도에 좌우됩니다.', en: 'Store ranking depends on early install velocity.' },
    products: [{ id: 186, w: 1 }],
  },
  app_reviews: {
    ko: '앱 리뷰·별점', en: 'App reviews + ratings',
    why: { ko: '설치 전환율은 별점과 첫 리뷰 10개가 결정합니다.', en: 'Install conversion is decided by the rating and first 10 reviews.' },
    products: [{ id: 189, w: 1 }],
  },
  global_map_reviews: {
    ko: '글로벌 지도 앱 리뷰', en: 'Global map app reviews',
    why: { ko: '외국인·관광객은 글로벌 지도 앱으로 찾아옵니다.', en: 'Tourists and expats find you on a global map app.' },
    products: [{ id: 173, w: 1 }],
  },
};

const TEMPLATES = {
  local: ['map_listing', 'receipt_reviews', 'blog', 'photo_social'],
  clinic: ['map_listing', 'press_clinic', 'receipt_reviews', 'blog'],
  ecommerce: ['search_traffic', 'photo_social', 'blog', 'press'],
  app: ['app_installs', 'app_reviews', 'press', 'photo_social'],
  franchise: ['press_franchise', 'map_listing', 'blog', 'receipt_reviews'],
};
const BASE_SHARES = [0.35, 0.3, 0.25, 0.1];

// Inquiry-only products (aiOrderable=false in the catalog) worth mentioning per business type.
const INQUIRY_BY_TYPE = {
  ecommerce: [179, 277],
  app: [176],
  restaurant: [165],
  cafe: [165],
};

// --- allowlist template (public demo) ---

/** Channel groups of the allowlist, in the order they appear in a plan. */
export const DEMO_GROUPS = {
  listing: {
    ko: '지도 매장정보 점검', en: 'Map listing check',
    why: { ko: '손님이 매장을 찾는 첫 화면이 매장정보입니다. 빠진 것부터 확인합니다.', en: 'The map listing is the first thing customers see. The audit shows what is missing before anything else runs.' },
  },
  press: {
    ko: '보도자료', en: 'Press release',
    why: { ko: '검색 결과에 기사가 뜨면 신뢰가 생기고 후기 글에 인용됩니다.', en: 'A news article in search results builds credibility and gets quoted in posts about you.' },
  },
  print: {
    ko: '인쇄물', en: 'Print',
    why: { ko: '매장에서 걸어서 닿는 동네 손님에게 바로 전달됩니다.', en: 'Reaches the people who live and work within walking distance.' },
  },
  blog: {
    ko: '블로거 후기 글', en: 'Blog posts',
    why: { ko: '"동네+업종" 검색 결과 상단은 블로그 후기가 차지합니다.', en: 'Blog posts own the top of "area + category" search results.' },
  },
  photo: {
    ko: '사진 보정', en: 'Photo retouching',
    why: { ko: '메뉴 사진이 좋아지면 매장정보와 후기 글이 함께 좋아집니다.', en: 'Better menu photos lift the listing and every post that uses them.' },
  },
};

// The same rules as the Voice Agent's build_plan (design 6-9), so a budget gets the same plan in either
// language: fixed-price items first, each only if the rest still covers the minimum blog order; the poster
// only stands in for a flyer that did not fit; the rest buys blog posts; a leftover of 3,000 won or more
// buys photo retouching (up to 30 images).
//   480,000 -> audit 100,000 + press 90,000 + flyer 99,000 + 21 blog posts 189,000 = 478,000
//   380,000 -> audit 100,000 + press 90,000 + flyer 99,000 + 10 blog posts  90,000 = 379,000
const DEMO_FIXED = [282, 142, 251];
const DEMO_FLYER = 251;
const DEMO_POSTER = 249;
const DEMO_FILL = 106;
const DEMO_LEFTOVER = { id: 112, cap: 30 };

function templateFor(businessType) {
  if (businessType === 'clinic') return TEMPLATES.clinic;
  if (businessType === 'ecommerce') return TEMPLATES.ecommerce;
  if (businessType === 'app') return TEMPLATES.app;
  if (businessType === 'franchise') return TEMPLATES.franchise;
  return TEMPLATES.local;
}

/** Turn the template into weighted channels, then nudge by the problems the owner mentioned. */
export function chooseChannels(profile) {
  const keys = [...templateFor(profile.business_type)];
  const shares = new Map(keys.map((k, i) => [k, BASE_SHARES[i]]));
  const bump = (k, d) => {
    if (!shares.has(k)) { keys.push(k); shares.set(k, 0); }
    shares.set(k, shares.get(k) + d);
  };
  // problem keys come from extract.js
  const problems = new Set(profile.problems || []);
  if (problems.has('reviews')) bump(LOCAL_TYPES.has(profile.business_type) || !profile.business_type ? 'receipt_reviews' : 'blog', 0.1);
  if (problems.has('place_rank')) bump(LOCAL_TYPES.has(profile.business_type) ? 'map_listing' : 'search_traffic', 0.1);
  if (problems.has('instagram')) bump('photo_social', 0.15);
  if (problems.has('repeat')) bump('messenger_channel', 0.08);
  if (problems.has('press') && !keys.some((k) => k.startsWith('press'))) bump('press', 0.15);
  if (problems.has('foreign')) bump('global_map_reviews', 0.12);
  if (problems.has('app_growth') && profile.business_type === 'app') bump('app_installs', 0.1);
  if (problems.has('low_traffic') && LOCAL_TYPES.has(profile.business_type)) bump('map_listing', 0.05);
  // normalize
  const total = [...shares.values()].reduce((a, b) => a + b, 0);
  return keys.map((k) => ({ key: k, share: shares.get(k) / total }));
}

function byId(catalog, id) {
  return catalog.find((p) => p.productId === id) || null;
}

function langOf(profile) {
  return profile.language === 'en' ? 'en' : 'ko';
}

const AREA_EN = new Map(Object.entries(EN_AREAS).map(([en, ko]) => [ko, en.charAt(0).toUpperCase() + en.slice(1)]));

/** The area as the plan's language says it: "망원" stays in a Korean plan and becomes "Mangwon" in an English one. */
export function placeName(location, lang) {
  if (!location) return '';
  return lang === 'en' ? AREA_EN.get(location) || location : location;
}

function itemFor(product, qty, lang) {
  return { productId: product.productId, name: displayName(product.productId, lang, product.productName), category: product.category, unitPrice: product.unitPrice, qty, cost: qty * product.unitPrice, minOrderUnit: product.minOrderUnit, maxOrderUnit: product.maxOrderUnit };
}

/**
 * Allocate the budget over channels and pick quantities that respect min/max order units.
 * Always returns total_cost <= budget.
 */
export function allocate(profile, catalog, { budget } = {}) {
  const budgetKrw = budget || profile.budget_krw || DEFAULT_BUDGET_KRW;
  const channels = chooseChannels(profile);
  const lang = langOf(profile);
  let running = 0;
  const out = [];
  for (const ch of channels) {
    const def = CHANNELS[ch.key];
    const alloc = ch.share * budgetKrw;
    const items = [];
    for (const pick of def.products) {
      const product = byId(catalog, pick.id);
      if (!product || !product.aiOrderable || !product.unitPrice) continue;
      const part = alloc * pick.w;
      const unit = product.unitPrice;
      let qty = Math.floor(part / unit);
      const min = product.minOrderUnit || 1;
      const max = product.maxOrderUnit || Infinity;
      if (qty < min) {
        // allow a small overrun for minimum order quantities when the overall budget still fits
        qty = min * unit <= part * 1.4 && running + min * unit <= budgetKrw ? min : 0;
      }
      qty = Math.min(qty, max);
      if (qty <= 0) continue;
      const cost = qty * unit;
      if (running + cost > budgetKrw) continue;
      running += cost;
      items.push(itemFor(product, qty, lang));
    }
    if (items.length) {
      out.push({ key: ch.key, label: def[lang], why: def.why[lang], share: ch.share, items, cost: items.reduce((a, b) => a + b.cost, 0) });
    }
  }
  // second pass: spend leftover on the first channel's first item (usually map listing visits)
  const leftover = budgetKrw - running;
  if (out.length && leftover > 0) {
    const first = out[0].items[0];
    const max = first.maxOrderUnit || Infinity;
    const extra = Math.min(Math.floor(leftover / first.unitPrice), Math.max(0, max - first.qty));
    if (extra > 0) {
      first.qty += extra;
      first.cost += extra * first.unitPrice;
      out[0].cost += extra * first.unitPrice;
      running += extra * first.unitPrice;
    }
  }
  return { budget_krw: budgetKrw, channels: out, total_cost: running };
}

/**
 * The allowlist template (rules above). Always returns total_cost <= budget.
 */
export function allocateAllowlist(profile, catalog, { budget } = {}) {
  const budgetKrw = budget || profile.budget_krw || DEFAULT_BUDGET_KRW;
  const lang = langOf(profile);
  const priced = (id) => {
    const p = byId(catalog, id);
    return p && p.aiOrderable && p.unitPrice > 0 && DISPLAY_NAMES.has(id) ? { p, unit: p.unitPrice, min: p.minOrderUnit || 1, max: p.maxOrderUnit || Infinity } : null;
  };
  let left = budgetKrw;
  const picked = [];
  const add = (x, qty) => { picked.push(itemFor(x.p, qty, lang)); left -= qty * x.unit; };
  const fill = priced(DEMO_FILL);
  const reserve = fill ? fill.min * fill.unit : 0; // keep room for the minimum blog order
  let flyerIn = false;
  for (const id of [...DEMO_FIXED, DEMO_POSTER]) {
    if (id === DEMO_POSTER && flyerIn) continue;
    const x = priced(id);
    if (x && x.min * x.unit <= left - reserve) {
      add(x, x.min);
      if (id === DEMO_FLYER) flyerIn = true;
    }
  }
  if (fill) {
    const qty = Math.min(Math.floor(left / fill.unit), fill.max);
    if (qty >= fill.min) add(fill, qty);
  }
  const extra = priced(DEMO_LEFTOVER.id);
  if (extra) {
    const qty = Math.min(Math.floor(left / extra.unit), DEMO_LEFTOVER.cap, extra.max);
    if (qty >= extra.min) add(extra, qty);
  }
  const running = budgetKrw - left;
  const groups = new Map();
  for (const it of picked) {
    const g = DISPLAY_NAMES.get(it.productId).group;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  const channels = [...groups].map(([g, items]) => {
    const cost = items.reduce((a, b) => a + b.cost, 0);
    return { key: g, label: DEMO_GROUPS[g][lang], why: DEMO_GROUPS[g].why[lang], share: running ? cost / running : 0, items, cost };
  });
  return { budget_krw: budgetKrw, channels, total_cost: running };
}

function inquiryItems(profile, catalog) {
  const ids = INQUIRY_BY_TYPE[profile.business_type] || [];
  return ids.map((id) => byId(catalog, id)).filter(Boolean).map((p) => ({ productId: p.productId, name: p.productName, category: p.category, reason: p.aiOrderableReason || null }));
}

function fmtKrw(n, lang) {
  const s = Math.round(n).toLocaleString('en-US');
  return lang === 'ko' ? `${s}원` : `${s} KRW`;
}

/** An amount the way the agent says it: "four hundred seventy-eight thousand won" / "47만 8천 원". */
export function spokenWon(value, lang) {
  return lang === 'ko' ? koreanShort(value) : `${englishWords(value)} won`;
}

/** One plan line the way the agent says it: "twenty-one blog posts by recruited bloggers" / "블로거 섭외 후기 글 21건". */
export function spokenLine(item, lang) {
  const d = DISPLAY_NAMES.get(item.productId);
  if (lang === 'ko') return `${item.name} ${item.qty}${d?.unit_ko || '건'}`;
  const [one, many] = d?.spoken_en || [item.name, item.name];
  return item.qty === 1 ? `one ${one}` : `${englishWords(item.qty)} ${many}`;
}

function joinList(parts, lang) {
  if (lang === 'ko' || parts.length < 2) return parts.join(', ');
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

function checklistFor(profile, alloc, lang, inquiry, { demo = false } = {}) {
  const t = (ko, en) => (lang === 'ko' ? ko : en);
  const list = [];
  const has = (k) => alloc.channels.find((c) => c.key === k);
  const qtyOf = (id) => alloc.channels.flatMap((c) => c.items).find((i) => i.productId === id)?.qty || 0;
  const bl = profile.business_label || businessLabel(profile.business_type, lang) || t('매장', 'business');
  const loc = placeName(profile.location, lang);
  const kw = loc ? `"${loc} ${bl}"` : `"${t('지역', 'area')} ${bl}"`;
  const listingLine = profile.place
    ? t(`지도 앱 매장정보 확인: "${profile.place.name}" (${profile.place.roadAddress || ''}) 이 내 매장이 맞는지 확인`, `Confirm your map listing: "${profile.place.name}" (${profile.place.roadAddress || ''})`)
    : null;
  if (has('listing')) {
    list.push(listingLine || t('지도 앱에서 내 매장을 검색해 매장정보 링크 복사 (진단 보고서에 필요)', 'Search your store on your map app and copy the listing link (the audit report needs it)'));
  }
  if (has('map_listing') || has('receipt_reviews')) {
    list.push(listingLine || t('지도 앱에서 내 매장을 검색해 매장정보 링크 복사 (상품 집행에 필요)', 'Search your store on your map app and copy the listing link (needed to run listing products)'));
    list.push(t('매장정보 대표 사진 5장·메뉴·영업시간·소식 1건 업데이트 (유입 상품 시작 전 3일 내)', 'Update 5 cover photos, menu, hours and 1 news post on your map listing within 3 days, before traffic starts'));
  }
  const rr = has('receipt_reviews');
  if (rr) {
    const qty = rr.items[0].qty;
    list.push(t(`영수증 리뷰 ${qty}건 집행: 리뷰에 넣을 대표 메뉴 3개와 강조 포인트(예: "주차 가능") 정하기`, `Run ${qty} receipt reviews: pick 3 signature items and 1 hook (e.g. "free parking") for reviewers to mention`));
  }
  if (has('press') || has('press_clinic') || has('press_franchise')) {
    list.push(t('기사에 넣을 사실 5줄 준비: 오픈일·대표 메뉴·차별점·위치·연락처', 'Prepare 5 facts for the article: opening date, signature item, difference, location, contact'));
  }
  if (has('print')) {
    list.push(t('전단지·포스터에 넣을 대표 메뉴 3개와 혜택 1개, 나눠 줄 곳(예: 매장에서 걸어서 5분 안) 정하기', 'Pick 3 signature items and 1 offer for the print, and where to hand it out (e.g. within a 5-minute walk)'));
  }
  const blog = has('blog');
  if (blog) {
    const n = qtyOf(106) || blog.items[0].qty;
    list.push(t(`블로그 키워드 3개 정하기: ${kw}, "${loc || ''} ${bl} 추천", "${loc || ''} 데이트" 등 · 블로거 ${n}명 섭외`, `Choose 3 blog keywords, e.g. ${kw}, "${loc} ${bl} recommended" · brief ${n} bloggers`));
  }
  if (has('photo')) {
    list.push(t(`보정할 메뉴·매장 사진 ${qtyOf(112)}장 고르기`, `Pick ${qtyOf(112)} menu and store photos to retouch`));
  }
  if (has('photo_social')) {
    list.push(t('이번 주 짧은 영상 3개 업로드 (매장·메뉴·후기) 후 팔로워·좋아요 상품 시작', 'Post 3 short videos this week (store, menu, review) before followers and likes start'));
  }
  if (has('app_installs') || has('app_reviews')) {
    list.push(t('스토어 등록정보 점검: 스크린샷 5장·설명 첫 2줄·키워드 (설치 상품 시작 전)', 'Fix the store listing first: 5 screenshots, first 2 lines of description, keywords'));
  }
  if (has('search_traffic')) {
    list.push(t('검색 유입 시킬 상품 페이지 URL 3개와 키워드 정하기', 'Pick 3 product page URLs and their search keywords for traffic'));
  }
  if (has('messenger_channel')) {
    list.push(t('메신저 채널 개설 후 첫 쿠폰(재방문 10%) 만들기', 'Open a messenger channel and create the first coupon (10% off the next visit)'));
  }
  if (has('global_map_reviews')) {
    list.push(t('글로벌 지도 앱 비즈니스 프로필에 영문 설명·사진 업데이트', 'Update your global map app business profile with an English description and photos'));
  }
  if (inquiry.length) {
    // catalog names can carry platform names, so the checklist only counts them (the plan card lists them)
    list.push(t(`견적 받기: 문의형 상품 ${inquiry.length}개 (계획표 아래 목록)`, `Request a quote for the ${inquiry.length} inquiry-only product${inquiry.length > 1 ? 's' : ''} listed under the plan`));
  }
  list.push(demo
    ? t('계획을 승인하면 데모 결제 화면이 열립니다 (실제 결제 없음) · 30일 후 매장정보 조회·후기 수·매출로 재조정', 'Approve the plan to open the demo checkout (no payment is taken) · re-plan after 30 days from listing views, review count and sales')
    : t('계획 승인 후 카드 결제 링크 받기 (회원가입 불필요) · 30일 후 매장정보 유입·리뷰 수·매출로 재조정', 'Approve the plan to get a card checkout link (no signup) · re-plan after 30 days from listing visits, review count and sales'));
  return list;
}

function spokenSummary(profile, alloc, lang, template) {
  const t = (ko, en) => (lang === 'ko' ? ko : en);
  const bl = profile.business_label || businessLabel(profile.business_type, lang) || t('매장', 'business');
  const loc = profile.location ? `${placeName(profile.location, lang)} ` : '';
  const probs = (profile.problems || []).slice(0, 2).map((p) => problemLabel(p, lang)).join(lang === 'ko' ? '·' : ' and ');
  const assumed = !profile.budget_krw;
  const budgetPhrase = assumed
    ? t(`예산을 말씀 안 하셔서 월 ${fmtKrw(alloc.budget_krw, lang)} 기준으로 잡았습니다.`, `You did not mention a budget, so I assumed ${spokenWon(alloc.budget_krw, lang)} a month.`)
    : t(`월 ${fmtKrw(alloc.budget_krw, lang)} 예산 기준입니다.`, `This is based on ${spokenWon(alloc.budget_krw, lang)} a month.`);
  const problemPhrase = probs ? t(`${probs} 문제를 먼저 풉니다.`, `It targets ${probs} first.`) : '';
  const total = lang === 'ko' ? fmtKrw(alloc.total_cost, lang) : spokenWon(alloc.total_cost, lang);
  if (template === 'allowlist') {
    const lines = joinList(alloc.channels.flatMap((c) => c.items).map((i) => spokenLine(i, lang)), lang);
    return t(
      `${loc}${bl} 30일 계획입니다. ${budgetPhrase} ${lines}을 넣었고 총 ${total}입니다. ${problemPhrase} 화면의 체크리스트를 확인하시고, 괜찮으면 "진행"이라고 말씀해 주세요.`,
      `Here is a 30-day plan for your ${loc}${bl}. ${budgetPhrase} It has ${lines}, for a total of ${total}. ${problemPhrase} The checklist is on screen. Say "go ahead" if it works for you.`,
    ).replace(/\s+/g, ' ').trim();
  }
  const top = alloc.channels.slice(0, 3).map((c) => `${c.label} ${Math.round(c.share * 100)}%`).join(', ');
  return t(
    `${loc}${bl} 30일 계획입니다. ${budgetPhrase} ${top} 순으로 나눴고 총 ${total} 입니다. ${problemPhrase} 화면의 체크리스트를 확인하시고, 괜찮으면 "진행"이라고 말씀해 주세요.`,
    `Here is a 30-day plan for your ${loc}${bl}. ${budgetPhrase} The split is ${top}, totaling ${total}. ${problemPhrase} The checklist is on screen. Say "go ahead" if it works for you.`,
  ).replace(/\s+/g, ' ').trim();
}

/**
 * Build the full plan.
 * @param {object} profile
 * @param {Array} catalog  products from MCP (live or snapshot)
 * @param {{catalogSource?:string, budget?:number, demo?:boolean}} opts  demo defaults to DEMO_MODE
 */
export function buildPlan(profile, catalog, opts = {}) {
  const lang = langOf(profile);
  const demo = opts.demo ?? isDemoMode();
  const template = demo || isAllowlistOnly(catalog) ? 'allowlist' : 'channel_mix';
  const alloc = template === 'allowlist' ? allocateAllowlist(profile, catalog, opts) : allocate(profile, catalog, opts);
  const inquiry = template === 'allowlist' ? [] : inquiryItems(profile, catalog);
  const assumptions = [];
  if (!profile.budget_krw) assumptions.push(lang === 'ko' ? `예산 미확인: 월 ${fmtKrw(DEFAULT_BUDGET_KRW, lang)} 가정` : `Budget not stated: assumed ${fmtKrw(DEFAULT_BUDGET_KRW, lang)} / month`);
  if (profile.budget_currency === 'USD') assumptions.push(lang === 'ko' ? `달러 예산을 1 USD = ${USD_RATE} KRW 로 환산` : `USD budget converted at 1 USD = ${USD_RATE} KRW`);
  if (!profile.business_type) assumptions.push(lang === 'ko' ? '업종 미확인: 로컬 매장 기본 조합 적용' : 'Business type unknown: default local-store mix applied');
  const items = alloc.channels.flatMap((c) => c.items);
  return {
    language: lang,
    horizon_days: 30,
    template,
    demo,
    budget_krw: alloc.budget_krw,
    total_cost: alloc.total_cost,
    total_krw: alloc.total_cost,
    unspent_krw: alloc.budget_krw - alloc.total_cost,
    // numbers in words, so a voice agent never has to turn digits into speech itself
    spoken_budget: lang === 'ko' ? `월 ${spokenWon(alloc.budget_krw, lang)}` : `${spokenWon(alloc.budget_krw, lang)} a month`,
    spoken_total: spokenWon(alloc.total_cost, lang),
    lines: items.map((i) => ({ product_id: i.productId, name: i.name, qty: i.qty, unit_krw: i.unitPrice, cost_krw: i.cost, spoken: spokenLine(i, lang), spoken_cost: spokenWon(i.cost, lang) })),
    channels: alloc.channels,
    inquiry_items: inquiry,
    assumptions,
    checklist: checklistFor(profile, alloc, lang, inquiry, { demo }),
    summary: spokenSummary(profile, alloc, lang, template),
    catalog_source: opts.catalogSource || 'unknown',
  };
}

const USD_RATE = 1350;

/** Items that can go straight into a MarketPilot checkout link. */
export function checkoutItems(plan) {
  return plan.channels.flatMap((c) => c.items.map((i) => ({ productId: i.productId, quantity: i.qty })));
}

export { fmtKrw };
