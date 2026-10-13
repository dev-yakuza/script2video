import { describe, expect, it } from 'vitest';
import {
  chapters,
  descriptionDraft,
  parseScript,
  subtitleCues,
  timestamp,
  toSrt,
  toVtt,
  type Timeline,
} from '../src/index.js';

const script = (cast: string) =>
  parseScript(
    `---\ntitle: 웹 폰트\nlang: ko\ncast:\n${cast}---\n\n# 하나 {#one}\n\na: 안녕하세요.\n`,
  ).script!;

const scene = (
  id: string,
  title: string,
  start: number,
  dur: number,
  subs: [number, number, string, string][] = [],
) => ({
  id,
  title,
  startFrame: start,
  durationFrames: dur,
  visuals: [],
  audio: [],
  cues: [],
  reactions: [],
  motions: [],
  framing: {},
  subtitles: subs.map(([s, e, text, cast]) => ({
    startFrame: s,
    endFrame: e,
    text,
    cast,
    words: [],
  })),
});

const timeline = (scenes: ReturnType<typeof scene>[]): Timeline => ({
  fps: 10,
  lang: 'ko',
  output: 'youtube',
  totalFrames: scenes.reduce((n, s) => n + s.durationFrames, 0),
  scenes,
});

describe('subtitle files', () => {
  it('names speakers only when there are several, and keeps overlaps', () => {
    const two = script('  a: { voice: "qwen:Sohee", name: 미나 }\n  b: { voice: "qwen:Ryan" }\n');
    const t = timeline([
      scene('one', '하나', 0, 100, [
        [10, 25, '안녕하세요.', 'a'],
        [20, 30, '오!', 'b'],
      ]),
    ]);
    const cues = subtitleCues(two, t);
    expect(cues.map((c) => c.text)).toEqual(['미나: 안녕하세요.', 'b: 오!']);
    expect(toSrt(cues)).toBe(
      '1\n00:00:01,000 --> 00:00:02,500\n미나: 안녕하세요.\n\n2\n00:00:02,000 --> 00:00:03,000\nb: 오!\n',
    );
    expect(toVtt(cues).startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n')).toBe(true);
    const one = script('  a: { voice: "qwen:Sohee" }\n');
    expect(
      subtitleCues(one, timeline([scene('one', '하나', 0, 50, [[0, 10, '네.', 'a']])]))[0]!.text,
    ).toBe('네.');
  });
});

describe('chapters', () => {
  it('merges short scenes and starts at 0:00', () => {
    // intro 5 s (joins the next), body 30 s, tiny 3 s (joins body), more 20 s, end 15 s
    const t = timeline([
      scene('intro', '인사', 0, 50),
      scene('body', '문제', 50, 300),
      scene('tiny', '잠깐', 350, 30),
      scene('more', '해결', 380, 200),
      scene('end', '정리', 580, 150),
    ]);
    expect(chapters(t).chapters).toEqual([
      { start: 0, title: '문제' },
      { start: 38, title: '해결' },
      { start: 58, title: '정리' },
    ]);
  });

  it('writes none (with a warning) below three chapters', () => {
    const r = chapters(timeline([scene('a', 'A', 0, 300), scene('b', 'B', 300, 300)]));
    expect(r.chapters).toEqual([]);
    expect(r.diagnostics[0]!.code).toBe('chapters');
  });

  it('formats YouTube timestamps', () => {
    expect([timestamp(0), timestamp(75.9), timestamp(3725)]).toEqual(['0:00', '1:15', '1:02:05']);
  });
});

describe('description draft', () => {
  it('adds the machine-generated notice when a Supertonic voice is used', () => {
    const list = [{ start: 0, title: '문제' }];
    const qwen = descriptionDraft(script('  a: { voice: "qwen:Sohee" }\n'), list);
    expect(qwen).toContain('# 웹 폰트');
    expect(qwen).toContain('0:00 문제');
    expect(qwen).not.toContain('Supertonic');
    const st = descriptionDraft(script('  a: { voice: "supertonic:F1" }\n'), list);
    expect(st).toContain('기계(Supertonic-3 음성 합성)로 생성');
  });
});
