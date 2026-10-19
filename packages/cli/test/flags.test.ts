/**
 * Strict flags (S3 plan 4): every command takes only its own flags; the usage text, the header of
 * main.ts and the documented examples name the same flags as the table.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { commandOf, FLAGS, parseFor, USAGE, UsageError, type CommandKey } from '../src/args.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cli = join(REPO, 'packages/cli/dist/main.js');
const run = (args: string[]) => {
  try {
    execFileSync('node', [cli, ...args], { cwd: REPO, stdio: 'pipe' });
    return { status: 0, err: '' };
  } catch (e) {
    const x = e as { status: number; stderr: Buffer };
    return { status: x.status, err: x.stderr.toString() };
  }
};

const KEYS = Object.keys(FLAGS) as CommandKey[];
const flagsIn = (text: string) =>
  new Set([...text.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]!));

/** The command key a `s2v …` line documents: the longest key its words start with. */
function keyOf(words: string[]): CommandKey | undefined {
  return KEYS.filter((k) => k.split(' ').every((w, i) => words[i] === w)).sort(
    (a, b) => b.length - a.length,
  )[0];
}

// each case starts node: give the suite room when every test file runs at once
describe('strict flags', { timeout: 60_000 }, () => {
  it('refuse a flag the command does not take', () => {
    for (const [args, message] of [
      [
        ['sentences', 'videos/sample-ko/script.ko.md', '--json'],
        /s2v sentences: unknown option --json \(takes no options\)/,
      ],
      [
        ['snapshot', 'videos/sample-ko/script.ko.md', '--idle', 'on'],
        /unknown option --idle \(takes: --output/,
      ],
      [
        ['tts', 'videos/sample-ko/script.ko.md', '--output', 'shorts'],
        /s2v tts: unknown option --output/,
      ],
      [
        ['voice', 'refs', 'videos/sample-ko/script.ko.md', '--lang', 'ko'],
        /s2v voice refs: unknown option --lang/,
      ],
      [
        ['lint', 'videos/sample-ko/script.ko.md', '--rhythm', 'on'],
        /s2v lint: unknown option --rhythm/,
      ],
      [
        ['inspect', 'videos/sample-ko/script.ko.md', '--json', '-o', 'x'],
        /s2v inspect: unknown option -o \(takes: --json, --hash-version\)/,
      ],
      [['voice', '--foo', 'bar', 'create', 'x.yaml'], /s2v voice: unknown option --foo/],
    ] as const) {
      const r = run([...args]);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toMatch(message);
    }
  });

  it('other parse errors are usage errors too', () => {
    expect(() => parseFor('inspect', ['x', '--hash-version'])).toThrow(UsageError);
    expect(() => parseFor('inspect', ['x', '--json=yes'])).toThrow(UsageError);
    expect(run(['inspect', 'videos/sample-ko/script.ko.md', '--json', '--', '--y']).status).toBe(2);
  });

  it('a flag may come before the subcommand, as before', () => {
    expect(commandOf('voice', ['--lang', 'ko', 'create', 'v.yaml'])).toEqual({
      key: 'voice create',
      positionals: ['create', 'v.yaml'],
    });
    expect(commandOf('character', ['--max-memory-gb', '16', 'build', 'x', '--dry-run'])?.key).toBe(
      'character build',
    );
    expect(commandOf('takes', ['--list', 'x.md'])?.key).toBe('takes');
    expect(commandOf('takes', ['pick', 'x.md', '1:0:0=2'])?.key).toBe('takes pick');
    expect(commandOf('audio', ['prune', 'x.md'])?.key).toBe('audio prune');
    expect(commandOf('voice', ['foo', 'x'])).toBeNull();
    // an unknown option is named as such, not taken for a missing subcommand
    expect(() => commandOf('voice', ['--foo', 'bar', 'create', 'x'])).toThrow(
      /s2v voice: unknown option --foo/,
    );
    expect(commandOf('audio', ['foo', 'x'])).toBeNull();
    expect(run(['voice', 'foo', 'x']).status).toBe(2);
    // names an object inherits are not commands; an unknown command with a flag is still usage
    for (const args of [
      ['constructor', 'x'],
      ['toString', 'x'],
      ['__proto__', 'x'],
      ['foo', '--bar'],
    ])
      expect(run(args).err, args.join(' ')).toMatch(/^usage: /);
    expect(run(['constructor', 'x']).status).toBe(2);
    // run to the end: whatever fails, it is not the flags
    for (const args of [
      ['voice', '--lang', 'ko', 'check', '/nonexistent.yaml'],
      ['takes', '--list', '/nonexistent.md'],
    ])
      expect(run(args).err, args.join(' ')).not.toMatch(/unknown option|usage:/);
    const build = run(['character', '--max-memory-gb', '16', 'build', '/nonexistent', '--dry-run']);
    expect(build.err).not.toMatch(/unknown option/);
  });

  it('a sentence starting with - goes after --', () => {
    expect(parseFor('say', ['--lang', 'ko', '--', '-5도입니다.']).positionals).toEqual([
      '-5도입니다.',
    ]);
    expect(() => parseFor('say', ['-5도입니다.'])).toThrow(/unknown option -5/);
  });

  it('--rhythm and --idle take on or off', () => {
    const r = run(['render', 'videos/sample-ko/script.ko.md', '--idle', 'maybe']);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/--idle must be on or off/);
  });
});

