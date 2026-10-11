/** Number readings shared by the ASR round-trip check and the aligner input (PLAN 5.2 / 5.3). */

const KO_DIGITS = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const KO_SMALL = ['', '십', '백', '천'];
const KO_LARGE = ['', '만', '억', '조'];

/** Sino-Korean reading of a non-negative integer string (e.g. "1200" → "천이백"). */
export function koreanInteger(digits: string): string {
  const n = digits.replace(/^0+(?=\d)/, '');
  if (n === '0') return '영';
  const groups: string[] = [];
  for (let end = n.length; end > 0; end -= 4) groups.unshift(n.slice(Math.max(0, end - 4), end));
  let out = '';
  groups.forEach((g, gi) => {
    let part = '';
    const padded = g.padStart(4, '0');
    for (let i = 0; i < 4; i++) {
      const d = Number(padded[i]);
      if (d === 0) continue;
      const unit = KO_SMALL[3 - i]!;
      part += (d === 1 && unit ? '' : KO_DIGITS[d]) + unit;
    }
    if (part)
      out +=
        (part === '일' && groups.length - gi - 1 === 1 ? '' : part) +
        KO_LARGE[groups.length - gi - 1];
  });
  return out;
}

/** Read every number in Korean text: "1,200개" → "천이백개", "2.5.1" → "이점오점일". */
export function readKoreanNumbers(text: string): string {
  return text.replace(/\d[\d,]*(?:\.\d+)*/g, (m) => {
    const parts = m.replace(/,/g, '').split('.');
    return parts
      .map((p, i) =>
        i === 0
          ? koreanInteger(p)
          : [...p].map((d) => (d === '0' ? '영' : KO_DIGITS[Number(d)])).join(''),
      )
      .join('점');
  });
}

const KANJI_DIGIT: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const KANJI_SMALL: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const KANJI_LARGE: Record<string, number> = { 万: 1e4, 億: 1e8 };

function kanjiValue(s: string): number | null {
  // Positional (二〇二六) or structured (二千二十六, 三万五千) numerals.
  if ([...s].every((c) => c in KANJI_DIGIT))
    return s.length > 1 ? Number([...s].map((c) => KANJI_DIGIT[c]).join('')) : KANJI_DIGIT[s]!;
  let total = 0;
  let section = 0;
  let digit: number | null = null;
  for (const c of s) {
    if (c in KANJI_DIGIT) digit = KANJI_DIGIT[c]!;
    else if (c in KANJI_SMALL) {
      section += (digit ?? 1) * KANJI_SMALL[c]!;
      digit = null;
    } else if (c in KANJI_LARGE) {
      total += (section + (digit ?? 0)) * KANJI_LARGE[c]!;
      section = 0;
      digit = null;
    } else return null;
  }
  return total + section + (digit ?? 0);
}

/**
 * Japanese: kanji numerals → digits, so "二十九" and "29" compare equal. A lone 一 inside a word
 * (一緒, 一番) stays: only runs that contain a power (十百千万億) or two or more digits convert.
 */
export function kanjiNumeralsToDigits(text: string): string {
  return text.replace(/[〇零一二三四五六七八九十百千万億]+/g, (m) => {
    const structured = /[十百千万億]/.test(m);
    if (!structured && [...m].length < 2) return m;
    const v = kanjiValue(m);
    return v === null ? m : String(v);
  });
}

const EN_UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const EN_TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const EN_SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
};

/** English: spelled-out numbers → digits ("twenty-nine" → "29", "two hundred" → "200"). */
export function englishNumbersToDigits(text: string): string {
  const word =
    '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)';
  const run = new RegExp(`\\b${word}(?:(?:[\\s-]+|\\s+and\\s+)${word})*\\b`, 'gi');
  return text.replace(run, (m) => {
    let total = 0;
    let current = 0;
    for (const w of m.toLowerCase().split(/[\s-]+/)) {
      if (w === 'and') continue;
      if (w in EN_UNITS) current += EN_UNITS[w]!;
      else if (w in EN_TENS) current += EN_TENS[w]!;
      else if (w === 'hundred') current = (current || 1) * 100;
      else if (w in EN_SCALES) {
        total += (current || 1) * EN_SCALES[w]!;
        current = 0;
      }
    }
    return String(total + current);
  });
}

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/g, 'cannot'],
  [/\bwon't\b/g, 'will not'],
  [/\b(\w+)n't\b/g, '$1 not'],
  [/\b(i|you|we|they)'re\b/g, '$1 are'],
  [/\b(i|you|we|they)'ve\b/g, '$1 have'],
  [/\b(i|you|we|they|he|she|it)'ll\b/g, '$1 will'],
  [/\b(i|you|we|they|he|she|it)'d\b/g, '$1 would'],
  [/\bi'm\b/g, 'i am'],
  [/\blet's\b/g, 'let us'],
  // 's after these words is "is" (possessive 's elsewhere is left alone).
  [/\b(it|that|there|here|what|he|she|who|where)'s\b/g, '$1 is'],
];

/** English contractions expanded, so "it's" and "it is" compare equal (input lowercased). */
export function expandContractions(text: string): string {
  let t = text.replace(/[\u2019\u2018]/g, "'");
  for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
  return t;
}
