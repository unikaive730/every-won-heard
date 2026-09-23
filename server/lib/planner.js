/**
 * Deterministic marketing planner.
 * profile + product catalog -> channel mix, priced product picks, inquiry-only items,
 * an action checklist and a short spoken summary. Prices always come from the catalog
 * (live MarketPilot MCP or the mock snapshot), never from the LLM.
 */
import { LOCAL_TYPES, businessLabel, problemLabel } from './extract.js';

export const DEFAULT_BUDGET_KRW = 300_000;

// Product IDs are MarketPilot catalog IDs (see server/data/products.mock.json for names/prices).
export const CHANNELS = {
  naver_place: {
    ko: '네이버 플레이스 트래픽', en: 'Naver Place traffic',
    why: { ko: '한국 로컬 매장 고객의 첫 검색은 네이버 플레이스에서 시작합니다. 유입·저장·길찾기 신호가 순위를 올립니다.', en: 'Korean local customers discover stores on Naver Place. Visits, saves and directions are the ranking signals.' },
    products: [{ id: 2, w: 0.5 }, { id: 1, w: 0.25 }, { id: 3, w: 0.25 }],
  },
  receipt_reviews: {
    ko: '방문자 영수증 리뷰', en: 'Receipt-verified visitor reviews',
    why: { ko: '영수증 리뷰는 네이버가 가장 신뢰하는 리뷰 유형이라 신규 매장의 전환율을 가장 빨리 올립니다.', en: 'Receipt reviews are the review type Naver trusts most; they lift conversion fastest for a new store.' },
    products: [{ id: 104, w: 1 }],
  },
  blog: {
    ko: '블로그 기자단 리뷰', en: 'Blogger review posts',
    why: { ko: '"지역+업종" 키워드 검색 결과의 상단은 블로그가 차지합니다.', en: 'Blog posts own the top of "area + category" search results on Naver.' },
    products: [{ id: 106, w: 1 }],
  },
  instagram: {
    ko: '인스타그램 (한국인 팔로워·좋아요)', en: 'Instagram (Korean followers + likes)',
    why: { ko: '매장 계정의 사회적 증거를 만들고 릴스 도달을 키웁니다.', en: 'Builds social proof on the store account and extends reel reach.' },
    products: [{ id: 234, w: 0.6 }, { id: 5, w: 0.4 }],
  },
  kakao_channel: {
    ko: '카카오 채널 친구', en: 'Kakao Channel friends',
    why: { ko: '재방문 쿠폰·소식을 보낼 단골 채널입니다.', en: 'A retention channel for coupons and news to regulars.' },
    products: [{ id: 109, w: 1 }],
  },
  kakao_map: {
    ko: '카카오맵 유입', en: 'Kakao Map traffic',
    why: { ko: '네이버 다음으로 큰 지도 앱에서의 노출입니다.', en: 'Visibility on the second-largest map app in Korea.' },
    products: [{ id: 111, w: 1 }],
  },
  press: {
    ko: '언론 기사 배포', en: 'Press release',
    why: { ko: '검색 결과에 기사가 뜨면 신뢰가 생기고 블로그·SNS에 인용됩니다.', en: 'A news article in search results builds credibility and gets cited by blogs and social.' },
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
    ko: '검색 트래픽 (네이버·구글)', en: 'Search traffic (Naver + Google)',
    why: { ko: '스토어·자사몰의 검색 유입 신호를 만듭니다.', en: 'Creates search-visit signals for a store or website.' },
    products: [{ id: 172, w: 1 }],
  },
  app_installs: {
    ko: '앱 다운로드 (구글 플레이)', en: 'App installs (Google Play)',
    why: { ko: '스토어 순위는 초기 설치 속도에 좌우됩니다.', en: 'Store ranking depends on early install velocity.' },
    products: [{ id: 186, w: 1 }],
  },
  app_reviews: {
    ko: '앱 리뷰·별점', en: 'App reviews + ratings',
    why: { ko: '설치 전환율은 별점과 첫 리뷰 10개가 결정합니다.', en: 'Install conversion is decided by the rating and first 10 reviews.' },
    products: [{ id: 189, w: 1 }],
  },
  google_reviews: {
    ko: '구글맵 리뷰', en: 'Google Maps reviews',
    why: { ko: '외국인·관광객은 구글맵으로 찾아옵니다.', en: 'Tourists and expats find you on Google Maps.' },
    products: [{ id: 173, w: 1 }],
  },
};

