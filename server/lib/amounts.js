/**
 * Money amounts in what an owner said, Korean or English. Pure functions, no dependencies.
 * This is the one parser the grounding check (grounding.js) and the call receipt (brief.js) use.
 *
 * Handles
 *   digits            480,000 won · 480000 · 480k · 1.5 million · $ is ignored (budgets are in won)
 *   English words     four hundred eighty thousand · four hundred and eighty thousand · half a million
 *                     a million won · fifty man won (Korean "man" = 10,000 said in English)
 *                     "four eighty thousand" (spoken shorthand, only when a scale word follows)
 *   Korean            사십팔만 원 · 48만 원 · 48만 5천 원 · 백만 원 · 1억 2천만 원
 *   ranges            four or five hundred thousand · between 300,000 and 400,000 · 사오십만 · 40~50만 원 · 40에서 50만
 *   corrections       no / sorry / actually / I mean / make that / wait · 아니 / 아니다 / 말고
 *
 * Not money: counts and percents (twenty percent, ten posts, 리뷰 30개, 10만 명), bare small numbers
 * ("오십", "50", "three eighty"), and malformed forms like "3.8 hundred thousand".
 *
 * parseAmounts(text) -> { items, corrected, lastCorrectionAt }
 *   items: [{ value, text, index, end, money, range:[lo,hi]|null, scaled, currency }] in order of appearance
 * pickAmount(text)   -> { status:'ok', value, item } | { status:'ambiguous', options, item? } | { status:'none' }
 */

const KO_DIGIT = { 일: 1, 이: 2, 삼: 3, 사: 4, 오: 5, 육: 6, 륙: 6, 칠: 7, 팔: 8, 구: 9 };
const KO_SMALL = { 십: 10, 백: 100, 천: 1000 };
const KO_BIG = { 만: 1e4, 억: 1e8 };
const KO_CHARS = '일이삼사오육륙칠팔구십백천만억';

const EN_UNITS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const EN_TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// big multipliers close a section; "man" is the Korean 10,000 unit said in English ("fifty man won")
const EN_BIG = { thousand: 1e3, k: 1e3, grand: 1e3, man: 1e4, million: 1e6, mil: 1e6, billion: 1e9 };

const CORRECTION_EN = new Set(['no', 'nope', 'sorry', 'actually', 'wait', 'correction', 'rather', 'instead']);
const CORRECTION_EN_PAIRS = [['i', 'mean'], ['make', 'that'], ['scratch', 'that'], ['change', 'that'], ['let', 'me', 'correct']];
const RANGE_EN = new Set(['or', 'to', 'between', 'through']);
const KO_RANGE_WORDS = /^(에서|부터|내지|이나|나|또는|혹은|아니면)$/;
// a word right after a number that makes it a count, not money
const NON_MONEY_EN = new Set(['percent', 'per', 'posts', 'post', 'reviews', 'review', 'followers', 'follower', 'people', 'customers', 'customer', 'visitors', 'views', 'likes', 'times', 'days', 'day', 'weeks', 'week', 'months', 'years', 'year', 'hours', 'hour', 'minutes', 'minute', 'items', 'pieces', 'units', 'seats', 'tables', 'stores', 'shops', 'branches', 'photos', 'dollars', 'dollar', 'usd', 'bucks']);
const NON_MONEY_KO = /^(명|개|건|번|회|일|시|분|초|년|개월|달|주|곳|장|퍼센트|프로|팔로워|리뷰|사람|분이|명이|개가|건이|달러|불)/;
// Korean endings allowed right after a number with no space (48만원이요, 오십만이에요, 30만 정도)
const KO_SUFFIX = /^(원|정도|쯤|까지|이내|가량|선|대|짜리|씩|요|이요|이에요|에요|예요|입니다|이고|이구요|이나|은|는|이|을|를|에|에서|으로|로|부터|도|이면|면|만|이요\.|이라|라고|이라고|이라서)/;

/** Normalize, keep offsets stable enough for display (we only need rough spans). */
function normalize(text) {
  return String(text || '')
    .replace(/천만에요|천만의 말씀/g, (m) => ' '.repeat(m.length)) // idiom "you're welcome", not money
    .replace(/[–—]/g, '-')
    .replace(/([A-Za-z])-([A-Za-z])/g, '$1 $2'); // forty-eight -> forty eight (same length)
}

