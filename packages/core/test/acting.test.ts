import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  CLOSE,
  consistencyReasons,
  decodeReferences,
  emotionGateFailures,
  emotionPitchWindow,
  estimateLengths,
  gainFor,
  GATES,
  instructFor,
  lintActing,
  paragraphActing,
  parsePrefixAttrs,
  parseScript,
  pitchRange,
  sentenceFace,
  sentenceId,
  speedProduct,
  TEMPLATES_V1,
  type AudioManifest,
  type Paragraph,
  type Script,
} from '../src/index.js';

const fm = (body: string, extra = '') => `---
lang: ko
cast:
  host: { voice: "qwen:Sohee" }
  guest: { voice: "persona:guest" }
  robo: { voice: "supertonic:F1" }
${extra}---

# s

${body}`;

function parse(src: string) {
  const r = parseScript(src);
  return {
    ...r,
    errors: r.diagnostics.items.filter((d) => d.severity === 'error').map((d) => d.code),
    infos: r.diagnostics.items.filter((d) => d.severity !== 'error').map((d) => d.code),
  };
}

function paragraphs(src: string): Paragraph[] {
  const { script, errors } = parse(src);
  expect(errors).toEqual([]);
  return script!.scenes.flatMap((s) =>
    s.blocks.filter((b): b is Paragraph => b.kind === 'paragraph'),
  );
}

describe('speaker prefix attributes', () => {
  it('reads every voice attribute', () => {
    const [p] = paragraphs(
      fm(
        'host{emo=sad power=weak say="혼잣말처럼" volume=soft speed=1.1 gap=-0.2}: 그럴 줄 알았어.\n',
      ),
    );
    expect(p!.acting).toEqual({
      emo: 'sad',
      power: 'weak',
      say: '혼잣말처럼',
      volume: 'soft',
      speed: 1.1,
    });
    expect(p!.gap).toBe(-0.2);
    expect(p!.sentences[0]!.acting).toEqual(p!.acting);
    expect(p!.sentences[0]!.text).toBe('그럴 줄 알았어.');
  });

  it.each([
    ['an unknown emotion', 'host{emo=sleepy}: 안녕.', 'emo-name'],
    ['power without emo', 'host{power=strong}: 안녕.', 'power-without-emo'],
    ['a wrong power', 'host{emo=sad power=max}: 안녕.', 'power-value'],
    ['a wrong volume', 'host{volume=quiet}: 안녕.', 'volume-value'],
    ['speed out of range', 'host{speed=1.5}: 안녕.', 'speed-value'],
    ['speed not a number', 'host{speed=fast}: 안녕.', 'speed-value'],
    ['gap out of range', 'host{gap=5}: 안녕.', 'gap-value'],
    ['an empty gap', 'host{gap=""}: 안녕.', 'gap-value'],
    ['an unknown attribute', 'host{colour=red}: 안녕.', 'prefix-attrs'],
    ['a repeated key', 'host{emo=sad emo=happy}: 안녕.', 'prefix-attrs'],
    ['a leftover token', 'host{emo=sad quietly}: 안녕.', 'prefix-attrs'],
    ['a quote inside say', `host{say="it's"}: 안녕.`, 'say-chars'],
    ['say on a persona voice', 'guest{say="낮게"}: 안녕.', 'say-unsupported'],
  ])('refuses %s', (_, line, code) => {
    expect(parse(fm(`${line}\n`)).errors).toContain(code);
  });

  it('decodes terminated character references like micromark', () => {
    expect(decodeReferences('a &amp; &#x41;&#66; &unknown; a\\b &nbsp;')).toBe(
      'a & AB &unknown; a\\b  ',
    );
    expect(parsePrefixAttrs('say="A &amp; B" emo=sad').attrs).toEqual({ say: 'A & B', emo: 'sad' });
  });

  it('accepts user emotions and refuses one named like a standard emotion', () => {
    const extra =
      'acting:\n  emotions:\n    sleepy: { voice: "Sound drowsy.", face: calm, speed: 0.8 }\n';
    expect(paragraphs(fm('host{emo=sleepy}: 졸려요.\n', extra))[0]!.acting).toEqual({
      emo: 'sleepy',
    });
    const bad = 'acting:\n  emotions:\n    sad: { voice: "x" }\n';
    expect(parse(fm('host: 안녕.\n', bad)).errors).toContain('emo-name');
  });
});

