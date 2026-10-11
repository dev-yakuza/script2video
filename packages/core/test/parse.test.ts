import { describe, expect, it } from 'vitest';
import { parseScript, splitSentences, type Paragraph, type Visual } from '../src/index.js';

const fm = (body: string, extra = '') => `---
lang: ko
cast:
  host: { voice: "qwen:Sohee" }
  mina: { voice: "qwen:Sohee" }
outputs:
  youtube: { aspect: "16:9", layout: presenter }
  shorts: { aspect: "9:16", layout: shorts, scenes: [hook] }
${extra}---

${body}`;

function paragraphs(src: string): Paragraph[] {
  const { script, diagnostics } = parseScript(src);
  expect(diagnostics.items.filter((d) => d.severity === 'error')).toEqual([]);
  return script!.scenes.flatMap((s) =>
    s.blocks.filter((b): b is Paragraph => b.kind === 'paragraph'),
  );
}

describe('splitSentences', () => {
  it('splits Korean/English at sentence-final punctuation followed by space', () => {
    const s = splitSentences(
      [{ type: 'text', value: '버전 2.5.1부터 tsconfig.json을 읽습니다. 정말 간단하죠? 네!' }],
      'ko',
    );
    expect(s.map((x) => x.text)).toEqual([
      '버전 2.5.1부터 tsconfig.json을 읽습니다.',
      '정말 간단하죠?',
      '네!',
    ]);
  });

  it('splits Japanese at full-width marks without spaces', () => {
    const s = splitSentences(
      [{ type: 'text', value: 'こんにちは。今日はコードの話です！よろしく' }],
      'ja',
    );
    expect(s.map((x) => x.text)).toEqual(['こんにちは。', '今日はコードの話です！', 'よろしく']);
  });

  it('keeps cue phrases inside the sentence and records their character range', () => {
    const s = splitSentences(
      [
        { type: 'text', value: '오른쪽 위의 ' },
        { type: 'cue', text: '설정 버튼', attrs: { x: '0.7' } },
        { type: 'text', value: '을 누릅니다. 다음입니다.' },
      ],
      'ko',
    );
    expect(s).toHaveLength(2);
    const first = s[0]!;
    expect(first.text).toBe('오른쪽 위의 설정 버튼을 누릅니다.');
    expect(first.text.slice(first.cues[0]!.start, first.cues[0]!.end)).toBe('설정 버튼');
  });

  it('ends a sentence at :pause and records the pause', () => {
    const s = splitSentences(
      [
        { type: 'text', value: '버튼을 누르면' },
        { type: 'pause', seconds: 0.5 },
        { type: 'text', value: '\n새 화면이 열립니다.' },
      ],
      'ko',
    );
    expect(s.map((x) => [x.text, x.pauseAfter])).toEqual([
      ['버튼을 누르면', 0.5],
      ['새 화면이 열립니다.', undefined],
    ]);
  });
});

