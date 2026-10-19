/** When a scene's picture changes, for `s2v snapshot --frames` (S6 plan 2.3). */
import type { TimelineScene } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import {
  FACE_HOLD,
  FADE_FRAMES,
  STAGE_LEAD,
  STAGE_SLIDE,
  type StageSwitch,
} from '../src/shared.js';
import { SETTLE, stillPoints, STILLS_PER_SCENE } from '../src/stills.js';

type Visual = TimelineScene['visuals'][number]['visual'];
const image = (src: string): Visual =>
  ({ kind: 'visual', line: 1, type: 'image', attrs: { src } }) as Visual;
const chart = (rows: number): Visual =>
  ({
    kind: 'visual',
    line: 1,
    type: 'chart',
    attrs: {},
    rows: [['k', 'v'], ...Array.from({ length: rows }, (_, i) => [`r${i}`, '1'])],
  }) as Visual;

function scene(over: Partial<TimelineScene> = {}): TimelineScene {
  return {
    id: 's',
    title: 'S',
    startFrame: 0,
    durationFrames: 600,
    visuals: [],
    audio: [],
    cues: [],
    subtitles: [],
    reactions: [],
    motions: [],
    framing: {},
    ...over,
  } as TimelineScene;
}

const art = (key: string, faces: string[], face = 'neutral') => ({
  key,
  face,
  character: { faces: Object.fromEntries(faces.map((f) => [f, {}])) },
});
const line = (cast: string, face: string, start: number, length: number) => ({
  sentenceId: `${cast}${start}`,
  cast,
  face,
  src: 'x',
  startFrame: start,
  durationFrames: length,
});
const onStage = (left: StageSwitch[], right: StageSwitch[] = []) => ({ s: { left, right } });

const points = (sc: TimelineScene, opts: Partial<Parameters<typeof stillPoints>[1]> = {}) =>
  stillPoints([sc], { cast: [], stage: {}, transition: 'none', ...opts })[0]!;

