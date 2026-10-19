/** `:look` (acting stage 5b): syntax, speaker and listener faces, lint. */
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  lintActing,
  listenerLookFaces,
  parseScript,
  sidesOf,
  type Script,
} from '../src/index.js';

const ALL = [
  'neutral',
  'happy',
  'surprised',
  'front-neutral',
  'front-happy',
  'front-surprised',
  'glance-neutral',
];

function script(
  body: string,
  opts: { faces?: string[]; character?: boolean; extra?: string } = {},
): Script {
  const ch = opts.character === false ? '' : ', character: c';
  const r = parseScript(
    `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee"${ch} }\n  b: { voice: "qwen:Ryan"${ch} }\n${opts.extra ?? ''}---\n\n# 하나 {#one}\n\n${body}\n`,
  );
  const s = r.script!;
  if (opts.character !== false)
    for (const m of Object.values(s.meta.cast)) m.faceSets = { any: opts.faces ?? ALL } as never;
  return s;
}

const words = (text: string, dur: number) =>
  text.split(' ').map((w, i, all) => ({
    text: w,
    start: (i * dur) / all.length,
    end: ((i + 1) * dur) / all.length,
  }));

/** Every sentence 2 s, words spread evenly; fps 10. */
function timeline(s: Script) {
  const manifest: Record<
    string,
    { src: string; duration: number; words: ReturnType<typeof words> }
  > = {};
  s.scenes[0]!.blocks.forEach((b, bi) => {
    if (b.kind !== 'paragraph') return;
    b.sentences.forEach(
      (x, si) =>
        (manifest[`one:${bi}:${si}`] = { src: 'x.wav', duration: 2, words: words(x.text, 2) }),
    );
  });
  return buildTimeline(s, 'youtube', manifest, 10).timeline.scenes[0]!;
}

describe(':look syntax', () => {
  it('records looks at their place, adds no text', () => {
    const s = script('a: 안녕 :look{b=viewer}하세요. 반갑습니다.');
    const p = s.scenes[0]!.blocks[0]!;
    expect(p.kind === 'paragraph' && p.sentences[0]).toMatchObject({
      text: '안녕 하세요.',
      looks: [{ at: 3, looks: { b: 'viewer' } }],
    });
  });

  it('rejects unknown cast, values, empty and repeated casts', () => {
    const codes = (body: string) =>
      parseScript(
        `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\n---\n\n# 하나 {#one}\n\n${body}\n`,
      ).diagnostics.items.map((d) => d.code);
    expect(codes('a: :look{z=viewer}안녕.')).toContain('look-cast');
    expect(codes('a: :look{b=up}안녕.')).toContain('look-value');
    expect(codes('a: :look{}안녕.')).toContain('look-empty');
    expect(codes('a: :look{b=viewer b=glance}안녕.')).toContain('look-duplicate');
  });

  it('warns when a look has no word after it', () => {
    const r = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\n---\n\n# 하나 {#one}\n\na: 안녕. :look{b=viewer}\n',
    );
    expect(r.diagnostics.items.map((d) => d.code)).toContain('look-dropped');
  });
});

describe('speaker looks', () => {
  it('a look leading a sentence changes it; inside a sentence, the next one', () => {
    const t = timeline(script('a: :look{a=viewer}첫 문장. 둘째 :look{a=glance}문장. 셋째 문장.'));
    expect(t.audio.map((x) => x.face)).toEqual([
      'front-neutral',
      'front-neutral',
      'glance-neutral',
    ]);
    expect(lintActing(script('a: 첫 :look{a=viewer}문장. 끝.')).map((d) => d.code)).toContain(
      'look-midsentence',
    );
    expect(lintActing(script('a: 첫 문장. 끝 :look{a=viewer}문장.')).map((d) => d.code)).toContain(
      'look-dropped',
    );
  });

  it('keeps the face without the variant (lint info); motions follow the face before the look', () => {
    const s = script('a{emo=surprised}: :look{a=glance}와.', {
      faces: ['neutral', 'surprised', 'front-surprised'],
    });
    const t = timeline(s);
    expect(t.audio[0]!.face).toBe('surprised');
    expect(t.motions.map((m) => m.motion)).toEqual(['jump']);
    expect(lintActing(s).map((d) => d.code)).toContain('look-variant');
    const v = timeline(script('a{emo=surprised}: :look{a=viewer}와.'));
    expect(v.audio[0]!.face).toBe('front-surprised');
    expect(v.motions.map((m) => m.motion)).toEqual(['jump']);
  });

  it('takes looks in the head framing too; casts without character information ignore them', () => {
    expect(timeline(script('::shot{a=head}\n\na: :look{a=viewer}안녕.')).audio[0]!.face).toBe(
      'front-neutral',
    );
    expect(timeline(script('a: :look{a=viewer}안녕.', { character: false })).audio[0]!.face).toBe(
      'neutral',
    );
    // A close-up draws the variant only from its own set; without it the face stays.
    const s = script('::shot{a=head}\n\na: :look{a=glance}안녕.');
    s.meta.cast.a!.faceSets = { full: ALL, upper: [], head: ['neutral', 'front-neutral'] } as never;
    expect(timeline(s).audio[0]!.face).toBe('neutral');
    expect(lintActing(s).find((d) => d.code === 'look-variant')!.message).toContain(
      'no drawable "glance-neutral" face in the head framing',
    );
  });
});

const SRC2 =
  '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: c }\n  b: { voice: "qwen:Ryan", character: c }\n  z: { voice: "qwen:Ryan", character: c }\n---\n\n# 하나 {#one}\n\na: :look{z=viewer b=glance}안녕.\n\nb: 네.\n';

