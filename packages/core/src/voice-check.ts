/**
 * Speaker consistency (acting plan 3.6): every sentence is compared with a committed reference
 * voice instead of the other sentences of the same run.
 *
 *   reference voice = 4 fixed sentences × 5 seeds synthesized once with the voice, measured
 *   (median pitch, its spread, speaking rate) and compared with one reference clip
 *   (similarity of the Base speaker encoder's x-vectors).
 *
 * A sentence fails when its pitch or similarity falls outside what those 20 takes showed. The
 * similarity is weak at telling people apart (same voice 0.92–0.985, another woman 0.90–0.92), so
 * it is a filter for takes that drifted far from the voice, not a speaker verifier.
 *
 * Also the gates for reference clips made by `voice create` (noise, pauses, cut ending, pitch of
 * the described gender).
 */

import { emotionPitchWindow, emotionSimFloor } from './acting.js';
import type { Lang } from './schema.js';

/** Bump when the reference voice recipe (sentences, seeds, measurements) changes. */
export const VOICE_REF_VERSION = 1;

/** Neutral sentences the reference voice is synthesized with (4 × REF_SEEDS takes). */
export const REF_SENTENCES: Record<Lang, string[]> = {
  ko: [
    '오늘은 날씨가 맑고 바람이 조금 불어요.',
    '회의는 세 시에 시작하니까 조금 일찍 와 주세요.',
    '이 길을 따라 걸으면 작은 공원이 나옵니다.',
    '자료는 내일 오전까지 정리해서 보내 드릴게요.',
  ],
  ja: [
    '今日は晴れていて、少し風があります。',
    '会議は三時に始まるので、少し早めに来てください。',
    'この道に沿って歩くと、小さな公園があります。',
    '資料は明日の午前中までにまとめてお送りします。',
  ],
  en: [
    'The weather is clear today, with a light breeze.',
    'The meeting starts at three, so please come a little early.',
    'If you follow this road, you will find a small park.',
    'I will put the notes together and send them by tomorrow morning.',
  ],
};
export const REF_SEEDS = 5;

/** Similarity floor: max(SIM_FLOOR_MIN, lowest similarity of the reference takes − SIM_MARGIN). */
export const SIM_FLOOR_MIN = 0.94;
export const SIM_MARGIN = 0.01;
/** Pitch window of sentences without emotion: ± max(PITCH_MIN_ST, PITCH_SIGMA_K × spread). */
export const PITCH_MIN_ST = 2;
export const PITCH_SIGMA_K = 2;
/** Extra room upward for questions and exclamations. */
export const PITCH_RISING_ST = 1;

/** Measured reference voice, committed next to the voice (see voice-refs.ts in the CLI). */
export interface VoiceReference {
  version: number;
  engine: 'qwen' | 'persona' | 'trained' | 'supertonic';
  voice: string;
  lang: Lang;
  /** trained: sha of the speaker vector the takes were made with (stage 4). */
  vectorSha?: string;
  /** qwen, trained: the cast's style instruction the takes were made with. */
  style?: string;
  /** Synthesis model and revision of the takes. */
  model: string;
  revision: string;
  /** persona: sha256 of the reference clip it clones. */
  refSha?: string;
  /** Speaker encoder used for the similarities. */
  embedder: { model: string; revision: string };
  /** File name of the clip every sentence is compared with, next to this file, and its sha256. */
  clip: string;
  clipSha: string;
  /** Median of the takes' median pitch (Hz) and their spread (standard deviation, semitones). */
  f0: number;
  sigma: number;
  /** Median speaking rate (normalized characters per second of the trimmed take). */
  rate: number;
  /** Similarity of each take with the clip, and the floor derived from them. */
  sims: number[];
  simFloor: number;
  takes: { sentence: number; seed: number; f0: number | null; rate: number; sim: number }[];
  created: string;
}

export const semitones = (hz: number, ref: number) => 12 * Math.log2(hz / ref);

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new Error(`vector sizes differ: ${a.length} vs ${b.length}`);
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i]! * b[i]!;
    aa += a[i]! * a[i]!;
    bb += b[i]! * b[i]!;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** Index of the vector most similar to all the others (the most typical take). */