describe('masking prefixes and parsing again', () => {
  it('keeps markup inside say as text', () => {
    const [p] = paragraphs(fm('host{emo=calm say="a :pause[1] *b* &amp; c"}: 대사입니다.\n'));
    expect(p!.acting!.say).toBe('a :pause[1] *b* & c');
    expect(p!.sentences.map((s) => s.text)).toEqual(['대사입니다.']);
  });

  it('reads a line right after the colon and a directive name after it', () => {
    const [p] = paragraphs(fm('host{face=happy}:Today we start.\n'));
    expect(p!.sentences[0]!.text).toBe('Today we start.');
    expect(p!.face).toBe('happy');
  });

  it('parses the rest of the document the same', () => {
    const body = [
      'host{emo=happy}: 첫 문장. :cue[강조]{zoom=2} 두 번째.',
      '',
      '```',
      'host{x=1}: not a speaker',
      '```',
      '',
      ':::markdown',
      '- **굵게** 항목',
      ':::',
      '',
      '1. 목록',
      '',
      'guest: 마지막.',
    ].join('\n');
    const masked = parseScript(fm(body));
    const plain = parseScript(fm(body.replace('host{emo=happy}:', 'host:')));
    const strip = (s: Script) =>
      JSON.stringify(s.scenes, (k, v) => (k === 'acting' ? undefined : v));
    expect(strip(masked.script!)).toBe(strip(plain.script!));
    expect(masked.trace!.masked.length).toBe(fm(body).length);
    expect(masked.trace!.masked.split('\n').length).toBe(fm(body).split('\n').length);
  });

  it('reports broken prefixes of cast members only', () => {
    expect(parse(fm('host{emo=sad: 안녕.\n')).errors).toContain('prefix-broken');
    expect(parse(fm('host {emo=sad}: 안녕.\n')).errors).toContain('prefix-broken');
    expect(parse(fm('host: {emo=sad} 안녕.\n')).errors).toContain('prefix-broken');
    expect(parse(fm('{face=happy} 안녕.\n')).errors).toContain('prefix-broken');
    expect(parse(fm('host { 이건 그냥 } 문장.\n')).errors).toContain('prefix-broken');
    expect(parse(fm('host{face=happy}:cue[x]{zoom=2} 봐요.\n')).errors).toEqual([
      'prefix-directive',
    ]);
    // narration that merely contains braces
    expect(parse(fm('host: {x=1} 객체를 넘깁니다.\n')).errors).toEqual([]);
    expect(parse(fm('Set {retries=3} in the config.\n')).errors).toEqual([]);
  });

  it('reports a directive glued to the prefix colon, keeps multi-line prefixes working', () => {
    expect(parse(fm('host{face=happy}:cue[설정]{x=0.5}을 눌러요.\n')).errors).toContain(
      'prefix-directive',
    );
    const [p] = paragraphs(fm('host{face=happy\n gap=1}: 안녕.\n'));
    expect(p).toMatchObject({ face: 'happy', gap: 1 });
    expect(parse(fm('_host{emo=sad}: 안녕.\n')).errors).toEqual([]);
    // a prefix over several lines that the older path cannot read either
    expect(parse(fm('host{emo=sad\n say="*x*"}: 여러 줄.\n')).errors).toContain('prefix-broken');
    expect(parse(fm('host{emo=sad\n say="a :pause[1] b"}: 여러 줄.\n')).errors).toContain(
      'prefix-broken',
    );
    // a bare ":emo" in text: the escape hint, no placement error
    const bare = parse(fm('host: 키는 key:emo 입니다.\n')).diagnostics.items;
    expect(bare.map((d) => d.code)).toEqual(['emo-attrs']);
    expect(bare[0]!.message).toMatch(/escape it as "\\:emo"/);
  });

  it('reports attributes that did not attach to a directive', () => {
    expect(parse(fm('host: 여기 :cue[x] {zoom=2} 봐요.\n')).errors).toContain('directive-brace');
  });
});

