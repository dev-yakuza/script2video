/** Training data gates (acting stage 4 plan 5): the S2 experiment's measures and judgements. */
import { describe, expect, it } from 'vitest';
import {
  emotionFails,
  firstMax,
  intensity,
  longestPauseS2,
  neutralBaseline,
  neutralFails,
  neutralRate,
  pauseLimit,
  percentile,
  pickNeutral,
  roundBaseline,
  trainMedian,
  type TrainMeasure,
} from '../src/index.js';
import { FIXTURES } from './fixtures/train-gates.js';

/** Expected values from librosa/numpy (tts-server/scripts/train_gate_fixtures.py). */
const fixtures = FIXTURES as unknown as {
  pause: { sr: number; segments: [number, number, number][]; pause: number }[];
  percentile: { xs: number[]; p90: number; p37: number }[];
};

/** The same signal as the fixture script: sine segments, rounded to int16. */
function signal(sr: number, segments: [number, number, number][]): Float32Array {
  const out: number[] = [];
  for (const [seconds, amp, hz] of segments) {
    const n = Math.round(seconds * sr);
    for (let i = 0; i < n; i++) out.push(amp * Math.sin((2 * Math.PI * hz * i) / sr));
  }
  return Float32Array.from(out, (y) => Math.round(y * 32767) / 32768);
}

const m = (over: Partial<TrainMeasure> = {}): TrainMeasure => ({
  seconds: 2,
  f0: 110,
  lead: 0.1,
  tail: 0.1,
  noise: 0.3,
  cer: 0,
  pause: 0.2,
  sim: 0.97,
  ...over,
});

describe('S2 measures', () => {
  it('finds the longest pause as librosa does', () => {
    for (const c of fixtures.pause)
      expect(longestPauseS2(signal(c.sr, c.segments), c.sr)).toBe(c.pause);
  });

  it('takes percentiles and medians as numpy and statistics do', () => {
    for (const c of fixtures.percentile) {
      expect(percentile(c.xs, 90)).toBeCloseTo(c.p90, 9);
      expect(percentile(c.xs, 37)).toBeCloseTo(c.p37, 9);
    }
    expect(trainMedian([3, 1, 2])).toBe(2);
    expect(trainMedian([4, 1, 3, 2])).toBe(2.5);
  });

  it('counts neutral rate without spaces and punctuation, emotion length with them', () => {
    expect(neutralRate('안녕, 하세요.', 2)).toBe(2.5);
    // 7 raw characters at 3.5 characters per second: 2 s expected
    expect(
      emotionFails(m({ seconds: 2 }), 'sad', '안녕, 하세요', { f0: 110, rate: 3.5 }).lenX,
    ).toBe(1);
  });

  it('allows a longer pause when the line has a break before its end', () => {
    expect(pauseLimit('네? 벌써요')).toBe(0.8);
    expect(pauseLimit('벌써요?')).toBe(0.45);
    expect(pauseLimit('그래요… 정말')).toBe(0.45);
  });
});

describe('neutral data', () => {
  const base = neutralBaseline([
    { f0: 100, rate: 5 },
    { f0: null, rate: 6 },
    { f0: 120, rate: 7 },
  ]);

  it('takes the medians of all takes, f0 without the unmeasured', () => {
    expect(base).toEqual({ f0: 110, rate: 6 });
  });

  it('fails on pitch, rate, CER, edges and noise; no f0 fails', () => {
    expect(neutralFails(m(), 6, base).fails).toEqual([]);
    expect(neutralFails(m({ f0: 110 * 2 ** (3.2 / 12) }), 6, base).fails).toEqual(['f0']);
    expect(neutralFails(m({ f0: null }), 6, base)).toEqual({ fails: ['f0'], f0St: 99 });
    expect(neutralFails(m(), 8.2, base).fails).toEqual(['rate']);
    expect(neutralFails(m({ cer: 0.11, lead: 0.4, noise: 0.8 }), 6, base).fails).toEqual([
      'cer',
      'edge',
      'noise',
    ]);
  });

  it('keeps the lowest CER, then the f0 nearest the baseline, the first on a tie', () => {
    const a = { cer: 0.05, f0St: 1, fails: [], n: 0 };
    const b = { cer: 0.05, f0St: -0.5, fails: [], n: 1 };
    const c = { cer: 0, f0St: 2, fails: ['rate'], n: 2 };
    expect(pickNeutral([a, b, c])!.n).toBe(1);
    expect(pickNeutral([{ ...a }, { ...a, n: 9 }])!.n).toBe(0);
    expect(pickNeutral([c])).toBeUndefined();
  });
});

describe('emotion data', () => {
  const base = { f0: 110, rate: 4 };
  const text = '정말 슬퍼요'; // 6 characters → 1.5 s expected

  it('takes the round baseline from raw text length and the f0 median', () => {
    const b = roundBaseline([
      { f0: 100, seconds: 2, text: '가나다라' },
      { f0: null, seconds: 1, text: '가나' },
      { f0: 120, seconds: 4, text: '가나다라마바사아' },
    ]);
    expect(b.f0).toBe(110);
    expect(b.rate).toBe(2);
    expect(b.sigma).toBeGreaterThan(0);
  });

  it('passes a take inside every gate', () => {
    expect(emotionFails(m({ seconds: 1.5 }), 'sad', text, base)).toEqual({
      fails: [],
      f0St: 0,
      lenX: 1,
    });
  });

  it('lets HIGH_PITCH emotions go to +6 semitones, others to +4.5', () => {
    const high = m({ seconds: 1.5, f0: 110 * 2 ** (5.5 / 12) });
    expect(emotionFails(high, 'happy', text, base).fails).toEqual([]);
    expect(emotionFails(high, 'sad', text, base).fails).toEqual(['f0 +5.5st']);
    expect(
      emotionFails(m({ seconds: 1.5, f0: 110 * 2 ** (-4.6 / 12) }), 'happy', text, base).fails,
    ).toEqual(['f0 -4.6st']);
  });

  it('skips the pitch check without f0', () => {
    const j = emotionFails(m({ seconds: 1.5, f0: null }), 'sad', text, base);
    expect(j).toEqual({ fails: [], lenX: 1 });
    expect(intensity(j)).toBe(0);
  });

  it('fails on length, edges, noise, CER, similarity and pause', () => {
    const j = emotionFails(
      m({ seconds: 2.1, tail: 0.36, noise: 0.76, cer: 0.16, sim: 0.964, pause: 0.46 }),
      'calm',
      text,
      base,
    );
    expect(j.fails).toEqual([
      'length x1.40',
      'edge',
      'noise 0.76s',
      'cer 0.16',
      'similarity 0.964',
      'pause 0.46',
    ]);
  });

  it('ranks by S2 intensity, the first of the highest winning', () => {
    expect(intensity({ f0St: 2, lenX: 0.8 })).toBeCloseTo(1 + 2.5, 9);
    const takes = [
      { v: 1, k: 'normal' },
      { v: 1, k: 'strong' },
      { v: 0.5, k: 'x' },
    ];
    expect(firstMax(takes, (t) => t.v)!.k).toBe('normal');
  });
});
