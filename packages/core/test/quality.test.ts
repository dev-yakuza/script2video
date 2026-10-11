import { describe, expect, it } from 'vitest';
import { assessSentence, bestAttempt } from '../src/quality.js';

const words = (pairs: [number, number][]) =>
  pairs.map(([start, end], i) => ({ text: `w${i}`, start, end }));

describe('assessSentence', () => {
  const text = '오른쪽 위의 설정 버튼을 누르면 됩니다.'; // 16 normalized chars

  it('passes a normal sentence', () => {
    const a = assessSentence({
      text,
      lang: 'ko',
      duration: 2.2,
      words: words([
        [0.05, 1.0],
        [1.0, 2.1],
      ]),
      cer: 0.02,
    });
    expect(a).toMatchObject({ ok: true, reasons: [] });
  });

  it('flags a high CER, a long tail and an implausible rate', () => {
    const a = assessSentence({
      text,
      lang: 'ko',
      duration: 9,
      words: words([
        [0.0, 0.5],
        [0.5, 1.0],
      ]),
      cer: 0.4,
    });
    expect(a.ok).toBe(false);
    expect(a.reasons.join(' | ')).toMatch(/too fast.*sound after the last word.*CER 0.40/);
  });

  it('scales the rate range with speed', () => {
    const fast = { text, lang: 'ko' as const, duration: 1.3, words: words([[0, 1.25]]), cer: 0 };
    expect(assessSentence(fast).ok).toBe(false);
    expect(assessSentence({ ...fast, speed: 1.5 }).ok).toBe(true);
  });
});

describe('non-speech detection', () => {
  const text = '오른쪽 위의 설정 버튼을 누르면 됩니다.';
  const w = words([
    [1.2, 2.0],
    [2.0, 3.3],
  ]);
  it('flags a loud sound before the first word (e.g. a laugh) but not quiet silence', () => {
    const laugh = assessSentence({
      text,
      lang: 'ko',
      duration: 3.4,
      words: w,
      cer: 0,
      loudness: (a) => (a === 0 ? -29 : -60),
    });
    expect(laugh.reasons).toEqual(['1.20s of non-speech sound before the first word (-29 dB)']);
    const quietLaugh = assessSentence({
      text,
      lang: 'ko',
      duration: 4.9,
      words: w,
      cer: 0,
      loudness: (a) => (a === 3.3 ? -40 : -60),
    });
    expect(quietLaugh.reasons).toEqual(['1.60s of non-speech sound after the last word (-40 dB)']);
    const quiet = assessSentence({
      text,
      lang: 'ko',
      duration: 3.4,
      words: w,
      cer: 0,
      loudness: () => -55,
    });
    expect(quiet.ok).toBe(true);
  });
});

describe('bestAttempt', () => {
  it('prefers the lowest CER', () => {
    const mk = (cer: number, rate: number) => ({
      assessment: { ok: false, cer, rate, tail: 0, reasons: [] },
    });
    expect(bestAttempt([mk(0.3, 7), mk(0.1, 2), mk(0.2, 7)], 'ko').assessment.cer).toBe(0.1);
  });
});