describe('parseScript', () => {
  it('parses scenes, visuals, cues and output-only paragraphs', () => {
    const src = fm(`# 코드로 영상 만들기 {#hook}

::title[코드로 영상을 만든다면?]

코드만으로 영상을 만들 수 있다면 어떨까요?

# 설정 화면

::image{src=assets/settings.png bg=blur}

오른쪽 위의 :cue[설정 버튼]{x=0.78 y=0.12 zoom=2.5 mark=circle}을 누르면 :pause[0.5]
새 프로젝트를 만들 수 있습니다.

:::bullets
- 템플릿 고르기
- 이름 정하기
:::

:only{youtube} 영상이 도움이 됐다면 구독 부탁드려요.

<!-- 메모 -->
`);
    const { script, diagnostics } = parseScript(src);
    expect(diagnostics.items).toEqual([]);
    expect(script!.scenes.map((s) => [s.id, s.title])).toEqual([
      ['hook', '코드로 영상 만들기'],
      ['scene-2', '설정 화면'],
    ]);
    const blocks = script!.scenes[1]!.blocks;
    expect(blocks.map((b) => (b.kind === 'visual' ? `v:${b.type}` : 'p'))).toEqual([
      'v:image',
      'p',
      'v:bullets',
      'p',
    ]);
    expect((blocks[0] as Visual).attrs).toEqual({ src: 'assets/settings.png', bg: 'blur' });
    expect((blocks[2] as Visual).items).toEqual(['템플릿 고르기', '이름 정하기']);
    const narration = blocks[1] as Paragraph;
    expect(narration.sentences.map((s) => s.text)).toEqual([
      '오른쪽 위의 설정 버튼을 누르면',
      '새 프로젝트를 만들 수 있습니다.',
    ]);
    expect(narration.sentences[0]!.cues[0]!.attrs).toMatchObject({
      x: '0.78',
      zoom: '2.5',
      mark: 'circle',
    });
    expect((blocks[3] as Paragraph).only).toEqual(['youtube']);
    expect((blocks[3] as Paragraph).sentences[0]!.text).toBe(
      '영상이 도움이 됐다면 구독 부탁드려요.',
    );
  });

  it('recognizes speaker prefixes only for cast keys, with attributes', () => {
    const ps = paragraphs(
      fm(`# 대화 {#hook}

mina: 그게 뭔데요?

mina{gap=-0.3}: 오!

note: 이건 화자가 아닙니다.
`),
    );
    expect(ps.map((p) => [p.cast, p.gap, p.sentences[0]!.text])).toEqual([
      ['mina', undefined, '그게 뭔데요?'],
      ['mina', -0.3, '오!'],
      ['host', undefined, 'note: 이건 화자가 아닙니다.'],
    ]);
  });

  it('restores a speaker prefix written without a space before Latin text', () => {
    const src = fm('# 대화 {#hook}\n\nmina:Today 시작합니다.\n').replace('lang: ko', 'lang: ko');
    const ps = paragraphs(src);
    expect(ps[0]!.cast).toBe('mina');
    expect(ps[0]!.sentences[0]!.text).toBe('Today 시작합니다.');
  });

  it('reports unknown directives and bad references', () => {
    const src = fm(
      `# 장면 {#hook}

예를 들어 Note:this 처럼 쓰면 문제가 됩니다.

:::sidebar
a: 1
:::

:only{podcast} 출력에 없는 이름입니다.

오른쪽 :cue[버튼]{x=1.4}입니다.
`,
      'targetDuration: 60\n',
    ).replace('scenes: [hook]', 'scenes: [hook, missing]');
    const { diagnostics } = parseScript(src);
    const codes = diagnostics.items.map((d) => d.code).sort();
    // Every reserved directive is implemented now, so :::sidebar is simply unknown.
    expect(codes).toEqual([
      'cue-range',
      'unknown-directive',
      'unknown-directive',
      'unknown-output',
      'unknown-scene',
    ]);
    expect(diagnostics.items.find((d) => d.code === 'unknown-directive')!.line).toBe(14);
  });

  it('rejects missing or invalid frontmatter', () => {
    expect(parseScript('# no frontmatter\n\n본문입니다.').diagnostics.items[0]!.code).toBe(
      'frontmatter-missing',
    );
    const bad = parseScript('---\nlang: fr\n---\n\n# x\n\n본문.');
    expect(bad.script).toBeNull();
    expect(bad.diagnostics.items[0]!.code).toBe('frontmatter-schema');
  });

  it('parses a code visual from a fenced block inside :::code', () => {
    const src = fm(`# 코드 {#hook}

:::code
\`\`\`html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css">
\`\`\`
:::

:cue[preconnect]{line=1}를 먼저 추가합니다.
`);
    const { script, diagnostics } = parseScript(src);
    expect(diagnostics.items).toEqual([]);
    const code = script!.scenes[0]!.blocks[0] as Visual;
    expect(code.type).toBe('code');
    expect(code.attrs.lang).toBe('html');
    expect(code.body!.split('\n')).toHaveLength(2);
  });

  it('rejects style on persona voices', () => {
    const src = `---
lang: ko
cast:
  alex: { voice: "persona:alex", style: "밝게" }
---

# a

안녕하세요.
`;
    expect(parseScript(src).diagnostics.items.map((d) => d.code)).toEqual(['style-unsupported']);
  });
});

describe('table and quote visuals', () => {
  const doc = (body: string) =>
    parseScript(
      `---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#one}\n\n${body}\n\n설명입니다.\n`,
    );

  it('reads a pipe table, dropping the separator and inline markup', () => {
    const { script, diagnostics } = doc(
      ':::table\n| CSS 속성 | 이유 |\n| --- | :--: |\n| `display: inline-block` | **콘텐츠**에 맞춤 |\n| `float` | [shrink](https://x) |\n:::',
    );
    expect(diagnostics.hasErrors).toBe(false);
    const v = script!.scenes[0]!.blocks[0]!;
    expect(v.kind === 'visual' && v.rows).toEqual([
      ['CSS 속성', '이유'],
      ['display: inline-block', '콘텐츠에 맞춤'],
      ['float', 'shrink'],
    ]);
  });

  it('reads quote paragraphs and its source', () => {
    const { script } = doc(':::quote{by="MDN"}\n첫 문단입니다.\n\n둘째 문단입니다.\n:::');
    const v = script!.scenes[0]!.blocks[0]!;
    expect(v.kind === 'visual' && [v.items, v.attrs.by]).toEqual([
      ['첫 문단입니다.', '둘째 문단입니다.'],
      'MDN',
    ]);
  });
});

