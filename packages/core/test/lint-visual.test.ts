/** `no-visual` and the shared "has a visual" predicate (pilot-1 P1). */
import { describe, expect, it } from 'vitest';
import { characterModeFor, lintVisuals, parseScript, type Script } from '../src/index.js';

const fm = (body: string, cast = '  host: { voice: "qwen:Sohee" }\n', outputs = '') => `---
lang: ko
cast:
${cast}outputs:
  youtube: { aspect: "16:9", layout: presenter }
${outputs}---

${body}`;

function parse(src: string): Script {
  const { script, diagnostics } = parseScript(src);
  expect(diagnostics.items.filter((d) => d.severity === 'error')).toEqual([]);
  return script!;
}

const warned = (src: string) =>
  lintVisuals(parse(src)).map((d) => ({ line: d.line, message: d.message }));

describe('no-visual', () => {
  it('warns on a scene that only speaks, with the output name and line', () => {
    const d = lintVisuals(parse(fm('# 시작 {#intro}\n\n안녕하세요.\n')));
    expect(d).toEqual([
      {
        severity: 'warning',
        code: 'no-visual',
        message:
          'output "youtube" scene intro: no visual — the frame shows only the background; add ::title[…], a text card (:::bullets/:::quote/…) or an image',
        line: 9,
      },
    ]);
  });

  it('a labelled title, a text card or an image is a visual', () => {
    expect(warned(fm('# a {#a}\n\n::title[제목]\n\n안녕하세요.\n'))).toEqual([]);
    expect(warned(fm('# a {#a}\n\n:::bullets\n- 하나\n:::\n\n안녕하세요.\n'))).toEqual([]);
    expect(warned(fm('# a {#a}\n\n::image{src="a.png"}\n\n안녕하세요.\n'))).toEqual([]);
    // after the narration too: the scene's visuals are drawn from its first frame
    expect(warned(fm('# a {#a}\n\n안녕하세요.\n\n::title[끝]\n'))).toEqual([]);
  });

  it('a title without a label and a thumbnail are not', () => {
    expect(warned(fm('# a {#a}\n\n::title\n\n안녕하세요.\n'))).toHaveLength(1);
    // the empty card is what the first narration shows, even with a labelled title later
    expect(
      warned(fm('# a {#a}\n\n::title\n\n안녕하세요.\n\n::title[x]\n\n둘째 문장입니다.\n')),
    ).toHaveLength(1);
    // a thumbnail first does not hide the visual after it
    expect(
      warned(fm('# a {#a}\n\n::thumbnail{src="t.png"}\n\n::title[x]\n\n안녕하세요.\n')),
    ).toEqual([]);
    expect(warned(fm('# a {#a}\n\n::thumbnail{src="t.png"}\n\n안녕하세요.\n'))).toHaveLength(1);
  });

  it('a scene without narration is not reported', () => {
    expect(warned(fm('# a {#a}\n\n::title[제목]\n\n안녕하세요.\n\n# b {#b}\n\n::title\n'))).toEqual(
      [],
    );
  });

  it('characters are the picture when every speaker has art', () => {
    const cast =
      '  host: { voice: "qwen:Sohee", character: "art/host" }\n  guest: { voice: "qwen:Sohee", character: "art/guest" }\n';
    const src = fm('# a {#a}\n\nhost: 안녕하세요.\n\nguest: 반가워요.\n', cast);
    expect(characterModeFor(parse(src), 'youtube')).toBe(true);
    expect(warned(src)).toEqual([]);
  });

  it('mixed art (one speaker without) warns on bare scenes', () => {
    const cast =
      '  host: { voice: "qwen:Sohee", character: "art/host" }\n  guest: { voice: "qwen:Sohee" }\n';
    const src = fm(
      '# a {#a}\n\nhost: 안녕하세요.\n\n# b {#b}\n\n::title[둘째]\n\nguest: 반가워요.\n',
      cast,
    );
    expect(characterModeFor(parse(src), 'youtube')).toBe(false);
    expect(warned(src).map((d) => d.line)).toEqual([10]);
  });

  it('is per output: scenes and paragraphs the output does not have are skipped', () => {
    const src = fm(
      '# a {#a}\n\n::title[하나]\n\n안녕하세요.\n\n# b {#b}\n\n둘째입니다.\n\n# c {#c}\n\n::title[셋]\n\n:only{shorts} 숏츠에서만.\n',
      undefined,
      '  shorts: { aspect: "9:16", layout: shorts, scenes: [b] }\n',
    );
    expect(warned(src).map((d) => d.message.split(':')[0])).toEqual([
      'output "youtube" scene b',
      'output "shorts" scene b',
    ]);
  });

  it('the cast of the output decides character mode', () => {
    // guest (no art) speaks only in scene b: the shorts output (scene a) draws characters
    const cast =
      '  host: { voice: "qwen:Sohee", character: "art/host" }\n  guest: { voice: "qwen:Sohee" }\n';
    const src = fm(
      '# a {#a}\n\nhost: 안녕하세요.\n\n# b {#b}\n\n::title[둘]\n\nguest: 반가워요.\n',
      cast,
      '  shorts: { aspect: "9:16", layout: shorts, scenes: [a] }\n',
    );
    expect(warned(src).map((d) => d.message.split(':')[0])).toEqual(['output "youtube" scene a']);
  });
});
