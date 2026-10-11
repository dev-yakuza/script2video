import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScript } from '@script2video/core';
import { assignSides, dialogueShape, stagePlan } from '@script2video/renderer-remotion';
import { describe, expect, it } from 'vitest';
import { lintCast } from '../src/lint-assets.js';
import { mouthLevels } from '../src/mouth.js';

/** Minimal PNG header with a given size (enough for imageSize). */
function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

describe('mouthLevels', () => {
  it('opens on loud frames, half on quieter ones, closes on silence, without flicker', () => {
    const rate = 4800;
    const fps = 10;
    // per frame: amplitude (0 = silence)
    const amps = [0, 0, 0.5, 0.5, 0.5, 0.1, 0.1, 0.5, 0.5, 0, 0.5, 0, 0];
    const samples = new Int16Array(amps.length * (rate / fps));
    amps.forEach((a, f) => {
      for (let i = 0; i < rate / fps; i++)
        samples[f * (rate / fps) + i] = Math.round(a * 32767 * Math.sin(i / 3));
    });
    // One-frame gaps and blips (indexes 9, 10) are too short to show: the mouth stays open
    // through them, as it would between quickly spoken words.
    expect(mouthLevels(samples, rate, fps, amps.length)).toBe('0022211222200');
  });
});

describe('speaker sides', () => {
  it('alternates unless a side is given', () => {
    const { left, right } = assignSides([
      { k: 'a' },
      { k: 'b' },
      { k: 'c', side: 'right' as const },
    ]);
    expect(left.map((c) => c.k)).toEqual(['a']);
    expect(right.map((c) => c.k)).toEqual(['b', 'c']);
  });

  it('puts one character per side on stage, taking turns', () => {
    const shape = dialogueShape('dialogue', [
      { character: 'a' },
      { character: 'b' },
      { character: 'c' },
    ]);
    expect(shape).toEqual({ mode: 'character', left: 1, right: 1 });
    const scenes = [
      {
        startFrame: 0,
        durationFrames: 100,
        audio: [
          { cast: 'a', startFrame: 10, durationFrames: 20 },
          { cast: 'b', startFrame: 40, durationFrames: 20 },
          { cast: 'c', startFrame: 70, durationFrames: 20 },
        ],
      },
      {
        startFrame: 100,
        durationFrames: 100,
        audio: [{ cast: 'a', startFrame: 20, durationFrames: 20 }],
      },
    ];
    const plan = stagePlan(scenes, { a: 'left', b: 'right', c: 'left' });
    // c steps in 8 frames before its line; a comes back 8 frames before its line in scene 2.
    expect(plan[0]).toEqual({
      left: [
        { frame: -1000, keys: ['a'] },
        { frame: 62, keys: ['c'] },
      ],
      right: [{ frame: -1000, keys: ['b'] }],
    });
    expect(plan[1]).toEqual({
      left: [
        { frame: -1000, keys: ['c'] },
        { frame: 12, keys: ['a'] },
      ],
      right: [{ frame: -1000, keys: ['b'] }],
    });
  });

  it('brings reacting listeners on stage, beside a talking speaker of their side', () => {
    const scenes = [
      {
        startFrame: 0,
        durationFrames: 200,
        audio: [
          { cast: 'a', startFrame: 10, durationFrames: 40 },
          { cast: 'b', startFrame: 60, durationFrames: 40 },
          { cast: 'c', startFrame: 110, durationFrames: 40 },
        ],
        reactions: [
          { cast: 'a', startFrame: 120, endFrame: 150 }, // c (same side) talks: a stands beside c
          { cast: 'a', startFrame: 170, endFrame: 190 }, // nobody talks on the left: a alone
        ],
      },
    ];
    const plan = stagePlan(scenes, { a: 'left', b: 'right', c: 'left' });
    expect(plan[0]!.left).toEqual([
      { frame: -1000, keys: ['a'] },
      { frame: 102, keys: ['c'] },
      { frame: 112, keys: ['c', 'a'] },
      { frame: 170, keys: ['a'] },
    ]);
  });

  it('shows every listener of a side reacting together', () => {
    const scenes = [
      {
        startFrame: 0,
        durationFrames: 300,
        audio: [
          { cast: 'a', startFrame: 10, durationFrames: 40 },
          { cast: 'b', startFrame: 60, durationFrames: 80 },
        ],
        reactions: [
          { cast: 'a', startFrame: 60, endFrame: 140 },
          { cast: 'c', startFrame: 60, endFrame: 140 },
        ],
      },
    ];
    const plan = stagePlan(scenes, { a: 'left', b: 'right', c: 'left' });
    expect(plan[0]!.left).toEqual([
      { frame: -1000, keys: ['a'] },
      { frame: 52, keys: ['a', 'c'] },
      { frame: 160, keys: ['a'] },
    ]);
  });

  it('uses characters only when every speaker has one', () => {
    expect(dialogueShape('dialogue', [{ character: 'x' }, { character: 'y' }]).mode).toBe(
      'character',
    );
    expect(dialogueShape('presenter', [{ character: 'x' }]).mode).toBe('character');
    expect(dialogueShape('dialogue', [{ character: 'x' }, {}]).mode).toBe('avatar');
    expect(dialogueShape('presenter', [{}]).mode).toBe('none');
  });
});