describe('listener looks', () => {
  it('lasts to the paragraph end (held) or the next look; partner ends it', () => {
    const t = timeline(
      script(
        'a: 하나 둘 :look{b=viewer}셋 넷. 다섯 :look{b=glance}여섯. 일곱 :look{b=partner}여덟.',
      ),
    );
    expect(t.looks).toEqual([
      { cast: 'b', face: 'front-neutral', startFrame: 23, endFrame: 46 },
      { cast: 'b', face: 'glance-neutral', startFrame: 46, endFrame: 69 },
    ]);
    const held = timeline(script('a: 하나 :look{b=viewer}둘.'));
    expect(held.looks).toEqual([
      { cast: 'b', face: 'front-neutral', startFrame: 23, endFrame: 33, hold: true },
    ]);
  });

  it('a reaction during a look takes its variant; partner shows the reaction face again', () => {
    const t = timeline(script('a: :look{b=viewer}하나 :react{b=surprised}둘 :look{b=partner}셋.'));
    expect(t.reactions[0]!.face).toBe('front-surprised');
    expect(t.looks!.at(-1)).toMatchObject({ face: 'surprised', hold: true });
  });

  it('partner brings back the latest of two reactions starting together', () => {
    const t = timeline(
      script('a: 하나 :react{b=happy}:react{b=surprised}둘 :look{b=viewer}셋 :look{b=partner}넷.'),
    );
    expect(t.looks!.at(-1)).toMatchObject({ face: 'surprised' });
  });

  it('drops a look after the last word, with a warning', () => {
    const s = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\n---\n\n# 하나 {#one}\n\na: 하나. 둘 셋 :look{b=viewer}.\n',
    );
    expect(s.diagnostics.items.map((d) => d.code)).toContain('look-dropped');
    const p = s.script!.scenes[0]!.blocks[0]!;
    expect(p.kind === 'paragraph' && p.sentences[1]!.looks).toBeUndefined();
  });

  it('a look during a reaction shows the variant of the reaction face', () => {
    const t = timeline(script('a: :react{b=happy}하나 :look{b=viewer}둘.'));
    expect(t.reactions[0]!.face).toBe('happy');
    expect(t.looks).toEqual([expect.objectContaining({ face: 'front-happy' })]);
    expect(
      listenerLookFaces(
        script('a: :react{b=happy}하나 :look{b=viewer}둘.').meta,
        script('a: :react{b=happy}하나 :look{b=viewer}둘.').scenes[0]!.blocks[0] as never,
        () => 'full',
      ),
    ).toEqual(
      expect.arrayContaining([
        { cast: 'b', face: 'front-neutral', wanted: 'front-neutral' },
        { cast: 'b', face: 'front-happy', wanted: 'front-happy' },
      ]),
    );
  });
});

describe('look lint', () => {
  const codes = (s: Script) => lintActing(s).map((d) => d.code);

  it('warns about a listener on the speaker side unless it reacts there', () => {
    const s2 = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: c }\n  b: { voice: "qwen:Ryan", character: c }\n  c: { voice: "qwen:Ryan", character: c }\n---\n\n# 하나 {#one}\n\na: :look{c=viewer}안녕.\n\nb: 네.\n\nc: 응.\n',
    ).script!;
    expect(codes(s2)).toContain('look-side');
    const s3 = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: c }\n  b: { voice: "qwen:Ryan", character: c }\n  c: { voice: "qwen:Ryan", character: c }\n---\n\n# 하나 {#one}\n\na: :react{c=happy}:look{c=viewer}안녕.\n\nb: 네.\n\nc: 응.\n',
    ).script!;
    expect(codes(s3)).not.toContain('look-side');
  });

  it('notes a missing variant of a reaction face', () => {
    const s = script('a: :react{b=happy}하나 :look{b=viewer}둘.', {
      faces: ['neutral', 'happy', 'front-neutral'],
    });
    expect(
      lintActing(s)
        .filter((d) => d.code === 'look-variant')
        .map((d) => d.message)
        .join(),
    ).toContain('front-happy');
  });

  it('notes a cast never on stage and a listener glance', () => {
    const s = parseScript(SRC2).script!;
    expect(codes(s)).toEqual(expect.arrayContaining(['look-absent', 'look-glance-listener']));
    const msg = (t: string) =>
      lintActing(parseScript(t).script!).find((d) => d.code === 'look-glance-listener')!.message;
    expect(msg(SRC2)).toContain('almost like its default stance');
    expect(msg(SRC2.replace('# 하나 {#one}\n\n', '# 하나 {#one}\n\n::shot{b=head}\n\n'))).toContain(
      'the same as its default stance',
    );
    // A classic folder's glance-<face>.png is its own picture, also in a close-up.
    const classic = parseScript(
      SRC2.replace('# 하나 {#one}\n\n', '# 하나 {#one}\n\n::shot{b=head}\n\n'),
    ).script!;
    classic.meta.cast.b!.faceSets = { any: ALL } as never;
    expect(lintActing(classic).find((d) => d.code === 'look-glance-listener')!.message).toContain(
      'almost like its default stance',
    );
  });

  it('assigns sides like the renderer', () => {
    expect(sidesOf([{ key: 'a' }, { key: 'b', side: 'left' }, { key: 'c' }, { key: 'd' }])).toEqual(
      { a: 'left', b: 'left', c: 'right', d: 'right' },
    );
  });
});