const TOKEN_RE = /(?<num>\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)|(?<ko>[일이삼사오육륙칠팔구십백천만억]+)|(?<won>원|₩)|(?<word>[A-Za-z]+)|(?<pct>%)|(?<sep>[~〜-])|(?<ell>\.{2,}|…)|(?<punct>[.,!?;:])|(?<hangul>[가-힣]+)|(?<dollar>\$)/g;

function tokenize(text) {
  const out = [];
  let prevEnd = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const type = Object.keys(m.groups).find((k) => m.groups[k] !== undefined);
    out.push({ type, text: m[0], lower: m[0].toLowerCase(), index: m.index, end: m.index + m[0].length, gap: m.index > prevEnd });
    prevEnd = m.index + m[0].length;
  }
  return out;
}

/** Evaluate a hangul numeral run such as 사십팔만, 백만, 천오백, 사오십만 (range). */
export function koNumeral(s) {
  const chars = [...s];
  // range: two consecutive ascending digits followed by a unit (사오십만 = 40~50만)
  for (let i = 0; i < chars.length - 1; i++) {
    const a = KO_DIGIT[chars[i]];
    const b = KO_DIGIT[chars[i + 1]];
    if (a && b && b === a + 1 && i + 2 < chars.length && (KO_SMALL[chars[i + 2]] || KO_BIG[chars[i + 2]])) {
      const lo = koNumeral(chars.slice(0, i + 1).concat(chars.slice(i + 2)).join(''));
      const hi = koNumeral(chars.slice(0, i).concat(chars.slice(i + 1)).join(''));
      if (lo && hi && lo.value != null && hi.value != null) return { value: null, range: [lo.value, hi.value], hasBig: lo.hasBig };
      return null;
    }
  }
  let total = 0;
  let section = 0;
  let digit = null;
  let lastSmall = Infinity;
  let lastBig = Infinity;
  let hasBig = false;
  let hasUnit = false;
  for (const ch of chars) {
    if (KO_DIGIT[ch] !== undefined) {
      if (digit !== null) return null; // two digits in a row that are not a range
      digit = KO_DIGIT[ch];
    } else if (KO_SMALL[ch]) {
      const u = KO_SMALL[ch];
      if (u >= lastSmall) return null; // 천천, 십백
      section += (digit ?? 1) * u;
      digit = null;
      lastSmall = u;
      hasUnit = true;
    } else if (KO_BIG[ch]) {
      const u = KO_BIG[ch];
      if (u >= lastBig) return null;
      section += digit ?? 0;
      if (section === 0) section = 1;
      total += section * u;
      section = 0;
      digit = null;
      lastSmall = Infinity;
      lastBig = u;
      hasBig = true;
      hasUnit = true;
    } else {
      return null;
    }
  }
  total += section + (digit ?? 0);
  return { value: total, range: null, hasBig, hasUnit };
}

/**
 * Evaluate a run of numeric atoms. Atoms: {n} numbers, {small} (Korean 십/백/천, English hundred), {big}.
 * Returns an array of pieces (a run splits where two plain numbers sit side by side).
 */
function evalAtoms(atoms) {
  const pieces = [];
  let total = 0;
  let section = 0;
  let current = null;
  let scaled = false;
  let big = false;
  let lastBig = Infinity;
  let start = null;
  let end = null;
  let bad = false;
  const flush = () => {
    if (start === null) return;
    const value = total + section + (current ?? 0);
    pieces.push({ value, scaled, big, index: start, end, bad });
    total = 0; section = 0; current = null; scaled = false; big = false; lastBig = Infinity; start = null; end = null; bad = false;
  };
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.kind === 'n') {
      if (current !== null) {
        // "eighty" + "eight" -> 88
        if (a.word && current >= 20 && current % 10 === 0 && current < 100 && a.n < 10) { current += a.n; end = a.end; continue; }
        // "four eighty thousand": units word then tens word, only if a big scale follows in this run
        const bigLater = atoms.slice(i + 1).some((x) => x.kind === 'big');
        if (a.word && current >= 1 && current <= 9 && a.n >= 20 && a.n < 100 && bigLater && section === 0) { current = current * 100 + a.n; end = a.end; continue; }
        flush();
      }
      if (start === null) start = a.index;
      current = a.n;
      end = a.end;
      continue;
    }
    if (start === null) start = a.index;
    end = a.end;
    if (a.kind === 'small') {
      if (current !== null && !Number.isInteger(current) && a.en) bad = true; // "3.8 hundred thousand"
      section += (current ?? 1) * a.mult;
      current = null;
      scaled = true;
    } else if (a.kind === 'big') {
      if (a.mult >= lastBig) { flush(); start = a.index; end = a.end; }
      section += current ?? 0;
      if (section === 0) section = 1;
      total += section * a.mult;
      section = 0;
      current = null;
      scaled = true;
      big = true;
      lastBig = a.mult;
    } else if (a.kind === 'half') {
      current = 0.5;
    } else if (a.kind === 'a') {
      if (current === null) current = 1;
    }
  }
  flush();
  return pieces;
}

