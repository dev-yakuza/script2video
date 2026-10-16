/**
 * Takes of an emotion line (acting plan 3.5, stage 3 plan 4–5): when to stop making takes, and
 * which passing take to keep. Pure functions over measured takes; `tts` measures and judges.
 */

import { ENDING_FLOOR, ENDING_LIFT, LOW_AROUSAL, type Emotion } from './acting.js';

/** Takes made first for an emotion line, and the most it gets (Q4). */
export const FIRST_TAKES = 3;
export const MAX_TAKES = 6;

/** What selection reads from a judged take. */
export interface TakeFacts {
  n: number;
  ok: boolean;
  /** Median pitch of the take (Hz, null: unmeasurable). */
  f0: number | null;
  /** Raw take inside the aligned words (seconds) and its ending (semitones, null: unmeasurable). */
  rawDuration: number | null;
  rawEnding: number | null;
  /** Heard speaking rate (characters per second of the final wav's words), for neighbor matching. */
  rate: number | null;
}

export interface TakeContext {
  /** Standard emotion of the line (undefined: a user emotion — no emotion set applies). */
  emotion?: Emotion;
  power?: 'weak' | 'strong';
  /** The line ends with a question mark (the ending floor's cell). */
  question: boolean;
  /** Reference pitch (Hz) of the voice, null without a voice reference. */
  refF0: number | null;
  /** Expected raw length (seconds), null without a voice reference. */
  expected: number | null;
}

/** A line ends with `?` / `？` once closing quotes and brackets are dropped. */
export function endsWithQuestion(text: string): boolean {
  return /[?？]$/.test(text.trim().replace(/["'”’」』)）\]\s]+$/u, ''));
}

const lifts = (ctx: TakeContext) =>
  ctx.emotion !== undefined && (ENDING_LIFT as readonly string[]).includes(ctx.emotion);

/** The take's ending reaches the emotion's floor (an unmeasurable ending does not). */
export function endingReached(t: TakeFacts, ctx: TakeContext): boolean {
  if (!ctx.emotion || t.rawEnding === null) return false;
  const floor = ENDING_FLOOR[ctx.emotion][ctx.question ? 'question' : 'other'];
  return t.rawEnding >= floor;
}

/**
 * Enough takes of an emotion line: two pass, and for an ENDING_LIFT emotion one passing take
 * reaches the ending floor (two with `power`, so the power rule still has a choice).
 */
export function takeBudgetDone(takes: TakeFacts[], ctx: TakeContext): boolean {
  const passed = takes.filter((t) => t.ok);
  if (passed.length < 2) return false;
  if (!lifts(ctx)) return true;
  return passed.filter((t) => endingReached(t, ctx)).length >= (ctx.power ? 2 : 1);
}

/** How strongly a take acts: pitch away from the voice, and length away from the expected. */
export function takeStrength(t: TakeFacts, ctx: TakeContext): number {
  let s = 0;
  if (ctx.refF0 && t.f0) s += Math.abs(12 * Math.log2(t.f0 / ctx.refF0)) / 2;
  if (ctx.expected && t.rawDuration) {
    const ratio = t.rawDuration / ctx.expected;
    s += Math.min(Math.abs(1 / ratio - 1), 0.3) / 0.1;
  }
  return s;
}

/** The previous sentence of the paragraph, for neighbor matching (stage 3 plan 5.6). */
export interface Neighbor {
  f0: number | null;
  rate: number | null;
}

export interface Selection<T extends TakeFacts> {
  take: T;
  /** Passing takes considered, the target rank among them and the chosen one's rank. */
  n: number;
  rank: number;
  chosenRank: number;
  /** Neighbor matching moved the choice off the target rank. */
  neighbor: boolean;
}

/** Weight of the rate difference (chars/s) against the pitch difference (semitones). */
export const NEIGHBOR_RATE_WEIGHT = 1;

const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * Distance of a take to the previous sentence (values rounded as the lock stores them), over the
 * terms every candidate and the previous sentence have.
 */
function neighborDistance(
  t: TakeFacts,
  prev: Neighbor,
  use: { f0: boolean; rate: boolean },
): number | null {
  const parts: number[] = [];
  if (use.f0) parts.push(Math.abs(12 * Math.log2(round1(t.f0!) / round1(prev.f0!))));
  if (use.rate) parts.push(NEIGHBOR_RATE_WEIGHT * Math.abs(round2(t.rate!) - round2(prev.rate!)));
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

/**
 * The take to keep among judged takes (null when none passes — the caller falls back to the
 * fewest failures). Passing takes, narrowed to those reaching the ending floor for an ENDING_LIFT
 * emotion, are ranked by strength: `power=weak` takes the weakest, `strong` the strongest, a
 * LOW_AROUSAL emotion the weakest, others the middle (⌊n/2⌋). With `prev`, ranks r−1…r+1 compete
 * on closeness to the previous sentence.
 */
export function selectTake<T extends TakeFacts>(
  takes: T[],
  ctx: TakeContext,
  prev?: Neighbor,
): Selection<T> | null {
  let pool = takes.filter((t) => t.ok);
  if (pool.length === 0) return null;
  if (lifts(ctx)) {
    const reached = pool.filter((t) => endingReached(t, ctx));
    if (reached.length > 0) pool = reached;
  }
  const ranked = pool
    .map((t) => ({ t, s: takeStrength(t, ctx) }))
    .sort((a, b) => a.s - b.s || a.t.n - b.t.n)
    .map((x) => x.t);
  const n = ranked.length;
  const low = ctx.emotion !== undefined && (LOW_AROUSAL as readonly string[]).includes(ctx.emotion);
  const rank =
    ctx.power === 'weak' ? 0 : ctx.power === 'strong' ? n - 1 : low ? 0 : Math.floor(n / 2);
  let chosen = rank;
  if (prev) {
    let window = [rank, rank - 1, rank + 1].filter((r) => r >= 0 && r < n);
    // a neighbor whose pitch was not measured cannot compete on the rate alone; without the
    // target's pitch, the rate decides for all
    if (prev.f0 && ranked[rank]!.f0) window = window.filter((r) => !!ranked[r]!.f0);
    const use = {
      f0: !!prev.f0 && window.every((r) => !!ranked[r]!.f0),
      rate: !!prev.rate && window.every((r) => !!ranked[r]!.rate),
    };
    let best: number | null = null;
    // ties keep the target rank (it is tried first)
    for (const r of window) {
      const d = neighborDistance(ranked[r]!, prev, use);
      if (d !== null && (best === null || d < best)) {
        best = d;
        chosen = r;
      }
    }
  }
  return { take: ranked[chosen]!, n, rank, chosenRank: chosen, neighbor: chosen !== rank };
}
