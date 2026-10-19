/** `s2v --version` (S3 plan 2): the code hash, the build stamps and the command line. */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILT_PACKAGES, codeFiles, stalePackages, treeHash } from '../src/version.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const STAMP = pathToFileURL(join(REPO, 'scripts', 'build-stamp.mjs')).href;

/** A tiny repository: what the code hash takes, and what it leaves out. */
function fixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 's2v-version-')));
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put('package.json', '{}');
  put('yarn.lock', 'lock');
  for (const pkg of BUILT_PACKAGES) {
    put(`packages/${pkg}/package.json`, `{"name":"${pkg}","version":"0.2.0"}`);
    put(`packages/${pkg}/tsconfig.build.json`, '{}');
    put(`packages/${pkg}/src/index.ts`, `export const name = '${pkg}';`);
    put(`packages/${pkg}/src/index.test.ts`, 'test');
    put(`packages/${pkg}/dist/index.js`, 'built');
    put(`packages/${pkg}/node_modules/x/index.js`, 'dep');
  }
  put('tts-server/server.py', 'print(1)');
  put('tts-server/test_server.py', 'test');
  put('tts-server/__pycache__/server.cpython-312.pyc', 'pyc');
  put('tts-server/.pytest_cache/v', 'cache');
  put('docs/notes.md', 'not code');
  return root;
}

const code = (root: string) => treeHash(root, codeFiles(root));

/** Stamp every package the way scripts/build-stamp.mjs does (without tsc). */
async function stampAll(root: string) {
  const { treeHashOf } = (await import(STAMP)) as {
    treeHashOf: (root: string, files: string[]) => string;
  };
  for (const pkg of BUILT_PACKAGES) {
    const files = [`packages/${pkg}/package.json`, `packages/${pkg}/src/index.ts`];
    writeFileSync(
      join(root, 'packages', pkg, 'dist', 'build-info.json'),
      JSON.stringify({ files, inputs: treeHashOf(root, files) }),
    );
  }
}

describe('code hash', () => {
  it('changes with the code and not with tests, builds, caches or docs', () => {
    const root = fixture();
    const before = code(root);
    expect(code(root)).toBe(before);
    expect(codeFiles(root)).not.toContain('docs/notes.md');
    for (const ignored of [
      'packages/core/src/index.test.ts',
      'packages/core/dist/index.js',
      'packages/core/node_modules/x/index.js',
      'tts-server/test_server.py',
      'tts-server/__pycache__/server.cpython-312.pyc',
      'tts-server/.pytest_cache/v',
      'docs/notes.md',
    ]) {
      writeFileSync(join(root, ignored), 'changed');
      expect(code(root), ignored).toBe(before);
    }
    writeFileSync(join(root, 'tts-server/server.py'), 'print(2)');
    expect(code(root)).not.toBe(before);
  });

  it('works without the Python folders (as in the Docker image)', () => {
    const root = fixture();
    execFileSync('rm', ['-rf', join(root, 'tts-server')]);
    expect(code(root)).toMatch(/^[0-9a-f]{12}$/);
  });

  it('tells a symlink from a file with the same text, and ignores Unicode normalization', () => {
    const a = fixture();
    const b = fixture();
    writeFileSync(join(a, 'tts-server/target.py'), 'x');
    writeFileSync(join(b, 'tts-server/target.py'), 'x');
    // the same bytes as the link's target: only the kind of entry tells them apart
    writeFileSync(join(a, 'tts-server/link.py'), 'x');
    symlinkSync('target.py', join(b, 'tts-server/link.py'));
    expect(code(a)).not.toBe(code(b));
    // a name stored decomposed is opened as stored and hashed as NFC (this proves the opening on
    // Linux only: APFS opens a file under either form)
    const nfdName = 'tts-server/한글.py'.normalize('NFD');
    const nfcName = 'tts-server/한글.py'.normalize('NFC');
    expect(nfdName).not.toBe(nfcName);
    const c = fixture();
    const d = fixture();
    writeFileSync(join(c, nfdName), 'k');
    writeFileSync(join(d, nfcName), 'k');
    expect(treeHash(c, [nfdName])).toBe(treeHash(d, [nfcName]));
    expect(code(c)).toBe(code(d));
  });

  it('hashes like scripts/build-stamp.mjs', async () => {
    const root = fixture();
    symlinkSync('server.py', join(root, 'tts-server/alias.py'));
    writeFileSync(join(root, 'tts-server', 'é.py'.normalize('NFD')), 'nfd');
    const { treeHashOf } = (await import(STAMP)) as {
      treeHashOf: (root: string, files: string[]) => string;
    };
    const files = codeFiles(root);
    expect(files).toContain('tts-server/alias.py');
    expect(treeHashOf(root, files)).toBe(treeHash(root, files));
  });
});

