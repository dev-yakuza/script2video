/** `render --scenes` (S11): the picked copy of a script and what the cut changes on screen. */
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  driftMessage,
  parseScript,
  pickDrift,
  pickScenes,
  SCENE_ID,
  type Script,
} from '../src/index.js';

/** The shape of videos/sample-ko: two scenes, shorts keeps one, a paragraph for youtube only. */
const SAMPLE = `---
lang: ko
cast:
  host: { voice: "qwen:Sohee" }
  mina: { voice: "supertonic:F1" }
outputs:
  youtube: { aspect: "16:9", layout: presenter }
  shorts: { aspect: "9:16", layout: shorts, scenes: [settings] }
---

# 코드로 영상 만들기 {#intro}

안녕하세요. 오늘은 영상을 만들어 보겠습니다.

mina: 정말 대본만 쓰면 되나요?

# 설정 화면 {#settings}

오른쪽 위의 설정 버튼을 누르면 새 프로젝트를 만들 수 있습니다.

:only{youtube} 영상이 도움이 됐다면 구독 부탁드려요.
`;

function parse(text: string): Script {
  const r = parseScript(text);
  if (!r.script) throw new Error(r.diagnostics.items.map((d) => d.message).join('\n'));
  return r.script;
}

const sample = () => parse(SAMPLE);

/** Every sentence 2 s (words spread evenly). */
function timeline(s: Script, output = 'youtube') {
  const manifest: Parameters<typeof buildTimeline>[2] = {};
  for (const scene of s.scenes)
    scene.blocks.forEach((b, bi) => {
      if (b.kind !== 'paragraph') return;
      b.sentences.forEach(
        (x, si) =>
          (manifest[`${scene.id}:${bi}:${si}`] = {
            src: 'x.wav',
            duration: 2,
            words: x.text.split(' ').map((w, i, all) => ({
              text: w,
              start: (i * 2) / all.length,
              end: ((i + 1) * 2) / all.length,
            })),
          }),
      );
    });
  return buildTimeline(s, output, manifest, 30).timeline;
}

function picked(s: Script, output: string, ids: string[]): Script {
  const r = pickScenes(s, output, ids);
  if (!r.ok) throw new Error(r.message);
  return r.script;
}

describe('pickScenes', () => {
  it('sets the output’s scenes and leaves the script and other outputs alone', () => {
    const s = sample();
    const r = pickScenes(s, 'youtube', ['settings']);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ids).toEqual(['settings']);
    expect(r.script.meta.outputs.youtube!.scenes).toEqual(['settings']);
    expect(r.script.meta.outputs.shorts).toBe(s.meta.outputs.shorts);
    expect(s.meta.outputs.youtube!.scenes).toBeUndefined();
    expect(r.script.scenes).toBe(s.scenes);
  });

  it('keeps script order, whatever order the ids come in', () => {
    const r = pickScenes(sample(), 'youtube', ['settings', 'intro']);
    expect(r.ok && r.ids).toEqual(['intro', 'settings']);
  });

  it('refuses an unknown id and one the output leaves out', () => {
    const unknown = pickScenes(sample(), 'youtube', ['nope']);
    expect(unknown).toMatchObject({ ok: false, code: 'unknown-scene' });
    expect(!unknown.ok && unknown.message).toMatch(/scenes: intro, settings/);
    const out = pickScenes(sample(), 'shorts', ['intro']);
    expect(out).toMatchObject({ ok: false, code: 'not-in-output' });
    expect(!out.ok && out.message).toMatch(/outputs\.shorts\.scenes: settings/);
  });

  it('renders as the frontmatter would: same timeline as `scenes: [settings]`', () => {
    const text = SAMPLE;
    const edited = parse(
      text.replace(
        'youtube: { aspect: "16:9", layout: presenter }',
        'youtube: { aspect: "16:9", layout: presenter, scenes: [settings] }',
      ),
    );
    expect(edited.meta.outputs.youtube!.scenes).toEqual(['settings']);
    const t = timeline(picked(sample(), 'youtube', ['settings']));
    expect(t).toEqual(timeline(edited));
    // the :only{youtube} paragraph stays
    expect(t.scenes[0]!.subtitles.some((x) => x.text.includes('구독'))).toBe(true);
  });

  it('with characters, shots and entrances too', () => {
    const body = `# 하나 {#s1}\n\n::shot{a=head}\n\na: 안녕.\n\n# 둘 {#s2}\n\n::enter{b}\n\nb: 반가워.\n\n# 셋 {#s3}\n\na{face=happy}: 네.\n\nb: 좋아요.\n`;
    const text = (scenes?: string) =>
      `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: x }\n  b: { voice: "qwen:Ryan", character: x }\noutputs:\n  youtube: { aspect: "16:9", layout: dialogue${scenes ? `, scenes: [${scenes}]` : ''} }\n---\n\n${body}`;
    expect(timeline(picked(parse(text()), 'youtube', ['s2', 's3']))).toEqual(
      timeline(parse(text('s2, s3'))),
    );
  });

  it('scene ids are the heading id characters', () => {
    for (const ok of ['intro', 'scene-1', 'A_b', '-x']) expect(SCENE_ID.test(ok), ok).toBe(true);
    for (const bad of ['', 'a.b', 'a b', 'a,b', 'a+b', 'a/b'])
      expect(SCENE_ID.test(bad), bad).toBe(false);
  });
});

