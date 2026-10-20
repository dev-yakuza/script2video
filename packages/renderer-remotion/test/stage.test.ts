/** Entrances and exits on stage (acting stage 5c plan 5): stagePlan, constants. */
import { FACE_HOLD_S, FADE_S, HOLD_END_S, STAGE_SLIDE_S } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import {
  FACE_HOLD,
  FADE_FRAMES,
  HOLD_END,
  maxGroup,
  STAGE_SLIDE,
  stagePlan,
} from '../src/shared.js';

const sides = { a: 'left', b: 'right', c: 'right' } as const;

describe('stage constants', () => {
  it('match the core seconds at 30 fps', () => {
    expect(Math.round(FACE_HOLD_S * 30)).toBe(FACE_HOLD);
    expect(Math.round(STAGE_SLIDE_S * 30)).toBe(STAGE_SLIDE);
    expect(Math.round(FADE_S * 30)).toBe(FADE_FRAMES);
    expect(Math.round(HOLD_END_S * 30)).toBe(HOLD_END);
  });
});

describe('stagePlan with entrances and exits', () => {
  it('an entrance in the second scene slides in from frame 0; the side was empty before', () => {
    const plan = stagePlan(
      [
        {
          startFrame: 0,
          durationFrames: 100,
          audio: [{ cast: 'a', startFrame: 10, durationFrames: 20 }],
        },
        {
          startFrame: 100,
          durationFrames: 100,
          audio: [{ cast: 'b', startFrame: 15, durationFrames: 20 }],
          stage: [{ cast: 'b', kind: 'enter', frame: 0 }],
        },
      ],
      sides,
    );
    expect(plan[0]!.right).toEqual([{ frame: -1000, keys: [] }]);
    expect(plan[1]!.right).toEqual([
      { frame: -1000, keys: [] },
      { frame: 0, keys: ['b'], move: { key: 'b', kind: 'enter' } },
    ]);
    expect(maxGroup(plan[0]!.right, 0, 100)).toBe(0);
  });

  it('an exit leaves at its frame; the next speaker of that side waits for the next scene', () => {
    const plan = stagePlan(
      [
        {
          startFrame: 0,
          durationFrames: 100,
          audio: [
            { cast: 'a', startFrame: 0, durationFrames: 20 },
            { cast: 'b', startFrame: 30, durationFrames: 20 },
          ],
          stage: [{ cast: 'b', kind: 'exit', frame: 70 }],
        },
        // c's line at frame 4 would step in at 96, inside the exit scene
        {
          startFrame: 100,
          durationFrames: 100,
          audio: [{ cast: 'c', startFrame: 4, durationFrames: 20 }],
        },
      ],
      sides,
    );
    expect(plan[0]!.right).toEqual([
      { frame: -1000, keys: ['b'] },
      { frame: 70, keys: [], move: { key: 'b', kind: 'exit' } },
    ]);
    // already standing at the scene start; the exit's move does not carry over
    expect(plan[1]!.right).toEqual([{ frame: -1000, keys: ['c'] }]);
  });

  it('keeps the move when a reaction switch falls on the entrance frame', () => {
    const plan = stagePlan(
      [
        {
          startFrame: 0,
          durationFrames: 50,
          audio: [{ cast: 'a', startFrame: 0, durationFrames: 20 }],
        },
        {
          startFrame: 50,
          durationFrames: 100,
          audio: [
            { cast: 'b', startFrame: 15, durationFrames: 20 },
            { cast: 'a', startFrame: 40, durationFrames: 20 },
          ],
          reactions: [{ cast: 'c', startFrame: 8, endFrame: 30 }],
          stage: [{ cast: 'b', kind: 'enter', frame: 0 }],
        },
      ],
      sides,
    );
    expect(plan[1]!.right[1]).toMatchObject({ frame: 0, move: { key: 'b', kind: 'enter' } });
  });

  it('a group on the side keeps its other member when one exits', () => {
    const plan = stagePlan(
      [
        {
          startFrame: 0,
          durationFrames: 200,
          audio: [{ cast: 'b', startFrame: 0, durationFrames: 40 }],
          reactions: [{ cast: 'c', startFrame: 10, endFrame: 150 }],
          stage: [{ cast: 'b', kind: 'exit', frame: 100 }],
        },
      ],
      sides,
    );
    const at100 = plan[0]!.right.find((s) => s.frame === 100)!;
    expect(at100).toEqual({ frame: 100, keys: ['c'], move: { key: 'b', kind: 'exit' } });
  });

  it('a reaction of that side in the next scene does not cut the exit slide', () => {
    const plan = stagePlan(
      [
        {
          startFrame: 0,
          durationFrames: 66,
          audio: [{ cast: 'b', startFrame: 0, durationFrames: 30 }],
          stage: [{ cast: 'b', kind: 'exit', frame: 50 }],
        },
        {
          startFrame: 66,
          durationFrames: 100,
          audio: [{ cast: 'a', startFrame: 0, durationFrames: 40 }],
          reactions: [{ cast: 'c', startFrame: 0, endFrame: 40 }],
        },
      ],
      sides,
    );
    expect(plan[0]!.right).toEqual([
      { frame: -1000, keys: ['b'] },
      { frame: 50, keys: [], move: { key: 'b', kind: 'exit' } },
    ]);
    expect(plan[1]!.right[0]).toEqual({ frame: -1000, keys: ['c'] });
  });

  it('a character sliding in stays when a reaction of its side starts with it', () => {
    const plan = stagePlan(
      [
        {
          startFrame: 0,
          durationFrames: 50,
          audio: [{ cast: 'a', startFrame: 0, durationFrames: 20 }],
        },
        {
          startFrame: 50,
          durationFrames: 100,
          audio: [
            { cast: 'a', startFrame: 8, durationFrames: 20 },
            { cast: 'b', startFrame: 40, durationFrames: 20 },
          ],
          reactions: [{ cast: 'c', startFrame: 8, endFrame: 30 }],
          stage: [{ cast: 'b', kind: 'enter', frame: 0 }],
        },
      ],
      sides,
    );
    expect(plan[1]!.right[1]).toEqual({
      frame: 0,
      keys: ['b', 'c'],
      move: { key: 'b', kind: 'enter' },
    });
  });

  it('the entered character stays beside a reaction of its side until it speaks', () => {
    const plan = stagePlan(
      [
        {
          startFrame: 0,
          durationFrames: 50,
          audio: [{ cast: 'c', startFrame: 0, durationFrames: 20 }],
        },
        {
          startFrame: 50,
          durationFrames: 200,
          audio: [
            { cast: 'a', startFrame: 15, durationFrames: 20 },
            { cast: 'b', startFrame: 60, durationFrames: 20 },
          ],
          reactions: [{ cast: 'c', startFrame: 15, endFrame: 35 }],
          stage: [{ cast: 'b', kind: 'enter', frame: 0 }],
        },
      ],
      sides,
    );
    expect(plan[1]!.right).toEqual([
      { frame: -1000, keys: ['c'] },
      { frame: 0, keys: ['b'], move: { key: 'b', kind: 'enter' } },
      { frame: 7, keys: ['b', 'c'] },
      { frame: 55, keys: ['b'] },
    ]);
  });

  it('leaves switches exactly on a scene boundary as already on stage (no entrance)', () => {
    const plan = stagePlan(
      [
        {
          startFrame: 0,
          durationFrames: 50,
          audio: [{ cast: 'b', startFrame: 0, durationFrames: 10 }],
        },
        // c's line at 8 switches at exactly frame 50
        {
          startFrame: 50,
          durationFrames: 50,
          audio: [{ cast: 'c', startFrame: 8, durationFrames: 10 }],
        },
      ],
      sides,
    );
    expect(plan[1]!.right).toEqual([{ frame: -1000, keys: ['c'] }]);
  });
});
