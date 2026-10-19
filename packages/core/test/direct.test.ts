/** `s2v direct` (acting stage 6): the direction plan and the director notes. */
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  DIRECT,
  directPlan,
  estimateLengths,
  filledManifest,
  parseScript,
  type AudioManifest,
  type Script,
} from '../src/index.js';

const CAST = {
  a: '{ voice: "qwen:Sohee", character: x }',
  b: '{ voice: "qwen:Ryan", character: x }',
};

function script(
  body: string,
  opts: { cast?: Record<string, string>; extra?: string; layout?: string } = {},
): Script {
  const cast = Object.entries(opts.cast ?? CAST)
    .map(([k, v]) => `  ${k}: ${v}\n`)
    .join('');
  const r = parseScript(
    `---\nlang: ko\ncast:\n${cast}outputs:\n  youtube: { aspect: "16:9", layout: ${opts.layout ?? 'dialogue'} }\n${opts.extra ?? ''}---\n\n${body}\n`,
  );
  if (!r.script) throw new Error(r.diagnostics.items.map((d) => d.message).join('\n'));
  return r.script;
}

/** Every sentence `seconds` long (words spread evenly). */
function audio(s: Script, seconds = 2, only?: (id: string) => boolean): AudioManifest {
  const m: AudioManifest = {};
  for (const scene of s.scenes)
    scene.blocks.forEach((b, bi) => {
      if (b.kind !== 'paragraph') return;
      b.sentences.forEach((x, si) => {
        const id = `${scene.id}:${bi}:${si}`;
        if (only && !only(id)) return;
        const words = x.text.split(' ');
        m[id] = {
          src: 'x.wav',
          duration: seconds,
          words: words.map((w, i) => ({
            text: w,
            start: (i * seconds) / words.length,
            end: ((i + 1) * seconds) / words.length,
          })),
        };
      });
    });
  return m;
}

const OFF = { rhythm: false } as const;
const codes = (p: ReturnType<typeof directPlan>) => p.notes.map((n) => n.code);
const repeat = (n: number, line: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => line(i)).join('\n\n');

describe('filledManifest', () => {
  it('keeps estimateLengths as it was', () => {
    const s = script('# T {#t}\n\na: 가나다라. 마바사.\n\nb{emo=sad}: 아자차카 타파하.');
    const { filled, measured, total } = filledManifest(s, {});
    expect([measured, total]).toEqual([0, 3]);
    const seconds = buildTimeline(s, 'youtube', filled, 30).timeline.totalFrames / 30;
    expect(estimateLengths(s)[0]!.seconds).toBe(seconds);
    expect(Object.values(filled).every((e) => e.words.length === 0)).toBe(true);
  });
});

