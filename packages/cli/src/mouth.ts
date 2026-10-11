/**
 * Mouth openness per video frame from the sentence audio (PLAN 5.8): loudness relative to the
 * sentence's own loud parts, so quiet and loud voices move the mouth alike.
 *   '2' open   within OPEN_DB of the sentence's loud level
 *   '1' half   within HALF_DB
 *   '0' closed otherwise
 * A state must last MIN_RUN frames, otherwise the mouth keeps its previous state (no flicker).
 */

import type { Timeline } from '@script2video/core';
import { readPcm16 } from './pauses.js';

const OPEN_DB = 9;
const HALF_DB = 20;
const MIN_RUN = 2;
const SILENCE_DB = -50;

export function mouthLevels(samples: Int16Array, rate: number, fps: number, frames: number) {
  const per = rate / fps;
  const db: number[] = [];
  for (let f = 0; f < frames; f++) {
    const a = Math.floor(f * per);
    const b = Math.min(samples.length, Math.floor((f + 1) * per));
    let sum = 0;
    for (let i = a; i < b; i++) sum += (samples[i]! / 32768) ** 2;
    db.push(b > a ? 10 * Math.log10(sum / (b - a) + 1e-12) : -120);
  }
  // "Loud" reference: 90th percentile of the voiced frames.
  const voiced = db.filter((d) => d > SILENCE_DB).sort((x, y) => x - y);
  const ref = voiced.length ? voiced[Math.floor(voiced.length * 0.9)]! : 0;
  const raw = db.map((d) =>
    d <= SILENCE_DB ? 0 : d >= ref - OPEN_DB ? 2 : d >= ref - HALF_DB ? 1 : 0,
  );
  // Drop runs shorter than MIN_RUN frames.
  const out = [...raw];
  let i = 0;
  while (i < raw.length) {
    let j = i;
    while (j < raw.length && raw[j] === raw[i]) j++;
    if (j - i < MIN_RUN && i > 0) for (let k = i; k < j; k++) out[k] = out[i - 1]!;
    i = j;
  }
  return out.join('');
}

/** Mouth strings for every sentence placed in the timeline, keyed by sentence id. */
export function timelineMouths(timeline: Timeline): Record<string, string> {
  const out: Record<string, string> = {};
  for (const scene of timeline.scenes)
    for (const a of scene.audio) {
      if (out[a.sentenceId] !== undefined) continue;
      const { rate, samples } = readPcm16(a.src);
      out[a.sentenceId] = mouthLevels(samples, rate, timeline.fps, a.durationFrames);
    }
  return out;
}
