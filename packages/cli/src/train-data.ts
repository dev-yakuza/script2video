/**
 * Measuring a training clip as the S2 experiment did (acting stage 4 plan 5): the raw server output,
 * its whole length, CER, pitch and edges from the aligner, S2's longest pause, and the x-vector
 * similarity with the persona's reference clip.
 */

import {
  cosine,
  longestPauseS2,
  roundTripCer,
  trainRound,
  type Lang,
  type TrainMeasure,
} from '@script2video/core';
import { readPcm16 } from './pauses.js';
import type { Service } from './services.js';
import { embed } from './voice-refs.js';

/** Bump when a measure changes (it is part of the training cache key). */
export const TRAIN_MEASURE_VERSION = 1;

interface Pitch {
  median_hz: number | null;
  lead_s: number;
  tail_s: number;
  noise_s: number;
}

export async function measureTrainClip(
  wav: string,
  text: string,
  lang: Lang,
  services: { aligner: Service; tts: Service },
  /** Emotion clips also get the pause and the similarity with this reference vector. */
  emotion?: { reference: number[] },
): Promise<TrainMeasure> {
  const { rate, samples } = readPcm16(wav);
  const seconds = trainRound(samples.length / rate, 2);
  const heard = (
    await services.aligner.post<{ text: string }>('/transcribe', { wav_path: wav, lang })
  ).data.text;
  const p = (await services.aligner.post<Pitch>('/pitch', { wav_path: wav })).data;
  const m: TrainMeasure = {
    seconds,
    f0: p.median_hz ? trainRound(p.median_hz, 1) : null,
    lead: trainRound(Math.max(p.lead_s, 0), 2),
    tail: trainRound(Math.max(p.tail_s, 0), 2),
    noise: trainRound(p.noise_s, 2),
    cer: trainRound(roundTripCer(text, heard, lang), 3),
  };
  if (emotion) {
    m.pause = longestPauseS2(
      Float32Array.from(samples, (x) => x / 32768),
      rate,
    );
    m.sim = trainRound(cosine(await embed(services.tts, wav), emotion.reference), 3);
  }
  return m;
}
