import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_REFERENCE, parsePersona, parseScript } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import { lintCast } from '../src/lint-assets.js';
import { genderMismatch, personaSearchDirs, resolvePersona } from '../src/persona.js';

const DESC = '30대 남성, 차분한 목소리';

/** videos/<video>/ with a shared videos/voices/minsu.yaml (+ optional ko clip). */
function fixture(withClip: boolean) {
  const root = mkdtempSync(join(tmpdir(), 's2v-persona-'));
  const video = join(root, 'video');
  mkdirSync(join(root, 'voices', 'minsu'), { recursive: true });
  mkdirSync(video);
  writeFileSync(join(root, 'voices', 'minsu.yaml'), `description: ${DESC}\n`);
  if (withClip) {
    const wav = Buffer.from('fake wav');
    writeFileSync(join(root, 'voices', 'minsu', 'ko.wav'), wav);
    writeFileSync(
      join(root, 'voices', 'minsu', 'ko.json'),
      JSON.stringify({
        description: DESC,
        text: DEFAULT_REFERENCE.ko,
        sha256: createHash('sha256').update(wav).digest('hex'),
      }),
    );
  }
  return { root, video };
}

describe('persona files', () => {
  it('defaults the reference sentence per language', () => {
    expect(parsePersona(`description: ${DESC}\n`).reference).toEqual({});
    expect(() => parsePersona('reference: {}\n')).toThrow();
  });

  it('resolves a persona shared in the parent folder', () => {
    const { video } = fixture(true);
    const ref = resolvePersona('minsu', 'ko', video);
    expect(typeof ref).toBe('object');
    expect(ref).toMatchObject({ id: 'minsu', text: DEFAULT_REFERENCE.ko });
  });

  it('searches up to the repository root, and only one level outside a repository', () => {
    const root = mkdtempSync(join(tmpdir(), 's2v-persona-repo-'));
    const video = join(root, 'studio', 'videos', 'intro');
    mkdirSync(video, { recursive: true });
    mkdirSync(join(root, 'studio', 'voices'), { recursive: true });
    writeFileSync(join(root, 'studio', 'voices', 'minsu.yaml'), `description: ${DESC}\n`);
    expect(resolvePersona('minsu', 'ko', video)).toMatch(/not found/);
    mkdirSync(join(root, '.git'));
    expect(personaSearchDirs(video)).toEqual([
      join(video, 'voices'),
      join(root, 'studio', 'videos', 'voices'),
      join(root, 'studio', 'voices'),
      join(root, 'voices'),
    ]);
    expect(resolvePersona('minsu', 'ko', video)).toMatch(/s2v voice create/);
  });

  it('says what to run when the clip is missing or stale', () => {
    const { video } = fixture(false);
    expect(resolvePersona('nobody', 'ko', video)).toMatch(/not found/);
    expect(resolvePersona('minsu', 'ko', video)).toMatch(/s2v voice create/);
    const withClip = fixture(true);
    writeFileSync(join(withClip.root, 'voices', 'minsu', 'ko.wav'), 'edited');
    expect(resolvePersona('minsu', 'ko', withClip.video)).toMatch(/changed since it was picked/);
  });

  it('flags a designed voice whose pitch contradicts the described gender', () => {
    expect(genderMismatch('30대 남성', 230)).toMatch(/sounds female/);
    expect(genderMismatch('30대 남성', 125)).toBeNull();
    expect(genderMismatch('a young woman', 120)).toMatch(/sounds male/);
    expect(genderMismatch('20代の女性', 240)).toBeNull();
    expect(genderMismatch('calm narrator', 300)).toBeNull();
  });
});

describe('lintCast', () => {
  const script = (cast: string, outputs: string, body: string) =>
    parseScript(`---\nlang: ko\ncast:\n${cast}outputs:\n${outputs}---\n\n# 하나 {#one}\n\n${body}`)
      .script!;

  it('warns about a missing persona clip and a shared voice', () => {
    const { video } = fixture(false);
    const s = script(
      '  a: { voice: "qwen:Sohee" }\n  b: { voice: "qwen:Sohee" }\n  c: { voice: "persona:minsu" }\n',
      '  youtube: { aspect: "16:9", layout: dialogue }\n',
      'a: 안녕하세요.\n\nb: 반가워요.\n\nc: 저도요.\n',
    );
    const codes = lintCast(s, video).map((d) => d.code);
    expect(codes).toContain('persona');
    expect(codes).toContain('same-voice');
  });

  it('warns when a dialogue has more speakers than avatars', () => {
    const cast = ['F1', 'F2', 'M1', 'M2', 'M3']
      .map((v, i) => `  s${i}: { voice: "supertonic:${v}" }\n`)
      .join('');
    const body = [0, 1, 2, 3, 4].map((i) => `s${i}: 안녕하세요.`).join('\n\n') + '\n';
    const s = script(cast, '  youtube: { aspect: "16:9", layout: dialogue }\n', body);
    expect(lintCast(s, '/tmp').map((d) => d.code)).toContain('machine-generated');
    expect(
      lintCast(s, '/tmp')
        .filter((d) => d.code === 'dialogue-cast')
        .map((d) => d.message),
    ).toEqual([
      '"youtube" has 5 speakers: avatars are hidden above 4, only name tags tell them apart',
    ]);
  });
});
