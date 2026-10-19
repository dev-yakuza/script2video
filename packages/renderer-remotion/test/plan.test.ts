/** Composition input plans (S4b plan 3, R1 / R3–R6): files and fallbacks, never ffmpeg. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { characterFixture } from './fixtures/characters.js';

// R3: planning must work where ffmpeg cannot even be started.
vi.mock('node:child_process', () => ({
  spawnSync: () => {
    throw new Error('ffmpeg must not run while planning');
  },
  execFileSync: () => {
    throw new Error('ffmpeg must not run while planning');
  },
}));

const { ArtMissing, planCharacter, planIdentity } = await import('../src/character/plan.js');
const { planLayeredFace } = await import('../src/character/plan.js');
const { resolveFace } = await import('../src/character/resolve.js');
const { loadCharacterSpec } = await import('../src/character/spec.js');

const sha = (p: string) => `sha:${p.slice(-12)}`;
const who = { key: 'a', dir: 'chars/x' };
const used = (m: Record<string, string[]>) =>
  new Map(Object.entries(m)) as Map<'full' | 'upper' | 'head', string[]>;

describe('composition plans (S4b)', () => {
  it('R1: layered fallbacks and missing parts', () => {
    const { root } = characterFixture();
    const dir = join(root, 'chars', 'layered');
    const spec = loadCharacterSpec(dir);
    if (spec.source === 'imported') throw new Error('layered expected');
    const r = (face: string) => resolveFace(dir, spec, 'full', face, 'left', [40, 50]);
    // smile has mouth.png: talk is its own stack, half falls back to talk, blink to closed
    const smile = planLayeredFace(r('smile'), sha);
    expect(smile.states.half).toEqual(smile.states.talk);
    expect(smile.states.blink).toEqual(smile.states.closed);
    expect(smile.front?.file).toMatch(/front\/stand\.png$/);
    // angry has no mouth: talk falls back to closed
    expect(planLayeredFace(r('angry'), sha).states.talk).toEqual(r('angry').head.states.closed);
    writeFileSync(join(dir, 'views/front/face/base/smile/mouth.1.png'), 'x');
    expect(planLayeredFace(r('smile'), sha).states.half.at(-1)).toMatch(/mouth\.1\.png$/);
    expect(() =>
      planLayeredFace(
        { ...r('calm'), body: { ...r('calm').body!, file: join(dir, 'gone.png') } },
        sha,
      ),
    ).toThrow(ArtMissing);
  });

  it('R5: keeps the given order, sizes sets from the default face, reports imported framings', () => {
    const { root } = characterFixture();
    const dir = join(root, 'chars', 'layered');
    const plan = planCharacter(
      dir,
      used({ full: ['smile', 'calm', 'angry'], head: ['smile', 'calm'] }),
      'smile',
      'left',
      sha,
      who,
    );
    if (plan.source !== 'layered') throw new Error('layered expected');
    expect(plan.sets.map((s) => s.framing)).toEqual(['full', 'head']);
    expect(plan.sets[0]!.faces.map(([f]) => f)).toEqual(['smile', 'calm', 'angry']);
    expect(plan.sets[0]!.size).toEqual([40, 50]);
    const im = planCharacter(
      join(root, 'chars', 'imported'),
      used({ full: ['smile'], upper: ['angry'] }),
      'smile',
      'right',
      sha,
      who,
    );
    expect(im.source === 'imported' && im.ignoredFramings).toEqual(['upper']);
    // a header too short to read and a part folder without pictures are art problems
    writeFileSync(
      join(dir, 'views/front/face/base/smile/head.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    expect(() => planCharacter(dir, used({ full: ['smile'] }), 'smile', 'left', sha, who)).toThrow(
      /truncated or unsupported image/,
    );
    const empty = join(root, 'chars', 'empty');
    mkdirSync(join(empty, 'views/main/体'), { recursive: true });
    writeFileSync(join(empty, 'character.yaml'), 'source: imported\nfaces:\n  smile: {}\n');
    expect(() =>
      planCharacter(empty, used({ full: ['smile'] }), 'smile', 'left', sha, who),
    ).toThrow(/no parts found/);
  });

  it('R4: imported mouth frames, borrowed parts and hair pass', () => {
    const { root } = characterFixture();
    const dir = join(root, 'chars', 'imported');
    const plan = () => {
      const p = planCharacter(dir, used({ full: ['angry', 'smile'] }), 'smile', 'right', sha, who);
      if (p.source !== 'imported') throw new Error('imported expected');
      return p;
    };
    const ids = () => plan().faces.map(([, f]) => JSON.stringify(planIdentity(f, dir)));
    const [angry, smile] = ids();
    expect(angry).toContain('口/口_00.1.png'); // the only middle frame
    expect(smile).toContain('体/体_00.png'); // borrowed from neutral
    writeFileSync(join(dir, 'views/main/口/口_00.2.png'), 'x');
    writeFileSync(join(dir, 'views/main/口/口_00.3.png'), 'x');
    expect(ids()[0]).toContain('口/口_00.2.png'); // middle of 1..3
    expect(ids()[1]).toBe(smile);
    writeFileSync(
      join(dir, 'character.yaml'),
      'source: imported\nfaces:\n  neutral: { 体: 体_00, 髪: 体_01 }\n  smile: {}\n  angry: {}\n',
    );
    mkdirSync(join(dir, 'views/main/髪'), { recursive: true });
    writeFileSync(join(dir, 'views/main/髪/体_01.png'), 'x');
    const hair = plan().faces[1]![1];
    expect(hair.layers[0]!.map((l) => l.opacity ?? 1)).toEqual([1, 1, 0.5]);
  });

  it('R6: classic faces take the variants that exist; identities are folder-relative', () => {
    const { root } = characterFixture();
    const dir = join(root, 'chars', 'classic');
    const p = planCharacter(
      dir,
      used({ full: ['smile', 'angry'], head: ['smile'] }),
      'smile',
      'left',
      sha,
      who,
    );
    if (p.source !== 'classic') throw new Error('classic expected');
    expect(p.faces.map(([f]) => f)).toEqual(['smile', 'angry']);
    expect(planIdentity(p.faces[0]![1], dir)).toEqual({
      kind: 'classic',
      base: `smile.png@${sha(join(dir, 'smile.png'))}`,
      talk: `smile-talk.png@${sha(join(dir, 'smile-talk.png'))}`,
    });
    expect(() => planCharacter(dir, used({ full: ['calm'] }), 'calm', 'left', sha, who)).toThrow(
      ArtMissing,
    );
    const layered = join(root, 'chars', 'layered');
    const l = planCharacter(layered, used({ full: ['smile'] }), 'smile', 'left', sha, who);
    if (l.source !== 'layered') throw new Error('layered expected');
    expect(JSON.stringify(planIdentity(l.sets[0]!.faces[0]![1], layered))).not.toContain(root);
  });
});