describe('build stamps', { timeout: 60_000 }, () => {
  it('a package is stale when its own inputs changed, not when Python did', async () => {
    const root = fixture();
    expect(stalePackages(root)).toEqual([...BUILT_PACKAGES]); // no stamps yet
    await stampAll(root);
    expect(stalePackages(root)).toEqual([]);
    writeFileSync(join(root, 'tts-server/server.py'), 'print(3)');
    expect(stalePackages(root)).toEqual([]);
    writeFileSync(join(root, 'packages/core/src/index.ts'), 'export const name = 1;');
    expect(stalePackages(root)).toEqual(['core']);
  });

  it('a stamp naming a file that is gone is stale', async () => {
    const root = fixture();
    await stampAll(root);
    execFileSync('rm', [join(root, 'packages/cli/src/index.ts')]);
    expect(stalePackages(root)).toEqual(['cli']);
  });

  it('stamps what tsc reads: own sources, sibling type declarations, configs', async () => {
    const { inputsOf } = (await import(STAMP)) as { inputsOf: (dir: string) => string[] };
    const files = inputsOf(join(REPO, 'packages', 'renderer-remotion'));
    expect(files).toContain('packages/renderer-remotion/src/index.ts');
    // type-only import from the folder Remotion bundles at run time
    expect(files).toContain('packages/renderer-remotion/src/remotion/types.ts');
    expect(files).toContain('packages/core/dist/index.d.ts');
    expect(files).toContain('tsconfig.base.json');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files).not.toContain('packages/renderer-remotion/tsconfig.remotion.json');
  });

  it('refuses a package whose sources tsc does not read', async () => {
    const { inputsOf } = (await import(STAMP)) as {
      inputsOf: (dir: string, root: string) => string[];
    };
    const root = realpathSync(mkdtempSync(join(tmpdir(), 's2v-stamp-')));
    const pkg = join(root, 'packages', 'x');
    mkdirSync(join(pkg, 'lib'), { recursive: true });
    writeFileSync(join(pkg, 'lib', 'a.ts'), 'export const a = 1;');
    writeFileSync(
      join(pkg, 'tsconfig.build.json'),
      JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: ['lib'] }),
    );
    expect(() => inputsOf(pkg, root)).toThrow(/no source files of packages\/x/);
  });
});

describe('s2v --version', { timeout: 60_000 }, () => {
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

  it('prints the id to pin and what it is made of', () => {
    const r = run(['--version', '--json']);
    expect(r.status).toBe(0);
    const v = JSON.parse(r.out) as Record<string, unknown>;
    expect(v.id).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
    expect(v.id).toBe(`${v.version}+${v.code}`);
    // whether this checkout's dist is current is not the test's business
    expect(typeof v.stale_build).toBe('boolean');
    expect(Array.isArray(v.stale_packages)).toBe(true);
    expect(v.commit === null || /^[0-9a-f]{40}$/.test(v.commit as string)).toBe(true);
    expect(run(['--version']).out).toMatch(/^s2v \d+\.\d+\.\d+\+[0-9a-f]{12}/);
  });

  it('takes only --json', () => {
    expect(run(['--version', '--output', 'x']).status).toBe(2);
    expect(run(['--version', 'foo']).status).toBe(2);
    expect(run(['render', 'videos/sample-ko/script.ko.md', '--version']).status).toBe(2);
  });

  it('all packages carry the same version', () => {
    const versions = [
      'package.json',
      ...BUILT_PACKAGES.map((p) => `packages/${p}/package.json`),
    ].map((f) => (JSON.parse(readFileSync(join(REPO, f), 'utf8')) as { version: string }).version);
    expect(new Set(versions).size).toBe(1);
  });
});
