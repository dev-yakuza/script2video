import { describe, expect, it } from 'vitest';
import { cropFor, cropWindow, judgeTake, shiftWords, type TakeJob } from '../src/take-judge.js';

const job = (over: Partial<TakeJob> = {}): TakeJob => ({
  text: '오늘은 날씨가 좋네요.',
  lang: 'ko',
  speed: 1,
  tempo: null,
  gated: false,
  chars: 9,
  multiplier: 1,
  maxPause: 0.9,
  synthSpeed: 1,
  ...over,
});
const words = [
  { text: '오늘은', start: 0.6, end: 1.0 },
  { text: '날씨가', start: 1.05, end: 1.45 },
  { text: '좋네요', start: 1.5, end: 2.0 },
];
const quiet = { duration: 2.1, loudness: () => -90 };
const pitch = { median_hz: 220, ending_st: 0, lead_s: 0, tail_s: 0, noise_s: 0 };

describe('take judging', () => {
  it('cuts sound before the first word, rounded to milliseconds', () => {
    const loud = { duration: 2.1, loudness: (a: number) => (a === 0 ? -20 : -90) };
    expect(cropFor(job(), words, pitch, loud)).toEqual({ from: 0.5, to: 2.1 });
    expect(cropFor(job(), words, pitch, quiet)).toBeNull();
    expect(cropWindow([{ text: 'a', start: 0.12345, end: 1.00049 }], 3)).toEqual({
      from: 0.023,
      to: 1.2,
    });
  });

  it('cuts sound around the voice of an emotion line beyond the edge gate (scaled by tempo)', () => {
    const p = { ...pitch, tail_s: 0.3 };
    expect(cropFor(job({ gated: true }), words, p, quiet)).toBeNull();
    expect(cropFor(job({ gated: true, tempo: 1.25 }), words, p, quiet)).not.toBeNull();
    expect(cropFor(job({ gated: false, tempo: 1.25 }), words, p, quiet)).toBeNull();
  });

  it('shifts words of a cut take without aligning again', () => {
    const [w] = shiftWords(words, 0.5);
    expect(w!.start).toBeCloseTo(0.1);
    expect(w!.end).toBeCloseTo(0.5);
  });

  it('fails the emotion gates from the raw take and the final pitch', () => {
    const raw = { duration: 1.5, pause: 1.2, ending: 0 };
    const r = judgeTake(
      job({ gated: true }),
      { words, wav: quiet, pitch: { ...pitch, noise_s: 2 }, cer: null, raw },
      null,
      null,
    );
    expect(r.assessment.ok).toBe(false);
    expect(r.assessment.reasons.join('\n')).toMatch(/non-speech sound in the take/);
    expect(r.assessment.reasons.join('\n')).toMatch(/pause inside the line/);
    expect(r.emotion).toMatchObject({ rawDuration: 1.5, noise: 2 });
    // not gated: no emotion measurements, and it passes
    expect(
      judgeTake(job(), { words, wav: quiet, pitch, cer: null, raw }, null, null).assessment.ok,
    ).toBe(true);
  });

  it('checks the voice only with a reference and a similarity', () => {
    const ref = {
      f0: 300,
      sigma: 1,
      rate: 5,
      sims: [0.99],
      simFloor: 0.98,
    } as unknown as Parameters<typeof judgeTake>[2];
    const take = { words, wav: quiet, pitch, cer: null };
    expect(judgeTake(job(), take, ref, 0.99).assessment.reasons.join('\n')).toMatch(/^pitch /m);
    expect(judgeTake(job(), take, ref, null).assessment.ok).toBe(true);
    expect(judgeTake(job(), take, null, 0.5).assessment.ok).toBe(true);
  });

  it('fails an emotion line whose raw take was not measured', () => {
    const r = judgeTake(job({ gated: true }), { words, wav: quiet, pitch, cer: null }, null, null);
    expect(r.assessment.reasons).toContain('emotion gates not measured (no raw take measurement)');
  });
});
