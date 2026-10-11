import { describe, expect, it } from 'vitest';
import { bgmOf, parseScript, sfxEvents, type Timeline } from '../src/index.js';

const script = (extra: string) =>
  parseScript(
    `---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n${extra}---\n\n# 하나 {#one}\n\n안녕하세요.\n`,
  ).script!;

const visual = (type: string, startFrame: number) => ({
  startFrame,
  visual: { kind: 'visual' as const, line: 1, type, attrs: {} },
});
const cue = (frame: number, attrs: Record<string, string>) => ({ frame, phrase: 'x', attrs });

const timeline: Timeline = {
  fps: 30,
  lang: 'ko',
  output: 'youtube',
  totalFrames: 300,
  scenes: [
    {
      id: 'a',
      title: 'A',
      startFrame: 0,
      durationFrames: 150,
      visuals: [visual('image', 0), visual('bullets', 90)],
      audio: [],
      subtitles: [],
      reactions: [],
      motions: [],
      cues: [
        cue(30, { mark: 'circle' }),
        cue(60, { show: 'b.png' }),
        cue(100, { highlight: '0' }),
        cue(120, { mark: 'box', sfx: 'none' }),
      ],
    },
    {
      id: 'b',
      title: 'B',
      startFrame: 150,
      durationFrames: 150,
      visuals: [visual('code', 0)],
      audio: [],
      subtitles: [],
      reactions: [],
      motions: [],
      cues: [cue(20, { line: '2', sfx: 'ding' })],
    },
  ],
};

describe('sfxEvents', () => {
  it('places automatic effects on visuals, marks and highlights', () => {
    expect(sfxEvents(script('sfx: auto\n'), timeline).map((e) => `${e.name}@${e.frame}`)).toEqual([
      'pop@30',
      'whoosh@60',
      'whoosh@90',
      'click@100',
      'whoosh@150',
      'ding@170',
    ]);
  });

  it('plays only explicit effects when sfx is off (the default)', () => {
    expect(sfxEvents(script(''), timeline).map((e) => e.name)).toEqual(['ding']);
  });
});

describe('bgm', () => {
  it('fills defaults for the short form', () => {
    expect(bgmOf(script('bgm: assets/music.mp3\n').meta)).toEqual({
      src: 'assets/music.mp3',
      level: -30,
      duck: true,
    });
    expect(bgmOf(script('').meta)).toBeNull();
  });
});

describe('theme and logo', () => {
  it('reads a base theme or overrides, and fills logo defaults', async () => {
    const { themeOf, logoOf } = await import('../src/index.js');
    expect(themeOf(script('').meta)).toEqual({ base: 'light' });
    expect(themeOf(script('theme: dark\n').meta)).toEqual({ base: 'dark' });
    expect(themeOf(script('theme: { base: dark, accent: "#22d3ee" }\n').meta)).toEqual({
      base: 'dark',
      accent: '#22d3ee',
    });
    expect(logoOf(script('logo: assets/logo.png\n').meta)).toEqual({
      src: 'assets/logo.png',
      position: 'top-right',
      size: 0.08,
      opacity: 0.9,
    });
  });
});
