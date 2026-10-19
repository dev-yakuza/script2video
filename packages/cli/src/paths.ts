/**
 * Where a script's results and caches go (S2 plan). Every result and every per-video cache path
 * is put together here, so one rule holds for all commands (a test checks no other file does).
 */
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { UsageError } from './args.js';

/** The results folder: `--out-dir`, or `<s2v>/out/<script folder name>`. */
export function outDirOf(scriptPath: string, repoRoot: string, flag?: string): string {
  if (flag !== undefined) return resolve(flag);
  return join(repoRoot, 'out', basename(dirname(resolve(scriptPath))));
}

/** The real path of `p`, also when its tail does not exist yet (the nearest existing folder's). */
function realPath(p: string, what: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      lstatSync(head);
    } catch {
      const up = dirname(head);
      if (up === head) return p;
      tail.unshift(basename(head));
      head = up;
      continue;
    }
    let dir: boolean;
    try {
      dir = statSync(head).isDirectory(); // follows a link
    } catch {
      throw new UsageError(`${what}: ${head} is a broken link`);
    }
    if (!dir) {
      if (tail.length > 0) throw new UsageError(`${what}: ${head} is not a folder`);
      return p; // the path itself is a file: the caller says so
    }
    return join(realpathSync.native(head), ...tail);
  }
}

/** `child` is `base` or inside it (compared case-blind on macOS, whose disks usually are). */
function within(child: string, base: string): boolean {
  const fold = (s: string) => (process.platform === 'darwin' ? s.toLowerCase() : s);
  const rel = relative(fold(base), fold(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * Check a results folder before anything runs: not a file, not inside the script's audio lock or
 * s2v's cache. It creates nothing: each command makes the folder when it writes there.
 */
export function checkOutDir(dir: string, scriptPath: string, repoRoot: string): string {
  if (dir.trim() === '') throw new UsageError('--out-dir: empty');
  const abs = resolve(dir);
  let exists = false;
  try {
    lstatSync(abs);
    exists = true;
  } catch {
    // not there yet
  }
  if (exists) {
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new UsageError(`--out-dir ${dir}: a broken link`);
    }
    if (!st.isDirectory()) throw new UsageError(`--out-dir ${dir}: not a folder`);
  }
  const real = realPath(abs, `--out-dir ${dir}`);
  // a broken link where the lock or the cache would be is not this command's business
  const base = (p: string) => {
    try {
      return realPath(p, p);
    } catch {
      return p;
    }
  };
  const audio = base(join(dirname(resolve(scriptPath)), 'audio'));
  const cache = base(join(repoRoot, '.s2v-cache'));
  if (within(real, audio))
    throw new UsageError(`--out-dir ${dir}: inside the script's audio lock (${audio})`);
  if (within(real, cache)) throw new UsageError(`--out-dir ${dir}: inside s2v's cache (${cache})`);
  return abs;
}

/**
 * The cache key of a script's folder: its name (to find it by eye) and a hash of its real path
 * (two folders with the same name are two keys). Every language of the folder shares it.
 */
export function cacheKeyOf(scriptPath: string): string {
  const folder = dirname(resolve(scriptPath));
  let real = folder;
  try {
    real = realpathSync.native(folder);
  } catch {
    // not there (tests): the resolved path
  }
  const hash = createHash('sha256').update(real).digest('hex').slice(0, 8);
  // the real folder's name too: a link, other case or other Unicode form is the same key
  return `${basename(real)}-${hash}`;
}

/** `.s2v-cache/<kind>/<key>` for the caches kept per video. */
export function cacheDirOf(
  repoRoot: string,
  kind: 'render' | 'draft-audio' | 'check',
  scriptPath: string,
): string {
  return join(repoRoot, '.s2v-cache', kind, cacheKeyOf(scriptPath));
}
