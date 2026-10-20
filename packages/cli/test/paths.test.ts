/** Where results and per-video caches go (S2 plan): `--out-dir`, its checks, the cache key. */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UsageError } from '../src/args.js';
import { cacheDirOf, cacheKeyOf, checkOutDir, outDirOf, snapshotPaths } from '../src/paths.js';
import { dropThumbnail, writePublishFiles } from '../src/publish.js';
import { buildTimeline, parseScript } from '@script2video/core';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A repo root with a script folder `videos/<name>/script.ko.md`. */
function setup(name = 'intro') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 's2v-paths-')));
  const script = join(root, 'videos', name, 'script.ko.md');
  mkdirSync(dirname(script), { recursive: true });
  writeFileSync(script, '');
  return { root, script };
}

describe('outDirOf', () => {
  it('is out/<script folder> by default, or the folder given (from the working directory)', () => {
    const { root, script } = setup();
    expect(outDirOf(script, root)).toBe(join(root, 'out', 'intro'));
    expect(outDirOf(script, root, 'rel/dir')).toBe(resolve('rel/dir'));
    expect(outDirOf(script, root, '/abs/dir')).toBe('/abs/dir');
  });
});

describe('checkOutDir', () => {
  const refused = (dir: string, script: string, root: string) => {
    expect(() => checkOutDir(dir, script, root), dir).toThrow(UsageError);
    expect(existsSync(dir), `${dir} is not created`).toBe(false);
  };

  it('accepts a folder to be, also through a link to a folder, and creates nothing', () => {
    const { root, script } = setup();
    const dir = join(root, 'results', 'ko');
    expect(checkOutDir(dir, script, root)).toBe(dir);
    expect(existsSync(dir)).toBe(false); // the command makes it when it writes
    mkdirSync(join(root, 'results'));
    symlinkSync(join(root, 'results'), join(root, 'linked'));
    expect(checkOutDir(join(root, 'linked', 'en'), script, root)).toBe(join(root, 'linked', 'en'));
    expect(statSync(join(root, 'linked')).isDirectory()).toBe(true);
  });

  it('refuses a file, a broken link, and a path under either', () => {
    const { root, script } = setup();
    expect(() => checkOutDir('', script, root)).toThrow(/empty/);
    writeFileSync(join(root, 'file.txt'), '');
    symlinkSync(join(root, 'nowhere'), join(root, 'broken'));
    expect(() => checkOutDir(join(root, 'file.txt'), script, root)).toThrow(/not a folder/);
    expect(() => checkOutDir(join(root, 'broken'), script, root)).toThrow(/broken link/);
    refused(join(root, 'file.txt', 'sub'), script, root);
    refused(join(root, 'broken', 'sub'), script, root);
  });

  it("refuses the script's audio lock and s2v's cache, without creating anything", () => {
    const { root, script } = setup();
    const audio = join(dirname(script), 'audio');
    refused(join(audio, 'x'), script, root); // audio/ not there yet
    mkdirSync(join(audio, 'ko'), { recursive: true });
    expect(() => checkOutDir(audio, script, root)).toThrow(/audio lock/);
    refused(join(audio, 'ko', 'x'), script, root);
    refused(join(root, '.s2v-cache', 'x'), script, root);
    // a link into the lock is the lock
    symlinkSync(audio, join(root, 'sneaky'));
    refused(join(root, 'sneaky', 'x'), script, root);
    // a name that only starts the same is outside
    expect(checkOutDir(join(dirname(script), 'audio2'), script, root)).toBeTruthy();
    if (process.platform === 'darwin') refused(join(dirname(script), 'AUDIO', 'x'), script, root);
  });
});

describe('cacheKeyOf', () => {
  it('tells two folders with the same name apart, and shares one folder across languages', () => {
    const a = setup('intro');
    const b = setup('intro');
    const ka = cacheKeyOf(a.script);
    expect(ka).toMatch(/^intro-[0-9a-f]{8}$/);
    expect(cacheKeyOf(b.script)).not.toBe(ka);
    expect(cacheKeyOf(join(dirname(a.script), 'script.en.md'))).toBe(ka);
    // a link, another case or another Unicode form of the same folder: the same key
    symlinkSync(dirname(a.script), join(a.root, 'alias'));
    expect(cacheKeyOf(join(a.root, 'alias', 'script.ko.md'))).toBe(ka);
    if (process.platform === 'darwin') {
      expect(cacheKeyOf(join(a.root, 'VIDEOS', 'INTRO', 'script.ko.md'))).toBe(ka);
      const ko = setup('소개-영상');
      const k = cacheKeyOf(ko.script);
      expect(k.normalize('NFC')).toMatch(/^소개-영상-[0-9a-f]{8}$/);
      const nfd = join(ko.root, 'videos', '소개-영상'.normalize('NFD'), 'script.ko.md');
      expect(cacheKeyOf(nfd)).toBe(k);
    }
    expect(cacheDirOf(a.root, 'render', a.script)).toBe(join(a.root, '.s2v-cache', 'render', ka));
  });
});

