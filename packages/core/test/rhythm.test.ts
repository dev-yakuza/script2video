/** Rhythm (acting stage 5d): content-aware paragraph gaps. */
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  lintLength,
  parseScript,
  RHYTHM,
  rhythmGaps,
  resolveRhythm,
  rhythmOn,
  unitHash,
  type Script,
} from '../src/index.js';

function script(body: string, extra = ''): Script {
  const r = parseScript(
    `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Ryan" }\n${extra}---\n\n${body}\n`,
  );
  if (!r.script) throw new Error(r.diagnostics.items.map((d) => d.message).join('\n'));
  return r.script;
}

/** Every sentence 1 s (one word); fps 30. Sentences listed in `skip` have no audio. */
function timeline(s: Script, opts: { rhythm?: boolean } = {}, skip: string[] = []) {
  const manifest: Record<
    string,
    { src: string; duration: number; words: { text: string; start: number; end: number }[] }
  > = {};
  for (const scene of s.scenes)
    scene.blocks.forEach((b, bi) => {
      if (b.kind !== 'paragraph') return;
      b.sentences.forEach((x, si) => {
        const id = `${scene.id}:${bi}:${si}`;
        if (!skip.includes(id))
          manifest[id] = { src: 'x.wav', duration: 1, words: [{ text: x.text, start: 0, end: 1 }] };
      });
    });
  return buildTimeline(s, 'youtube', manifest, 30, opts);
}

/** A factor equals `base` up to the ±12% jitter. */
const within = (f: number, base: number) => {
  expect(f).toBeGreaterThanOrEqual(base * (1 - RHYTHM.jitter));
  expect(f).toBeLessThanOrEqual(base * (1 + RHYTHM.jitter));
};

