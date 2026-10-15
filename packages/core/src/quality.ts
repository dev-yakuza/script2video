/**
 * Bad-output detection for synthesized sentences (PLAN 5.2): LLM-style TTS can skip, repeat or add
 * sounds. A sentence fails when any check fails; the caller re-synthesizes with another seed.
 */

import { normalizeForCer } from './cer.js';
import type { Lang } from './schema.js';
import type { AlignedWord } from './timeline.js';
import { failureWeight } from './voice-check.js';

export const CER_LIMIT: Record<Lang, number> = { ko: 0.15, ja: 0.15, en: 0.1 };
/** Plausible speaking rate in normalized characters per second at speed 1.0. */
export const RATE_RANGE: Record<Lang, [number, number]> = { ko: [3, 11], ja: [4, 13], en: [7, 22] };
/** Sound after the last aligned word longer than this suggests an extra noise or laugh. */
export const MAX_TAIL_S = 1.0;
/**
 * Non-speech sound (laugh, breath, hum) outside the aligned words: a region before the first word,
 * between words or after the last word that lasts at least NONSPEECH_MIN_S and is louder than
 * NONSPEECH_DB. ASR does not transcribe laughs, so CER alone misses them.
 */
export const NONSPEECH_MIN_S = 0.5;
/** Between words breaths are normal, so only clearly audible sound counts there. */
export const NONSPEECH_DB = -38;
/** Before the first / after the last word there should be near-silence (a quiet laugh was -40 dB). */
export const NONSPEECH_EDGE_DB = -45;

export interface SentenceAssessment {
  ok: boolean;
  cer: number | null;
  rate: number;
  tail: number;
  reasons: string[];
}

export function assessSentence(input: {
  text: string;
  lang: Lang;
  duration: number;
  words: AlignedWord[];
  cer: number | null;
  speed?: number;
  /** RMS level in dBFS of the audio between two times (seconds). Enables non-speech detection. */
  loudness?: (from: number, to: number) => number;
}): SentenceAssessment {
  const { text, lang, duration, words, cer, loudness } = input;
  const speed = input.speed ?? 1;
  const reasons: string[] = [];
  const first = words[0]?.start ?? 0;
  const last = words[words.length - 1]?.end ?? duration;
  const spoken = Math.max(0.1, last - first);
  const rate = [...normalizeForCer(text, lang)].length / spoken;
  const [lo, hi] = RATE_RANGE[lang];
  if (rate < lo * speed) reasons.push(`speech rate ${rate.toFixed(1)} chars/s is too slow`);
  if (rate > hi * speed) reasons.push(`speech rate ${rate.toFixed(1)} chars/s is too fast`);
  const tail = Math.max(0, duration - last);
  if (loudness) {
    const regions: [string, number, number][] = [['before the first word', 0, first]];
    for (let i = 0; i + 1 < words.length; i++)
      regions.push([
        `between "${words[i]!.text}" and "${words[i + 1]!.text}"`,
        words[i]!.end,
        words[i + 1]!.start,
      ]);
    regions.push(['after the last word', last, duration]);
    for (const [where, a, b] of regions) {
      if (b - a < NONSPEECH_MIN_S) continue;
      const db = loudness(a, b);
      const edge = a === 0 || b === duration;
      if (db > (edge ? NONSPEECH_EDGE_DB : NONSPEECH_DB))
        reasons.push(`${(b - a).toFixed(2)}s of non-speech sound ${where} (${db.toFixed(0)} dB)`);
    }
  } else if (tail > MAX_TAIL_S) reasons.push(`${tail.toFixed(2)}s of sound after the last word`);
  if (cer !== null && cer > CER_LIMIT[lang]) reasons.push(`ASR round-trip CER ${cer.toFixed(2)}`);
  return { ok: reasons.length === 0, cer, rate, tail, reasons };
}

/**
 * Pick the best attempt: passing first, then fewest failed checks (a wrong voice or an added sound
 * counts double), lowest CER, most typical rate.
 */
export function bestAttempt<T extends { assessment: SentenceAssessment }>(
  attempts: T[],
  lang: Lang,
): T {
  const [lo, hi] = RATE_RANGE[lang];
  const mid = (lo + hi) / 2;
  return [...attempts].sort(
    (a, b) =>
      Number(b.assessment.ok) - Number(a.assessment.ok) ||
      failureWeight(a.assessment.reasons) - failureWeight(b.assessment.reasons) ||
      (a.assessment.cer ?? 0) - (b.assessment.cer ?? 0) ||
      Math.abs(a.assessment.rate - mid) - Math.abs(b.assessment.rate - mid),
  )[0]!;
}
