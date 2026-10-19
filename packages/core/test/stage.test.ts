/** `::enter` / `::exit` (acting stage 5c): syntax, who stands on stage, timing, lint. */
import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  castsIn,
  FACE_HOLD_S,
  lintActing,
  outputScenes,
  parseScript,
  sidesOf,
  STAGE_SLIDE_S,
  stageEvents,
  type Script,
} from '../src/index.js';

/** a and c stand left, b right (cast order alternates; c is set left). */
function script(body: string, opts: { character?: boolean; extra?: string } = {}): Script {
  const ch = opts.character === false ? '' : ', character: x';
  const r = parseScript(
    `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee"${ch} }\n  b: { voice: "qwen:Ryan"${ch} }\n  c: { voice: "qwen:Ryan", side: left${ch} }\n${opts.extra ?? ''}---\n\n${body}\n`,
  );
  if (!r.script) throw new Error(r.diagnostics.items.map((d) => d.message).join('\n'));
  return r.script;
}

const parse = (body: string) => {
  const r = parseScript(
    `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: x }\n  b: { voice: "qwen:Ryan", character: x }\n---\n\n${body}\n`,
  );
  return { script: r.script, codes: r.diagnostics.items.map((d) => d.code) };
};

/** Every sentence 2 s (words spread evenly); fps 30. */
function timeline(s: Script, output = 'youtube') {
  const manifest: Record<
    string,
    { src: string; duration: number; words: { text: string; start: number; end: number }[] }
  > = {};
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
  return buildTimeline(s, output, manifest, 30);
}

const codes = (s: Script) => lintActing(s).map((d) => d.code);

describe('::enter / ::exit syntax', () => {
  it('records the scene attribute; several casts; no block, so sentence ids stay', () => {
    const { script: s, codes: c } = parse(
      '# 하나 {#one}\n\n::enter{a b}\n::exit{b}\n\na: 안녕하세요.',
    );
    expect(c).toEqual([]);
    expect(s!.scenes[0]!.stage).toEqual([
      { kind: 'enter', cast: 'a', line: expect.any(Number) },
      { kind: 'enter', cast: 'b', line: expect.any(Number) },
      { kind: 'exit', cast: 'b', line: expect.any(Number) },
    ]);
    expect(s!.scenes[0]!.blocks[0]!.kind).toBe('paragraph');
  });

  it('rejects a misplaced, empty, unknown, valued or repeated cast and the inline form', () => {
    expect(parse('# 하나\n\na: 안녕.\n\n::enter{a}').codes).toEqual(['stage-placement']);
    expect(parse('# 하나\n\n::exit{}\n\na: 안녕.').codes).toEqual(['stage-empty']);
    expect(parse('# 하나\n\n::enter{z}\n\na: 안녕.').codes).toEqual(['stage-cast']);
    expect(parse('# 하나\n\n::enter{a=1}\n\na: 안녕.').codes).toEqual(['stage-value']);
    expect(parse('# 하나\n\n::enter{a=""}\n\na: 안녕.').codes).toEqual(['stage-value']);
    expect(parse('# 하나\n\n::exit{a}\n::exit{a}\n\na: 안녕.').codes).toEqual(['stage-duplicate']);
    expect(parse('# 하나\n\na: 안녕 :enter{a} 하세요.').codes).toEqual(['stage-placement']);
    expect(parse(':::enter{a}\n:::\n\n# 하나\n\na: 안녕.').codes).toContain('stage-placement');
  });
});

