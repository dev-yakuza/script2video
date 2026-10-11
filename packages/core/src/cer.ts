/**
 * ASR round-trip check (PLAN 5.2 ①): character error rate between the script and what an ASR
 * model heard in the synthesized audio, after normalizing both sides the same way.
 *
 * ASR writes canonical spellings ("CLI" for "씨엘아이", digits for spoken numbers), so:
 * - NFKC, lowercase, drop punctuation / symbols / spaces
 * - numbers are written the same way on both sides (ko: Sino-Korean reading; ja: kanji numerals
 *   as digits; en: number words as digits, contractions expanded)
 * - each pronunciation-dictionary span accepts either the original or the replacement
 */

import type { Lang } from './schema.js';
import { buildMatcher } from './tts-text.js';

import {
  englishNumbersToDigits,
  expandContractions,
  kanjiNumeralsToDigits,
  readKoreanNumbers,
} from './numbers.js';

export { koreanInteger, readKoreanNumbers } from './numbers.js';

export function normalizeForCer(text: string, lang: Lang): string {
  let t = text.normalize('NFKC').toLowerCase();
  if (lang === 'ko') t = readKoreanNumbers(t);
  if (lang === 'ja') t = kanjiNumeralsToDigits(t);
  if (lang === 'en') t = englishNumbersToDigits(expandContractions(t));
  return [...t].filter((ch) => !/[\p{P}\p{S}\p{Z}\s]/u.test(ch)).join('');
}

function editDistance(a: string, b: string): number {
  const ac = [...a];
  const bc = [...b];
  let prev = Array.from({ length: bc.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ac.length; i++) {
    const cur = [i];
    for (let j = 1; j <= bc.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (ac[i - 1] === bc[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[bc.length]!;
}

/**
 * CER of `heard` against `script`, letting each dictionary span match either spelling.
 * Spans are resolved independently (greedy per span, which is exact when spans do not interact).
 */
export function roundTripCer(
  script: string,
  heard: string,
  lang: Lang,
  pronounce: Record<string, string> = {},
): number {
  const hyp = normalizeForCer(heard, lang);
  const matcher = buildMatcher(pronounce);
  const lower = new Map(Object.entries(pronounce).map(([k, v]) => [k.toLowerCase(), v]));
  // Split the script into fixed text and alternative spans.
  const pieces: string[][] = [];
  let pos = 0;
  for (const m of matcher ? script.matchAll(matcher) : []) {
    pieces.push([script.slice(pos, m.index)]);
    pieces.push([m[0], lower.get(m[0].toLowerCase()) ?? m[0]]);
    pos = m.index + m[0].length;
  }
  pieces.push([script.slice(pos)]);
  // Choose each alternative to minimize the distance of the whole reference.
  const choice = pieces.map((alts) => alts[0]!);
  pieces.forEach((alts, i) => {
    if (alts.length < 2) return;
    let best = Infinity;
    for (const alt of alts) {
      choice[i] = alt;
      const d = editDistance(normalizeForCer(choice.join(''), lang), hyp);
      if (d < best) {
        best = d;
        pieces[i] = [alt, ...alts.filter((a) => a !== alt)];
      }
    }
    choice[i] = pieces[i]![0]!;
  });
  const ref = normalizeForCer(choice.join(''), lang);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return editDistance(ref, hyp) / [...ref].length;
}
