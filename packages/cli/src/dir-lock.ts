/**
 * A lock that is a directory (S8 plan 3.3), shared by the machine lock (~/.s2v/heavy.lock.d) and
 * a character's work lock (<dir>/.work/op.lock.d), and by Studio's lock.py (same algorithm):
 *
 * - take: write owner.json inside a private `<lock>.new.<rand>/`, then rename it onto `<lock>`.
 *   The rename fails (ENOTEMPTY / EEXIST) while someone holds it, so `<lock>` only ever appears
 *   with its owner inside. A rename onto an EMPTY directory succeeds: never mix this with an
 *   implementation that takes the lock with mkdir and writes its owner afterwards.
 * - a dead owner (pid + process start time) is broken only under `<lock>.break` (mkdir mutex):
 *   the owner is read again there and the lock moved away only when its token is unchanged.
 * - release: only by the token's holder (rename away, then delete).
 *
 * Everything is synchronous: two ensure() calls of one process must not interleave.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export interface LockOwner {
  pid: number;
  pid_start: string;
  token: string;
  [key: string]: unknown;
}

/** `ps` could not run: a holder is then taken as alive. */
export class CannotCheck extends Error {}

/**
 * The start time of a process as `LC_ALL=C TZ=UTC ps -o lstart= -p <pid>` prints it (both ends
 * trimmed only: a one-digit day keeps its double space), or null when there is no such process.
 */