describe('stageEvents', () => {
  const twoScenes = (s1: string, s2: string, s3 = 'a: 셋.') =>
    script(`# 하나 {#one}\n\n${s1}\n\n# 둘 {#two}\n\n${s2}\n\n# 셋 {#three}\n\n${s3}`);

  it('a cast whose first event is its entrance is away before it; its side is empty', () => {
    const s = twoScenes('a: 하나.', '::enter{b}\nb: 둘.');
    const st = stageEvents(s, 'youtube');
    expect(st.diagnostics).toEqual([]);
    expect(st.events.get('two')).toEqual([{ kind: 'enter', cast: 'b' }]);
    const p1 = s.scenes[0]!.blocks[0] as never;
    expect([...st.empty.get(p1)!]).toEqual(['right']);
  });

  it('an exit leaves the side empty and the cast away until it enters again', () => {
    const s = twoScenes('a: 하나.\n\nb: 둘.', '::exit{b}\na: 셋.', '::enter{b}\nb: 넷.');
    const st = stageEvents(s, 'youtube');
    expect(st.diagnostics).toEqual([]);
    expect(st.events.get('two')).toEqual([{ kind: 'exit', cast: 'b' }]);
    expect(st.events.get('three')).toEqual([{ kind: 'enter', cast: 'b' }]);
    // the exit takes effect at the end of its scene
    expect([...st.absent.get(s.scenes[1]!.blocks[0] as never)!]).toEqual([]);
    expect([...st.absent.get(s.scenes[2]!.blocks[0] as never)!]).toEqual([]);
  });

  it('ignores with a warning: a silent cast, an entrance on stage, an exit of someone not there', () => {
    const silent = script('# 하나\n\n::enter{c}\na: 하나.');
    expect(stageEvents(silent, 'youtube').diagnostics.map((d) => d.code)).toEqual(['stage-silent']);
    const onStage = script('# 하나 {#one}\n\nb: 하나.\n\n# 둘 {#two}\n\n::enter{b}\nb: 둘.');
    const st = stageEvents(onStage, 'youtube');
    expect(st.diagnostics.map((d) => d.code)).toEqual(['enter-occupant']);
    expect(st.events.size).toBe(0);
    const notThere = script('# 하나 {#one}\n\n::exit{a}\na: 하나.\n\nc: 둘.');
    expect(stageEvents(notThere, 'youtube').diagnostics.map((d) => d.code)).toEqual([
      'exit-not-occupant',
    ]);
  });

  it('warns when an exited cast speaks again without entering: it steps in as usual', () => {
    const s = twoScenes('b: 하나.', '::exit{b}\nb: 둘.', 'b: 셋.');
    const st = stageEvents(s, 'youtube');
    expect(st.diagnostics.map((d) => d.code)).toEqual(['stage-absent']);
    expect([...st.absent.get(s.scenes[2]!.blocks[0] as never)!]).toEqual(['b']);
  });

  it('two entrances on one side: the later cast enters', () => {
    const s = script('# 하나 {#one}\n\n::enter{a c}\nc: 하나.\n\na: 둘.');
    const st = stageEvents(s, 'youtube');
    expect(st.events.get('one')).toEqual([{ kind: 'enter', cast: 'c' }]);
    expect(st.diagnostics.map((d) => d.code)).toEqual(['enter-side-order']);
  });

  it('another speaker of the side first: the entrance is ignored and empties nothing', () => {
    const s = script('# 하나 {#one}\n\n::enter{c}\na: 하나.\n\nc: 둘.\n\nb: 셋.');
    const st = stageEvents(s, 'youtube');
    expect(st.events.size).toBe(0);
    expect(st.diagnostics.map((d) => d.code)).toEqual(['enter-side-order']);
    expect([...st.empty.get(s.scenes[0]!.blocks[0] as never)!]).toEqual([]);
  });

  it('per output: picked scenes and :only; no events without characters', () => {
    const s = script(
      '# 하나 {#one}\n\na: 하나.\n\nb: 둘.\n\n# 둘 {#two}\n\n::exit{b}\na: 셋.\n\n# 셋 {#three}\n\nb: 넷.',
      {
        extra:
          'outputs:\n  youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16", scenes: [one, three] }\n',
      },
    );
    expect(stageEvents(s, 'youtube').diagnostics.map((d) => d.code)).toEqual(['stage-absent']);
    expect(stageEvents(s, 'shorts').diagnostics).toEqual([]);
    const plain = script('# 하나\n\n::enter{b}\nb: 하나.', { character: false });
    const st = stageEvents(plain, 'youtube');
    expect(st.characterMode).toBe(false);
    expect(st.events.size).toBe(0);
    expect(st.diagnostics.map((d) => d.code)).toEqual(['stage-avatar']);
  });

  it('keeps the moved helpers under their names', () => {
    const s = script('# 하나 {#one}\n\na: 하나.\n\nb: 둘 :react{c=happy}입니다.');
    expect([...castsIn(outputScenes(s, 'youtube'))].sort()).toEqual(['a', 'b', 'c']);
    expect(sidesOf([{ key: 'a' }, { key: 'b' }, { key: 'c', side: 'left' }])).toEqual({
      a: 'left',
      b: 'right',
      c: 'left',
    });
  });
});