describe('the flag table is what the help and the docs say', () => {
  it('the usage text names every command once, with exactly its flags', () => {
    const seen = new Set<CommandKey>();
    for (const line of USAGE.slice(1)) {
      const [syntax] = line.split('   (');
      const key = keyOf(syntax!.split(' ').slice(1));
      expect(key, line).toBeDefined();
      expect(seen.has(key!), line).toBe(false);
      seen.add(key!);
      expect([...flagsIn(syntax!)].sort(), line).toEqual([...FLAGS[key!]].sort());
    }
    expect([...seen].sort()).toEqual([...KEYS].sort());
    expect(USAGE[0]).toMatch(/^s2v --version \[--json\]/);
  });

  it('the header of main.ts is the usage text', () => {
    const src = readFileSync(join(REPO, 'packages/cli/src/main.ts'), 'utf8');
    const header = [...src.matchAll(/^ \* {3}(s2v .*)$/gm)].map((m) => m[1]);
    expect(header).toEqual(USAGE);
  });

  it('the README and the write-script skill only show flags their command takes', () => {
    const docs = [
      'README.md',
      'README.ko.md',
      'README.ja.md',
      '.claude/skills/write-script/SKILL.md',
      '.claude/skills/write-script/reference.md',
    ];
    let checked = 0;
    for (const doc of docs) {
      const text = readFileSync(join(REPO, doc), 'utf8');
      const snippets: string[] = [];
      // backtick spans and code-block lines (not prose: one prose line may name two commands)
      for (const m of text.matchAll(/`([^`\n]+)`/g)) snippets.push(m[1]!);
      let fenced = false;
      for (const line of text.split('\n')) {
        if (line.trimStart().startsWith('```')) fenced = !fenced;
        else if (fenced) snippets.push(line);
      }
      // the Commands table: the first cell names the command without a prefix
      for (const line of text.split('\n')) {
        const cell = /^\|\s*`([^`]+)`/.exec(line)?.[1];
        if (cell) snippets.push(`s2v ${cell}`);
      }
      for (const raw of snippets) {
        const m = /(?:^|\s|`)(?:s2v|node packages\/cli\/dist\/main\.js)\s+(.*)$/.exec(raw);
        if (!m) continue;
        const rest = m[1]!.replace(/\s#.*$/, '').replace(/\\\|/g, '|');
        const words = rest.split(/\s+/);
        if (!words[0] || words[0].startsWith('<') || words[0].startsWith('-')) continue;
        // `voice create / pick`, `render|snapshot|timeline`
        const heads = words[0].split('|');
        const subs: string[] = [];
        for (const w of words.slice(1)) {
          if (w === '/') continue;
          if (!/^[a-z][a-z-]*$/.test(w)) break;
          subs.push(w);
        }
        for (const head of heads) {
          const candidates = subs.length ? subs.map((s) => keyOf([head, s])).filter(Boolean) : [];
          const keys = (candidates.length ? candidates : [keyOf([head])]).filter(
            Boolean,
          ) as CommandKey[];
          if (keys.length === 0) continue; // prose that happens to say "s2v"
          const flags = [...flagsIn(rest)].filter((f) => f !== 'version');
          for (const key of keys) {
            for (const f of flags)
              expect(FLAGS[key] as readonly string[], `${doc}: ${raw.trim()} (${key})`).toContain(
                f,
              );
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
  });
});
