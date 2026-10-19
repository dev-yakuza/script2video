/** `render --scenes` (S11): flag, names, lint on the picked copy, the lock left alone, exit codes. */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript, pickScenes, type Script } from '@script2video/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { atomicWrite } from '../src/atomic.js';
import { checkDevOutput } from '../src/dev.js';
import { parseScenesFlag, UsageError } from '../src/args.js';
import { renderBase, renderWorkDir } from '../src/paths.js';
import { scenesLint, spokenIn } from '../src/scenes.js';
import { frozenSaveDecision, synthesizeScript } from '../src/tts.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(REPO, 'packages/cli/dist/main.js');
const SAMPLE = 'videos/sample-ko/script.ko.md';

const run = (args: string[]) => {
  try {
    const out = execFileSync('node', [CLI, ...args], { cwd: REPO, stdio: 'pipe' });
    return { status: 0, err: '', out: out.toString() };
  } catch (e) {
    const x = e as { status: number; stderr: Buffer };
    return { status: x.status, err: x.stderr.toString(), out: '' };
  }
};

describe('--scenes on the command line', () => {
  it('takes comma lists and repeats, and refuses empty, odd or repeated ids', () => {
    expect(parseScenesFlag(undefined)).toBeUndefined();
    expect(parseScenesFlag(['a,b'])).toEqual(['a', 'b']);
    expect(parseScenesFlag(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseScenesFlag([' a , b '])).toEqual(['a', 'b']);
    expect(parseScenesFlag(['-x'])).toEqual(['-x']);
    for (const bad of [[''], ['a,,b'], ['a,'], ['a.b'], ['a/b'], ['a,a'], ['a', 'a']])
      expect(() => parseScenesFlag(bad), JSON.stringify(bad)).toThrow(UsageError);
  });
});

describe('names of a scene pick', () => {
  it('spells the scenes out, apart from the plain and the marked render', () => {
    const b = (o: Parameters<typeof renderBase>[3]) => renderBase('/o', 'youtube', 'ko', o);
    expect(b({})).toBe('/o/youtube.ko');
    expect(b({ draft: true, proxy: true })).toBe('/o/youtube.ko.draft.proxy');
    expect(b({ scenes: ['settings'] })).toBe('/o/youtube.ko.scenes-settings');
    expect(b({ draft: true, scenes: ['intro', 'settings'], proxy: true })).toBe(
      '/o/youtube.ko.draft.scenes-intro+settings.proxy',
    );
    // every scene picked is still a pick
    expect(b({ scenes: ['intro', 'settings'] })).not.toBe(b({}));
  });

  it('hashes a long list behind a mark no scene id has', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `a-rather-long-scene-${i}`);
    const name = renderBase('/o', 'youtube', 'ko', { scenes: ids });
    expect(name).toMatch(/^\/o\/youtube\.ko\.scenes@10-[0-9a-f]{8}$/);
    expect(renderBase('/o', 'youtube', 'ko', { scenes: [...ids] })).toBe(name);
  });

  it('works in a folder of its own per pick, always hashed', () => {
    const w = (scenes?: string[], draft = false) =>
      renderWorkDir(REPO, join(REPO, SAMPLE), 'youtube', 'ko', { draft, scenes });
    expect(w()).toMatch(/\/youtube\.ko$/);
    expect(w(undefined, true)).toMatch(/\/youtube\.ko\.draft$/);
    expect(w(['settings'])).toMatch(/\/youtube\.ko\.scenes-[0-9a-f]{8}$/);
    expect(w(['settings'], true)).toMatch(/\/youtube\.ko\.draft\.scenes-[0-9a-f]{8}$/);
    expect(w(['Intro'])).not.toBe(w(['intro']));
    expect(dirname(w(['settings']))).toBe(dirname(w()));
  });
});