const TEMPLATES = {
  local: ['naver_place', 'receipt_reviews', 'blog', 'instagram'],
  clinic: ['naver_place', 'press_clinic', 'receipt_reviews', 'blog'],
  ecommerce: ['search_traffic', 'instagram', 'blog', 'press'],
  app: ['app_installs', 'app_reviews', 'press', 'instagram'],
  franchise: ['press_franchise', 'naver_place', 'blog', 'receipt_reviews'],
};
const BASE_SHARES = [0.35, 0.3, 0.25, 0.1];

// Inquiry-only products (aiOrderable=false in the catalog) worth mentioning per business type.
const INQUIRY_BY_TYPE = {
  ecommerce: [179, 277],
  app: [176],
  restaurant: [165],
  cafe: [165],
};

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
  const problems = new Set(profile.problems || []);
  if (problems.has('reviews')) bump(LOCAL_TYPES.has(profile.business_type) || !profile.business_type ? 'receipt_reviews' : 'blog', 0.1);
  if (problems.has('place_rank')) bump(LOCAL_TYPES.has(profile.business_type) ? 'naver_place' : 'search_traffic', 0.1);
  if (problems.has('instagram')) bump('instagram', 0.15);
  if (problems.has('repeat')) bump('kakao_channel', 0.08);
  if (problems.has('press') && !keys.some((k) => k.startsWith('press'))) bump('press', 0.15);
  if (problems.has('foreign')) bump('google_reviews', 0.12);
  if (problems.has('app_growth') && profile.business_type === 'app') bump('app_installs', 0.1);
  if (problems.has('low_traffic') && LOCAL_TYPES.has(profile.business_type)) bump('naver_place', 0.05);
  // normalize
  const total = [...shares.values()].reduce((a, b) => a + b, 0);
  return keys.map((k) => ({ key: k, share: shares.get(k) / total }));
}

function byId(catalog, id) {
  return catalog.find((p) => p.productId === id) || null;
}

/**
 * Allocate the budget over channels and pick quantities that respect min/max order units.
 * Always returns total_cost <= budget.
 */
export function allocate(profile, catalog, { budget } = {}) {
  const budgetKrw = budget || profile.budget_krw || DEFAULT_BUDGET_KRW;
  const channels = chooseChannels(profile);
  const lang = profile.language === 'en' ? 'en' : 'ko';
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
      items.push({ productId: product.productId, name: product.productName, category: product.category, unitPrice: unit, qty, cost, minOrderUnit: product.minOrderUnit, maxOrderUnit: product.maxOrderUnit });
    }
    if (items.length) {
      out.push({ key: ch.key, label: def[lang], why: def.why[lang], share: ch.share, items, cost: items.reduce((a, b) => a + b.cost, 0) });
    }
  }
  // second pass: spend leftover on the first channel's first item (usually Naver Place visits)
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

function inquiryItems(profile, catalog) {
  const ids = INQUIRY_BY_TYPE[profile.business_type] || [];
  return ids.map((id) => byId(catalog, id)).filter(Boolean).map((p) => ({ productId: p.productId, name: p.productName, category: p.category, reason: p.aiOrderableReason || null }));
}

function fmtKrw(n, lang) {
  const s = Math.round(n).toLocaleString('en-US');
  return lang === 'ko' ? `${s}원` : `${s} KRW`;
}