describe(':emo', () => {
  it('changes the voice attributes from the next sentence, replacing them whole', () => {
    const [p] = paragraphs(
      fm(
        'host{emo=calm volume=soft}: 처음엔 괜찮았어요. :emo{emo=sad power=weak}그런데 그날 이후로는요. 계속요.\n',
      ),
    );
    expect(p!.sentences.map((s) => [s.acting, s.actingChange])).toEqual([
      [{ emo: 'calm', volume: 'soft' }, undefined],
      [{ emo: 'sad', power: 'weak' }, true],
      [{ emo: 'sad', power: 'weak' }, undefined],
    ]);
  });

  it('must stand between sentences', () => {
    expect(parse(fm('host: 처음엔 :emo{emo=sad}괜찮았어요.\n')).errors).toContain('emo-placement');
    expect(parse(fm('host: 처음엔 괜찮았어요. :emo{emo=sad}\n')).errors).toContain('emo-placement');
    expect(parse(fm('host: :emo{emo=sad}처음엔 괜찮았어요.\n')).infos).toContain('emo-placement');
  });

  it('needs emo and known keys, once each', () => {
    expect(parse(fm('host: 하나. :emo{sad}둘.\n')).errors).toContain('emo-attrs');
    expect(parse(fm('host: 하나. :emo{emo=sad emo=happy}둘.\n')).errors).toContain('emo-attrs');
    expect(parse(fm('host: 하나. :emo{emo=sad say="emo=x"}둘.\n')).errors).toEqual([]);
    expect(parse(fm('host: 하나. :emo{emo=sad colour=red}둘.\n')).errors).toContain('emo-attrs');
  });

  it('keeps only the face and volume of a recording', () => {
    const r = parse(fm('host{emo=sad power=weak volume=loud}: :audio{src=a.wav} 녹음입니다.\n'));
    expect(r.infos).toContain('recording-acting');
    expect(r.diagnostics.items.filter((d) => d.code === 'recording-acting')).toHaveLength(2);
    const p = r.script!.scenes[0]!.blocks[0] as Paragraph;
    expect(p.acting).toEqual({ emo: 'sad', volume: 'loud' });
  });
});

describe('acting rules', () => {
  const meta = parseScript(
    fm(
      'host: x.\n',
      'acting:\n  emotions:\n    sleepy: { voice: "Sound drowsy.", face: calm, motion: none, speed: 0.8, maxPause: 1.5 }\n',
    ),
  ).script!.meta;

  it('builds the instruction from style, template and say', () => {
    expect(instructFor(meta, 'calm', undefined)).toEqual({ instruct: 'calm', template: false });
    expect(instructFor(meta, undefined, { say: '속삭이듯' })).toEqual({
      instruct: '속삭이듯',
      template: false,
    });
    expect(instructFor(meta, 'calm', { emo: 'sad', say: '천천히' })).toEqual({
      instruct: `calm ${TEMPLATES_V1.sad}${CLOSE} 천천히`,
      template: true,
    });
    expect(instructFor(meta, undefined, { emo: 'sleepy' }).instruct).toBe(`Sound drowsy.${CLOSE}`);
  });

  it('multiplies the speeds', () => {
    expect(
      speedProduct(meta, { ...meta.cast.host!, speed: 1.1 }, { emo: 'sleepy', speed: 0.9 }),
    ).toBeCloseTo(1.1 * 0.9 * 0.8);
  });

  it('widens the pitch window of emotion lines, never below the plain one', () => {
    expect(emotionPitchWindow('happy', 1, '좋아요.')).toEqual([-4.5, 9]);
    expect(emotionPitchWindow('sad', 1, '그래?')).toEqual([-4.5, 5.5]);
    expect(emotionPitchWindow('sad', 3, '그래.')).toEqual([-6, 6]);
    const plain = pitchRange(3, '그래.');
    expect(emotionPitchWindow('sad', 3, '그래.')[0]).toBeLessThanOrEqual(plain[0]);
    const ref = { f0: 200, sigma: 1, simFloor: 0.97, sims: [0.98, 0.99] };
    const high = 200 * 2 ** (5 / 12);
    expect(consistencyReasons({ text: '좋아요.', f0: high, sim: null }, ref)).toHaveLength(1);
    expect(consistencyReasons({ text: '좋아요.', f0: high, sim: null, emo: 'happy' }, ref)).toEqual(
      [],
    );
    // emotion lines: similarity floor max(0.94, lowest reference take − 0.03)
    expect(consistencyReasons({ text: '좋아요.', f0: null, sim: 0.955 }, ref)).toHaveLength(1);
    expect(
      consistencyReasons({ text: '좋아요.', f0: null, sim: 0.955, emo: 'happy' }, ref),
    ).toEqual([]);
    expect(
      consistencyReasons({ text: '좋아요.', f0: null, sim: 0.945, emo: 'happy' }, ref),
    ).toHaveLength(1);
  });

  it('applies the gates', () => {
    const job = { multiplier: 1, maxPause: GATES.pauseS, synthSpeed: 1 };
    const ok = { chars: 10, rawDuration: 2, rawPause: 0.3, lead: 0.1, tail: 0.1, noise: 0.2 };
    expect(emotionGateFailures(ok, job, 5)).toEqual([]);
    expect(emotionGateFailures({ ...ok, lead: 0.5 }, job, 5)).toHaveLength(1);
    expect(emotionGateFailures({ ...ok, noise: 0.8 }, job, 5)).toHaveLength(1);
    // long takes may carry more unvoiced sound (0.15 s per second)
    expect(emotionGateFailures({ ...ok, rawDuration: 7, chars: 35, noise: 1.0 }, job, 5)).toEqual(
      [],
    );
    expect(emotionGateFailures({ ...ok, rawDuration: 3.2 }, job, 5)).toHaveLength(1);
    // within 0.5 s of the expected length passes
    expect(emotionGateFailures({ ...ok, chars: 8, rawDuration: 2.1 }, job, 5)).toEqual([]);
    // short lines skip the length gate; no reference skips it too
    expect(emotionGateFailures({ ...ok, chars: 3, rawDuration: 3 }, job, 5)).toEqual([]);
    expect(emotionGateFailures({ ...ok, rawDuration: 9 }, job, null)).toEqual([]);
    expect(emotionGateFailures({ ...ok, rawPause: 1.0 }, job, 5)).toHaveLength(1);
    expect(emotionGateFailures({ ...ok, rawPause: 1.0 }, { ...job, maxPause: 1.5 }, 5)).toEqual([]);
  });
});

