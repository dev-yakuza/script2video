import { describe, expect, it } from 'vitest';
import {
  estimateLengths,
  lintLength,
  lintSubtitleBudget,
  lintUnreadWords,
  parseScript,
} from '../src/index.js';

const doc = (body: string, extra = '', lang = 'ko') =>
  parseScript(`---\nlang: ${lang}\n${extra}cast:\n  host: { voice: "qwen:Sohee" }\n---\n\n${body}`)
    .script!;

describe('lintSubtitleBudget', () => {
  it('accepts sentences that break at spaces', () => {
    const s = doc(
      '# 하나 {#one}\n\n폰트를 미리 불러오면 첫 화면이 훨씬 빨리 보이고 점수도 올라갑니다.\n',
    );
    expect(lintSubtitleBudget(s)).toEqual([]);
  });

  it('flags an unbreakable word and a long cue phrase', () => {
    const s = doc(
      '# 하나 {#one}\n\nhttps://example.com/a/very/long/path/to/the/settings/page 를 엽니다.\n\n' +
        ':cue[설정 화면 오른쪽 위 모서리에 작게 표시되어 있는 회색 톱니바퀴 모양의 버튼]{x=0.5 y=0.5}을 누릅니다.\n',
    );
    const d = lintSubtitleBudget(s);
    expect(d.map((x) => x.code)).toEqual(['subtitle-budget', 'subtitle-budget']);
    expect(d[0]!.message).toMatch(/no place to break/);
    expect(d[1]!.message).toMatch(/shorten the cue phrase/);
  });
});

describe('lintLength', () => {
  const body =
    '# 하나 {#one}\n\n' + '이 문장은 길이를 추정하기 위한 문장입니다. '.repeat(10) + '\n';

  it('estimates from text and uses real audio when given', () => {
    const s = doc(body);
    const [est] = estimateLengths(s);
    expect(est!.measured).toBe(0);
    expect(est!.seconds).toBeGreaterThan(30);
    const manifest = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`one:0:${i}`, { src: '', duration: 1, words: [] }]),
    );
    const [real] = estimateLengths(s, manifest);
    expect(real!.measured).toBe(10);
    // lead 1.3 + 10 × 1 s + 9 × 0.3 s + tail 3.0
    expect(real!.seconds).toBeCloseTo(17, 1);
  });

  it('warns outside ±15% of targetDuration and over maxDuration', () => {
    const [est] = estimateLengths(doc(body));
    const near = Math.round(est!.seconds);
    expect(lintLength(doc(body, `targetDuration: ${near}\n`))).toEqual([]);
    const far = lintLength(doc(body, `targetDuration: ${near * 2}\n`));
    expect(far.map((d) => d.code)).toEqual(['target-duration']);
    expect(far[0]!.message).toMatch(/-\d+% from targetDuration/);
    const shorts = lintLength(
      doc(body, 'outputs:\n  shorts: { aspect: "9:16", layout: shorts, maxDuration: 10 }\n'),
    );
    expect(shorts.map((d) => d.code)).toEqual(['max-duration']);
  });
});

describe('lintUnreadWords', () => {
  it('lists English words the dictionary does not cover, once each', () => {
    const s = doc(
      '# 하나 {#one}\n\nPreload와 display를 씁니다. display는 다시 나옵니다.\n',
      'pronounce:\n  Preload: 프리로드\n',
    );
    expect(lintUnreadWords(s).map((d) => d.message.split('"')[1])).toEqual(['display']);
  });

  it('ignores English scripts', () => {
    expect(lintUnreadWords(doc('# One {#one}\n\nUse display.\n', '', 'en'))).toEqual([]);
  });
});
