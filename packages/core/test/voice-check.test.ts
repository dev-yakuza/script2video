import { describe, expect, it } from 'vitest';
import {
  analyzeLevels,
  bestAttempt,
  consistencyReasons,
  cosine,
  describedGender,
  expectedPauses,
  failureWeight,
  medoid,
  pitchRange,
  referenceGateFailures,
  simFloor,
  summarizeTakes,
  type LevelAnalysis,
  type SentenceAssessment,
} from '../src/index.js';

const REF = { f0: 120, sigma: 0.5, simFloor: 0.95, sims: [0.95, 0.97] };
const st = (hz: number, n: number) => hz * 2 ** (n / 12);

describe('consistency against the reference voice', () => {
  it('measures similarity as the cosine of x-vectors', () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 2])).toBeCloseTo(0);
    expect(cosine([1, 1], [2, 2])).toBeCloseTo(1);
    expect(() => cosine([1], [1, 2])).toThrow(/differ/);
  });

  it('picks the most typical take as the clip', () => {
    expect(
      medoid([
        [1, 0.1],
        [1, 0],
        [1, -0.1],
        [-1, 0],
      ]),
    ).toBe(1);
  });

  it('derives the similarity floor from the reference takes, never under 0.94', () => {
    expect(simFloor([0.99, 0.975, 0.98])).toBeCloseTo(0.965);
    expect(simFloor([0.99, 0.9])).toBe(0.94);
  });

  it('summarizes pitch as the median and its spread in semitones', () => {
    const s = summarizeTakes([
      { f0: 100, rate: 6 },
      { f0: 120, rate: 7 },
      { f0: 140, rate: 8 },
    ]);
    expect(s.f0).toBe(120);
    expect(s.rate).toBe(7);
    expect(s.sigma).toBeGreaterThan(2);
    expect(s.sigma).toBeLessThan(3);
    expect(() =>
      summarizeTakes([
        { f0: null, rate: 6 },
        { f0: null, rate: 6 },
      ]),
    ).toThrow(/pitch/);
  });

  it('allows ±max(2, 2σ) semitones, one more upward for questions', () => {
    expect(pitchRange(0.5, '좋아요.')).toEqual([-2, 2]);
    expect(pitchRange(1.5, '좋아요.')).toEqual([-3, 3]);
    expect(pitchRange(0.5, '정말요?')).toEqual([-2, 3]);
    expect(pitchRange(0.5, '「本当？」')).toEqual([-2, 3]);
  });

  it('rejects a take far from the reference pitch or similarity', () => {
    expect(consistencyReasons({ text: '네.', f0: st(120, 1.9), sim: 0.96 }, REF)).toEqual([]);
    expect(consistencyReasons({ text: '네.', f0: st(120, 2.5), sim: 0.96 }, REF)[0]).toMatch(
      /^pitch .*\+2\.5 st/,
    );
    expect(consistencyReasons({ text: '네?', f0: st(120, 2.5), sim: 0.96 }, REF)).toEqual([]);
    expect(consistencyReasons({ text: '네.', f0: st(120, -2.5), sim: 0.96 }, REF)).toHaveLength(1);
    expect(consistencyReasons({ text: '네.', f0: 120, sim: 0.93 }, REF)[0]).toMatch(
      /^voice similarity 0\.930/,
    );
    // nothing measured: nothing to judge
    expect(consistencyReasons({ text: '네.', f0: null, sim: null }, REF)).toEqual([]);
  });

  it('keeps a take with the right voice over one with a wrong voice when none passes', () => {
    const a = (reasons: string[], cer = 0): { assessment: SentenceAssessment } => ({
      assessment: { ok: false, cer, rate: 6, tail: 0, reasons },
    });
    const wrongVoice = a(['voice similarity 0.900 is below 0.950 (sounds like another person)'], 0);
    const slowAndMisread = a(['speech rate 2.0 chars/s is too slow'], 0.05);
    expect(failureWeight(wrongVoice.assessment.reasons)).toBe(2);
    expect(failureWeight(slowAndMisread.assessment.reasons)).toBe(1);
    expect(bestAttempt([wrongVoice, slowAndMisread], 'ko')).toBe(slowAndMisread);
  });
});