export function procStart(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    return out === '' ? null : out;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { status?: number | null };
    // ps ran and found nothing (exit 1); anything else means ps itself could not run
    if (typeof err.status === 'number') return null;
    throw new CannotCheck(`cannot check process ${pid} (ps: ${err.code ?? err.message})`);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Mon Oct  5 20:06:47 2026` read as UTC (ms), or null. */
export function parseLstart(s: string): number | null {
  const m = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(s);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]!);
  if (month < 0) return null;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/**
 * Two start times of one process. Linux computes lstart from the boot time, which moves by a
 * second when the clock is adjusted: within 2 s is the same there. Elsewhere the exact string.
 */
export function sameStart(a: string, b: string, platform: string = process.platform): boolean {
  if (a === b) return true;
  if (platform !== 'linux') return false;
  const x = parseLstart(a);
  const y = parseLstart(b);
  return x !== null && y !== null && Math.abs(x - y) <= 2000;
}

export interface LockEnv {
  procStart: (pid: number) => string | null;
  platform: string;
  now: () => number;
  /** Test hooks at the points where other processes may act. */
  hooks?: {
    beforeOwnerRead?: () => void;
    inMutex?: () => void;
    beforeRename?: () => void;
    afterBreakRename?: (stale: string) => void;
  };
  warn?: (m: string) => void;
}

export const defaultEnv = (): LockEnv => ({
  procStart,
  platform: process.platform,
  now: Date.now,
});

export interface Liveness {
  alive: boolean;
  /** `ps` could not run: taken as alive. */
  cannotCheck: boolean;
}

export function liveness(owner: LockOwner, env: LockEnv): Liveness {
  try {
    const start = env.procStart(owner.pid);
    return {
      alive: start !== null && sameStart(start, owner.pid_start, env.platform),
      cannotCheck: false,
    };
  } catch (e) {
    if (e instanceof CannotCheck) return { alive: true, cannotCheck: true };
    throw e;
  }
}

/** owner.json of a lock directory, or null when missing or not an owner. */
export function readOwner(dir: string): LockOwner | null {
  try {
    const o = JSON.parse(readFileSync(join(dir, 'owner.json'), 'utf8')) as unknown;
    if (!o || typeof o !== 'object') return null;
    const r = o as Record<string, unknown>;
    if (typeof r.pid !== 'number' || typeof r.pid_start !== 'string' || typeof r.token !== 'string')
      return null;
    return r as LockOwner;
  } catch {
    return null;
  }
}

const rand = () => randomBytes(4).toString('hex');
const tokenOf = (o: LockOwner | null) => o?.token ?? null;
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const inodeOf = (p: string): number | null => {
  try {
    return statSync(p).ino;
  } catch {
    return null;
  }
};

export const MUTEX_STALE_MS = 30_000;
const BREAKING_TRIES = 5;
/** Looks (10 ms apart) at a lock without a readable owner before breaking it. */
const UNREADABLE_TRIES = 5;
const TRIES = 50;

export type AcquireResult =
  | { status: 'acquired'; token: string }
  | { status: 'reentered'; owner: LockOwner }
  | { status: 'held'; owner: LockOwner | null; cannotCheck: boolean; note?: string }
  | { status: 'breaking' };

/**
 * Take `lock` for `fields` (written with a new token), or say why not. `envToken`: the token a
 * parent passed down — a lock holding it is already ours (re-entry).
 */
export function acquireDir(
  lock: string,
  fields: Record<string, unknown>,
  opts: { envToken?: string | undefined; env?: LockEnv } = {},
): AcquireResult {
  const env = opts.env ?? defaultEnv();
  const token = randomBytes(16).toString('hex');
  const body = `${JSON.stringify({ ...fields, token })}\n`;
  mkdirSync(dirname(lock), { recursive: true });
  // one ps per owner in this call (each is a process start, slow on a busy machine)
  const seen = new Map<string, Liveness>();
  const live = (o: LockOwner) => {
    const key = `${o.pid}\0${o.pid_start}\0${o.token}`;
    let l = seen.get(key);
    if (!l) seen.set(key, (l = liveness(o, env)));
    return l;
  };
  let breaking = 0;
  let unreadable = 0;
  for (let i = 0; i < TRIES; i++) {
    const priv = `${lock}.new.${rand()}`;
    mkdirSync(priv);
    try {
      writeFileSync(join(priv, 'owner.json'), body);
      renameSync(priv, lock);
      return { status: 'acquired', token };
    } catch (e) {
      rmSync(priv, { recursive: true, force: true });
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw e;
    }
    // the lock as judged: its folder (inode) and its owner. A released lock is renamed away and a
    // new one is another folder, so the pair names this lock and no later one.
    const ino = inodeOf(lock);
    if (ino === null) continue; // released meanwhile
    env.hooks?.beforeOwnerRead?.();
    const cur = readOwner(lock);
    if (cur) unreadable = 0;
    else if (++unreadable <= UNREADABLE_TRIES) {
      // a lock is published with its owner inside: none is a lock going away (or another
      // program's broken one) — look again before breaking it
      sleep(10);
      continue;
    }
    if (cur && opts.envToken && cur.token === opts.envToken)
      return { status: 'reentered', owner: cur };
    if (cur) {
      const l = live(cur);
      if (l.alive) return { status: 'held', owner: cur, cannotCheck: l.cannotCheck };
    }
    // dead, or no readable owner: break it, under the mutex only
    const mutex = `${lock}.break`;
    try {
      mkdirSync(mutex);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try {
        // a breaker takes milliseconds: one older than 30 s (or from the future) died
        if (Math.abs(env.now() - statSync(mutex).mtimeMs) > MUTEX_STALE_MS) {
          rmdirSync(mutex);
          continue;
        }
      } catch {
        continue; // gone meanwhile
      }
      if (++breaking > BREAKING_TRIES) return { status: 'breaking' };
      sleep(10);
      continue;
    }
    try {
      env.hooks?.inMutex?.();
      // only its holder releases a lock, and a dead one cannot: the same folder with the same
      // owner is the judged lock (a lock published meanwhile is another folder)
      // (stat, owner, stat again: the owner read is of that folder)
      if (inodeOf(lock) !== ino) continue;
      if (tokenOf(readOwner(lock)) !== tokenOf(cur)) continue;
      if (inodeOf(lock) !== ino) continue;
      env.hooks?.beforeRename?.();
      const stale = `${lock}.stale.${rand()}`;
      try {
        renameSync(lock, stale);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        continue;
      }
      env.hooks?.afterBreakRename?.(stale);
      const moved = readOwner(stale);
      if (inodeOf(stale) === ino && tokenOf(moved) === tokenOf(cur)) {
        rmSync(stale, { recursive: true, force: true });
        continue;
      }
      // another lock took its place between the check and the rename (an unreadable lock that
      // went away, another program's lock): put it back
      let back = false;
      try {
        renameSync(stale, lock);
        back = true;
      } catch {
        // the lock was taken again meanwhile
      }
      const note = back
        ? `moved a lock that was not the judged one; put it back`
        : `moved a lock that was not the judged one; it is left at ${stale}`;
      env.warn?.(`warning: ${note}`);
      return { status: 'held', owner: moved, cannotCheck: false, note };
    } finally {
      try {
        rmdirSync(mutex);
      } catch {
        // removed as stale by another process
      }
    }
  }
  return { status: 'held', owner: readOwner(lock), cannotCheck: false, note: 'contended' };
}

/** Release `lock` when `token` holds it; false when it is not ours (any more). */
export function releaseDir(lock: string, token: string): boolean {
  if (tokenOf(readOwner(lock)) !== token) return false;
  const gone = `${lock}.gone.${rand()}`;
  try {
    renameSync(lock, gone);
  } catch {
    return false;
  }
  rmSync(gone, { recursive: true, force: true });
  return true;
}

export const LEFTOVER_MS = 60_000;

/**
 * Leftovers of `lock` (`.new.*`, `.stale.*`, `.gone.*`) older than 60 s whose owner is dead or
 * missing: removed; their names are returned.
 */
export function cleanLeftovers(lock: string, env: LockEnv = defaultEnv()): string[] {
  const dir = dirname(lock);
  const base = basename(lock);
  const out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\.(new|stale|gone)\.[0-9a-f]+$/.test(name.slice(base.length)) || !name.startsWith(base))
      continue;
    const p = join(dir, name);
    try {
      if (env.now() - statSync(p).mtimeMs <= LEFTOVER_MS) continue;
      const o = readOwner(p);
      if (o && liveness(o, env).alive) continue;
      rmSync(p, { recursive: true, force: true });
      out.push(name);
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

/** Strip control characters and cap the length: holder strings come from other programs. */
export const displayText = (s: unknown, max = 200): string => {
  // eslint-disable-next-line no-control-regex
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
