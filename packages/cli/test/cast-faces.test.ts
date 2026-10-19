import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript, sidesOf, type Script } from '@script2video/core';
import {
  assignSides,
  loadCharacterSpec,
  resolveFace,
  type LayeredSpec,
} from '@script2video/renderer-remotion';
import { describe, expect, it } from 'vitest';
import { enrichCast } from '../src/cast-faces.js';
import { addedText, applyMissing, findMissing } from '../src/character-gen/missing.js';
import { lintCast, usedFaces } from '../src/lint-assets.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function png(path: string, w = 40, h = 50): void {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, b);
}

/** A script folder with the sample's classic characters. */
function classic(body: string): { script: Script; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 's2v-faces-'));
  cpSync(join(ROOT, 'videos/sample-dialogue-ko/characters'), join(dir, 'characters'), {
    recursive: true,
  });
  const script = parseScript(
    `---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee", character: characters/host }\n  guest: { voice: "qwen:Sohee", character: characters/guest }\noutputs:\n  youtube: { aspect: "16:9", layout: dialogue }\n---\n# s\n\n${body}\n`,
  ).script!;
  return { script, dir };
}

describe('enrichCast: emotion faces', () => {
  it('lists the classic faces that exist', () => {
    const { script, dir } = classic('host{emo=sad}: 슬퍼요.\n\nguest{emo=happy}: 좋아요.');
    enrichCast(script, dir);
    expect(script.meta.cast.host!.faceSets).toEqual({ any: ['neutral', 'happy', 'surprised'] });
  });

  it('draws a missing emotion face with the default face (no lint error), and lists it as optional', () => {
    const { script, dir } = classic('host{emo=sad}: 슬퍼요.\n\nguest{emo=happy}: 좋아요.');
    enrichCast(script, dir);
    const errors = lintCast(script, dir).filter((d) => d.severity === 'error');
    expect(errors).toEqual([]);
    expect([...usedFaces(script, 'host').get('full')!]).toEqual(['neutral']);
    expect([...usedFaces(script, 'host', 'wanted').get('full')!]).toEqual(['neutral', 'sad']);
    expect([...usedFaces(script, 'guest').get('full')!]).toEqual(['neutral', 'happy']);
  });

  it('draws a look variant when its PNG exists, and lists looks in the used faces', () => {
    const { script, dir } = classic(
      'host: :look{host=viewer}안녕하세요. :look{guest=viewer}반가워요.\n\nguest: 네.',
    );
    png(join(dir, 'characters/host/front-neutral.png'));
    enrichCast(script, dir);
    expect(script.meta.cast.host!.faceSets).toEqual({
      any: ['neutral', 'happy', 'surprised', 'front-neutral'],
    });
    expect([...usedFaces(script, 'host').get('full')!]).toEqual(['neutral', 'front-neutral']);
    // the guest has no front-neutral: drawn as neutral, asked for as front-neutral
    expect([...usedFaces(script, 'guest').get('full')!]).toEqual(['neutral']);
    expect([...usedFaces(script, 'guest', 'wanted').get('full')!]).toEqual([
      'neutral',
      'front-neutral',
    ]);
  });

  it('warns when a speaker talks with a classic look variant that has no talk art', () => {
    const { script, dir } = classic('host: :look{host=viewer}안녕하세요.\n\nguest: 네.');
    png(join(dir, 'characters/host/front-neutral.png'));
    enrichCast(script, dir);
    const warns = lintCast(script, dir).filter((d) => d.severity === 'warning');
    expect(warns.map((d) => d.message).join()).toContain('front-neutral-talk.png');
  });

  it('assigns sides in lint as the renderer does for the same cast', () => {
    const { script } = classic('host: 안녕.\n\nguest: 네.');
    const cast = Object.keys(script.meta.cast).map((key, i) => ({
      key,
      side: i === 1 ? ('left' as const) : undefined,
    }));
    const { left, right } = assignSides(cast);
    expect(sidesOf(cast)).toEqual(
      Object.fromEntries([
        ...left.map((c) => [c.key, 'left']),
        ...right.map((c) => [c.key, 'right']),
      ]),
    );
    const plain = [
      { key: 'a' },
      { key: 'b' },
      { key: 'c' },
      { key: 'd', side: 'left' as const },
      { key: 'e' },
    ];
    const r = assignSides(plain);
    expect(sidesOf(plain)).toEqual(
      Object.fromEntries([
        ...r.left.map((c) => [c.key, 'left']),
        ...r.right.map((c) => [c.key, 'right']),
      ]),
    );
  });

  it('never throws on a broken character', () => {
    const { script, dir } = classic('host: 안녕.');
    writeFileSync(join(dir, 'characters/host/character.yaml'), 'source: [broken');
    expect(() => enrichCast(script, dir)).not.toThrow();
    expect(script.meta.cast.host!.faceSets).toBeUndefined();
  });

  it('needs mouth frames for a parts emotion face', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-faces-'));
    const c = join(dir, 'c');
    mkdirSync(c);
    writeFileSync(
      join(c, 'character.yaml'),
      `source: drawn\nlicense: test\neyes: dot\nviews:\n  front: { facing: front, pivot: [20, 30] }\nexpressions:\n  neutral: {}\n  happy: {}\nfaces:\n  neutral: { view: front, expression: neutral }\n  happy: { view: front, expression: happy }\n`,
    );
    png(join(c, 'views/front/body/stand.png'));
    png(join(c, 'views/front/face/base/neutral/head.png'));
    png(join(c, 'views/front/face/base/happy/head.png'));
    const script = parseScript(
      `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: c }\n---\n# s\n\na{emo=happy}: 좋아요.\n`,
    ).script!;
    enrichCast(script, dir);
    expect(script.meta.cast.a!.faceSets).toMatchObject({ full: [] });
    const spec = loadCharacterSpec(c) as LayeredSpec;
    for (const face of ['neutral', 'happy']) {
      const r = resolveFace(c, spec, 'full', face, 'left', [1, 1]);
      png(r.head.states.talk.at(-1)!);
    }
    const again = parseScript(
      `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: c }\n---\n# s\n\na{emo=happy}: 좋아요.\n`,
    ).script!;
    enrichCast(again, dir);
    expect(again.meta.cast.a!.faceSets).toMatchObject({ full: ['neutral', 'happy'] });
    expect(findMissing(again, dir, { repoRoot: ROOT }).every((r) => r.emotional.length === 0)).toBe(
      true,
    );
  });
});

