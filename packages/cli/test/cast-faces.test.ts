import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript, type Script } from '@script2video/core';
import { loadCharacterSpec, resolveFace, type LayeredSpec } from '@script2video/renderer-remotion';
import { describe, expect, it } from 'vitest';
import { enrichCast } from '../src/cast-faces.js';
import { findMissing } from '../src/character-gen/missing.js';
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
    expect(findMissing(again, dir).every((r) => r.emotional.length === 0)).toBe(true);
  });
});
