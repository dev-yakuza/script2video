import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneAudio } from '../src/tts.js';

describe('pruneAudio', () => {
  it('drops entries the sentence map no longer uses, and stray takes', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-prune-'));
    const lock = join(dir, 'audio', 'ko');
    mkdirSync(lock, { recursive: true });
    for (const f of ['keep.wav', 'old.wav', 'keep.try1.wav']) writeFileSync(join(lock, f), 'x');
    writeFileSync(
      join(lock, 'manifest.json'),
      JSON.stringify({
        version: 1,
        lang: 'ko',
        entries: { k1: { src: 'keep.wav' }, k2: { src: 'old.wav' } },
        sentences: { 'one:0:0': 'k1' },
        env: {},
      }),
    );
    const r = pruneAudio(join(dir, 'script.ko.md'), 'ko');
    expect(r).toMatchObject({ entries: 1, files: 2 });
    expect(readdirSync(lock).sort()).toEqual(['keep.wav', 'manifest.json']);
    expect(
      Object.keys(JSON.parse(readFileSync(join(lock, 'manifest.json'), 'utf8')).entries),
    ).toEqual(['k1']);
  });
});