export function medoid(vectors: ArrayLike<number>[]): number {
  let best = 0;
  let bestSum = -Infinity;
  for (let i = 0; i < vectors.length; i++) {
    let sum = 0;
    for (let j = 0; j < vectors.length; j++) if (j !== i) sum += cosine(vectors[i]!, vectors[j]!);
    if (sum > bestSum) {
      bestSum = sum;
      best = i;
    }
  }
  return best;
}

export function simFloor(sims: number[]): number {
  return Math.max(SIM_FLOOR_MIN, Math.min(...sims) - SIM_MARGIN);
}

const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Pitch center, spread and speaking rate of the reference takes. */
export function summarizeTakes(takes: { f0: number | null; rate: number }[]): {
  f0: number;
  sigma: number;
  rate: number;
} {
  const pitched = takes.map((t) => t.f0).filter((f): f is number => f !== null && f > 0);
  if (pitched.length < Math.ceil(takes.length / 2))
    throw new Error(`pitch was measured on only ${pitched.length} of ${takes.length} takes`);
  const f0 = median(pitched);
  const st = pitched.map((f) => semitones(f, f0));
  const mean = st.reduce((a, b) => a + b, 0) / st.length;
  const sigma = Math.sqrt(st.reduce((a, b) => a + (b - mean) ** 2, 0) / st.length);
  return { f0, sigma, rate: median(takes.map((t) => t.rate)) };
}

/** Allowed pitch offset (semitones) of a sentence without emotion from the reference. */
export function pitchRange(sigma: number, text: string): [number, number] {
  const limit = Math.max(PITCH_MIN_ST, PITCH_SIGMA_K * sigma);
  const rising = /[?!？！]["'」』）)\s]*$/.test(text.trim()) ? PITCH_RISING_ST : 0;
  return [-limit, limit + rising];
}

/**
 * Failed consistency checks of one take (empty: it sounds like the reference voice). `emo`: the
 * emotion of an emotion line (acting stage 2 plan 4.2), which gets the wider emotion window.
 */
export function consistencyReasons(
  take: { text: string; f0: number | null; sim: number | null; emo?: string },
  ref: Pick<VoiceReference, 'f0' | 'sigma' | 'simFloor' | 'sims'>,
): string[] {
  const reasons: string[] = [];
  const floor = take.emo !== undefined ? emotionSimFloor(ref.sims) : ref.simFloor;
  if (take.f0 !== null) {
    const dev = semitones(take.f0, ref.f0);
    const [lo, hi] =
      take.emo !== undefined
        ? emotionPitchWindow(take.emo, ref.sigma, take.text)
        : pitchRange(ref.sigma, take.text);
    if (dev < lo || dev > hi)
      reasons.push(
        `pitch ${take.f0.toFixed(0)}Hz is ${dev > 0 ? '+' : ''}${dev.toFixed(1)} st from the voice reference ${ref.f0.toFixed(0)}Hz (allowed ${lo.toFixed(1)}…+${hi.toFixed(1)})`,
      );
  }
  if (take.sim !== null && take.sim < floor)
    reasons.push(
      `voice similarity ${take.sim.toFixed(3)} is below ${floor.toFixed(3)} (sounds like another person)`,
    );
  return reasons;
}

/**
 * Failed checks that make a take sound like another person or add sounds count double when no
 * take passes (acting plan 3.5: the "fewest failures" fallback must not keep a take with a wrong
 * voice over one with a long pause).
 */
const HEAVY = /^pitch |^voice similarity |non-speech sound/;
export function failureWeight(reasons: string[]): number {
  return reasons.reduce((n, r) => n + (HEAVY.test(r) ? 2 : 1), 0);
}

// ---------- reference clips (`voice create`) ----------

export type Gender = 'male' | 'female';

/** The gender a voice description asks for, or null (child, neutral, not said). */
export function describedGender(description: string): Gender | null {
  const d = description.toLowerCase();
  const female = /여성|여자|female|woman|girl|女性|女の/.test(d);
  const male = !female && /남성|남자|\bmale\b|\bman\b|\bboy\b|男性|男の/.test(d);
  return female ? 'female' : male ? 'male' : null;
}

/** Typical median pitch of adult speech (Hz). */
export const GENDER_F0: Record<Gender, [number, number]> = { male: [85, 155], female: [165, 255] };
/** A reference clip must be read right: at most this many wrong characters, or this CER. */
export const REF_CER_CHARS = 1;
export const REF_CER = 0.03;
export const REF_NOISE_DB = -50;
export const REF_PAUSE_MIN_S = 0.2;
export const REF_PAUSE_MAX_S = 1.5;
export const REF_END_DB = -40;
/** Pauses shorter than this are not pauses (closures inside words). */
const GAP_MIN_S = 0.12;
const HOP_S = 0.01;

export interface LevelAnalysis {
  seconds: number;
  /** Speech level: 90th percentile of the frame levels (dBFS). */
  speechDb: number;
  /** Noise floor: 10th percentile of the frame levels (dBFS). */
  floorDb: number;
  /** Quiet stretches (30 dB under the speech level) between the first and last speech, seconds. */
  gaps: number[];
  /** Level of the last 50 ms (dBFS): speech still going there means the clip was cut. */
  endDb: number;
}

const db = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-9));
const percentile = (v: number[], p: number) => {
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]!;
};

