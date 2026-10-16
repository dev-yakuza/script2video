/**
 * Gates for the training data of a persona's trained speaker (acting stage 4 plan 5). They copy the
 * S2 experiment that the user chose (experiments/m7-acting: s2data.py, s2emo.py, s2emo2.py,
 * e3s1.gate, e1b.analyse, s2gen.longest_pause) — constants, measures, rounding and picks — so the
 * pass count can be compared with it. They are stricter than the gates of synthesis (3.5, 3.6).
 * Pure: the CLI measures, these judge.
 */

import { HIGH_PITCH, type Emotion } from './acting.js';
import { normalizeForCer } from './cer.js';

export const TRAIN_GATES = {
  version: 1,
  cer: { neutral: 0.1, emotion: 0.15 },
  /** Neutral: semitones from the median of all neutral takes. */
  neutralF0St: 3,
  /** Emotion: semitones from the round's baseline (HIGH_PITCH emotions may go higher). */
  emotionF0St: { low: -4.5, high: 4.5, highPitch: 6 },
  /** Neutral: heard rate against the median rate of all neutral takes. */
  rate: [0.75, 1.35] as const,
  /** Emotion: length against the expected length (raw text length ÷ the round's rate). */
  length: [0.7, 1.35] as const,
  /** Longest pause inside an emotion take; longer when the line has a break in it. */
  pause: { plain: 0.45, punct: 0.8 },
  edgeS: 0.35,
  noiseS: 0.75,
  /** Emotion: x-vector similarity with the persona's reference clip. */
  simMin: 0.965,
} as const;

/** Python's `round(x, d)` for the values S2 rounded (ties are not exact in practice). */
export const round = (x: number, d: number) => Number(x.toFixed(d));

/** Python's `statistics.median`: the mean of the two middle values for an even count. */
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** numpy's `percentile` with linear interpolation. */
export function percentile(xs: ArrayLike<number>, p: number): number {
  const s = Array.from(xs).sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const pos = ((s.length - 1) * p) / 100;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, s.length - 1);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
}

/**
 * S2's longest pause (s2gen.longest_pause): librosa RMS (frame 40 ms, hop 10 ms, centred with zero
 * padding, 1 + ⌊n/hop⌋ frames) in dB, quiet = more than 30 dB under the 90th percentile, the
 * longest quiet run from the first loud frame up to (not including) the last one, in seconds.
 */
export function longestPauseS2(samples: Float32Array, sr: number): number {
  const hop = Math.floor(sr * 0.01);
  const frame = hop * 4;
  const half = frame >> 1;
  const n = samples.length;
  const frames = 1 + Math.floor(n / hop);
  const db = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    const start = f * hop - half;
    let sum = 0;
    for (let i = start; i < start + frame; i++) if (i >= 0 && i < n) sum += samples[i]! ** 2;
    db[f] = 20 * Math.log10(Math.sqrt(sum / frame) + 1e-9);
  }
  const threshold = percentile(db, 90) - 30;
  const quiet = Array.from(db, (x) => x < threshold);
  const loud: number[] = [];
  quiet.forEach((q, i) => {
    if (!q) loud.push(i);
  });
  let best = 0;
  let run = 0;
  if (loud.length > 0)
    for (const q of quiet.slice(loud[0], loud[loud.length - 1])) {
      run = q ? run + 1 : 0;
      best = Math.max(best, run);
    }
  return round(best * 0.01, 2);
}

/** One take as S2 measured it (e1b.analyse, rounded the same way). */
export interface TrainMeasure {
  /** Length of the raw file. */
  seconds: number;
  /** Median pitch (Hz), null when too few voiced frames. */
  f0: number | null;
  lead: number;
  tail: number;
  noise: number;
  cer: number;
  /** Emotion takes: longest pause and similarity with the reference clip. */
  pause?: number;
  sim?: number;
}

const st = (f0: number, ref: number) => 12 * Math.log2(f0 / ref);

// ---------- neutral data (s2data.py) ----------

/** Heard rate of a neutral take: normalized characters per second, as S2 (`norm`). */
export const neutralRate = (text: string, seconds: number) =>
  round([...normalizeForCer(text, 'ko')].length / seconds, 2);

/** Baseline of the neutral data: the medians of all neutral takes (f0 without the unmeasured). */
export function neutralBaseline(takes: { f0: number | null; rate: number }[]) {
  return {
    f0: median(takes.flatMap((t) => (t.f0 ? [t.f0] : []))),
    rate: median(takes.map((t) => t.rate)),
  };
}

export interface NeutralJudged {
  fails: string[];
  /** Semitones from the baseline, rounded (99 without f0, as S2). */
  f0St: number;
}