describe('the audio lock', () => {
  it('is written whole, and a failed write leaves nothing beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-atomic-'));
    const f = join(dir, 'manifest.json');
    atomicWrite(f, '{"a":1}');
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}');
    mkdirSync(join(dir, 'folder'));
    expect(() => atomicWrite(join(dir, 'folder'), 'x')).toThrow();
    expect(readdirSync(dir).sort()).toEqual(['folder', 'manifest.json']);
  });

  it('a frozen run rewrites it only when it changes and nobody else wrote it meanwhile', () => {
    expect(frozenSaveDecision('a', 'a', 'a')).toBe('same');
    expect(frozenSaveDecision('a', 'a', 'b')).toBe('write');
    expect(frozenSaveDecision('a', 'c', 'b')).toBe('changed');
    expect(frozenSaveDecision('a', 'b', 'b')).toBe('same');
  });

  describe('frozen synthesis', () => {
    const prev = process.env.S2V_TTS;
    beforeAll(() => {
      process.env.S2V_TTS = 'mock';
    });
    afterAll(() => {
      if (prev === undefined) delete process.env.S2V_TTS;
      else process.env.S2V_TTS = prev;
    });

    it('leaves an unchanged lock untouched', async () => {
      const dir = mkdtempSync(join(tmpdir(), 's2v-frozen-'));
      mkdirSync(join(dir, 'video'));
      const path = join(dir, 'video', 'script.ko.md');
      writeFileSync(
        path,
        '---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#one}\n\nhost: 안녕하세요.\n',
      );
      const script = parseScript(readFileSync(path, 'utf8')).script!;
      await synthesizeScript(path, script, REPO, { asr: false, log: () => {} });
      const manifest = join(dir, 'video', 'audio', 'ko', 'manifest.json');
      // the lock as tts left it: no frozen run rewrites it, the first one included
      const before = statSync(manifest);
      const text = readFileSync(manifest, 'utf8');
      for (let i = 0; i < 2; i++)
        await synthesizeScript(path, script, REPO, { asr: false, frozen: true, log: () => {} });
      const after = statSync(manifest);
      expect(after.ino).toBe(before.ino);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(readFileSync(manifest, 'utf8')).toBe(text);
    });
  });
});

/** The parts character of parts.test.ts, its faces all drawable at full size. */
const YAML = `source: drawn
license: test
eyes: full
views:
  front: { facing: front, pivot: [20, 30] }
  turn: { facing: right, pivot: [20, 30] }
heads:
  front/glance: { facing: right }
expressions:
  neutral: {}
  side: { gaze: toward }
faces:
  neutral: { view: front, expression: neutral }
  listen: { view: front, head: glance, expression: neutral }
  gasp: { view: turn, expression: neutral }
  look: { view: front, expression: side }
sets:
  head:
    views: { front: {} }
    faces: [neutral]
`;

function png(path: string, w = 40, h = 50): void {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, b);
}

/** A video folder: a parts character `c` whose head set has `neutral` only, and a script. */
function shotVideo(): { dir: string; path: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 's2v-scenes-')));
  const c = join(dir, 'c');
  mkdirSync(c);
  writeFileSync(join(c, 'character.yaml'), YAML);
  for (const v of ['front', 'turn']) {
    png(join(c, `views/${v}/body/stand.png`));
    png(join(c, `views/${v}/face/base/neutral/head.png`));
  }
  png(join(c, 'views/front/face/glance/neutral/head.png'));
  png(join(c, 'sets/head/views/front/face/base/neutral/head.png'));
  const path = join(dir, 'script.ko.md');
  writeFileSync(
    path,
    `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: c }\noutputs:\n  youtube: { aspect: "16:9", layout: dialogue }\n---\n\n# 하나 {#s1}\n\n::shot{a=head}\n\na: 하나.\n\n# 둘 {#s2}\n\n::shot{a=full}\n\na: 둘.\n\n# 셋 {#s3}\n\na{face=listen}: 셋.\n`,
  );
  return { dir, path };
}

describe('lint on the picked copy', () => {
  const pick = (s: Script, ids: string[]) => {
    const r = pickScenes(s, 'youtube', ids);
    if (!r.ok) throw new Error(r.message);
    return r.script;
  };

  it('finds a face the inherited framing cannot draw, and only what is new', () => {
    const { dir, path } = shotVideo();
    const full = parseScript(readFileSync(path, 'utf8')).script!;
    const fullDiags = scenesLint(full, dir, []);
    expect(fullDiags.filter((d) => d.severity === 'error')).toEqual([]);
    const fresh = scenesLint(pick(full, ['s1', 's3']), dir, fullDiags);
    expect(fresh.filter((d) => d.severity === 'error').map((d) => d.message)).toEqual([
      expect.stringContaining('"listen" is not in sets.head.faces'),
    ]);
    expect(scenesLint(pick(full, ['s2', 's3']), dir, fullDiags)).toEqual([]);
  });

  it('counts the speech a pick keeps', () => {
    const full = parseScript(readFileSync(join(REPO, SAMPLE), 'utf8')).script!;
    expect(spokenIn(pick(full, ['settings']), 'youtube')).toBeGreaterThan(0);
  });
});

