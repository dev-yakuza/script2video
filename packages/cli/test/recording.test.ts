import { describe, expect, it } from 'vitest';
import { splitRecording } from '../src/recording.js';

const w = (text: string, start: number, end: number) => ({ text, start, end });

describe('splitRecording', () => {
  it('hands words to sentences by spoken characters and cuts mid-gap', () => {
    const words = [
      w('안녕하세요', 0.5, 1.4),
      w('오늘은', 2.0, 2.4),
      w('폰트', 2.5, 2.9),
      w('이야기입니다', 3.0, 3.9),
    ];
    const cuts = splitRecording(words, ['안녕하세요.', '오늘은 폰트 이야기입니다.'], 'ko', 4.5);
    expect(cuts.map((c) => [Number(c.from.toFixed(2)), Number(c.to.toFixed(2))])).toEqual([
      [0.4, 1.7],
      [1.7, 4.1],
    ]);
    expect(cuts[1]!.words[0]).toEqual({ text: '오늘은', start: 2.0 - 1.7, end: 2.4 - 1.7 });
  });

  it('names the sentence the recording does not reach', () => {
    expect(() =>
      splitRecording([w('안녕하세요', 0, 1)], ['안녕하세요.', '빠진 문장입니다.'], 'ko', 1.2),
    ).toThrow(/sentence 2/);
  });
});

describe('paragraphCuts', () => {
  it('cuts halfway through the gaps, with lead and tail at the ends', async () => {
    const { paragraphCuts } = await import('../src/recording.js');
    expect(
      paragraphCuts(
        [
          { first: 0.5, last: 4 },
          { first: 5, last: 9 },
        ],
        9.2,
      ),
    ).toEqual([
      { from: 0.35, to: 4.5 },
      { from: 4.5, to: 9.2 },
    ]);
  });
});