describe('rhythmGaps', () => {
  it('answers a question quickly, breathes on an emotion change, lingers after sadness', () => {
    const s = script(
      '# 하나 {#one}\n\na: 어디 가요?\n\nb: 시장에 가요.\n\nb{emo=happy}: 정말 좋아요.\n\na{emo=sad}: 저는 슬퍼요.\n\na{emo=sad}: 아직도요.',
    );
    const g = rhythmGaps(s, 'youtube');
    expect(g.map((x) => x.rules)).toEqual([
      ['question', 'jitter'],
      ['emotion', 'jitter'],
      ['emotion', 'jitter'],
      ['linger', 'jitter'],
    ]);
    within(g[0]!.factor, RHYTHM.answer);
    within(g[1]!.factor, RHYTHM.emotion);
    within(g[3]!.factor, RHYTHM.linger);
  });

  it('multiplies rules; a question to the same speaker is no answer', () => {
    const s = script('# 하나 {#one}\n\na{emo=sad}: 왜요?\n\nb: 몰라요.\n\nb: 그래요?\n\nb: 네.');
    const g = rhythmGaps(s, 'youtube');
    expect(g[0]!.rules).toEqual(['question', 'emotion', 'linger', 'jitter']);
    within(g[0]!.factor, RHYTHM.answer * RHYTHM.emotion * RHYTHM.linger);
    expect(g[2]!.rules).toEqual(['jitter']);
  });

  it('keeps an explicit gap; skips left-out paragraphs and visuals; never crosses a scene', () => {
    const s = script(
      '# 하나 {#one}\n\na{emo=sad}: 하나.\n\n::title[제목]\n\nb{gap=-0.2}: 둘.\n\nb: :only{shorts} 셋.\n\na: 넷.\n\n# 둘 {#two}\n\nb{emo=happy}: 다섯.',
      'outputs:\n  youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16" }\n',
    );
    const g = rhythmGaps(s, 'youtube');
    expect(g.map((x) => [x.line, x.rules])).toEqual([
      [g[0]!.line, ['explicit']],
      [g[1]!.line, ['jitter']],
    ]);
    expect(g[0]!.factor).toBe(1);
  });

  it('a leading inline :emo is the paragraph emotion; one inside is not', () => {
    const s = script(
      '# 하나 {#one}\n\na: 하나.\n\nb: :emo{emo=sad}둘.\n\na: 셋 :emo{emo=happy}넷.\n\nb: 다섯.',
    );
    const g = rhythmGaps(s, 'youtube');
    expect(g[0]!.rules).toEqual(['emotion', 'jitter']);
    expect(g[1]!.rules).toEqual(['emotion', 'linger', 'jitter']);
    expect(g[2]!.rules).toEqual(['jitter']);
  });

  it('jitter: stable, spread, different for outputs one letter apart', () => {
    expect(unitHash('rhythm', 'k', 0, 's1')).toBe(unitHash('rhythm', 'k', 0, 's1'));
    expect(
      Math.abs(unitHash('rhythm', 'k', 0, 's1') - unitHash('rhythm', 'k', 0, 's2')),
    ).toBeGreaterThan(0.01);
    const us = Array.from({ length: 400 }, (_, i) => unitHash('rhythm', 'k', i, 'youtube'));
    const mean = us.reduce((x, y) => x + y, 0) / us.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(Math.min(...us)).toBeLessThan(0.05);
    expect(Math.max(...us)).toBeGreaterThan(0.95);
  });

  it('adding gap= to one paragraph moves no other gap', () => {
    const body = (g: string) => `# 하나 {#one}\n\na: 하나.\n\nb${g}: 둘.\n\na: 셋.\n\nb: 넷.`;
    const plain = rhythmGaps(script(body('')), 'youtube');
    const set = rhythmGaps(script(body('{gap=1}')), 'youtube');
    expect(set[1]!.factor).toBe(plain[1]!.factor);
    expect(set[2]!.factor).toBe(plain[2]!.factor);
  });

  it('turns on by the override, else the output, else acting.rhythm', () => {
    const s = script(
      '# 하나\n\na: 하나.',
      'acting: { rhythm: true }\noutputs:\n  youtube: { aspect: "16:9", rhythm: false }\n  shorts: { aspect: "9:16" }\n',
    );
    expect(rhythmOn(s, 'youtube')).toBe(false);
    expect(rhythmOn(s, 'shorts')).toBe(true);
    expect(rhythmOn(s, 'youtube', true)).toBe(true);
    // on when nothing says otherwise; an object of factors means on
    expect(rhythmOn(script('# 하나\n\na: 하나.'), 'youtube')).toBe(true);
    expect(rhythmOn(script('# 하나\n\na: 하나.', 'acting: { rhythm: false }\n'), 'youtube')).toBe(
      false,
    );
    const own = script(
      '# 하나\n\na: 하나.',
      'acting: { rhythm: { answer: 0.8, linger: 2 } }\noutputs:\n  youtube: { aspect: "16:9", rhythm: { linger: 1.1 } }\n',
    );
    expect(resolveRhythm(own, 'youtube')).toEqual({
      on: true,
      values: { ...RHYTHM, answer: 0.8, linger: 1.1 },
    });
  });

  it('uses the factors a script sets; a misspelled or out-of-range factor is an error', () => {
    const s = script(
      '# 하나 {#one}\n\na: 어디?\n\nb: 여기.',
      'acting: { rhythm: { answer: 1, jitter: 0 } }\n',
    );
    expect(rhythmGaps(s, 'youtube')[0]!.factor).toBe(1);
    const bad = (fm: string) =>
      parseScript(
        `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee" }\n${fm}---\n\n# 하나\n\na: 하나.\n`,
      ).diagnostics.items.map((d) => d.code);
    expect(bad('acting: { rhythm: { anwser: 0.5 } }\n')).toContain('frontmatter-schema');
    expect(bad('acting: { rhythm: { linger: 9 } }\n')).toContain('frontmatter-schema');
  });
});