describe('stillPoints', () => {
  it('starts after the first visual settles, then each visual and cue in its own segment', () => {
    const sc = scene({
      visuals: [
        { startFrame: 30, visual: chart(6) }, // shown from frame 0; 6 bars settle at 5×4+18+2
        { startFrame: 200, visual: image('b.png') },
        { startFrame: 210, visual: image('c.png') },
      ],
      cues: [
        { frame: 100, phrase: 'one', attrs: { zoom: '2' } },
        // its settle runs past the next visual: taken at the segment's last frame
        { frame: 190, phrase: 'late', attrs: {} },
      ],
    });
    const p = points(sc);
    expect(p.points[0]).toEqual({ frame: 40, reasons: ['start'] });
    expect(p.points[1]).toEqual({ frame: 100 + SETTLE, reasons: ['cue:"one"'] });
    // late (cut to 199, its segment's last frame) and b (cut to 209): not one still across the
    // picture change — each in its own segment
    expect(p.points.slice(2)).toEqual([
      { frame: 199, reasons: ['cue:"late"'] },
      { frame: 209, reasons: ['visual:image'] },
      { frame: 230, reasons: ['visual:image'] },
    ]);
  });

  it('a scene with no visual starts at SETTLE; nothing in the last frames of a fade', () => {
    const sc = scene({ durationFrames: 100, cues: [{ frame: 92, phrase: 'end', attrs: {} }] });
    expect(points(sc).points.map((p) => p.frame)).toEqual([SETTLE, 99]);
    // the cue at 92 happens inside the fade's last frames: not taken (its picture never shows)
    expect(points(sc, { transition: 'fade' }).points.map((p) => p.frame)).toEqual([SETTLE]);
    const late = scene({ durationFrames: 100, cues: [{ frame: 80, phrase: 'end', attrs: {} }] });
    expect(points(late, { transition: 'fade' }).points.map((p) => p.frame)).toEqual([
      SETTLE,
      100 - 1 - FADE_FRAMES,
    ]);
    // a scene shorter than the fade: frame 0 (it is still fading in)
    const tiny = scene({ durationFrames: 6 });
    expect(points(tiny, { transition: 'fade' }).points.map((p) => p.frame)).toEqual([0]);
  });

  it('faces of characters on stage: each change, the return to the default, not undrawable ones', () => {
    const sc = scene({
      audio: [line('a', 'happy', 100, 60), line('a', 'unknown', 300, 30)],
    } as Partial<TimelineScene>);
    const p = points(sc, {
      cast: [art('a', ['neutral', 'happy'])],
      stage: onStage([{ frame: -1000, keys: ['a'] }]),
    });
    expect(p.points.map((x) => [x.frame, x.reasons])).toEqual([
      [SETTLE, ['start']],
      [108, ['face:a=happy']],
      // back to neutral FACE_HOLD after the line; "unknown" cannot be drawn: no change
      [100 + 60 + FACE_HOLD + 8, ['face:a=neutral']],
    ]);
  });

  it('no face, stage or motion points unless characters are drawn, nor for one off stage', () => {
    const sc = scene({
      audio: [line('a', 'happy', 100, 60)],
      motions: [{ cast: 'a', motion: 'sink', startFrame: 300, endFrame: 400 }],
    } as Partial<TimelineScene>);
    const cast = [art('a', ['neutral', 'happy'])];
    expect(points(sc, { cast }).points).toHaveLength(1);
    // on stage only from frame 250: its face changes (108, 188) are not taken, the held sink is
    const p = points(sc, { cast, stage: onStage([{ frame: 250, keys: ['a'] }]) });
    expect(p.points.map((x) => x.reasons)).toEqual([['start'], ['stage:left'], ['motion:a=sink']]);
    expect(p.points.find((x) => x.reasons[0] === 'stage:left')!.frame).toBe(250 + STAGE_LEAD + 5);
  });

  it('stage switches: entrances slide, the speaker steps in; already-on-stage is not a point', () => {
    const sc = scene();
    const p = points(sc, {
      stage: onStage(
        [{ frame: -1000, keys: ['a'] }],
        [
          { frame: 150, keys: ['b'], move: { key: 'b', kind: 'enter' } },
          { frame: 400, keys: ['c'] },
        ],
      ),
    });
    expect(p.points.map((x) => x.frame)).toEqual([
      SETTLE,
      150 + STAGE_SLIDE + 5,
      400 + STAGE_LEAD + 5,
    ]);
  });

  it('reactions, looks, exits, held motions; one-shot motions take no still', () => {
    const sc = scene({
      reactions: [{ cast: 'a', face: 'happy', startFrame: 100, endFrame: 150 }],
      looks: [{ cast: 'a', face: 'side', startFrame: 300, endFrame: 360 }],
      motions: [
        { cast: 'a', motion: 'lean', startFrame: 400, endFrame: 480 },
        { cast: 'a', motion: 'nod', startFrame: 500, endFrame: 500 },
      ],
    } as Partial<TimelineScene>);
    const p = points(sc, {
      cast: [art('a', ['neutral', 'happy', 'side'])],
      stage: onStage([
        { frame: -1000, keys: ['a'] },
        { frame: 540, keys: [], move: { key: 'a', kind: 'exit' } },
      ]),
    });
    expect(p.points.map((x) => [x.frame, x.reasons])).toEqual([
      [SETTLE, ['start']],
      [108, ['face:a=happy']],
      [150 + FACE_HOLD + 8, ['face:a=neutral']],
      [308, ['face:a=side']],
      // a look that ends before its paragraph is not held: back at its end
      [360 + 8, ['face:a=neutral']],
      [417, ['motion:a=lean']],
      [540 + STAGE_SLIDE + 5, ['stage:left']],
    ]);
  });

  it('a change in the very last frames shows nothing yet: no still for it', () => {
    const sc = scene({
      durationFrames: 100,
      cues: [{ frame: 97, phrase: 'x', attrs: {} }],
      reactions: [
        { cast: 'a', face: 'happy', startFrame: 40, endFrame: 44 },
        { cast: 'a', face: 'side', startFrame: 45, endFrame: 60 },
      ],
    } as Partial<TimelineScene>);
    const p = points(sc, {
      cast: [art('a', ['neutral', 'happy', 'side'])],
      stage: onStage(
        [{ frame: -1000, keys: ['a'] }],
        [{ frame: 98, keys: ['b'], move: { key: 'b', kind: 'enter' } }],
      ),
    });
    const reasons = p.points.flatMap((x) => x.reasons);
    expect(reasons).not.toContain('cue:"x"');
    expect(reasons).not.toContain('stage:right');
    // happy at 40, side at 45: one still showing side, with side's reason only
    expect(p.points.find((x) => x.reasons.includes('face:a=side'))!.reasons).toEqual([
      'face:a=side',
    ]);
  });

  it(`at most ${STILLS_PER_SCENE} a scene, first and last kept`, () => {
    const cues = Array.from({ length: 30 }, (_, i) => ({
      frame: 40 + i * 15,
      phrase: `c${i}`,
      attrs: {},
    }));
    const p = points(scene({ cues }));
    expect(p.points).toHaveLength(STILLS_PER_SCENE);
    expect(p.capped).toEqual({ total: 31 });
    expect(p.points[0]!.reasons).toEqual(['start']);
    expect(p.points.at(-1)!.reasons).toEqual(['cue:"c29"']);
  });
});