describe('render results are the exact set of this run', () => {
  it('drops last run’s thumbnail when this run makes none', () => {
    const { root } = setup();
    const thumb = join(root, 'youtube.ko.thumbnail.png');
    writeFileSync(thumb, 'last run');
    dropThumbnail(thumb);
    expect(existsSync(thumb)).toBe(false);
    dropThumbnail(thumb); // nothing there: fine
    // and main.ts calls it where no thumbnail is written (a source check: rendering is not tested)
    const main = readFileSync(join(REPO, 'packages/cli/src/main.ts'), 'utf8');
    expect(main).toMatch(/else if \(!draft\) dropThumbnail\(out\.replace\(/);
  });

  it('drops last run’s chapters when there are none now', () => {
    const { root } = setup();
    const base = join(root, 'youtube.ko');
    // one scene: no chapters to write
    const script = parseScript(
      `---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#a}\n\nhost: 첫 장면입니다.\n`,
    ).script!;
    const write = () =>
      writePublishFiles(
        script,
        buildTimeline(script, 'youtube', {}, 30).timeline,
        base,
        false,
        () => {},
      );
    writeFileSync(`${base}.chapters.txt`, 'last run');
    const files = write();
    expect(files).not.toContain(`${base}.chapters.txt`);
    expect(existsSync(`${base}.chapters.txt`)).toBe(false);
    expect(existsSync(`${base}.srt`)).toBe(true);
  });
});

describe('paths are put together in paths.ts only', () => {
  it('no other source builds out/ or a per-video cache path', () => {
    const src = join(REPO, 'packages/cli/src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true }))
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith('.ts')) files.push(join(d, e.name));
    };
    walk(src);
    const rules = [
      /'\.s2v-cache',\s*'(render|draft-audio|check)'/,
      /(join|resolve)\(\s*[\w.]+,\s*'out'/,
      /basename\(dirname\(/,
    ];
    const offending = files
      .filter((f) => !f.endsWith('/paths.ts'))
      .flatMap((f) => {
        const text = readFileSync(f, 'utf8');
        return rules.filter((r) => r.test(text)).map((r) => `${f}: ${r}`);
      });
    expect(offending).toEqual([]);
    // each rule finds what it looks for
    const positives = [
      "join(\n  REPO_ROOT,\n  '.s2v-cache',\n  'render',\n  videoId,\n)",
      "join(REPO_ROOT, 'out', videoId)",
      'basename(dirname(path))',
    ];
    rules.forEach((r, i) => expect(r.test(positives[i]!), String(r)).toBe(true));
  });
});

describe('--out-dir on the command line', { timeout: 60_000 }, () => {
  const cli = join(REPO, 'packages/cli/dist/main.js');
  const run = (args: string[]) => {
    try {
      const out = execFileSync('node', [cli, ...args], { cwd: REPO, stdio: 'pipe' });
      return { status: 0, out: out.toString(), err: '' };
    } catch (e) {
      const x = e as { status: number; stderr: Buffer };
      return { status: x.status, out: '', err: x.stderr.toString() };
    }
  };

  it('direct writes its page there and leaves out/ alone', () => {
    const dir = join(realpathSync(mkdtempSync(join(tmpdir(), 's2v-out-'))), 'ko');
    const page = join(REPO, 'out', 'sample-ko', 'direct', 'youtube.ko.html');
    const before = existsSync(page) ? statSync(page).mtimeMs : null;
    const r = run(['direct', 'videos/sample-ko/script.ko.md', '--out-dir', dir, '--no-open']);
    expect(r.status).toBe(0);
    expect(r.out.trim()).toBe(join(dir, 'direct', 'youtube.ko.html'));
    expect(existsSync(join(dir, 'direct', 'youtube.ko.html'))).toBe(true);
    expect(existsSync(page) ? statSync(page).mtimeMs : null).toBe(before);
  });

  it('refuses before anything runs', () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 's2v-out-')));
    writeFileSync(join(tmp, 'file'), '');
    const lock = join(REPO, 'videos', 'sample-ko', 'audio', 'x');
    for (const args of [
      ['takes', 'videos/sample-ko/script.ko.md', '--no-open', '--out-dir', join(tmp, 'file')],
      ['takes', 'videos/sample-ko/script.ko.md', '--list', '--out-dir', join(tmp, 'a')],
      ['direct', 'videos/sample-ko/script.ko.md', '--out-dir', join(tmp, 'file'), '--no-open'],
      ['render', 'videos/sample-ko/script.ko.md', '--frozen-audio', '--out-dir', lock],
      ['snapshot', 'videos/sample-ko/script.ko.md', '--out-dir', join(REPO, '.s2v-cache', 'x')],
    ]) {
      const r = run(args);
      expect(r.status, args.join(' ')).toBe(2);
    }
    expect(existsSync(join(tmp, 'a'))).toBe(false);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(join(REPO, '.s2v-cache', 'x'))).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('snapshot results (final review 10)', () => {
  it('a draft sheet and its frames are named apart from the real ones', () => {
    expect(snapshotPaths('/o', 'youtube', 'ko', false)).toEqual({
      sheet: '/o/youtube.ko.snapshot.png',
      frames: '/o/youtube.ko.frames',
    });
    expect(snapshotPaths('/o', 'youtube', 'ko', true)).toEqual({
      sheet: '/o/youtube.ko.draft.snapshot.png',
      frames: '/o/youtube.ko.draft.frames',
    });
  });

  it('the snapshot command uses them', () => {
    const src = readFileSync(join(REPO, 'packages/cli/src/main.ts'), 'utf8');
    const branch = src.slice(src.indexOf("case 'snapshot': {"));
    const head = branch.slice(0, branch.indexOf('clearSnapshot('));
    expect(head).toContain('snapshotPaths(outDir, outputName, script.meta.lang, draft)');
    expect(head).not.toMatch(/\.snapshot\.png`/);
  });
});