describe('timeline', () => {
  const body =
    '# 하나 {#one}\n\na: 어디 가요?\n\nb: 시장에 가요.\n\nb{emo=happy}: 정말 좋아요.\n\nb{emo=happy}: 사과도 사요.\n\na{emo=sad}: 저는 못 가요.\n\nb: 왜요?';

  it('off is the old timeline, whichever way it is off; no gap list', () => {
    const base = timeline(script(body, 'acting: { rhythm: false }\n'));
    expect(base.gaps).toBeUndefined();
    const off = timeline(script(body), { rhythm: false });
    const out = timeline(script(body, 'outputs:\n  youtube: { aspect: "16:9", rhythm: false }\n'));
    expect(JSON.stringify(off.timeline)).toBe(JSON.stringify(base.timeline));
    expect(JSON.stringify(out.timeline)).toBe(JSON.stringify(base.timeline));
    // the old timeline: every paragraph gap is paragraphGap
    const t = base.timeline.scenes[0]!.audio;
    expect(t[1]!.startFrame - (t[0]!.startFrame + t[0]!.durationFrames)).toBe(18);
  });

  it('on: gaps follow the rules; sentence gaps, lead and tail stay', () => {
    const s = script(body);
    const off = timeline(s, { rhythm: false }).timeline;
    const { timeline: on, gaps } = timeline(s);
    expect(gaps).toHaveLength(5);
    const pg = s.meta.pacing.paragraphGap;
    gaps!.forEach((g) => expect(g.seconds).toBeCloseTo(pg * g.factor, 6));
    // lead unchanged, length moves by the gap differences
    expect(on.scenes[0]!.audio[0]!.startFrame).toBe(off.scenes[0]!.audio[0]!.startFrame);
    const diff = gaps!.reduce((x, g) => x + g.seconds - pg, 0);
    expect(Math.abs(on.totalFrames - off.totalFrames - diff * 30)).toBeLessThanOrEqual(
      gaps!.length,
    );
  });

  it('judges the script, not the audio: a missing sentence changes no gap', () => {
    const s = script(body);
    const full = timeline(s, { rhythm: true }).gaps!;
    const holes = timeline(s, { rhythm: true }, ['one:0:0', 'one:2:0']).gaps!;
    expect(holes.map((g) => g.factor)).toEqual(full.map((g) => g.factor));
  });

  it('a subtitle stays across a same-speaker gap rhythm widened, and only there', () => {
    // b → b with an emotion change: ×1.3 over the 0.6 s bridge
    const s = script('# 하나 {#one}\n\nb: 하나.\n\nb{emo=happy}: 둘.');
    const on = timeline(s, { rhythm: true });
    expect(on.gaps![0]!.factor).toBeGreaterThan(1);
    const [first, second] = on.timeline.scenes[0]!.subtitles;
    expect(first!.endFrame).toBe(second!.startFrame);
    // an explicit gap and a long paragraphGap keep today's bridge
    const explicit = script('# 하나 {#one}\n\nb: 하나.\n\nb{gap=2}: 둘.');
    expect(timeline(explicit, { rhythm: true }).timeline.scenes[0]!.subtitles).toEqual(
      timeline(explicit).timeline.scenes[0]!.subtitles,
    );
  });

  it('bridges a widened same-speaker gap whenever rhythm off bridged it (any rounding)', () => {
    /** Each sentence lasts `d` s; returns whether b's two paragraphs' subtitles touch. */
    const touches = (text: string, d: number, pacing: string, on: boolean) => {
      const s = script(`# 하나 {#one}\n\nb: ${text}.\n\nb{emo=happy}: 둘${text}.`, pacing);
      const manifest: Record<
        string,
        { src: string; duration: number; words: { text: string; start: number; end: number }[] }
      > = {};
      s.scenes[0]!.blocks.forEach((b, bi) => {
        if (b.kind === 'paragraph')
          manifest[`one:${bi}:0`] = {
            src: 'x',
            duration: d,
            words: [{ text: b.sentences[0]!.text, start: 0, end: d }],
          };
      });
      const [x, y] = buildTimeline(s, 'youtube', manifest, 30, { rhythm: on }).timeline.scenes[0]!
        .subtitles;
      return x!.endFrame === y!.startFrame;
    };
    let widened = 0;
    for (let i = 0; i < 120; i++)
      for (const d of [0.97, 1.01, 1.234, 2.5]) {
        const text = `문장${String.fromCharCode(0xac00 + i * 7)}`; // digits would be read out
        if (touches(text, d, '', false)) {
          expect(touches(text, d, '', true), `${text} ${d}`).toBe(true);
          widened++;
        }
        // a long paragraphGap is not bridged off, and rhythm does not start bridging it
        const long = 'pacing: { paragraphGap: 1.2 }\n';
        expect(touches(text, d, long, true)).toBe(touches(text, d, long, false));
      }
    expect(widened).toBeGreaterThan(400);
  });

  it('also bridges with a late first word and after an earlier widened boundary', () => {
    // three paragraphs of b, each a different emotion: two widened boundaries in one scene
    const pairs = (text: string, d: number, t0: number, on: boolean) => {
      const s = script(
        `# 하나 {#one}\n\nb: ${text}.\n\nb{emo=happy}: 둘${text}.\n\nb{emo=sad}: 셋${text}.`,
      );
      const manifest: Record<
        string,
        { src: string; duration: number; words: { text: string; start: number; end: number }[] }
      > = {};
      s.scenes[0]!.blocks.forEach((b, bi) => {
        if (b.kind === 'paragraph')
          manifest[`one:${bi}:0`] = {
            src: 'x',
            duration: d,
            words: [{ text: b.sentences[0]!.text, start: t0, end: d }],
          };
      });
      const subs = buildTimeline(s, 'youtube', manifest, 30, { rhythm: on }).timeline.scenes[0]!
        .subtitles;
      return subs.slice(1).map((y, i) => subs[i]!.endFrame === y.startFrame);
    };
    for (let i = 0; i < 80; i++)
      for (const d of [0.97, 1.234])
        for (const t0 of [0, 0.013, 0.05]) {
          const text = `문장${String.fromCharCode(0xac00 + i * 11)}`;
          const off = pairs(text, d, t0, false);
          const on = pairs(text, d, t0, true);
          off.forEach((bridged, k) => {
            if (bridged) expect(on[k], `${text} ${d} ${t0} #${k}`).toBe(true);
          });
        }
  });

  it('with 5c: the exit scene still grows to show the slide', () => {
    const r = parseScript(
      `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: x }\n  b: { voice: "qwen:Ryan", character: x }\n---\n\n# 하나 {#one}\n\n::exit{b}\na{emo=sad}: 하나.\n\nb: 둘.\n\n# 둘 {#two}\n\na: 셋.\n`,
    );
    const one = timeline(r.script!, { rhythm: true }).timeline.scenes[0]!;
    const x = one.stage![0]!.frame;
    expect(one.durationFrames).toBeGreaterThanOrEqual(x + 15 + 1);
  });

  it('with 5c: an exit still waits for everything, the first line for the entrance', () => {
    const r = parseScript(
      `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: x }\n  b: { voice: "qwen:Ryan", character: x }\n---\n\n# 하나 {#one}\n\na: 하나.\n\n# 둘 {#two}\n\n::enter{b}\n::exit{b}\nb: 둘?\n\na{emo=sad}: 셋.\n\nb: 넷.\n\n# 셋 {#three}\n\na: 다섯.\n`,
    );
    const { timeline: t } = timeline(r.script!, { rhythm: true });
    const two = t.scenes[1]!;
    expect(two.audio[0]!.startFrame).toBe(15);
    const end = Math.max(...two.audio.map((x) => x.startFrame + x.durationFrames));
    expect(two.stage!.find((e) => e.kind === 'exit')!.frame).toBe(end + 20);
  });

  it('the length lint sees the rhythm', () => {
    const lines = Array.from(
      { length: 12 },
      (_, i) => `a{emo=sad}: 문장${i}.\n\nb: 대답${i}.`,
    ).join('\n\n');
    const make = (on: boolean) =>
      script(
        `# 하나 {#one}\n\n${lines}`,
        `${on ? '' : 'acting: { rhythm: false }\n'}outputs:\n  youtube: { aspect: "16:9", maxDuration: 45 }\n`,
      );
    const manifest = (s: Script) => {
      const m: Record<string, { src: string; duration: number; words: never[] }> = {};
      s.scenes[0]!.blocks.forEach((b, bi) => {
        if (b.kind === 'paragraph') m[`one:${bi}:0`] = { src: 'x', duration: 1, words: [] };
      });
      return m;
    };
    const off = make(false);
    const on = make(true);
    // 24 lines of 1 s + 1.3 lead + 3 tail + 23 gaps: 42 s off, about 50 s on (×1.3–1.8)
    expect(lintLength(off, manifest(off)).map((d) => d.code)).toEqual([]);
    expect(lintLength(on, manifest(on)).map((d) => d.code)).toEqual(['max-duration']);
  });
});