/** Build numeric runs from tokens and evaluate them. */
function numericItems(tokens) {
  const items = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    const isKo = t.type === 'ko';
    const isNum = t.type === 'num';
    const isWord = t.type === 'word' && (EN_UNITS[t.lower] !== undefined || EN_TENS[t.lower] !== undefined || (t.lower === 'half' && tokens[i + 1]?.lower === 'a') || (t.lower === 'a' && /^(hundred|thousand|million|half)$/.test(tokens[i + 1]?.lower || '')));
    if (!isKo && !isNum && !isWord) { i++; continue; }

    // collect a run: numeric tokens joined by whitespace only (plus "and" after hundred, and hesitations)
    const run = [];
    let j = i;
    while (j < tokens.length) {
      const x = tokens[j];
      const prev = run[run.length - 1];
      if (run.length && x.gap === false && x.type === 'ko' && prev?.type === 'num') { run.push(x); j++; continue; } // 48만
      if (x.type === 'num' || x.type === 'ko') {
        if (run.length && x.type === 'num' && prev?.type === 'num') break; // "40 50" are two numbers
        if (run.length && x.type === 'num' && run.some((r) => r.type === 'word')) break; // "Four hundred... 80,000": words then digits are two numbers
        run.push(x); j++; continue;
      }
      if (x.type === 'word') {
        const w = x.lower;
        if (EN_UNITS[w] !== undefined || EN_TENS[w] !== undefined || w === 'hundred' || EN_BIG[w] !== undefined) {
          if (w === 'k' && prev?.type !== 'num') break;
          if (w === 'man' && !run.length) break;
          run.push(x); j++; continue;
        }
        if (w === 'and' && prev?.lower === 'hundred' && (EN_UNITS[tokens[j + 1]?.lower] !== undefined || EN_TENS[tokens[j + 1]?.lower] !== undefined)) { j++; continue; }
        if (w === 'a' && /^(hundred|thousand|million)$/.test(tokens[j + 1]?.lower || '') && run.length && run[run.length - 1].lower === 'half') { run.push(x); j++; continue; }
        if ((w === 'a' || w === 'half') && !run.length) { run.push(x); j++; continue; }
        if (/^(uh|um|er|erm|uhm)$/.test(w)) { j++; continue; }
        break;
      }
      if (x.type === 'ell' && run.length && tokens[j + 1] && (tokens[j + 1].type === 'word' || tokens[j + 1].type === 'num')) { j++; continue; } // "four hundred... eighty thousand"
      // "four hundred. eighty thousand": a pause the transcriber punctuated, inside one spoken number
      if (x.type === 'punct' && /^[.,]$/.test(x.text) && prev?.lower === 'hundred') {
        const nx = tokens[j + 1]?.lower;
        if ((EN_TENS[nx] !== undefined || EN_UNITS[nx] !== undefined) && tokens.slice(j + 1, j + 5).some((t) => t.type === 'word' && EN_BIG[t.lower] !== undefined && t.lower !== 'man')) { j++; continue; }
      }
      break;
    }
    if (!run.length) { i++; continue; }

    // Korean attachment checks on the first/last hangul numeral token
    const first = run[0];
    const last = run[run.length - 1];
    const before = tokens[i - 1];
    const after = tokens[j];
    const attachedBefore = before && !first.gap && before.type === 'hangul' && first.type === 'ko';
    let attachedAfter = after && !after.gap && after.type === 'hangul';
    if (attachedAfter && last.type === 'ko' && !KO_SUFFIX.test(after.text)) {
      // 만약, 백화점, 사장님, 천천히: numeral characters at the start of an ordinary word
      i = j; continue;
    }

    // turn run tokens into atoms
    const atoms = [];
    let failed = false;
    for (let k = 0; k < run.length; k++) {
      const x = run[k];
      if (x.type === 'num') {
        atoms.push({ kind: 'n', n: parseFloat(x.text.replace(/,/g, '')), index: x.index, end: x.end, decimal: x.text.includes('.') });
      } else if (x.type === 'ko') {
        let s = x.text;
        // particle 이 after 만/억: 오십만이요 -> 오십만
        if (k === run.length - 1 && attachedAfter && /[만억][일이삼사오육칠팔구]$/.test(s)) s = s.slice(0, -1);
        const onlyUnits = [...s].every((c) => KO_SMALL[c] || KO_BIG[c]);
        if (onlyUnits && atoms.length && atoms[atoms.length - 1].kind === 'n') {
          // 48만, 1.5천만, 5천 -> number followed by units
          for (const c of s) atoms.push({ kind: KO_BIG[c] ? 'big' : 'small', mult: KO_BIG[c] || KO_SMALL[c], index: x.index, end: x.end, ko: true });
        } else {
          const v = koNumeral(s);
          if (!v) { failed = true; break; }
          if (v.range) { atoms.push({ kind: 'range', range: v.range, hasBig: v.hasBig, index: x.index, end: x.end }); continue; }
          if (!v.hasUnit && attachedBefore && k === 0) { failed = true; break; }
          atoms.push({ kind: 'n', n: v.value, index: x.index, end: x.end, ko: true, koBig: v.hasBig, koUnit: v.hasUnit });
        }
      } else {
        const w = x.lower;
        if (EN_UNITS[w] !== undefined) atoms.push({ kind: 'n', n: EN_UNITS[w], word: true, index: x.index, end: x.end });
        else if (EN_TENS[w] !== undefined) atoms.push({ kind: 'n', n: EN_TENS[w], word: true, index: x.index, end: x.end });
        else if (w === 'hundred') atoms.push({ kind: 'small', mult: 100, en: true, index: x.index, end: x.end });
        else if (EN_BIG[w] !== undefined) atoms.push({ kind: 'big', mult: EN_BIG[w], en: true, man: w === 'man', index: x.index, end: x.end });
        else if (w === 'half') atoms.push({ kind: 'half', index: x.index, end: x.end });
        else if (w === 'a') atoms.push({ kind: 'a', index: x.index, end: x.end });
      }
    }
    if (failed) { i = j; continue; }

    // a hangul numeral token that already carries 만/억 counts as big-scaled
    const pieces = [];
    const buf = [];
    const flushBuf = () => { if (buf.length) { for (const p of evalAtoms(buf)) pieces.push(p); buf.length = 0; } };
    for (const a of atoms) {
      if (a.kind === 'range') { flushBuf(); pieces.push({ value: null, range: a.range, scaled: true, big: a.hasBig, index: a.index, end: a.end }); continue; }
      if (a.kind === 'n' && a.koBig) {
        // 사십팔만 is complete on its own; a following 5천 adds (48만 5천)
        flushBuf();
        buf.push({ kind: 'n', n: a.n, index: a.index, end: a.end });
        pieces.push(...evalAtoms(buf).map((p) => ({ ...p, scaled: true, big: true })));
        buf.length = 0;
        continue;
      }
      buf.push(a);
    }
    flushBuf();
    // merge "48만" + "5천": a big-scaled piece followed right away by a smaller scaled piece
    const merged = [];
    for (const p of pieces) {
      const prev = merged[merged.length - 1];
      if (prev && prev.big && !p.big && !p.range && p.value != null && prev.value != null && p.value < 1e4 && p.index - prev.end <= 1) {
        prev.value += p.value; prev.end = p.end; continue;
      }
      merged.push({ ...p });
    }
    for (const p of merged) items.push(p);
    i = j;
  }
  return items;
}

