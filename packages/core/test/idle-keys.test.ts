/** Seeds of idle motion (acting stage 5a plan 2): what is said, its occurrence, questions. */
import { describe, expect, it } from 'vitest';
import { buildTimeline, isQuestion, parseScript, textKey } from '../src/index.js';

describe('textKey', () => {
  it('is 16 hex characters of 64-bit FNV-1a over UTF-8', () => {
    expect(textKey('', '')).toMatch(/^[0-9a-f]{16}$/);
    expect(textKey('host', '안녕하세요.')).toBe(textKey('host', '안녕하세요.'));
    expect(textKey('host', '안녕하세요.')).not.toBe(textKey('guest', '안녕하세요.'));
    expect(textKey('host', '안녕')).not.toBe(textKey('host', '안녕.'));
  });

  it('matches FNV-1a 64 over the UTF-8 bytes (values from Buffer in node)', () => {
    expect(textKey('host', '안녕하세요.')).toBe('888e7008675a7d07');
    expect(textKey('a', 'Hello?')).toBe('6e5b34dad44ff9b1');
    expect(textKey('b', 'こんにちは😀')).toBe('4c6eaefddd44b032');
  });
});

describe('isQuestion', () => {
  it('sees a question mark behind closing quotes, brackets and exclamation marks', () => {
    for (const q of [
      '정말요?',
      'Really?"',
      '本当？」',
      '뭐라고?!',
      'what?)',
      '진짜？ ',
      '그래?…',
      '그래?...',
      '그래?~',
      '本当？］',
      '정말?).',
    ])
      expect(isQuestion(q)).toBe(true);
    for (const s of ['네.', '좋아요!', '?는 물음표입니다.', '本当ですか。'])
      expect(isQuestion(s)).toBe(false);
  });
});

describe('contentKey and ordinal in the timeline', () => {
  const src = (only: string) =>
    `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\noutputs:\n  youtube: { aspect: "16:9", layout: dialogue }\n  shorts: { aspect: "9:16", layout: shorts }\n---\n\n# 하나 {#one}\n\na: 네. 그래요?\n\n${only}b: 네.\n\na: 네.\n`;
  const manifest = {
    'one:0:0': { src: '1.wav', duration: 1, words: [] },
    'one:0:1': { src: '2.wav', duration: 1, words: [] },
    'one:1:0': { src: '3.wav', duration: 1, words: [] },
    'one:2:0': { src: '4.wav', duration: 1, words: [] },
  };

  it('counts the same speaker and text in the output, keyed by speaker', () => {
    const { script } = parseScript(src(''));
    const audio = buildTimeline(script!, 'youtube', manifest, 10).timeline.scenes[0]!.audio;
    expect(audio.map((a) => [a.contentKey, a.ordinal, a.question])).toEqual([
      [textKey('a', '네.'), 0, false],
      [textKey('a', '그래요?'), 0, true],
      [textKey('b', '네.'), 0, false],
      [textKey('a', '네.'), 1, false],
    ]);
  });

  it('does not count paragraphs the output leaves out', () => {
    const { script } = parseScript(src(':only{youtube} '));
    const shorts = buildTimeline(script!, 'shorts', manifest, 10).timeline.scenes[0]!.audio;
    expect(shorts.map((a) => [a.cast, a.ordinal])).toEqual([
      ['a', 0],
      ['a', 0],
      ['a', 1],
    ]);
  });
});
