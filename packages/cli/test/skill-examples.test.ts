/**
 * The write-script skill's marked examples parse (acting stage 6 plan 5), so the skill never
 * teaches syntax the build does not take. It reads `.claude/skills` at the repository root, which is
 * why it lives with the cli tests (core tests read nothing outside their package).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from '@script2video/core';
import { describe, expect, it } from 'vitest';

const SKILL = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '../../..'),
  '.claude/skills/write-script',
);
const docs = ['SKILL.md', 'reference.md'].map((f) => readFileSync(join(SKILL, f), 'utf8'));

/** Fenced blocks right after a `<!-- s2v:<mark> -->` line. */
function marked(mark: string): string[] {
  const re = new RegExp(`<!-- s2v:${mark} -->\\n\`\`\`[a-z]*\\n([\\s\\S]*?)\\n\`\`\``, 'g');
  return docs.flatMap((d) => [...d.matchAll(re)].map((m) => m[1]!));
}

const FRONTMATTER = `---
lang: ko
cast:
  minsu: { voice: "qwen:Sohee", character: x }
  jiwoo: { voice: "qwen:Ryan", character: x }
  host: { voice: "qwen:Sohee" }
outputs:
  youtube: { aspect: "16:9", layout: dialogue }
---
`;

const errors = (source: string) =>
  parseScript(source)
    .diagnostics.items.filter((d) => d.severity === 'error')
    .map((d) => `${d.code}: ${d.message}`);

describe('write-script skill examples', () => {
  const examples = marked('example');

  it('has the examples it promises', () => {
    expect(examples.length + marked('frontmatter').length).toBeGreaterThanOrEqual(5);
    const all = examples.join('\n');
    for (const syntax of ['{emo=', ':emo{', ':react{', ':look{', '::enter{', '::exit{'])
      expect(all).toContain(syntax);
  });

  it.each(examples.map((e, i) => [i, e]))('example %i parses', (_i, example) => {
    expect(errors(`${FRONTMATTER}\n# T {#t}\n\n${example}\n`)).toEqual([]);
  });

  it('the frontmatter examples parse', () => {
    const blocks = marked('frontmatter');
    expect(blocks.join('\n')).toContain('acting:');
    // their own --- lines; one scene the outputs can pick
    for (const fm of blocks)
      expect(errors(`${fm}\n\n# 문제 {#problem}\n\nhost: 안녕하세요.\n`)).toEqual([]);
  });
});