/**
 * Parse every number-like phrase and decide which ones are money.
 * @param {string} text
 */
export function parseAmounts(text) {
  const norm = normalize(text);
  const tokens = tokenize(norm);
  const raw = numericItems(tokens);

  // correction markers (positions)
  const corrections = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.type === 'word' && CORRECTION_EN.has(t.lower)) corrections.push(t.index);
    if (t.type === 'word') {
      for (const pair of CORRECTION_EN_PAIRS) {
        if (pair.every((w, o) => tokens[k + o]?.lower === w)) corrections.push(t.index);
      }
    }
    if (t.type === 'hangul' && /^(아니(?!면)|말고|정정)/.test(t.text)) corrections.push(t.index);
  }

  const items = raw.map((p) => {
    const after = tokens.find((t) => t.index >= p.end);
    const before = [...tokens].reverse().find((t) => t.end <= p.index);
    const nearAfter = after && after.index - p.end <= 2 ? after : null;
    let won = false;
    let nonMoney = false;
    let currency = 'KRW';
    if (nearAfter) {
      if (nearAfter.type === 'won' || (nearAfter.type === 'word' && /^(won|krw)$/.test(nearAfter.lower))) won = true;
      if (nearAfter.type === 'hangul' && /^원/.test(nearAfter.text)) won = true;
      if (nearAfter.type === 'pct') nonMoney = true;
      if (nearAfter.type === 'word' && NON_MONEY_EN.has(nearAfter.lower)) nonMoney = true;
      if (nearAfter.type === 'hangul' && NON_MONEY_KO.test(nearAfter.text)) nonMoney = true;
      if (nearAfter.type === 'word' && /^(dollars?|usd|bucks)$/.test(nearAfter.lower)) currency = 'USD';
    }
    if (before && before.type === 'dollar' && p.index - before.end <= 1) currency = 'USD';
    if (before && before.type === 'won' && before.text === '₩') won = true;
    const value = p.value;
    const range = p.range || null;
    const big = p.big || (range ? range[1] >= 1e4 : value >= 1e4);
    const money = !p.bad && !nonMoney && currency === 'KRW' && (won || big);
    return { value: range ? null : value, range, text: norm.slice(p.index, p.end).trim(), index: p.index, end: p.end, money, scaled: Boolean(p.scaled), currency, bad: Boolean(p.bad) };
  });

  // ranges between two items: "four or five hundred thousand", "300 to 400 thousand", "40에서 50만", "40~50만", "between A and B"
  for (let k = 0; k < items.length - 1; k++) {
    const A = items[k];
    const B = items[k + 1];
    if (A.range || B.range || A.value == null || B.value == null) continue;
    const between = tokens.filter((t) => t.index >= A.end && t.end <= B.index);
    const connector = between.length > 0 && between.length <= 2 && between.every((t) => (t.type === 'word' && RANGE_EN.has(t.lower)) || t.type === 'sep' || (t.type === 'hangul' && KO_RANGE_WORDS.test(t.text)) || (t.type === 'punct' && t.text === ','));
    const betweenAnd = between.length === 1 && between[0].lower === 'and' && tokens.some((t) => t.lower === 'between' && t.end <= A.index && A.index - t.end <= 2);
    if (!connector && !betweenAnd) continue;
    if (between.every((t) => t.type === 'punct') && corrections.some((c) => c >= A.end && c <= B.index)) continue;
    if (!B.money) continue;
    let lo = A.value;
    if (!A.money) {
      // scale A to B's order of magnitude: 4 vs 500,000 -> 400,000
      if (lo <= 0) continue;
      const mag = (n) => Math.floor(Math.log10(n));
      lo = lo * 10 ** (mag(B.value) - mag(lo));
      if (lo > B.value) lo /= 10;
    }
    if (!(lo > 0 && lo < B.value && B.value / lo <= 5)) continue;
    const merged = { value: null, range: [Math.round(lo), B.value], text: norm.slice(A.index, B.end).trim(), index: A.index, end: B.end, money: true, scaled: true, currency: 'KRW', bad: false };
    items.splice(k, 2, merged);
  }

  // corrected: a correction marker sits after some number and before a later money item
  let lastCorrectionAt = -1;
  for (const c of corrections) {
    const hasBefore = items.some((it) => it.end <= c);
    const hasAfter = items.some((it) => it.index >= c && it.money);
    if (hasBefore && hasAfter) lastCorrectionAt = Math.max(lastCorrectionAt, c);
  }
  return { items, corrected: lastCorrectionAt >= 0, lastCorrectionAt };
}