describe('rows', () => {
  it('times rows from the timeline and marks what follows an estimate', () => {
    const s = script('# T {#t}\n\na: 가 나.\n\nb: 다 라.\n\na: 마 바.');
    const m = audio(s, 2, (id) => id !== 't:1:0');
    const p = directPlan(s, 'youtube', m, OFF);
    const rows = p.scenes[0]!.rows;
    expect(rows.map((r) => r.estimated)).toEqual([false, false, true]);
    expect(rows[0]!.sentences[0]!.measured).toBe(true);
    expect(rows[1]!.sentences[0]!.measured).toBe(false);
    expect([p.measured, p.total]).toEqual([2, 3]);
    const { timeline } = buildTimeline(s, 'youtube', filledManifest(s, m).filled, 30, OFF);
    const a = timeline.scenes[0]!.audio;
    expect(rows.map((r) => r.start)).toEqual(a.map((x) => x.startFrame / 30));
  });

  it('gives gaps the timeline uses (rhythm on and off, explicit, first paragraph)', () => {
    const s = script(
      '# T {#t}\n\na{gap=0.5}: 가 나?\n\nb{emo=sad}: 다 라.\n\na{gap=1.2}: 마 바.\n\nb: 사 아.',
    );
    for (const rhythm of [true, false]) {
      const p = directPlan(s, 'youtube', audio(s), { rhythm });
      const rows = p.scenes[0]!.rows;
      expect(rows[0]!.gap).toBeUndefined();
      expect(rows[2]!.gap).toMatchObject({ seconds: 1.2, explicit: true, factor: 1 });
      for (let i = 1; i < rows.length; i++) {
        const end = rows[i - 1]!.start + 2;
        expect(Math.abs(rows[i]!.start - (end + rows[i]!.gap!.seconds))).toBeLessThanOrEqual(
          1 / 30,
        );
      }
      if (rhythm) expect(rows[1]!.gap!.rules).toContain('question');
      else expect(rows[1]!.gap).toMatchObject({ seconds: 0.6, factor: 1, rules: [] });
    }
  });

  it('shows faces, motions, looks and reactions in character mode', () => {
    const s = script(
      '# T {#t}\n\na{emo=surprised}: 가 나. :look{a=viewer}다 라. 마 바 :react{b=happy}사.\n\nb: :look{a=glance}아 자.',
      {
        cast: {
          a: '{ voice: "qwen:Sohee", character: x }',
          b: '{ voice: "qwen:Ryan", character: x }',
        },
      },
    );
    const p = directPlan(s, 'youtube', audio(s), OFF);
    expect(p.mode).toBe('character');
    const [r0, r1] = p.scenes[0]!.rows;
    expect(r0!.motions[0]).toMatchObject({ sentence: 0 });
    expect(r0!.sentences[1]!.look).toBe('viewer');
    expect(r0!.sentences[2]!.listeners).toEqual([
      expect.objectContaining({ cast: 'b', face: 'happy' }),
    ]);
    expect(r1!.sentences[0]!.listeners).toEqual([{ cast: 'a', look: 'glance' }]);
  });

  it('flags an emotion face that falls back, not a look variant', () => {
    const s = script('# T {#t}\n\na{emo=sad}: 가 나.\n\na: :look{a=viewer}다 라.');
    s.meta.cast.a!.faceSets = { any: ['neutral'] } as never;
    const p = directPlan(s, 'youtube', audio(s), OFF);
    const [r0, r1] = p.scenes[0]!.rows;
    expect(r0!.sentences[0]!.fallback).toEqual({ wanted: 'sad', drawn: 'neutral' });
    expect(r1!.sentences[0]!.fallback).toBeUndefined();
  });

  it('leaves the character columns empty without characters; recordings do not act', () => {
    const s = script('# T {#t}\n\na{emo=happy}: 가 나.\n\nb: 다 라.', {
      cast: { a: '{ voice: "qwen:Sohee" }', b: '{ voice: "qwen:Ryan" }' },
    });
    const p = directPlan(s, 'youtube', audio(s), OFF);
    expect(p.mode).toBe('avatar');
    const r0 = p.scenes[0]!.rows[0]!;
    expect(r0.sentences[0]!.face).toBeUndefined();
    expect(r0.sentences[0]!.acts).toBe(true);
    const presenter = directPlan(
      script('# T {#t}\n\na: 가.', { cast: { a: '{ voice: "qwen:Sohee" }' }, layout: 'presenter' }),
      'youtube',
      {},
      OFF,
    );
    expect(presenter.mode).toBe('none');
  });

  it("only includes the output's paragraphs and scenes", () => {
    const s = script('# T {#t}\n\na: 가.\n\nb: :only{other}나.\n\n# U {#u}\n\na: 다.', {
      extra: '  other: { aspect: "9:16", layout: shorts, scenes: [u] }\n',
    });
    s.meta.outputs.other = { ...s.meta.outputs.youtube!, scenes: ['u'] };
    const p = directPlan(s, 'youtube', {}, OFF);
    expect(p.scenes.map((x) => x.rows.length)).toEqual([1, 1]);
    expect(directPlan(s, 'other', {}, OFF).scenes.map((x) => x.id)).toEqual(['u']);
    expect(() => directPlan(s, 'nope', {}, OFF)).toThrow(/unknown output/);
  });
});