describe('lintCast characters', () => {
  const setup = (files: Record<string, [number, number]>) => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-char-'));
    mkdirSync(join(dir, 'chars', 'mina'), { recursive: true });
    for (const [f, [w, h]] of Object.entries(files))
      writeFileSync(join(dir, 'chars', 'mina', f), png(w, h));
    return dir;
  };
  const script = (body: string) =>
    parseScript(
      `---\nlang: ko\ncast:\n  mina: { voice: "qwen:Sohee", character: chars/mina }\n  joon: { voice: "qwen:Ryan" }\n---\n\n# 하나 {#one}\n\n${body}`,
    ).script!;

  it('reports a missing face, a still mouth and mixed canvas sizes', () => {
    const dir = setup({ 'neutral.png': [800, 1000], 'happy.png': [800, 900] });
    const msgs = lintCast(script('mina{face=angry}: 안녕하세요.\n\njoon: 네.\n'), dir).map(
      (d) => `${d.severity} ${d.message}`,
    );
    expect(msgs).toEqual([
      'error cast.mina: chars/mina/angry.png is missing (face "angry")',
      'warning cast.mina: no <face>-talk.png in chars/mina, so the mouth will not move',
      'warning cast.mina: images in chars/mina have different sizes (800×900, 800×1000); use one canvas',
    ]);
  });

  it('accepts a complete folder', () => {
    const dir = setup({ 'neutral.png': [800, 1000], 'neutral-talk.png': [800, 1000] });
    expect(lintCast(script('mina: 안녕하세요.\n'), dir)).toEqual([]);
  });

  it('rejects a malformed face name', () => {
    const { diagnostics } = parseScript(
      '---\nlang: ko\ncast:\n  mina: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#one}\n\nmina{face=Big Smile}: 안녕.\n',
    );
    expect(diagnostics.items.map((d) => d.code)).toContain('face-name');
  });
});

describe('subtitle geometry with a style', () => {
  it('scales the text and keeps speaker-side bubbles only at the bottom', async () => {
    const { dialogueGeometry } = await import('../../renderer-remotion/src/shared.js');
    const shape = { mode: 'character' as const, left: 1, right: 1, portrait: false };
    expect(dialogueGeometry(shape).subtitle.fontSize).toBe(48);
    expect(dialogueGeometry(shape, { size: 1.5 }).subtitle.fontSize).toBe(72);
    expect(dialogueGeometry(shape).subtitle.sideInset).not.toBeNull();
    expect(dialogueGeometry(shape, { position: 'middle' }).subtitle).toMatchObject({
      sideInset: null,
      anchor: 'middle',
    });
  });
});
