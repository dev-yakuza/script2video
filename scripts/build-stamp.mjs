#!/usr/bin/env node
/**
 * Build stamp (S3 plan 2.2). Run by each package's build after tsc, in the package directory:
 * writes dist/build-info.json with the files tsc read (inside the repository, outside
 * node_modules) and their hash. `s2v --version` hashes the same files again: when they differ,
 * that package's dist is older than its source (stale_build).
 *
 * Plain JavaScript so that it runs before any package is built. packages/cli/src/version.ts
 * hashes with the same rules (a test compares the two).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO_ROOT = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..'));

/** Hash of files (repository-relative POSIX paths): content for files, target for symlinks. */
export function treeHashOf(root, files) {
  // hashed under the NFC name, opened under the name on disk (Linux keeps NFD names apart)
  const sorted = files
    .map((path) => ({ path, key: path.normalize('NFC') }))
    .sort(
      (a, b) =>
        Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)) ||
        Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    );
  const h = createHash('sha256');
  for (const { path, key } of sorted) {
    const abs = join(root, path);
    if (lstatSync(abs).isSymbolicLink()) h.update(`l\0${key}\0${readlinkSync(abs)}\n`);
    else h.update(`f\0${key}\0${createHash('sha256').update(readFileSync(abs)).digest('hex')}\n`);
  }
  return h.digest('hex').slice(0, 12);
}

/** The files tsc reads for this package, and the configs that steer it. */
export function inputsOf(pkgDir, root = REPO_ROOT) {
  const dir = realpathSync(pkgDir);
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--listFilesOnly'], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (r.status !== 0)
    throw new Error(`tsc --listFilesOnly failed in ${dir}:\n${r.stdout}${r.stderr}`);
  const listed = r.stdout.split('\n').filter((l) => l.trim() !== '');
  const configs = ['package.json', 'tsconfig.build.json', 'tsconfig.json']
    .map((f) => join(dir, f))
    .concat(join(root, 'tsconfig.base.json'))
    .filter((f) => existsSync(f));
  const files = new Set();
  for (const f of [...listed, ...configs]) {
    const rel = relative(root, realpathSync(f)).split(sep).join('/');
    if (rel.startsWith('../') || rel.split('/').includes('node_modules')) continue;
    files.add(rel);
  }
  const own = relative(root, dir).split(sep).join('/');
  if (![...files].some((f) => f.startsWith(`${own}/src/`)))
    throw new Error(`build-stamp: no source files of ${own} among tsc's inputs`);
  return [...files].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const files = inputsOf(process.cwd());
    const out = join(process.cwd(), 'dist', 'build-info.json');
    writeFileSync(
      out,
      `${JSON.stringify({ files, inputs: treeHashOf(REPO_ROOT, files) }, null, 2)}\n`,
    );
    console.error(`${basename(process.cwd())}: stamped ${files.length} inputs`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
