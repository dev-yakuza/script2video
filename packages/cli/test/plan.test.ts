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

  it.each(SAMPLES)('parses %s without acting fields', (rel) => {
    const r = parseScript(readFileSync(join(ROOT, rel), 'utf8'));
    expect(r.diagnostics.items.filter((d) => d.severity === 'error')).toEqual([]);
    expect(JSON.stringify(r.script)).not.toMatch(/"acting"|"actingChange"/);
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

  const plan = (body: string, draft = false) => {
    const path = join(ROOT, 'videos/x/script.ko.md');
    const { script } = parseScript(
      `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", style: "밝게" }\n  r: { voice: "supertonic:F1", speed: 0.7 }\n---\n# s\n${body}\n`,
    );
    return planSentences(path, script!, ROOT, { draft, mock: false });
  };

  it('keeps the keys of lines without acting', () => {
    const a = plan('a: 안녕하세요.');
    const b = plan('a{gap=0.2 face=happy}: 안녕하세요.');
    expect(b.sentences).toEqual(a.sentences);
    expect(a.jobs[0]!.synthFields.instruct).toBe('밝게');
  });

  it('puts the template and its version into the synthesis key of emotion lines', () => {
    const [plain] = plan('a: 안녕하세요.').jobs;
    const [sad] = plan('a{emo=sad}: 안녕하세요.').jobs;
    expect(sad!.synthKey).not.toBe(plain!.synthKey);
    expect(sad!.synthFields.instruct).toMatch(/^밝게 Sound sad: .* Say only the words/);
    expect(sad).toMatchObject({ emotional: true, template: true, multiplier: 1.05 });
    expect((sad!.synthFields as unknown as { templates?: number }).templates).toBe(1);
  });

  it('puts power of an emotion line into the lock key, not the synthesis key (stage 3 plan 1)', () => {
    const [weak] = plan('a{emo=sad power=weak}: 안녕하세요.').jobs;
    const [normal] = plan('a{emo=sad}: 안녕하세요.').jobs;
    expect(weak!.key).not.toBe(normal!.key);
    expect(weak!.synthKey).toBe(normal!.synthKey);
    expect(weak!.pickKey).not.toBe(normal!.pickKey);
    expect(weak!.power).toBe('weak');
    // no effect (and no key change) on a line that is not an emotion line
    const [plainWeak] = plan('a{emo=neutral power=weak}: 안녕하세요.').jobs;
    expect(plainWeak!.key).toBe(plan('a{emo=neutral}: 안녕하세요.').jobs[0]!.key);
  });

  it('turns the line speed into tempo, or the synthesis speed for supertonic', () => {
    const [q] = plan('a{speed=1.2}: 안녕하세요.').jobs;
    expect(q).toMatchObject({ tempo: 1.2, speedProduct: 1.2 });
    expect(q!.synthKey).toBe(plan('a: 안녕하세요.').jobs[0]!.synthKey);
    const [r] = plan('r{speed=1.25}: 안녕하세요.').jobs;
    expect(r!.synthFields.speed).toBeCloseTo(0.875);
  });

  it('speaks plainly in a draft, even with a qwen draft voice', () => {
    const path = join(ROOT, 'videos/x/script.ko.md');
    const { script } = parseScript(
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", draftVoice: "qwen:Sohee" }\n---\n# s\na{emo=sad say="조용히"}: 안녕하세요.\n',
    );
    const [job] = planSentences(path, script!, ROOT, { draft: true, mock: false }).jobs;
    expect(job).toMatchObject({ template: false, emotional: false });
    expect(job!.synthFields.instruct).toBe('');
  });

  it('refuses a speed Supertonic cannot take, and clamps a draft', () => {
    expect(plan('r{speed=0.8}: 안녕하세요.').errors[0]!.message).toMatch(/Supertonic speed 0.560/);
    const draft = plan('r{speed=0.8}: 안녕하세요.', true);
    expect(draft.errors).toEqual([]);
    expect(draft.notes[0]).toMatch(/clamped/);
    expect(draft.jobs[0]!.emotional).toBe(false);
  });
});
