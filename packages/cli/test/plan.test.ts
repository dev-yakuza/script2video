import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import { planSentences } from '../src/tts.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SAMPLES = [
  'videos/sample-ko/script.ko.md',
  'videos/sample-en/script.en.md',
  'videos/sample-dialogue-ko/script.ko.md',
];

describe('planSentences', () => {
  it.each(SAMPLES)('gives the lock keys tts committed for %s', (rel) => {
    const path = join(ROOT, rel);
    const { script } = parseScript(readFileSync(path, 'utf8'));
    const plan = planSentences(path, script!, ROOT, { draft: false, mock: false });
    const manifest = JSON.parse(
      readFileSync(join(dirname(path), 'audio', script!.meta.lang, 'manifest.json'), 'utf8'),
    ) as { sentences: Record<string, string> };
    expect(plan.errors).toEqual([]);
    expect(plan.sentences).toEqual(manifest.sentences);
  });

  it('reports a paragraph it cannot plan instead of throwing', () => {
    const path = join(ROOT, 'videos/x/script.ko.md');
    const { script } = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "persona:nobody" }\n---\n# s\na: 안녕하세요.\n\na: :audio{src=missing.wav}둘째.\n',
    );
    const plan = planSentences(path, script!, ROOT, { draft: false, mock: false });
    expect(plan.errors.map((e) => e.message)).toEqual([
      expect.stringMatching(/persona "nobody" not found/),
      'recording not found: missing.wav',
    ]);
  });
});