export function neutralFails(
  m: TrainMeasure,
  rate: number,
  base: { f0: number; rate: number },
): NeutralJudged {
  const g = TRAIN_GATES;
  const d = m.f0 ? st(m.f0, base.f0) : 99;
  const fails: string[] = [];
  if (Math.abs(d) > g.neutralF0St) fails.push('f0');
  const r = rate / base.rate;
  if (r < g.rate[0] || r > g.rate[1]) fails.push('rate');
  if (m.cer > g.cer.neutral) fails.push('cer');
  if (m.lead > g.edgeS || m.tail > g.edgeS) fails.push('edge');
  if (m.noise > g.noiseS) fails.push('noise');
  return { fails, f0St: round(d, 1) };
}

/** The neutral take kept for a sentence: lowest CER, then f0 nearest the baseline (first wins). */
export function pickNeutral<T extends { cer: number; f0St: number; fails: string[] }>(
  takes: T[],
): T | undefined {
  let best: T | undefined;
  for (const t of takes) {
    if (t.fails.length) continue;
    if (!best || t.cer < best.cer || (t.cer === best.cer && Math.abs(t.f0St) < Math.abs(best.f0St)))
      best = t;
  }
  return best;
}

// ---------- emotion data (s2emo.py, s2emo2.py, e3s1.gate) ----------

/**
 * Baseline of a round: the round vector's uninstructed takes — f0 median (Hz), its spread
 * (semitones, for the record only) and the rate as raw text length per second (S2 `len(text)`).
 */
export function roundBaseline(takes: { f0: number | null; seconds: number; text: string }[]) {
  const f0s = takes.flatMap((t) => (t.f0 ? [t.f0] : []));
  const f0 = median(f0s);
  const sts = f0s.map((x) => st(x, f0));
  const mean = sts.reduce((a, b) => a + b, 0) / Math.max(1, sts.length);
  const sigma = Math.sqrt(sts.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, sts.length));
  return { f0, sigma, rate: median(takes.map((t) => t.text.length / t.seconds)) };
}

/** S2 `pause_ok`: 0.8 s when the line has `. , ? !` before its last character, else 0.45 s. */
export const pauseLimit = (text: string) =>
  /[.,?!]/.test(text.slice(0, -1)) ? TRAIN_GATES.pause.punct : TRAIN_GATES.pause.plain;

export interface EmotionJudged {
  fails: string[];
  /** Semitones from the round baseline (rounded; absent without f0). */
  f0St?: number;
  /** Actual ÷ expected length (rounded). */
  lenX: number;
}

export function emotionFails(
  m: TrainMeasure,
  emo: Emotion,
  text: string,
  base: { f0: number; rate: number },
): EmotionJudged {
  const g = TRAIN_GATES;
  const fails: string[] = [];
  let f0St: number | undefined;
  // without f0 the pitch is not checked (e3s1.gate)
  if (m.f0) {
    const d = st(m.f0, base.f0);
    f0St = round(d, 1);
    const high = (HIGH_PITCH as readonly string[]).includes(emo)
      ? g.emotionF0St.highPitch
      : g.emotionF0St.high;
    if (d < g.emotionF0St.low || d > high) fails.push(`f0 ${d >= 0 ? '+' : ''}${d.toFixed(1)}st`);
  }
  const ratio = m.seconds / (text.length / base.rate);
  if (ratio < g.length[0] || ratio > g.length[1]) fails.push(`length x${ratio.toFixed(2)}`);
  if (m.lead > g.edgeS || m.tail > g.edgeS) fails.push('edge');
  if (m.noise > g.noiseS) fails.push(`noise ${m.noise}s`);
  if (m.cer > g.cer.emotion) fails.push(`cer ${m.cer}`);
  if (m.sim === undefined || m.sim < g.simMin) fails.push(`similarity ${m.sim}`);
  if (m.pause === undefined || m.pause > pauseLimit(text)) fails.push(`pause ${m.pause}`);
  return { fails, ...(f0St !== undefined ? { f0St } : {}), lenX: round(ratio, 2) };
}

/** S2 intensity (s2gen.intensity): pitch distance and speed change, the speed term not capped. */
export const intensity = (j: { f0St?: number; lenX: number }) =>
  Math.abs(j.f0St ?? 0) / 2 + Math.abs(1 / j.lenX - 1) / 0.1;

/** Python `max(…, key)`: the first of the highest. */
export function firstMax<T>(xs: T[], key: (x: T) => number): T | undefined {
  let best: T | undefined;
  let bestKey = -Infinity;
  for (const x of xs) {
    const k = key(x);
    if (best === undefined || k > bestKey) {
      best = x;
      bestKey = k;
    }
  }
  return best;
}
