/**
 * Turn a display sentence into the text sent to TTS (pronunciation dictionary applied) and keep a
 * character-level mapping back to the display text, so that word timings measured on the TTS text
 * can be mapped back to the words the viewer sees (PLAN 4.4 / 5.3).
 */

import { readKoreanNumbers } from './numbers.js';

export interface TtsSpan {
  /** [start, end) in the display text. */
  displayStart: number;
  displayEnd: number;
  /** [start, end) in the TTS text. */
  ttsStart: number;
  ttsEnd: number;
  /** True when this span was rewritten by the pronunciation dictionary. */
  replaced: boolean;
}

export interface TtsText {
  display: string;
  tts: string;
  spans: TtsSpan[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A dictionary key matches only as a whole word: not glued to letters/digits on either side.
// Hangul, kana and kanji count as "other" here, so "React를" still matches "React".
const WORD_CHAR = '[A-Za-z0-9_]';

export function buildMatcher(dict: Record<string, string>): RegExp | null {
  const keys = Object.keys(dict).filter((k) => k.length > 0);
  if (keys.length === 0) return null;
  keys.sort((a, b) => b.length - a.length); // longest first
  const alt = keys.map(escapeRegExp).join('|');
  return new RegExp(`(?<!${WORD_CHAR})(?:${alt})(?!${WORD_CHAR})`, 'giu');
}

export function toTtsText(display: string, dict: Record<string, string>): TtsText {
  const matcher = buildMatcher(dict);
  const lower = new Map(Object.entries(dict).map(([k, v]) => [k.toLowerCase(), v]));
  const spans: TtsSpan[] = [];
  let tts = '';
  let pos = 0;
  const pushPlain = (end: number) => {
    if (end <= pos) return;
    const start = tts.length;
    tts += display.slice(pos, end);
    spans.push({
      displayStart: pos,
      displayEnd: end,
      ttsStart: start,
      ttsEnd: tts.length,
      replaced: false,
    });
  };
  if (matcher) {
    for (const m of display.matchAll(matcher)) {
      const at = m.index;
      pushPlain(at);
      const replacement = lower.get(m[0].toLowerCase()) ?? m[0];
      const start = tts.length;
      tts += replacement;
      spans.push({
        displayStart: at,
        displayEnd: at + m[0].length,
        ttsStart: start,
        ttsEnd: tts.length,
        replaced: true,
      });
      pos = at + m[0].length;
    }
  }
  pushPlain(display.length);
  return { display, tts, spans };
}

/**
 * Text for the forced aligner: the TTS text with numbers spelled out the way they are spoken
 * (ko: Sino-Korean reading), because aligners match characters to sounds and cannot align "29"
 * to "이십구". Number readings become replaced spans, so ranges still map back to the display text.
 * TTS itself keeps the digits (the engines read them fine).
 */
export function toAlignText(display: string, dict: Record<string, string>, lang: string): TtsText {
  const base = toTtsText(display, dict);
  if (lang !== 'ko') return base;
  const spans: TtsSpan[] = [];
  let text = '';
  for (const s of base.spans) {
    const piece = base.tts.slice(s.ttsStart, s.ttsEnd);
    if (s.replaced) {
      const start = text.length;
      text += piece;
      spans.push({ ...s, ttsStart: start, ttsEnd: text.length });
      continue;
    }
    let pos = 0;
    for (const m of piece.matchAll(/\d[\d,]*(?:\.\d+)*/g)) {
      if (m.index > pos) {
        const start = text.length;
        text += piece.slice(pos, m.index);
        spans.push({
          displayStart: s.displayStart + pos,
          displayEnd: s.displayStart + m.index,
          ttsStart: start,
          ttsEnd: text.length,
          replaced: false,
        });
      }
      const start = text.length;
      text += readKoreanNumbers(m[0]);
      spans.push({
        displayStart: s.displayStart + m.index,
        displayEnd: s.displayStart + m.index + m[0].length,
        ttsStart: start,
        ttsEnd: text.length,
        replaced: true,
      });
      pos = m.index + m[0].length;
    }
    if (pos < piece.length) {
      const start = text.length;
      text += piece.slice(pos);
      spans.push({
        displayStart: s.displayStart + pos,
        displayEnd: s.displayEnd,
        ttsStart: start,
        ttsEnd: text.length,
        replaced: false,
      });
    }
  }
  return { display, tts: text, spans };
}

/**
 * Map a [start, end) range in the TTS text back to the display text.
 * A range touching a replaced span expands to that whole display word.
 */
export function ttsRangeToDisplay(t: TtsText, start: number, end: number): [number, number] {
  let dStart = -1;
  let dEnd = -1;
  for (const s of t.spans) {
    if (s.ttsEnd <= start || s.ttsStart >= end) continue;
    const from = s.replaced ? s.displayStart : s.displayStart + Math.max(0, start - s.ttsStart);
    const to = s.replaced ? s.displayEnd : s.displayStart + Math.min(s.ttsEnd, end) - s.ttsStart;
    if (dStart < 0 || from < dStart) dStart = from;
    if (to > dEnd) dEnd = to;
  }
  return dStart < 0 ? [0, 0] : [dStart, dEnd];
}
