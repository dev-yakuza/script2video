/**
 * `s2v --version` (S3 plan 2). The version a tool pins is `id` = semver + `code`, a hash of the
 * code and fixed data s2v runs (read from the files, not from git: uncommitted and unbuilt
 * changes count, and a copy without git hashes the same). `stale_build` says a package's dist is
 * older than its source (its build stamp, scripts/build-stamp.mjs, no longer matches).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './args.js';

/** Packages whose dist is built by tsc and stamped. */
export const BUILT_PACKAGES = ['core', 'renderer-remotion', 'cli'] as const;

/** Root files in the code hash. */
const ROOT_FILES = [
  'package.json',
  'tsconfig.base.json',
  'yarn.lock',
  'models.lock.json',
  'imagegen.lock.json',
  'fonts.lock.json',
];
/** Folders hashed whole (Python runs from source). */
const ROOT_DIRS = ['tts-server', 'imagegen', 'aligner'];
const SKIP_NAMES = new Set([
  'node_modules',
  'dist',
  '.venv',
  '__pycache__',
  '.ruff_cache',
  '.pytest_cache',
  '.mypy_cache',
  '.DS_Store',
  'test',
  'tests',
]);

/** Tests and editor or interpreter leftovers do not change what s2v does. */
function skipped(name: string): boolean {
  return (
    SKIP_NAMES.has(name) ||
    name.endsWith('~') ||
    name.endsWith('.swp') ||
    name.endsWith('.pyc') ||
    name.endsWith('.test.ts') ||
    (name.startsWith('test_') && name.endsWith('.py'))
  );
}

/** Repository-relative paths under `rel` (a folder), symlinks not followed. */
function walk(root: string, rel: string, out: string[]): void {
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    if (skipped(e.name)) continue;
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(root, p, out);
    else if (e.isFile() || e.isSymbolicLink()) out.push(p);
  }
}

/** The files in the code hash (S3 plan 2.1). */
export function codeFiles(root: string): string[] {
  const out = ROOT_FILES.filter((f) => existsSync(join(root, f)));
  const pkgs = join(root, 'packages');
  for (const pkg of existsSync(pkgs) ? readdirSync(pkgs).sort() : []) {
    const dir = join(pkgs, pkg);
    if (!lstatSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir))
      if (f === 'package.json' || /^tsconfig.*\.json$/.test(f)) out.push(`packages/${pkg}/${f}`);
    walk(root, `packages/${pkg}/src`, out);
  }
  for (const d of ROOT_DIRS) walk(root, d, out);
  return out;
}

/** Same rules as treeHashOf in scripts/build-stamp.mjs. */
export function treeHash(root: string, files: string[]): string {
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

/** Packages whose dist no longer matches their source (or has no stamp). */
export function stalePackages(root: string): string[] {
  return BUILT_PACKAGES.filter((pkg) => {
    const stamp = join(root, 'packages', pkg, 'dist', 'build-info.json');
    try {
      const { files, inputs } = JSON.parse(readFileSync(stamp, 'utf8')) as {
        files: string[];
        inputs: string;
      };
      return treeHash(root, files) !== inputs;
    } catch {
      return true; // no stamp, or a file it names is gone
    }
  });
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/** Only s2v's own checkout: a copy without .git inside another repository is not that one. */
function ownGit(root: string): boolean {
  // no path comparison: on macOS the case of a path may differ from the disk's
  return git(root, ['rev-parse', '--show-prefix']) === '';
}

export interface VersionInfo {
  version: string;
  code: string;
  /** What a tool pins and compares. */
  id: string;
  /** For information (and for going back to it): null without git. */
  commit: string | null;
  dirty: boolean | null;
  stale_build: boolean;
  stale_packages: string[];
}

const known = new Map<string, VersionInfo>();

/**
 * Once per process: a command is a short process on one checkout, and inspect is called many
 * times in tests. A long-running process that imports this would keep the first answer.
 * `git: false` leaves out commit and dirty (inspect needs only the id).
 */
export function versionInfo(repoRoot: string, opts: { git?: boolean } = {}): VersionInfo {
  const root = realpathSync(repoRoot);
  const memo = `${root}\0${opts.git !== false}`;
  const seen = known.get(memo);
  if (seen) return seen;
  const info = computeVersion(root, opts);
  known.set(memo, info);
  return info;
}

function computeVersion(root: string, opts: { git?: boolean }): VersionInfo {
  const version = (
    JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const code = treeHash(root, codeFiles(root));
  const commit = opts.git === false || !ownGit(root) ? null : git(root, ['rev-parse', 'HEAD']);
  const status = commit === null ? null : git(root, ['status', '--porcelain']);
  const stale = stalePackages(root);
  return {
    version,
    code,
    id: `${version}+${code}`,
    commit,
    dirty: status === null ? null : status !== '',
    stale_build: stale.length > 0,
    stale_packages: stale,
  };
}

/** `s2v --version [--json]`. */
export function printVersion(repoRoot: string, args: string[]): void {
  if (args.some((a) => a !== '--json')) throw new UsageError('s2v --version: takes only --json');
  const v = versionInfo(repoRoot);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(v)}\n`);
  else {
    const git = v.commit ? ` (commit ${v.commit.slice(0, 7)}${v.dirty ? ', dirty' : ''})` : '';
    console.log(`s2v ${v.id}${git}`);
  }
  if (v.stale_build)
    console.error(
      `warning: a package's dist is older than its source (${v.stale_packages.join(', ')}); run yarn build`,
    );
}