describe('notes', () => {
  it('same-emotion-run from 6 paragraphs, ended by neutral or no emo, not by others', () => {
    const run = (n: number) => repeat(n, (i) => `a{emo=happy}: 가 나 ${i}.\n\nb: 다 라.`);
    const five = directPlan(script(`# T {#t}\n\n${run(5)}`), 'youtube', {}, OFF);
    expect(codes(five)).not.toContain('same-emotion-run');
    const six = directPlan(script(`# T {#t}\n\n${run(6)}`), 'youtube', {}, OFF);
    expect(codes(six)).toContain('same-emotion-run');
    const broken = directPlan(
      script(`# T {#t}\n\n${run(3)}\n\na{emo=neutral}: 마.\n\n${run(3)}`),
      'youtube',
      {},
      OFF,
    );
    expect(codes(broken)).not.toContain('same-emotion-run');
    const scenes = directPlan(
      script(`# T {#t}\n\n${run(3)}\n\n# U {#u}\n\n${run(3)}`),
      'youtube',
      {},
      OFF,
    );
    expect(codes(scenes)).not.toContain('same-emotion-run');
  });

  it('long-turn from 4 paragraphs of one cast, only with two speakers', () => {
    const turn = (n: number) => repeat(n, (i) => `a: 가 ${i}.`);
    expect(
      codes(directPlan(script(`# T {#t}\n\n${turn(3)}\n\nb: 나.`), 'youtube', {}, OFF)),
    ).not.toContain('long-turn');
    expect(
      codes(directPlan(script(`# T {#t}\n\n${turn(4)}\n\nb: 나.`), 'youtube', {}, OFF)),
    ).toContain('long-turn');
    expect(codes(directPlan(script(`# T {#t}\n\n${turn(6)}`), 'youtube', {}, OFF))).not.toContain(
      'long-turn',
    );
  });

  it('flat-emotion from 10 lines of an acting voice without emo, with two speakers', () => {
    const body = (n: number) =>
      `# T {#t}\n\n${repeat(n, (i) => `a: 가 ${i}.`)}\n\nb{emo=happy}: 나.`;
    expect(codes(directPlan(script(body(9)), 'youtube', {}, OFF))).not.toContain('flat-emotion');
    const ten = directPlan(script(body(10)), 'youtube', {}, OFF);
    expect(ten.notes.filter((n) => n.code === 'flat-emotion')).toHaveLength(1);
    const persona = script(body(10), {
      cast: { a: '{ voice: "supertonic:F1", character: x }', b: CAST.b },
    });
    expect(codes(directPlan(persona, 'youtube', {}, OFF))).not.toContain('flat-emotion');
  });

  it('no-reaction after 30 s with idle off and someone opposite', () => {
    const idleOff = { extra: 'acting: { idle: false }\n' };
    // a 2 s line + 0.6 s gap per paragraph; the window runs to the last paragraph's start
    const lines = (n: number, react = '') =>
      `# T {#t}\n\nb: 시작.\n\n${repeat(n, (i) => `a: 가 ${i}.`)}${react}`;
    const at = (n: number) =>
      directPlan(script(lines(n), idleOff), 'youtube', audio(script(lines(n), idleOff)), OFF);
    // first start = lead; last start = first + n × 2.6
    const window = (p: ReturnType<typeof directPlan>) => {
      const r = p.scenes[0]!.rows;
      return r[r.length - 1]!.start - r[0]!.start;
    };
    let n = 1;
    while (window(at(n)) < DIRECT.noReactionS) n++;
    expect(codes(at(n - 1))).not.toContain('no-reaction');
    expect(codes(at(n))).toContain('no-reaction');
    // idle on (default): nods come by themselves
    const on = script(lines(n));
    expect(codes(directPlan(on, 'youtube', audio(on), OFF))).not.toContain('no-reaction');
    // a reaction halfway breaks the window
    const half = Math.floor(n / 2);
    const reacted = script(
      `# T {#t}\n\nb: 시작.\n\n${repeat(n, (i) => (i === half ? `a: 가 :react{b=happy}${i}.` : `a: 가 ${i}.`))}`,
      idleOff,
    );
    expect(codes(directPlan(reacted, 'youtube', audio(reacted), OFF))).not.toContain('no-reaction');
    // one character alone, no stage directives: nobody opposite
    const alone = script(`# T {#t}\n\n${repeat(n + 2, (i) => `a: 가 ${i}.`)}`, idleOff);
    expect(codes(directPlan(alone, 'youtube', audio(alone), OFF))).not.toContain('no-reaction');
    // avatars: no reactions to show
    const avatars = script(lines(n), {
      ...idleOff,
      cast: { a: '{ voice: "qwen:Sohee" }', b: '{ voice: "qwen:Ryan" }' },
    });
    expect(codes(directPlan(avatars, 'youtube', audio(avatars), OFF))).not.toContain('no-reaction');
  });

  it('trained-joy for a trained voice without power, once per paragraph and emotion', () => {
    const cast = {
      a: '{ voice: "persona:g", personaModel: trained, character: x }',
      b: CAST.b,
    };
    const s = script(
      '# T {#t}\n\na{emo=happy}: 가. 나.\n\na{emo=excited}: 다.\n\na{emo=happy power=strong}: 라.\n\nb{emo=happy}: 마.',
      { cast },
    );
    const notes = directPlan(s, 'youtube', {}, OFF).notes.filter((n) => n.code === 'trained-joy');
    expect(notes.map((n) => n.rowId)).toEqual(['t:0', 't:1']);
    expect(notes[1]!.message).toMatch(/angry/);
    expect(notes[1]!.message).not.toMatch(/Try power=strong/);
  });

  it(`caps each code at ${DIRECT.perCode} notes`, () => {
    const cast = { a: '{ voice: "persona:g", personaModel: trained }', b: CAST.b };
    const s = script(`# T {#t}\n\n${repeat(8, (i) => `a{emo=happy}: 가 ${i}.\n\nb: 나.`)}`, {
      cast,
    });
    const joy = directPlan(s, 'youtube', {}, OFF).notes.filter((n) => n.code === 'trained-joy');
    expect(joy).toHaveLength(DIRECT.perCode + 1);
    expect(joy[DIRECT.perCode]!.message).toMatch(/and 3 more/);
    expect(directPlan(s, 'youtube', {}, OFF).noteCount).toBe(9); // 8 trained-joy + 1 same-emotion-run
  });

  it('no-reaction names the listener opposite the speaker and the row inside the window', () => {
    const idleOff = 'acting: { idle: false }\n';
    // b reacts once, then a talks long: the note is for b (not a), at a row after the reaction
    const s = script(
      `# T {#t}\n\nb: 시작 :react{a=happy}해요.\n\n${repeat(15, (i) => `a: 가 ${i}.`)}`,
      { extra: idleOff },
    );
    const notes = directPlan(s, 'youtube', audio(s), OFF).notes.filter(
      (n) => n.code === 'no-reaction',
    );
    expect(notes).toHaveLength(1);
    expect(notes[0]!.message).toMatch(/:react\{b=/);
    expect(notes[0]!.rowId).toBe('t:1');
    // the listener is opposite whoever talks most in the window, not its first speaker
    const mostly = script(`# T {#t}\n\nb: 시작.\n\n${repeat(15, (i) => `a: 가 ${i}.`)}`, {
      extra: idleOff,
    });
    const nm = directPlan(mostly, 'youtube', audio(mostly), OFF).notes.find(
      (n) => n.code === 'no-reaction',
    );
    expect(nm?.message).toMatch(/:react\{b=/);
    expect(nm?.rowId).toBe('t:1');
    // a cast that walked on is the one standing there, not the side's earlier speaker
    const entered = script(
      `# T {#t}\n\nb: 안녕.\n\na: 네.\n\n# U {#u}\n\n::enter{c}\n\n${repeat(15, (i) => `a: 가 ${i}.`)}\n\n# V {#v}\n\nc: 끝.`,
      { extra: idleOff, cast: { ...CAST, c: '{ voice: "qwen:Ryan", character: x, side: right }' } },
    );
    const ne = directPlan(entered, 'youtube', audio(entered), OFF).notes.find(
      (n) => n.code === 'no-reaction',
    );
    expect(ne?.message).toMatch(/:react\{c=/);
    // three casts: c sits opposite a (b never appears in this scene but sits left with a)
    const three = script(`# T {#t}\n\nc: 시작.\n\n${repeat(15, (i) => `a: 가 ${i}.`)}`, {
      extra: idleOff,
      cast: { ...CAST, c: '{ voice: "qwen:Ryan", character: x, side: right }' },
    });
    const n3 = directPlan(three, 'youtube', audio(three), OFF).notes.find(
      (n) => n.code === 'no-reaction',
    );
    expect(n3?.message).toMatch(/:react\{c=/);
  });

  it('no-reaction counts only rows with someone opposite (stage directives)', () => {
    const idleOff = 'acting: { idle: false }\n';
    // b exits at the end of scene T; in U, a talks long with the right side empty
    const s = script(
      `# T {#t}\n\n::exit{b}\n\nb: 안녕.\n\na: 네.\n\n# U {#u}\n\n${repeat(15, (i) => `a: 가 ${i}.`)}\n\n# V {#v}\n\n::enter{b}\n\nb: 다시 왔어요.`,
      { extra: idleOff },
    );
    const p = directPlan(s, 'youtube', audio(s), OFF);
    expect(codes(p)).not.toContain('no-reaction');
    expect(p.scenes[0]!.stage).toEqual([expect.objectContaining({ cast: 'b', kind: 'exit' })]);
    expect(p.scenes[2]!.stage).toEqual([{ cast: 'b', kind: 'enter', at: p.scenes[2]!.start }]);
    // b has not come on yet (its first event is an entrance): the right side is empty before
    const before = script(
      `# U {#u}\n\n${repeat(15, (i) => `a: 가 ${i}.`)}\n\n# V {#v}\n\n::enter{b}\n\nb: 왔어요.`,
      { extra: idleOff },
    );
    expect(codes(directPlan(before, 'youtube', audio(before), OFF))).not.toContain('no-reaction');
  });

  it('skips recordings in the emotion rules and does not let them act', () => {
    const rec = (i: number, emo = 'sad') => `a{emo=${emo}}: :audio{src=rec/${i}.wav}가 ${i}.`;
    const s = script(
      `# T {#t}\n\n${repeat(3, (i) => `a{emo=happy}: 가 ${i}.`)}\n\n${rec(9)}\n\n${repeat(3, (i) => `a{emo=happy}: 나 ${i}.`)}\n\nb: 다.`,
    );
    const p = directPlan(s, 'youtube', {}, OFF);
    const row = p.scenes[0]!.rows[3]!;
    expect(row.recording).toBe(true);
    expect(row.sentences[0]!.acts).toBe(false);
    // the recording neither counts nor breaks the run: 6 happy paragraphs around it
    expect(codes(p)).toContain('same-emotion-run');
    const flat = script(
      `# T {#t}\n\n${repeat(9, (i) => `a: 가 ${i}.`)}\n\na: :audio{src=rec/x.wav}나.\n\nb{emo=happy}: 다.`,
    );
    expect(codes(directPlan(flat, 'youtube', {}, OFF))).not.toContain('flat-emotion');
    const trained = script(rec(1, 'happy') + '\n\nb: 나.', {
      cast: { a: '{ voice: "persona:g", personaModel: trained }', b: CAST.b },
    });
    expect(codes(directPlan(trained, 'youtube', {}, OFF))).not.toContain('trained-joy');
  });

  it('flags a look variant the character lacks', () => {
    const s = script('# T {#t}\n\na: :look{a=viewer}가 나.\n\nb: 다.');
    s.meta.cast.a!.faceSets = { any: ['neutral'] } as never;
    const r0 = directPlan(s, 'youtube', audio(s), OFF).scenes[0]!.rows[0]!;
    expect(r0.sentences[0]!.lookMissing).toBe('front-neutral');
  });

  it('no flat-emotion with one speaker; no trained-joy for excited with power', () => {
    const one = script(`# T {#t}\n\n${repeat(12, (i) => `a: 가 ${i}.`)}`);
    expect(codes(directPlan(one, 'youtube', {}, OFF))).not.toContain('flat-emotion');
    const s = script('# T {#t}\n\na{emo=excited power=weak}: 가.\n\nb: 나.', {
      cast: { a: '{ voice: "persona:g", personaModel: trained }', b: CAST.b },
    });
    expect(codes(directPlan(s, 'youtube', {}, OFF))).not.toContain('trained-joy');
  });
});