/** Frame levels of a clip (10 ms hop, 40 ms frames), samples in [-1, 1]. */
export function analyzeLevels(samples: Float32Array, rate: number): LevelAnalysis {
  const hop = Math.max(1, Math.round(rate * HOP_S));
  const half = hop * 2;
  const levels: number[] = [];
  for (let c = 0; c < samples.length; c += hop) {
    const a = Math.max(0, c - half);
    const b = Math.min(samples.length, c + half);
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i]! * samples[i]!;
    levels.push(db(Math.sqrt(sum / Math.max(1, b - a))));
  }
  const speechDb = percentile(levels, 90);
  const quiet = levels.map((l) => l < speechDb - 30);
  const first = quiet.indexOf(false);
  const last = quiet.lastIndexOf(false);
  const gaps: number[] = [];
  for (let i = first; first >= 0 && i < last;) {
    if (!quiet[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < last && quiet[j]) j++;
    const s = (j - i) * HOP_S;
    if (s >= GAP_MIN_S) gaps.push(Number(s.toFixed(2)));
    i = j;
  }
  const tail = samples.subarray(Math.max(0, samples.length - Math.round(rate * 0.05)));
  let sum = 0;
  for (const x of tail) sum += x * x;
  return {
    seconds: samples.length / rate,
    speechDb,
    floorDb: percentile(levels, 10),
    gaps,
    endDb: db(Math.sqrt(sum / Math.max(1, tail.length))),
  };
}

/** Pauses a reference sentence should show: one per break inside it, at most two. */
export function expectedPauses(text: string): number {
  const breaks = text.trim().match(/[.,!?;:…。、，！？；：](?=\s*\S)/g)?.length ?? 0;
  return Math.min(2, breaks);
}

export interface ReferenceMeasure {
  text: string;
  cer: number;
  /** Normalized characters of the sentence (for the wrong-character count). */
  chars: number;
  f0: number | null;
  gender: Gender | null;
  levels: LevelAnalysis;
}

/** Failed gates of a reference clip candidate (empty: usable). */
export function referenceGateFailures(m: ReferenceMeasure): string[] {
  const fails: string[] = [];
  const wrong = Math.round(m.cer * m.chars);
  if (wrong > REF_CER_CHARS && m.cer > REF_CER)
    fails.push(`misread (${wrong} wrong characters, CER ${m.cer.toFixed(2)})`);
  if (m.gender) {
    const [lo, hi] = GENDER_F0[m.gender];
    if (m.f0 === null) fails.push('no pitch measured');
    else if (m.f0 < lo || m.f0 > hi)
      fails.push(`pitch ${Math.round(m.f0)} Hz is outside ${lo}–${hi} Hz for a ${m.gender} voice`);
  }
  const { levels } = m;
  if (levels.floorDb > REF_NOISE_DB)
    fails.push(`noisy (floor ${levels.floorDb.toFixed(0)} dB, needs ≤ ${REF_NOISE_DB})`);
  const pauses = levels.gaps.filter((g) => g >= REF_PAUSE_MIN_S).length;
  const need = expectedPauses(m.text);
  if (pauses < need)
    fails.push(`runs together (${pauses} pause(s) of ${REF_PAUSE_MIN_S}s+, needs ${need})`);
  const long = levels.gaps.filter((g) => g > REF_PAUSE_MAX_S);
  if (long.length > 0) fails.push(`pause of ${Math.max(...long).toFixed(1)}s is too long`);
  if (levels.endDb > REF_END_DB)
    fails.push(`ending is cut (last 50 ms at ${levels.endDb.toFixed(0)} dB)`);
  return fails;
}