describe('pickDrift', () => {
  const head = (cast: string) =>
    `---\nlang: ko\ncast:\n${cast}outputs:\n  youtube: { aspect: "16:9", layout: dialogue }\n---\n\n`;
  const both =
    '  a: { voice: "qwen:Sohee", character: x }\n  b: { voice: "qwen:Ryan", character: x }\n';

  it('names a framing the cut changes', () => {
    const s = parse(
      `${head(both)}# 하나 {#s1}\n\n::shot{a=head}\n\na: 하나.\n\n# 둘 {#s2}\n\n::shot{a=full}\n\na: 둘.\n\n# 셋 {#s3}\n\na{face=listen}: 셋.\n`,
    );
    const d = pickDrift(s, picked(s, 'youtube', ['s1', 's3']), 'youtube');
    expect(d).toEqual([{ kind: 'framing', scene: 's3', cast: 'a', here: 'head', full: 'full' }]);
    expect(driftMessage(d[0]!, 'youtube')).toBe(
      '--scenes: in "s3" a is head here but full in the full video',
    );
    expect(pickDrift(s, picked(s, 'youtube', ['s1', 's2', 's3']), 'youtube')).toEqual([]);
  });

  it('names a side the cut changes (both casts drawn)', () => {
    const s = parse(`${head(both)}# 하나 {#s1}\n\na: 하나.\n\nb: 둘.\n\n# 둘 {#s2}\n\nb: 셋.\n`);
    const d = pickDrift(s, picked(s, 'youtube', ['s2']), 'youtube');
    expect(d).toEqual([{ kind: 'side', cast: 'b', here: 'left', full: 'right' }]);
    expect(driftMessage(d[0]!, 'youtube')).toBe(
      '--scenes: b stands left here but right in the full video',
    );
  });

  it('says nothing for avatars, and one line when only the full video has no characters', () => {
    const avatars = parse(
      `${head('  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\n')}# 하나 {#s1}\n\na: 하나.\n\nb: 둘.\n\n# 둘 {#s2}\n\nb: 셋.\n`,
    );
    expect(pickDrift(avatars, picked(avatars, 'youtube', ['s2']), 'youtube')).toEqual([]);
    const mixed = parse(
      `${head('  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan", character: x }\n')}# 하나 {#s1}\n\na: 하나.\n\n# 둘 {#s2}\n\nb: 셋.\n`,
    );
    const d = pickDrift(mixed, picked(mixed, 'youtube', ['s2']), 'youtube');
    expect(d).toEqual([{ kind: 'full-not-character' }]);
    expect(driftMessage(d[0]!, 'youtube')).toBe(
      '--scenes: the full video draws no characters for "youtube"',
    );
  });
});