describe('character missing: the head close-up (closeup-look plan)', () => {
  it('draws a pose with its expression, and --apply copies the turned head it needs', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-faces-'));
    const c = join(dir, 'c');
    mkdirSync(c);
    writeFileSync(
      join(c, 'character.yaml'),
      `source: generated\nlicense: test\nviews:\n  front: { facing: front, pivot: [20, 30] }\nheads:\n  front/glance: { facing: right }\nbodies:\n  front/wave: {}\nexpressions:\n  neutral: {}\n  happy: {}\nfaces:\n  neutral: { view: front, expression: neutral }\n  glance-neutral: { view: front, head: glance, expression: neutral }\n  wave: { view: front, body: wave, expression: happy }\nsets:\n  head:\n    views: { front: {} }\n    faces: [neutral]\n`,
    );
    const script = parseScript(
      `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: c }\n---\n# s\n\n::shot{a=head}\n\na{face=wave}: 안녕.\n\na{face=glance-neutral}: 네.\n`,
    ).script!;
    const [r] = findMissing(script, dir, { repoRoot: ROOT });
    expect(r!.impossible).toEqual([]);
    expect(r!.notInSet.map((x) => x.face).sort()).toEqual(['glance-neutral', 'wave']);
    const added = applyMissing(r!);
    // the text says it as it always did; tools get the parts (S9b)
    expect(added.map(addedText)).toContain(
      'head:heads.front/glance (turned faces in the head close-up now use this head)',
    );
    expect(added).toContainEqual({
      framing: 'head',
      kind: 'head',
      key: 'front/glance',
      note: 'turned faces in the head close-up now use this head',
    });
    expect(readFileSync(join(c, 'character.yaml'), 'utf8')).toMatch(
      /front\/glance: \{ facing: right \}|front\/glance:\n\s+facing: right/,
    );
    const spec = loadCharacterSpec(c) as LayeredSpec;
    expect(spec.sets.head!.heads['front/glance']).toEqual({ facing: 'right' });
    expect(spec.sets.head!.bodies).toEqual({});
    expect(resolveFace(c, spec, 'head', 'wave', 'left', [1, 1]).key).toMatchObject({
      head: 'base',
      expr: 'happy',
      body: 'stand',
    });
  });
});