/** All money values (ranges excluded) in a text, e.g. for matching a ledger row against a transcript. */
export function moneyValues(text) {
  return parseAmounts(text).items.filter((i) => i.money && i.value != null).map((i) => i.value);
}

/**
 * The single budget a sentence states, per the grounding rules (design 6-5, rule 4):
 * after a correction marker only the last amount counts; without one, two amounts or a range are ambiguous.
 */
export function pickAmount(text) {
  const { items, corrected, lastCorrectionAt } = parseAmounts(text);
  let money = items.filter((i) => i.money);
  if (!money.length) return { status: 'none', items };
  if (corrected) {
    const afterFix = money.filter((i) => i.index >= lastCorrectionAt);
    if (afterFix.length) money = [afterFix[afterFix.length - 1]];
  }
  const ranges = money.filter((i) => i.range);
  if (ranges.length) {
    const r = ranges[ranges.length - 1];
    return { status: 'ambiguous', options: [...r.range], item: r, items };
  }
  const distinct = [...new Set(money.map((i) => i.value))];
  if (distinct.length > 1) return { status: 'ambiguous', options: distinct.slice(0, 3).sort((a, b) => a - b), items };
  const item = money[money.length - 1];
  return { status: 'ok', value: item.value, item, items };
}

// ---------- saying amounts back ----------