describe('faces, motions and gain', () => {
  const extra = 'acting:\n  emotions:\n    sleepy: { voice: "Sound drowsy.", face: calm }\n';
  const setup = (body: string, sets?: object, castExtra?: object) => {
    const s = parseScript(fm(body, extra)).script!;
    if (sets) s.meta.cast.host!.faceSets = sets as never;
    Object.assign(s.meta.cast.host!, castExtra ?? {});
    return s;
  };
  const para = (s: Script) => s.scenes[0]!.blocks[0] as Paragraph;

  it('shows an emotion face only when the character can draw it', () => {
    const s = setup('host{emo=happy}: 좋아요.\n', { full: ['happy'], head: [] });
    const p = para(s);
    expect(sentenceFace(s.meta, p, p.sentences[0]!, 'full')).toEqual({
      wanted: 'happy',
      drawn: 'happy',
    });
    expect(sentenceFace(s.meta, p, p.sentences[0]!, 'head')).toEqual({
      wanted: 'happy',
      drawn: 'neutral',
    });
    const none = setup('host{emo=happy}: 좋아요.\n');
    expect(sentenceFace(none.meta, para(none), para(none).sentences[0]!, 'full').drawn).toBe(
      'neutral',
    );
    const fixed = setup('host{emo=happy face=wave}: 좋아요.\n', { any: ['happy'] });
    expect(sentenceFace(fixed.meta, para(fixed), para(fixed).sentences[0]!, 'full').drawn).toBe(
      'wave',
    );
    const user = setup('host{emo=sleepy}: 졸려.\n', { any: ['calm'] });
    expect(sentenceFace(user.meta, para(user), para(user).sentences[0]!, 'full').drawn).toBe(
      'calm',
    );
  });

  it('starts motion runs at :emo face changes', () => {
    const s = setup(
      'host{emo=calm}: 하나. :emo{emo=surprised}둘. :emo{emo=surprised volume=loud}셋.\n',
      {
        any: ['calm', 'surprised'],
      },
    );
    expect(paragraphActing(s.meta, para(s), 'full').runs).toEqual([
      { sentence: 0 },
      { sentence: 1, motion: 'jump' },
    ]);
    // a paragraph motion= holds; face= fixes the face
    const held = setup('host{emo=calm motion=sink}: 하나. :emo{emo=surprised}둘.\n', {
      any: ['calm', 'surprised'],
    });
    expect(paragraphActing(held.meta, para(held), 'full').runs).toEqual([
      { sentence: 0, motion: 'sink' },
    ]);
    // motion: off turns automatic motions off
    const off = setup('host{emo=happy}: 좋아.\n', { any: ['happy'] }, { motion: 'off' });
    expect(paragraphActing(off.meta, para(off), 'full').runs).toEqual([{ sentence: 0 }]);
    // a cast face alone brings no motion (as before)
    const plain = setup('host: 그냥.\n', undefined, { face: 'happy' });
    expect(paragraphActing(plain.meta, para(plain), 'full').runs).toEqual([{ sentence: 0 }]);
  });

  it('lets a paragraph face= decide the motion over the emotion', () => {
    const s = setup('host{face=happy emo=sad}: 좋아.\n', { any: ['happy', 'sad'] });
    expect(paragraphActing(s.meta, para(s), 'full').runs).toEqual([
      { sentence: 0, motion: 'bounce' },
    ]);
  });

  it('keeps a parts character’s own motion table (no name-based motion)', () => {
    const s = setup('host{face=happy}: 좋아.\n', undefined, { faceMotions: { surprised: 'jump' } });
    expect(paragraphActing(s.meta, para(s), 'full').runs).toEqual([{ sentence: 0 }]);
    const e = setup('host{emo=excited}: 좋아.\n', { full: ['excited'] }, { faceMotions: {} });
    expect(paragraphActing(e.meta, para(e), 'full').runs).toEqual([
      { sentence: 0, motion: 'bounce' },
    ]);
  });

  it('sets the gain from volume, and power only for voices that cannot act it', () => {
    const s = parseScript(
      fm(
        'host{emo=sad power=strong volume=soft}: 하나.\n\nguest{emo=sad power=strong}: 둘.\n\nrobo{volume=loud emo=sad power=weak}: 셋.\n',
      ),
    ).script!;
    const ps = s.scenes[0]!.blocks as Paragraph[];
    expect(ps.map((p) => gainFor(s.meta, p, p.sentences[0]!))).toEqual([-6, 2, 1]);
  });

  it('carries face and gain into the timeline', () => {
    const s = setup('host{emo=surprised volume=loud}: 와!\n', { any: ['surprised'] });
    const manifest: AudioManifest = {
      [sentenceId('scene-1', 0, 0)]: { src: 'a.wav', duration: 1, words: [] },
    };
    const { timeline } = buildTimeline(s, 'youtube', manifest);
    const scene = timeline.scenes[0]!;
    expect(scene.audio[0]).toMatchObject({ face: 'surprised', gain: 3 });
    expect(scene.motions.map((m) => m.motion)).toEqual(['jump']);
  });
});

