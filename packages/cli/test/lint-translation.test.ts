import { parseScript } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import { lintTranslation } from '../src/lint-assets.js';

const doc = (lang: string, body: string, extra = '') =>
  parseScript(`---\nlang: ${lang}\n${extra}cast:\n  host: { voice: "qwen:Ryan" }\n---\n\n${body}`)
    .script!;

const original = doc(
  'ko',
  '# 하나 {#one}\n\n::title[제목]\n\n:cue[버튼]{x=0.5 y=0.5}을 누릅니다.\n\n# 둘 {#two}\n\n끝입니다.\n',
);

describe('lintTranslation', () => {
  it('accepts a translation with the same structure', () => {
    const t = doc(
      'en',
      '# One {#one}\n\n::title[Title]\n\nPress the :cue[button]{x=0.5 y=0.5}.\n\n# Two {#two}\n\nDone.\n',
    );
    expect(lintTranslation(t, original, 'script.ko.md')).toEqual([]);
  });

  it('reports a missing cue and a changed visual', () => {
    const t = doc(
      'en',
      '# One {#one}\n\n::image{src=a.png}\n\nPress the button.\n\n# Two {#two}\n\nDone.\n',
    );
    const msgs = lintTranslation(t, original, 'script.ko.md').map((d) => d.message);
    expect(msgs).toEqual([
      'scene "one": visuals [image] differ from script.ko.md [title]',
      'scene "one": 0 cues vs 1 in script.ko.md',
    ]);
  });

  it('reports different scene ids and can be silenced with allowDrift', () => {
    const t = doc('en', '# One {#first}\n\nHi.\n\n# Two {#two}\n\nDone.\n');
    expect(lintTranslation(t, original, 'o.md')[0]!.message).toMatch(/scene ids differ/);
    const drift = doc('en', '# One {#first}\n\nHi.\n', 'allowDrift: true\n');
    expect(lintTranslation(drift, original, 'o.md')).toEqual([]);
  });
});
