/**
 * Narration from your own recording (`:audio{src=...}` on a paragraph, PLAN 5.3). The whole
 * paragraph is aligned once against its text; the words are then handed to the sentences in
 * order (by spoken characters) and the recording is cut between sentences, in the middle of the
 * gap, so each sentence gets its own audio, word times and cues like a synthesized one.
 */

import { normalizeForCer, type AlignedWord, type Lang } from '@script2video/core';

/** Speech kept before the first / after the last word of a sentence (seconds). */
const LEAD_S = 0.1;
const TAIL_S = 0.2;

export interface SentenceCut {
  from: number;
  to: number;
  /** Word times relative to `from`. */
  words: AlignedWord[];
}

/**
 * Give each sentence the aligned words that spell it (normalized characters), and cut points
 * halfway between sentences. Throws when the words run out (the recording says less than the
 * text: a skipped sentence), naming the sentence.
 */
export function splitRecording(
  words: AlignedWord[],
  sentences: string[],
  lang: Lang,
  duration: number,
): SentenceCut[] {
  const len = (s: string) => [...normalizeForCer(s, lang)].length;
  const groups: AlignedWord[][] = [];
  let i = 0;
  for (const [n, text] of sentences.entries()) {
    const need = len(text);
    const group: AlignedWord[] = [];
    let have = 0;
    while (i < words.length && (have < need || group.length === 0)) {
      const w = words[i++]!;
      group.push(w);
      have += len(w.text);
    }
    if (group.length === 0)
      throw new Error(`recording ends before sentence ${n + 1} ("${text}"): is it missing?`);
    // The last sentence takes whatever words remain (minor alignment drift).
    if (n === sentences.length - 1) while (i < words.length) group.push(words[i++]!);
    groups.push(group);
  }
  return groups.map((g, n) => {
    const prev = groups[n - 1];
    const next = groups[n + 1];
    const first = g[0]!.start;
    const last = g[g.length - 1]!.end;
    const from = prev ? (prev[prev.length - 1]!.end + first) / 2 : Math.max(0, first - LEAD_S);
    const to = next ? (last + next[0]!.start) / 2 : Math.min(duration, last + TAIL_S);
    return {
      from,
      to,
      words: g.map((w) => ({ text: w.text, start: w.start - from, end: w.end - from })),
    };
  });
}

/** Where one paragraph sits in a long recording (seconds), from its aligned words. */
export interface ParagraphSpan {
  first: number;
  last: number;
}

/**
 * Cut points for paragraphs found in one recording: halfway through each gap between
 * paragraphs, a little lead before the first and tail after the last.
 */
export function paragraphCuts(
  spans: ParagraphSpan[],
  duration: number,
): { from: number; to: number }[] {
  return spans.map((p, k) => ({
    from: k === 0 ? Math.max(0, p.first - 0.15) : (spans[k - 1]!.last + p.first) / 2,
    to:
      k === spans.length - 1
        ? Math.min(duration, p.last + 0.3)
        : (p.last + spans[k + 1]!.first) / 2,
  }));
}