describe('reference clip gates', () => {
  const RATE = 16000;
  /** Speech-like bursts (sine) separated by pauses, over a noise floor. */
  function clip(parts: [kind: 'tone' | 'gap', seconds: number][], noise = 0.0005, cutEnd = false) {
    const total = parts.reduce((n, [, s]) => n + s, 0) + (cutEnd ? 0 : 0.2);
    const out = new Float32Array(Math.round(total * RATE));
    let i = 0;
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    for (const [kind, s] of parts)
      for (let k = 0; k < Math.round(s * RATE); k++, i++)
        out[i] =
          (kind === 'tone' ? 0.3 * Math.sin((2 * Math.PI * 150 * k) / RATE) : 0) + noise * rnd();
    for (; i < out.length; i++) out[i] = noise * rnd();
    return out;
  }
  const TEXT = '안녕하세요. 오늘도 함께 이야기를 나눠 볼게요. 천천히, 또박또박 말씀드리겠습니다.';
  const judge = (
    levels: LevelAnalysis,
    over: Partial<Parameters<typeof referenceGateFailures>[0]> = {},
  ) =>
    referenceGateFailures({
      text: TEXT,
      cer: 0,
      chars: 34,
      f0: 120,
      gender: 'male',
      levels,
      ...over,
    });

  it('passes a clean clip with pauses and a quiet ending', () => {
    const levels = analyzeLevels(
      clip([
        ['tone', 1],
        ['gap', 0.4],
        ['tone', 1.5],
        ['gap', 0.3],
        ['tone', 1],
      ]),
      RATE,
    );
    expect(levels.gaps).toHaveLength(2);
    expect(levels.floorDb).toBeLessThan(-50);
    expect(judge(levels)).toEqual([]);
  });

  it('catches noise, run-together sentences, long pauses and a cut ending', () => {
    const noisy = analyzeLevels(
      clip(
        [
          ['tone', 1],
          ['gap', 0.4],
          ['tone', 1],
          ['gap', 0.4],
          ['tone', 1],
        ],
        0.01,
      ),
      RATE,
    );
    expect(judge(noisy).join()).toMatch(/noisy/);
    const together = analyzeLevels(clip([['tone', 3.5]]), RATE);
    expect(judge(together).join()).toMatch(/runs together/);
    const long = analyzeLevels(
      clip([
        ['tone', 1],
        ['gap', 2],
        ['tone', 1],
        ['gap', 0.4],
        ['tone', 1],
      ]),
      RATE,
    );
    expect(judge(long).join()).toMatch(/pause of 2\.0s is too long/);
    const cut = analyzeLevels(
      clip(
        [
          ['tone', 1],
          ['gap', 0.4],
          ['tone', 1],
          ['gap', 0.4],
          ['tone', 1],
        ],
        0.0005,
        true,
      ),
      RATE,
    );
    expect(judge(cut).join()).toMatch(/ending is cut/);
  });

  it('checks the described gender and the reading', () => {
    const levels = analyzeLevels(
      clip([
        ['tone', 1],
        ['gap', 0.4],
        ['tone', 1],
        ['gap', 0.4],
        ['tone', 1],
      ]),
      RATE,
    );
    expect(judge(levels, { f0: 230 }).join()).toMatch(/outside 85–155 Hz/);
    expect(judge(levels, { f0: 230, gender: 'female' })).toEqual([]);
    expect(judge(levels, { f0: 230, gender: null })).toEqual([]);
    // one wrong character is fine even above 3 %; two are not
    expect(judge(levels, { cer: 1 / 20, chars: 20 })).toEqual([]);
    expect(judge(levels, { cer: 2 / 20, chars: 20 }).join()).toMatch(/misread/);
    expect(judge(levels, { cer: 2 / 100, chars: 100 })).toEqual([]);
  });

  it('reads the gender from the description', () => {
    expect(describedGender('30대 남성, 차분한 목소리')).toBe('male');
    expect(describedGender('a young woman')).toBe('female');
    expect(describedGender('20代の女性')).toBe('female');
    expect(describedGender('calm narrator')).toBeNull();
  });

  it('expects as many pauses as breaks in the sentence, at most two', () => {
    expect(expectedPauses(TEXT)).toBe(2);
    expect(expectedPauses('Hello there.')).toBe(0);
    expect(expectedPauses('Hello, there.')).toBe(1);
  });
});
