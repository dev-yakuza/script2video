/**
 * A character's work lock (S8 plan 3.7): `<dir>/.work/op.lock.d`, the same directory lock as the
 * machine lock. Every command that writes the character's provenance, yaml or sources holds it for
 * the whole command, so a build round and an approve (or two approves) never interleave. Studio's
 * `lock.py actor-op` takes the same lock and passes its token in S2V_ACTOR_LOCK_TOKEN; s2v only
 * reads that variable (its own token stays out of the environment: nothing it starts writes there).
 */

import { join, resolve } from 'node:path';
import {
  acquireDir,
  cleanLeftovers,
  displayText,
  readOwner,
  releaseDir,
  type LockOwner,
} from './dir-lock.js';
import { ExitError } from './errors.js';
import { holderOf, ownProcessStart, processAlive } from './heavy-lock.js';
import { onRelease } from './shutdown.js';
import { ensureGitignore } from './character-gen/state.js';

export const ACTOR_TOKEN_ENV = 'S2V_ACTOR_LOCK_TOKEN';
/** Another command works on this character. */
export const EXIT_ACTOR_BUSY = 74;

export const actorLockPath = (dir: string) => join(dir, '.work', 'op.lock.d');

export class ActorBusyError extends ExitError {
  constructor(message: string) {
    super(`actor busy: ${message}`, EXIT_ACTOR_BUSY);
  }
}

const held = new Map<string, { token: string | null; unregister: () => void }>();

function describe(o: LockOwner | null): string {
  return o
    ? `${displayText(o.cmd)} is working on this character (pid ${o.pid})`
    : 'an unreadable lock is on this character';
}

/** Hold `dir`'s work lock until this process ends (or BusyError 74 at once). */
export function acquireActor(dir: string, cmd = holderOf()): void {
  const key = resolve(dir);
  if (held.has(key)) return;
  const lock = actorLockPath(key);
  const r = acquireDir(
    lock,
    { pid: process.pid, pid_start: ownProcessStart(), cmd },
    { envToken: process.env[ACTOR_TOKEN_ENV] },
  );
  if (r.status === 'breaking')
    throw new ActorBusyError(`another s2v is clearing a stale lock of ${key}; try again`);
  if (r.status === 'held') throw new ActorBusyError(`${describe(r.owner)}: ${key}`);
  if (r.status === 'reentered') {
    held.set(key, { token: null, unregister: () => {} });
    return;
  }
  const entry = { token: r.token, unregister: () => {} };
  held.set(key, entry);
  entry.unregister = onRelease(() => releaseActor(key));
  ensureGitignore(key); // .work/ (and this lock) stay out of git
  cleanLeftovers(lock);
}

/** Take several at once: all or none (the ones taken are released when one is busy). */
export function acquireActors(dirs: string[], cmd = holderOf()): void {
  const taken: string[] = [];
  try {
    for (const d of dirs) {
      const had = held.has(resolve(d));
      acquireActor(d, cmd);
      if (!had) taken.push(d);
    }
  } catch (e) {
    for (const d of taken) releaseActor(d);
    throw e;
  }
}

export function releaseActor(dir: string): void {
  const key = resolve(dir);
  const h = held.get(key);
  if (!h) return;
  held.delete(key);
  h.unregister();
  if (h.token) releaseDir(actorLockPath(key), h.token);
}

/** Who works on `dir` now (a live holder), for the JSON reports; null when nobody. */
export function actorRunning(dir: string): { pid: number; pid_start: string; cmd: string } | null {
  const o = readOwner(actorLockPath(dir));
  if (!o || !processAlive(o.pid, o.pid_start)) return null;
  return { pid: o.pid, pid_start: o.pid_start, cmd: displayText(o.cmd) };
}

/** Tests: release and forget. */
export function resetActorsForTests(): void {
  for (const k of [...held.keys()]) releaseActor(k);
}