describe('render --scenes refuses before anything runs', { timeout: 60_000 }, () => {
  it('exit 2 for ids the script or the output does not have, and for bad lists', () => {
    // out/ is not in the repository: a fresh checkout has none
    const outDir = join(REPO, 'out', 'sample-ko');
    const listing = () => (existsSync(outDir) ? readdirSync(outDir).sort() : null);
    const outBefore = listing();
    const cases: [string[], RegExp][] = [
      [['--scenes', 'nope'], /scenes: intro, settings/],
      [['--output', 'shorts', '--scenes', 'intro'], /not in output "shorts"/],
      [['--scenes', 'a/b'], /not a scene id/],
      [['--scenes', ''], /empty scene id/],
      [['--scenes', 'intro,intro'], /given twice/],
      [['--scenes', '-x'], /--scenes=-/],
      [['--scenes=-x'], /no scene "-x"/],
    ];
    for (const [args, msg] of cases) {
      const r = run(['render', SAMPLE, '--frozen-audio', ...args]);
      expect(r.status, args.join(' ')).toBe(2);
      expect(r.err, args.join(' ')).toMatch(msg);
    }
    expect(run(['snapshot', SAMPLE, '--scenes', 'intro']).status).toBe(2);
    expect(listing()).toEqual(outBefore);
  });

  it('exit 1 with the lint error when the cut leaves a face undrawable, before synthesis', () => {
    const { path } = shotVideo();
    const out = realpathSync(mkdtempSync(join(tmpdir(), 's2v-clip-')));
    const r = run(['render', path, '--frozen-audio', '--scenes', 's1,s3', '--out-dir', out]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/"listen" is not in sets\.head\.faces.*\(--scenes\)/);
    expect(r.err).not.toMatch(/^tts:|^video:/m);
    expect(readdirSync(out)).toEqual([]);
    expect(existsSync(join(dirname(path), 'audio'))).toBe(false);
  });
});

describe('an unknown --output is a usage error', { timeout: 60_000 }, () => {
  it('exit 2 naming the outputs, in every command that takes one', () => {
    // dev is left out: it starts the servers, so its check is tested as a function (below)
    for (const cmd of ['render', 'snapshot', 'timeline', 'direct']) {
      const args = [cmd, SAMPLE, '--output', 'nope', ...(cmd === 'direct' ? ['--no-open'] : [])];
      const r = run(cmd === 'render' || cmd === 'snapshot' ? [...args, '--frozen-audio'] : args);
      expect(r.status, cmd).toBe(2);
      expect(r.err, cmd).toMatch(/unknown output "nope" \(have: youtube, shorts\)/);
    }
  });

  it('dev checks the output only: a script with lint errors or one that does not parse goes on', () => {
    // dev itself starts the servers, so the check before them is tested as a function
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 's2v-dev-')));
    const lintError = join(dir, 'lint.ko.md');
    writeFileSync(
      lintError,
      '---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#one}\n\n:only{nope} 안녕하세요.\n',
    );
    expect(
      parseScript(readFileSync(lintError, 'utf8')).diagnostics.items.map((d) => d.code),
    ).toContain('unknown-output');
    expect(() => checkDevOutput(lintError, 'youtube')).not.toThrow();
    expect(() => checkDevOutput(lintError, 'nope')).toThrow(UsageError);
    const broken = join(dir, 'broken.ko.md');
    writeFileSync(broken, '---\nlang: [\n---\n');
    expect(() => checkDevOutput(broken, 'nope')).not.toThrow();
    expect(() => checkDevOutput(join(dir, 'missing.md'), 'nope')).not.toThrow();
  });

  it('dev checks the output before it starts anything', () => {
    const src = readFileSync(join(REPO, 'packages/cli/src/main.ts'), 'utf8');
    const branch = src.slice(src.indexOf("if (command === 'dev') {"));
    const check = branch.indexOf('checkDevOutput(');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(branch.indexOf('await dev('));
  });
});

describe('the README shows --scenes', () => {
  it('on the render row of each language', () => {
    for (const f of ['README.md', 'README.ko.md', 'README.ja.md']) {
      const row = readFileSync(join(REPO, f), 'utf8')
        .split('\n')
        .find((l) => l.startsWith('| `render '));
      expect(row, f).toMatch(/\[--scenes <id,…>\]/);
    }
  });
});
