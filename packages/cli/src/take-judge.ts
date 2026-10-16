/**
 * Judging one take (stage 3 plan 3): where to cut non-speech at the edges, and which checks fail.
 * Pure over the measurements (the wav is read only through `duration` and `loudness`), so a take
 * measured once is judged again whenever the text, the checks or the reference change.
 */

import {
  assessSentence,
  consistencyReasons,
  emotionGateFailures,
  GATES,
  type AlignedWord,
  type EmotionTakeMeasure,
  type Lang,
  type SentenceAssessment,
  type VoiceReference,
} from '@script2video/core';

/** Padding kept around the aligned speech when cutting non-speech at the edges. */
export const EDGE_PAD_LEAD_S = 0.1;
export const EDGE_PAD_TAIL_S = 0.2;
/** Assessment reasons that a cut at the edges can fix. */
const EDGE_ONLY = /before the first word|after the last word/;

/** What a line asks of its takes. */
export interface TakeJob {
  text: string;
  lang: Lang;
  /** cast × line × emotion speed (the rate check scales with it). */
  speed: number;
  tempo: number | null;
  /** The emotion gates apply (ko emotion lines with voice checks). */
  gated: boolean;
  /** Normalized characters of the TTS text. */
  chars: number;
  multiplier: number;
  maxPause: number;
  synthSpeed: number;
  /** Emotion of an emotion line (the wider pitch window and similarity floor). */
  emo?: string;
}

/** Pitch and non-speech of a wav (aligner `/pitch`). */
export interface PitchFacts {
  median_hz: number | null;
  ending_st: number | null;
  lead_s: number;
  tail_s: number;
  noise_s: number;
}

/** The wav as the checks read it. */
export interface WavFacts {
  duration: number;
  loudness: (from: number, to: number) => number;
}

/** The edge cut around the words, rounded to milliseconds (the cache names it). */
export function cropWindow(words: AlignedWord[], duration: number): { from: number; to: number } {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    from: r3(Math.max(0, words[0]!.start - EDGE_PAD_LEAD_S)),
    to: r3(Math.min(duration, words[words.length - 1]!.end + EDGE_PAD_TAIL_S)),
  };
}

/**
 * Where to cut a take (null: keep it whole). Non-speech before the first / after the last word
 * (laughs, breaths — common on very short sentences) is cut instead of re-synthesizing; on emotion
 * lines also sound before / after the voice beyond the edge gate.
 */
export function cropFor(
  job: TakeJob,
  words: AlignedWord[],
  pitch: PitchFacts,
  wav: WavFacts,
): { from: number; to: number } | null {
  if (words.length === 0) return null;
  const first = assessSentence({
    text: job.text,
    lang: job.lang,
    duration: wav.duration,
    words,
    cer: null,
    speed: job.speed,
    loudness: wav.loudness,
  });
  if (!first.ok && first.reasons.some((r) => EDGE_ONLY.test(r)))
    return cropWindow(words, wav.duration);
  const tempo = job.tempo ?? 1;
  if (job.gated && (pitch.lead_s * tempo > GATES.edgeS || pitch.tail_s * tempo > GATES.edgeS))
    return cropWindow(words, wav.duration);
  return null;
}

/** Words of a cut take: shifted, not aligned again. */
export const shiftWords = (words: AlignedWord[], from: number): AlignedWord[] =>
  words.map((w) => ({ ...w, start: Math.max(0, w.start - from), end: w.end - from }));

/**
 * The checks of a final take (cut or whole): the sentence checks, the emotion gates and the voice
 * consistency against the reference (`ref` null: unchecked).
 */
export function judgeTake(
  job: TakeJob,
  take: {
    words: AlignedWord[];
    wav: WavFacts;
    pitch: PitchFacts;
    cer: number | null;
    raw?: { duration: number; pause: number; ending: number | null };
  },
  ref: VoiceReference | null,
  sim: number | null,
): { assessment: SentenceAssessment; emotion?: EmotionTakeMeasure & { ending: number | null } } {
  let assessment = assessSentence({
    text: job.text,
    lang: job.lang,
    duration: take.wav.duration,
    words: take.words,
    cer: take.cer,
    speed: job.speed,
    loudness: take.wav.loudness,
  });
  const fail = (reasons: string[]) => {
    if (reasons.length)
      assessment = { ...assessment, ok: false, reasons: [...assessment.reasons, ...reasons] };
  };
  let emotion: (EmotionTakeMeasure & { ending: number | null }) | undefined;
  // an emotion line must not pass its gates unmeasured
  if (job.gated && !take.raw) fail(['emotion gates not measured (no raw take measurement)']);
  if (job.gated && take.raw) {
    const tempo = job.tempo ?? 1;
    emotion = {
      chars: job.chars,
      rawDuration: take.raw.duration,
      rawPause: take.raw.pause,
      ending: take.raw.ending,
      lead: take.pitch.lead_s * tempo,
      tail: take.pitch.tail_s * tempo,
      noise: take.pitch.noise_s * tempo,
    };
    fail(
      emotionGateFailures(
        emotion,
        { multiplier: job.multiplier, maxPause: job.maxPause, synthSpeed: job.synthSpeed },
        ref?.rate ?? null,
      ),
    );
  }
  // the voice checks need both: without a similarity the voice counts as unchecked (the caller
  // judges the whole sentence without the reference then, stage 3 plan 3)
  if (ref && sim !== null)
    fail(
      consistencyReasons(
        { text: job.text, f0: take.pitch.median_hz, sim, ...(job.emo ? { emo: job.emo } : {}) },
        ref,
      ),
    );
  return { assessment, ...(emotion ? { emotion } : {}) };
}
