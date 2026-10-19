/** The stage of core lint and the renderer's stagePlan agree (acting stage 5c plan 3, M6). */
import { buildTimeline, parseScript, stageEvents } from '@script2video/core';
import { stagePlan } from '@script2video/renderer-remotion';
import { describe, expect, it } from 'vitest';

const SOURCE = `---
lang: ko
cast:
  a: { voice: "qwen:Sohee", character: x }
  b: { voice: "qwen:Ryan", character: x }
  c: { voice: "qwen:Ryan", character: x, side: right }
---

# 하나 {#one}

c: 하나 :react{a=happy}입니다.

a: 둘.

# 둘 {#two}

::enter{b}
b: 셋.

a: 넷.

# 셋 {#three}

::exit{b}
b: 다섯.

# 넷 {#four}

a: 여섯.

c: 일곱.
`;

describe('stage parity', () => {
  it('the same sides are empty for core and the renderer at every line', () => {
    const script = parseScript(SOURCE).script!;
    const manifest: Record<string, { src: string; duration: number; words: [] }> = {};
    for (const s of script.scenes)
      s.blocks.forEach((b, bi) => {
        if (b.kind === 'paragraph')
          b.sentences.forEach(
            (_, si) => (manifest[`${s.id}:${bi}:${si}`] = { src: 'x', duration: 1, words: [] }),
          );
      });
    const { timeline } = buildTimeline(script, 'youtube', manifest, 30);
    const core = stageEvents(script, 'youtube');
    expect(core.diagnostics).toEqual([]);
    const plan = stagePlan(timeline.scenes, core.side);
    timeline.scenes.forEach((scene, si) => {
      const paragraphs = script.scenes[si]!.blocks.filter((b) => b.kind === 'paragraph');
      scene.audio.forEach((a, ai) => {
        const empty = core.empty.get(paragraphs[ai] as never)!;
        for (const side of ['left', 'right'] as const) {
          const list = plan[si]![side];
          let keys: string[] = [];
          for (const sw of list) if (sw.frame <= a.startFrame) keys = sw.keys;
          // the side of the line is never empty; the other side is empty exactly when core says so
          expect(keys.length === 0, `${scene.id} line ${ai} ${side}`).toBe(empty.has(side));
        }
      });
    });
  });
});