describe('subtitleStyle', () => {
  it('merges script and output styles; null font falls back to the default', async () => {
    const { subtitleStyleFor } = await import('../src/schema.js');
    const { script } = parseScript(
      '---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\nsubtitleStyle: { size: 1.2, font: a.ttf, color: "#fff" }\noutputs:\n  youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16", subtitleStyle: { position: middle, font: null } }\n---\n\n# 하나 {#one}\n\n안녕하세요.\n',
    );
    expect(subtitleStyleFor(script!.meta, 'youtube')).toEqual({
      size: 1.2,
      font: 'a.ttf',
      color: '#fff',
    });
    expect(subtitleStyleFor(script!.meta, 'shorts')).toEqual({
      size: 1.2,
      color: '#fff',
      position: 'middle',
    });
  });
});

describe('compare, gallery, chart, video visuals', () => {
  const doc = (body: string) =>
    parseScript(
      `---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#one}\n\n${body}\n\n설명입니다.\n`,
    );
  const first = (body: string) => {
    const r = doc(body);
    return { v: r.script?.scenes[0]?.blocks[0], codes: r.diagnostics.items.map((d) => d.code) };
  };

  it('reads compare columns from headings and lists', () => {
    const { v } = first(':::compare\n### 전\n- 느림\n### 후\n- 빠름\n- 가벼움\n:::');
    expect(v?.kind === 'visual' && v.columns).toEqual([
      { title: '전', items: ['느림'] },
      { title: '후', items: ['빠름', '가벼움'] },
    ]);
    expect(first(':::compare\n### 하나\n- a\n:::').codes).toContain('compare-columns');
  });

  it('reads gallery images with captions', () => {
    const { v } = first(':::gallery\n![첫째](a.png) ![](b.png)\n:::');
    expect(v?.kind === 'visual' && v.images).toEqual([
      { src: 'a.png', caption: '첫째' },
      { src: 'b.png' },
    ]);
    expect(first(':::gallery\n![x](a.png)\n:::').codes).toContain('gallery-images');
  });

  it('needs numeric chart values and a video src', () => {
    expect(first(':::chart\n| a | b |\n| --- | --- |\n| x | 1,200 |\n:::').codes).toEqual([]);
    expect(first(':::chart\n| a | b |\n| --- | --- |\n| x | many |\n:::').codes).toContain(
      'chart-data',
    );
    expect(first('::video').codes).toContain('image-src');
  });
});

describe('diagram visual', () => {
  it('takes a mermaid block', () => {
    const { script, diagnostics } = parseScript(
      '---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#one}\n\n:::diagram\n```mermaid\nflowchart LR\n  A --> B\n```\n:::\n\n설명입니다.\n',
    );
    expect(diagnostics.hasErrors).toBe(false);
    const v = script!.scenes[0]!.blocks[0]!;
    expect(v.kind === 'visual' && [v.type, v.body]).toEqual(['diagram', 'flowchart LR\n  A --> B']);
  });
});

describe('markdown and split visuals', () => {
  const doc = (body: string) =>
    parseScript(
      `---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#one}\n\n${body}\n\n설명입니다.\n`,
    );
  it('reads headings, paragraphs and list items with bold and code', () => {
    const { script } = doc(':::markdown\n## 제목\n`a: b`와 **굵게**\n\n- 하나\n:::');
    const v = script!.scenes[0]!.blocks[0]!;
    expect(v.kind === 'visual' && v.md).toEqual([
      { kind: 'h', runs: [{ text: '제목' }] },
      {
        kind: 'p',
        runs: [{ text: 'a: b', code: true }, { text: '와 ' }, { text: '굵게', bold: true }],
      },
      { kind: 'li', runs: [{ text: '하나' }] },
    ]);
  });
  it('takes one image and the text for split', () => {
    const { script } = doc(':::split{side=right}\n![화면](a.png)\n\n설명 문단\n:::');
    const v = script!.scenes[0]!.blocks[0]!;
    expect(v.kind === 'visual' && [v.type, v.images, v.md?.length]).toEqual([
      'split',
      [{ src: 'a.png', caption: '화면' }],
      1,
    ]);
    expect(doc(':::split\n설명만\n:::').diagnostics.items.map((d) => d.code)).toContain(
      'split-image',
    );
  });
});
