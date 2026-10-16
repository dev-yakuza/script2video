/**
 * Mock TTS (PLAN 5.1): runs the whole pipeline without models, for CI and layout work. Each
 * word of the alignment text becomes a short tone whose length follows a typical speaking rate,
 * and the "aligner" returns exactly those word times. Selected with `S2V_TTS=mock`; mock audio
 * gets its own cache keys, so it never mixes with real takes in an audio lock.
 */

import { createHash } from 'node:crypto';
import { ESTIMATE_RATE, normalizeForCer, type AlignedWord, type Lang } from '@script2video/core';
import { writePcm16 } from './pauses.js';

const RATE = 48_000;
const GAP_S = 0.08;
const EDGE_S = 0.1;

export const mockEnabled = () => process.env.S2V_TTS === 'mock';

/** Tokens like an aligner returns them: words (ko/en) or characters (ja), without punctuation. */
export function mockTokens(alignText: string, lang: Lang): string[] {
  const clean = (s: string) => s.replace(/[\p{P}\p{S}]/gu, '');
  const parts = lang === 'ja' ? [...alignText] : alignText.split(/\s+/);
  return parts.map(clean).filter(Boolean);
}

export function mockSynthesize(
  alignText: string,
  lang: Lang,
  speed: number,
  outPath: string,
): AlignedWord[] {
  const words: AlignedWord[] = [];
  let t = EDGE_S;
  for (const tok of mockTokens(alignText, lang)) {
    const chars = Math.max(1, [...normalizeForCer(tok, lang)].length);
    const dur = chars / (ESTIMATE_RATE[lang] * speed);
    words.push({ text: tok, start: t, end: t + dur });
    t += dur + GAP_S;
  }
  const total = t - GAP_S + EDGE_S;
  const samples = new Int16Array(Math.ceil(total * RATE));
  for (const w of words) {
    const a = Math.floor(w.start * RATE);
    const b = Math.floor(w.end * RATE);
    for (let i = a; i < b; i++) {
      // A voice-like tone with a syllable-rate envelope, so loudness and mouth shapes move.
      const local = (i - a) / RATE;
      const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 5 * local);
      samples[i] = Math.round(9000 * env * Math.sin((2 * Math.PI * 180 * i) / RATE));
    }
  }
  writePcm16(outPath, RATE, samples);
  return words;
}

/** Reference pitch of the mock voice: take selection ranks mock takes against it. */
export const MOCK_REF_F0 = 200;

/** A number in [0, 1) from a key, the same everywhere. */
function unit(key: string): number {
  return createHash('sha256').update(key).digest().readUInt32BE(0) / 2 ** 32;
}

/**
 * What take selection reads from a mock take (stage 3 plan 10): spread so strength, power and
 * the ending floor tell takes apart. f0 within ±3 semitones of the reference, raw length within
 * ±15% of the expected, ending −6…0 semitones (across every ENDING_LIFT floor).
 */
export function mockMeasure(
  synthKey: string,
  n: number,
  chars: number,
  rate: number,
): { f0: number; rawDuration: number; rawEnding: number } {
  const u = (salt: string) => unit(`${synthKey}:${n}:${salt}`);
  return {
    f0: MOCK_REF_F0 * 2 ** ((6 * u('f0') - 3) / 12),
    rawDuration: (chars / rate) * (1 + 0.3 * u('len') - 0.15),
    rawEnding: -6 * u('ending'),
  };
}

/**
 * Takes a test makes fail: `S2V_TTS_MOCK_FAIL="<synthKey prefix>:0,1;<prefix>:2"` (stage 3 plan
 * 10), to walk the budget, fallback and retry paths without models.
 */
export function mockFails(synthKey: string, n: number): boolean {
  for (const part of (process.env.S2V_TTS_MOCK_FAIL ?? '').split(';')) {
    const [prefix, list] = part.split(':');
    if (prefix && list && synthKey.startsWith(prefix) && list.split(',').map(Number).includes(n))
      return true;
  }
  return false;
}