function checklistFor(profile, alloc, lang, inquiry) {
  const t = (ko, en) => (lang === 'ko' ? ko : en);
  const list = [];
  const has = (k) => alloc.channels.find((c) => c.key === k);
  const bl = profile.business_label || businessLabel(profile.business_type, lang) || t('매장', 'business');
  const loc = profile.location || '';
  if (has('naver_place') || has('receipt_reviews')) {
    if (profile.place) {
      list.push(t(`네이버 플레이스 확인: "${profile.place.name}" (${profile.place.roadAddress || ''}) 이 내 매장이 맞는지 확인`, `Confirm your Naver Place listing: "${profile.place.name}" (${profile.place.roadAddress || ''})`));
    } else {
      list.push(t('네이버 지도에서 내 매장을 검색해 플레이스 URL 복사 (상품 집행에 필요)', 'Search your store on Naver Map and copy the Place URL (needed to run Place products)'));
    }
    list.push(t('플레이스 대표 사진 5장·메뉴·영업시간·소식 1건 업데이트 (트래픽 상품 시작 전 3일 내)', 'Update 5 cover photos, menu, hours and 1 news post on Naver Place within 3 days, before traffic starts'));
  }
  const rr = has('receipt_reviews');
  if (rr) {
    const qty = rr.items[0].qty;
    list.push(t(`영수증 리뷰 ${qty}건 집행: 리뷰에 넣을 대표 메뉴 3개와 강조 포인트(예: "주차 가능") 정하기`, `Run ${qty} receipt reviews: pick 3 signature items and 1 hook (e.g. "free parking") for reviewers to mention`));
  }
  const blog = has('blog');
  if (blog) {
    const kw = loc ? `"${loc} ${bl}"` : `"${t('지역', 'area')} ${bl}"`;
    list.push(t(`블로그 키워드 3개 정하기: ${kw}, "${loc || ''} ${bl} 추천", "${loc || ''} 데이트" 등 · 블로거 ${blog.items[0].qty}명 섭외`, `Choose 3 blog keywords, e.g. ${kw}, "${loc} ${bl} recommended" · brief ${blog.items[0].qty} bloggers`));
  }
  if (has('instagram')) {
    list.push(t('이번 주 릴스 3개 업로드 (매장·메뉴·후기) 후 팔로워·좋아요 상품 시작', 'Post 3 reels this week (store, menu, review) before followers/likes start'));
  }
  if (has('press') || has('press_clinic') || has('press_franchise')) {
    list.push(t('기사에 넣을 사실 5줄 준비: 오픈일·대표 메뉴·차별점·위치·연락처', 'Prepare 5 facts for the article: opening date, signature item, difference, location, contact'));
  }
  if (has('app_installs') || has('app_reviews')) {
    list.push(t('스토어 등록정보 점검: 스크린샷 5장·설명 첫 2줄·키워드 (설치 상품 시작 전)', 'Fix store listing first: 5 screenshots, first 2 lines of description, keywords'));
  }
  if (has('search_traffic')) {
    list.push(t('검색 유입 시킬 상품 페이지 URL 3개와 키워드 정하기', 'Pick 3 product page URLs and their search keywords for traffic'));
  }
  if (has('kakao_channel')) {
    list.push(t('카카오 채널 개설 후 첫 쿠폰(재방문 10%) 만들기', 'Open a Kakao Channel and create the first coupon (10% off next visit)'));
  }
  if (has('google_reviews')) {
    list.push(t('구글 비즈니스 프로필 영문 설명·사진 업데이트', 'Update the Google Business Profile with English description and photos'));
  }
  for (const q of inquiry) {
    list.push(t(`상담 접수: ${q.name} (문의형 상품)`, `Request a quote: ${q.name} (inquiry-only product)`));
  }
  list.push(t(`계획 승인 후 카드 결제 링크 받기 (회원가입 불필요) · 30일 후 플레이스 유입·리뷰 수·매출로 재조정`, `Approve the plan to get a card checkout link (no signup) · review Place visits, review count and sales after 30 days`));
  return list;
}