describe('lint', () => {
  it('reports what each voice does with the attributes', () => {
    const s = parseScript(
      fm(
        'guest{emo=sad}: 하나.\n\nrobo{say="낮게"}: 둘.\n\nhost{emo=sad power=weak}: 셋.\n\nhost{emo=neutral power=strong}: 넷.\n\nrobo{speed=0.8}: 다섯.\n\nrobo: 여섯.\n',
      ),
    ).script!;
    s.meta.cast.robo!.speed = 0.8;
    const d = lintActing(s);
    expect(d.map((x) => [x.severity, x.code])).toEqual([
      ['info', 'acting-voice'],
      ['warning', 'acting-voice'],
      // power on an emotion line picks a take (stage 3): only the neutral line is told
      ['info', 'acting-power'],
      ['error', 'speed-range'],
    ]);
    // a plain line is checked too: cast speed 0.6 is outside what Supertonic takes
    const plain = parseScript(fm('robo: 여섯.\n')).script!;
    plain.meta.cast.robo!.speed = 0.6;
    expect(lintActing(plain).map((x) => x.code)).toEqual(['speed-range']);
  });

  it('estimates the length with the speed and the emotion', () => {
    const plain = parseScript(fm('host: 가나다라마바사아자차카타파하.\n')).script!;
    const slow = parseScript(
      fm('host{emo=calm speed=0.8}: 가나다라마바사아자차카타파하.\n'),
    ).script!;
    const a = estimateLengths(plain)[0]!.seconds;
    const b = estimateLengths(slow)[0]!.seconds;
    expect(b).toBeGreaterThan(a);
  });
});