const KO_DIGIT_WORD = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];

function koGroup(n) {
  // n < 10000, Korean reading with the 1 omitted before 십/백/천
  let s = '';
  const units = [[1000, '천'], [100, '백'], [10, '십']];
  let rest = n;
  for (const [u, name] of units) {
    const d = Math.floor(rest / u);
    if (d) s += (d === 1 ? '' : KO_DIGIT_WORD[d]) + name;
    rest %= u;
  }
  if (rest) s += KO_DIGIT_WORD[rest];
  return s;
}

/** 480000 -> "사십팔만 원", 1000000 -> "백만 원", 10000 -> "만 원" */
export function koreanWords(value, { suffix = ' 원' } = {}) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return `영${suffix}`;
  const eok = Math.floor(n / 1e8);
  const man = Math.floor((n % 1e8) / 1e4);
  const rest = n % 1e4;
  const parts = [];
  if (eok) parts.push(`${koGroup(eok) || '일'}억`);
  if (man) parts.push(`${man === 1 ? '' : koGroup(man)}만`);
  if (rest) parts.push(koGroup(rest));
  return `${parts.join(' ')}${suffix}`;
}

/** 480000 -> "48만 원", 485000 -> "48만 5천 원", 1000000 -> "100만 원" (what Korean TTS reads naturally) */
export function koreanShort(value) {
  const n = Math.round(Number(value));
  const eok = Math.floor(n / 1e8);
  const man = Math.floor((n % 1e8) / 1e4);
  const rest = n % 1e4;
  const parts = [];
  if (eok) parts.push(`${eok}억`);
  if (man) parts.push(`${man}만`);
  if (rest) parts.push(rest % 1000 === 0 ? `${rest / 1000}천` : String(rest));
  return `${parts.join(' ') || '0'} 원`;
}

const EN_ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS_WORD = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enHundreds(n) {
  const parts = [];
  if (n >= 100) { parts.push(`${EN_ONES[Math.floor(n / 100)]} hundred`); n %= 100; }
  if (n >= 20) { parts.push(EN_TENS_WORD[Math.floor(n / 10)] + (n % 10 ? `-${EN_ONES[n % 10]}` : '')); n = 0; }
  if (n > 0) parts.push(EN_ONES[n]);
  return parts.join(' ');
}

/** 480000 -> "four hundred eighty thousand" */
export function englishWords(value) {
  let n = Math.round(Number(value));
  if (!Number.isFinite(n) || n <= 0) return 'zero';
  const parts = [];
  for (const [u, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
    if (n >= u) { parts.push(`${enHundreds(Math.floor(n / u))} ${name}`); n %= u; }
  }
  if (n) parts.push(enHundreds(n));
  return parts.join(' ');
}

/** What the agent says when it reads a budget back. */
export function readBack(value, lang = 'en') {
  return lang === 'ko' ? `월 ${koreanShort(value)}` : `${englishWords(value)} won a month`;
}

/** Amount in words for the ledger row label: "사십팔만 원" / "four hundred eighty thousand won". */
export function spokenAmount(value, lang = 'en') {
  return lang === 'ko' ? koreanWords(value) : `${englishWords(value)} won`;
}