function spokenSummary(profile, alloc, lang) {
  const t = (ko, en) => (lang === 'ko' ? ko : en);
  const bl = profile.business_label || businessLabel(profile.business_type, lang) || t('매장', 'business');
  const loc = profile.location ? (lang === 'ko' ? `${profile.location} ` : `${profile.location} `) : '';
  const top = alloc.channels.slice(0, 3).map((c) => `${c.label} ${Math.round(c.share * 100)}%`).join(', ');
  const probs = (profile.problems || []).slice(0, 2).map((p) => problemLabel(p, lang)).join(lang === 'ko' ? '·' : ' and ');
  const assumed = !profile.budget_krw;
  const budgetPhrase = assumed
    ? t(`예산을 말씀 안 하셔서 월 ${fmtKrw(alloc.budget_krw, lang)} 기준으로 잡았습니다.`, `You did not mention a budget, so I assumed ${fmtKrw(alloc.budget_krw, lang)} per month.`)
    : t(`월 ${fmtKrw(alloc.budget_krw, lang)} 예산 기준입니다.`, `This is based on ${fmtKrw(alloc.budget_krw, lang)} per month.`);
  const problemPhrase = probs ? t(`${probs} 문제를 먼저 풉니다.`, `It targets ${probs} first.`) : '';
  return t(
    `${loc}${bl} 30일 계획입니다. ${budgetPhrase} ${top} 순으로 나눴고 총 ${fmtKrw(alloc.total_cost, lang)} 입니다. ${problemPhrase} 화면의 체크리스트를 확인하시고, 괜찮으면 "진행"이라고 말씀해 주세요.`,
    `Here is a 30-day plan for your ${loc}${bl}. ${budgetPhrase} The split is ${top}, totaling ${fmtKrw(alloc.total_cost, lang)}. ${problemPhrase} The checklist is on screen. Say "go ahead" if it works for you.`,
  ).replace(/\s+/g, ' ').trim();
}

/**
 * Build the full plan.
 * @param {object} profile
 * @param {Array} catalog  products from MCP (live or mock)
 */
export function buildPlan(profile, catalog, opts = {}) {
  const lang = profile.language === 'en' ? 'en' : 'ko';
  const alloc = allocate(profile, catalog, opts);
  const inquiry = inquiryItems(profile, catalog);
  const assumptions = [];
  if (!profile.budget_krw) assumptions.push(lang === 'ko' ? `예산 미확인: 월 ${fmtKrw(DEFAULT_BUDGET_KRW, lang)} 가정` : `Budget not stated: assumed ${fmtKrw(DEFAULT_BUDGET_KRW, lang)} / month`);
  if (profile.budget_currency === 'USD') assumptions.push(lang === 'ko' ? `달러 예산을 1 USD = ${USD_RATE} KRW 로 환산` : `USD budget converted at 1 USD = ${USD_RATE} KRW`);
  if (!profile.business_type) assumptions.push(lang === 'ko' ? '업종 미확인: 로컬 매장 기본 조합 적용' : 'Business type unknown: default local-store mix applied');
  return {
    language: lang,
    horizon_days: 30,
    budget_krw: alloc.budget_krw,
    total_cost: alloc.total_cost,
    channels: alloc.channels,
    inquiry_items: inquiry,
    assumptions,
    checklist: checklistFor(profile, alloc, lang, inquiry),
    summary: spokenSummary(profile, alloc, lang),
    catalog_source: opts.catalogSource || 'unknown',
  };
}

const USD_RATE = 1350;

/** Items that can go straight into a MarketPilot checkout link. */
export function checkoutItems(plan) {
  return plan.channels.flatMap((c) => c.items.map((i) => ({ productId: i.productId, quantity: i.qty })));
}

export { fmtKrw };