describe('timeline', () => {
  const hold = Math.round(FACE_HOLD_S * 30);
  const slide = Math.round(STAGE_SLIDE_S * 30);

  it('the scene first line waits for its entering speaker; the first scene keeps its lead', () => {
    const s = script('# 하나 {#one}\n\n::enter{a}\na: 하나.\n\n# 둘 {#two}\n\n::enter{b}\nb: 둘.');
    const { timeline: t, issues } = timeline(s);
    expect(issues).toEqual([]);
    expect(t.scenes[0]!.audio[0]!.startFrame).toBe(Math.round(s.meta.pacing.lead * 30));
    expect(t.scenes[1]!.audio[0]!.startFrame).toBe(slide);
    expect(t.scenes[1]!.stage).toEqual([{ cast: 'b', kind: 'enter', frame: 0 }]);
    // without an entrance nothing moves
    const plain = timeline(script('# 하나 {#one}\n\na: 하나.\n\n# 둘 {#two}\n\nb: 둘.')).timeline;
    expect(plain.scenes[1]!.audio[0]!.startFrame).toBe(0);
    expect(plain.scenes[1]!.stage).toBeUndefined();
  });

  it('an exit slides after everything and its hold; the scene grows to show it (and the fade)', () => {
    const body =
      '# 하나 {#one}\n\na: 하나.\n\nb: 둘.\n\n# 둘 {#two}\n\n::exit{b}\nb: 셋.\n\n# 셋 {#three}\n\na: 넷.';
    const t = timeline(script(body)).timeline;
    const two = t.scenes[1]!;
    const end = two.audio[0]!.startFrame + two.audio[0]!.durationFrames;
    expect(two.stage).toEqual([{ cast: 'b', kind: 'exit', frame: end + hold }]);
    expect(two.durationFrames).toBe(end + hold + slide + 1);
    const faded = timeline(script(body, { extra: 'transition: fade\n' })).timeline.scenes[1]!;
    expect(faded.durationFrames).toBe(end + hold + slide + 1 + 9);
  });

  it('a held motion and a pause after the line delay the exit', () => {
    const t = timeline(
      script('# 하나 {#one}\n\n::exit{b}\na: 하나.\n\nb{motion=sink}: 둘. [pause=1]'),
    ).timeline.scenes[0]!;
    const sink = t.motions.find((m) => m.motion === 'sink')!;
    expect(t.stage![0]!.frame).toBe(sink.endFrame + 12 + hold);
  });

  it('a reaction ends the scene later; a scene without lines still slides in before out', () => {
    const t = timeline(
      script('# 하나 {#one}\n\n::exit{b}\nb: 하나.\n\na: 둘 :react{b=happy}입니다. [pause=2]'),
    ).timeline.scenes[0]!;
    const r = t.reactions.find((x) => x.cast === 'b')!;
    expect(t.stage![0]!.frame).toBeGreaterThanOrEqual(r.endFrame + hold);
    // b speaks elsewhere in the output, so it may enter and leave a scene without lines
    const empty = timeline(
      script(
        '# 하나 {#one}\n\na: 하나.\n\n# 둘 {#two}\n\n::enter{b}\n::exit{b}\n\n# 셋 {#three}\n\n::enter{b}\nb: 셋.',
      ),
    ).timeline.scenes[1]!;
    expect(empty.stage).toEqual([
      { cast: 'b', kind: 'enter', frame: 0 },
      { cast: 'b', kind: 'exit', frame: hold > slide ? hold : slide },
    ]);
  });

  it('keeps sentence ids when a paragraph is left out of an output', () => {
    const s = script('# 하나 {#one}\n\na: :only{shorts} 하나.\n\nb: 둘.', {
      extra: 'outputs:\n  youtube: { aspect: "16:9" }\n  shorts: { aspect: "9:16" }\n',
    });
    const { timeline: t } = timeline(s);
    expect(t.scenes[0]!.audio.map((a) => a.sentenceId)).toEqual(['one:1:0']);
  });
});

describe('lint', () => {
  it('a look at an exited cast shows nothing; a speaker facing an empty side gets a hint', () => {
    const s = script(
      '# 하나 {#one}\n\na: 하나.\n\nb: 둘.\n\n# 둘 {#two}\n\n::exit{b}\na: 셋.\n\n# 셋 {#three}\n\na: 넷 :look{b=viewer}입니다.',
    );
    const c = codes(s);
    expect(c).toContain('look-absent');
    expect(c).toContain('look-empty-side');
    // a speaker already facing the viewer gets no hint
    const facing = script(
      '# 하나 {#one}\n\na: 하나.\n\nb: 둘.\n\n# 둘 {#two}\n\n::exit{b}\na: 셋.\n\n# 셋 {#three}\n\na: :look{a=viewer}넷.',
    );
    expect(lintActing(facing).filter((d) => d.code === 'look-empty-side')).toHaveLength(0);
  });
});
