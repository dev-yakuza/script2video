/**
 * The machine lock (S8, Studio D26): one heavy job at a time on this machine — TTS work (the TTS
 * and alignment servers, voice training) or image generation. `<state>/heavy.lock.d/owner.json`
 * holds `{kind, pid, pid_start, holder, token}` (the format Studio's lock.py shares); `<state>` is
 * S2V_STATE_DIR (absolute) or ~/.s2v. A child given S2V_HEAVY_LOCK_TOKEN of the holder runs under
 * its lock (same kind only).
 *
 * `resident.json` records a TTS server kept running by `s2v tts-server start` (no lock while it
 * runs; the lock is held only while it starts).
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { atomicWrite } from './atomic.js';
import {
  acquireDir,
  cleanLeftovers,
  defaultEnv,
  displayText,
  liveness,
  procStart,
  readOwner,
  releaseDir,
  type LockEnv,
  type LockOwner,
} from './dir-lock.js';
import { ExitError } from './errors.js';
import { onRelease } from './shutdown.js';

export type HeavyKind = 'tts' | 'gen';
export const TOKEN_ENV = 'S2V_HEAVY_LOCK_TOKEN';

/** The machine is busy (lock, a dying breaker, a resident server, an unowned server, …). */
export const EXIT_BUSY = 73;

export type BusyReason = 'lock' | 'breaking' | 'resident' | 'orphan' | 'changed';

export class BusyError extends ExitError {
  constructor(
    readonly reason: BusyReason,
    message: string,
  ) {
    super(`busy (${reason}): ${message}`, EXIT_BUSY);
  }
}

/** S2V_STATE_DIR (absolute only: s2v and the tools must see one place) or ~/.s2v. */
export function stateDir(): string {
  const v = process.env.S2V_STATE_DIR;
  if (v !== undefined && v !== '') {
    if (!isAbsolute(v)) throw new ExitError(`S2V_STATE_DIR must be an absolute path: ${v}`, 2);
    return v;
  }
  return join(homedir(), '.s2v');
}

export const heavyLockPath = () => join(stateDir(), 'heavy.lock.d');
export const residentPath = () => join(stateDir(), 'resident.json');

function ensureStateDir(): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
}

interface Held {
  kind: HeavyKind;
  token: string;
  reentered: boolean;
  unregister: () => void;
}
let held: Held | null = null;
let env: LockEnv = defaultEnv();

/** Tests: another clock / ps / hooks. */
export function setLockEnvForTests(e: Partial<LockEnv>): void {
  env = { ...defaultEnv(), ...e };
}

/** The command line as the lock shows it: `s2v tts /abs/script.md`. */
export function holderOf(argv = process.argv.slice(2)): string {
  const args = argv.map((a) => (!a.startsWith('-') && existsSync(a) ? resolve(a) : a));
  return displayText(['s2v', ...args].join(' '));
}

export function describeOwner(o: LockOwner): string {
  const kind = typeof o.kind === 'string' ? displayText(o.kind, 20) : '?';
  return `${kind} — ${displayText(o.holder)} (pid ${o.pid}, started ${displayText(o.pid_start, 40)} UTC)`;
}

function busyMessage(o: LockOwner | null, cannotCheck: boolean, note?: string): string {
  const who = o ? describeOwner(o) : 'an unreadable lock';
  return (
    `another heavy job holds this machine: ${who}${cannotCheck ? ' (cannot check whether it still runs: ps failed)' : ''}` +
    `${note ? `; ${note}` : ''}\nrun this again when it is done; see: s2v services status`
  );
}

let ownStart: string | null = null;
/** This process's start time (ps, once). */
export function ownProcessStart(): string {
  if (ownStart) return ownStart;
  const s = procStart(process.pid);
  if (!s) throw new Error('cannot read this process start time (ps)');
  return (ownStart = s);
}

/** This process holds the lock (itself or through its parent's token). */
export const heldHere = (): boolean => held !== null;

/**
 * Take the machine lock for `kind` (at once or BusyError, exit 73). A second call in the same
 * process returns. `reentry: false` refuses a parent's token too (tts-server start).
 */
export function acquireHeavy(
  kind: HeavyKind,
  opts: { holder?: string; reentry?: boolean } = {},
): void {
  if (held) {
    if (held.kind !== kind) throw new Error(`internal: holding ${held.kind}, asked for ${kind}`);
    return;
  }
  ensureStateDir();
  const pidStart = ownProcessStart();
  const r = acquireDir(
    heavyLockPath(),
    { kind, pid: process.pid, pid_start: pidStart, holder: opts.holder ?? holderOf() },
    {
      envToken: opts.reentry === false ? undefined : process.env[TOKEN_ENV],
      env: { ...env, warn: (m) => console.error(m) },
    },
  );
  if (r.status === 'breaking')
    throw new BusyError(
      'breaking',
      'another s2v is clearing a stale lock (or died doing it); try again in a minute\nsee: s2v services status',
    );
  if (r.status === 'held') throw new BusyError('lock', busyMessage(r.owner, r.cannotCheck, r.note));
  if (r.status === 'reentered') {
    // a wrapper set up for the other kind: a mistake in how this command was started (exit 2)
    if (r.owner.kind !== kind)
      throw new ExitError(
        `the machine lock passed down in ${TOKEN_ENV} is held as ${displayText(r.owner.kind, 20)}; this command needs a ${kind} lock: start it under one`,
        2,
      );
    held = { kind, token: r.owner.token, reentered: true, unregister: () => {} };
    return;
  }
  const token = r.token;
  process.env[TOKEN_ENV] = token;
  held = { kind, token, reentered: false, unregister: () => {} };
  held.unregister = onRelease(releaseHeavy);
  cleanLeftovers(heavyLockPath(), env);
}

/** Release the lock this process took (a re-entered one stays with its holder). */
export function releaseHeavy(): void {
  const h = held;
  if (!h) return;
  held = null;
  h.unregister();
  if (h.reentered) return;
  if (!releaseDir(heavyLockPath(), h.token))
    console.error('warning: the machine lock was no longer ours when releasing it');
  if (process.env[TOKEN_ENV] === h.token) delete process.env[TOKEN_ENV];
}

export interface LockState {
  state: 'held' | 'stale' | 'invalid';
  owner: LockOwner | null;
  alive: boolean;
}

/** The machine lock as it is now (nothing is changed). */
export function readHeavy(): LockState | null {
  const p = heavyLockPath();
  if (!existsSync(p)) return null;
  const owner = readOwner(p);
  if (!owner) return { state: 'invalid', owner: null, alive: false };
  const alive = liveness(owner, env).alive;
  return { state: alive ? 'held' : 'stale', owner, alive };
}

/** A process alive with this start time (resident.json, actor locks). */
export const processAlive = (pid: number, pidStart: string) =>
  liveness({ pid, pid_start: pidStart, token: '' }, env).alive;

// ---------- resident.json ----------

export interface Resident {
  pid: number;
  pid_start: string;
  port: number;
  server_pgid: number | null;
  id: string;
  wrapper_version: string;
  started: string;
}

export function readResident(): Resident | null {
  try {
    const r = JSON.parse(readFileSync(residentPath(), 'utf8')) as Resident;
    return typeof r.pid === 'number' && typeof r.pid_start === 'string' ? r : null;
  } catch {
    return null;
  }
}

export function writeResident(r: Resident): void {
  ensureStateDir();
  atomicWrite(residentPath(), `${JSON.stringify(r, null, 2)}\n`);
}

/** Remove resident.json when it is this one (by pid and start time). */
export function removeResident(r: Resident): void {
  const cur = readResident();
  if (cur && cur.pid === r.pid && cur.pid_start === r.pid_start)
    rmSync(residentPath(), { force: true });
}

/** Whether its `s2v tts-server start` process still runs (health is checked by the caller). */
export const residentProcessAlive = (r: Resident) => processAlive(r.pid, r.pid_start);

/** Tests: drop what this process holds and the token it set. */
export function resetHeavyForTests(): void {
  if (held && !held.reentered) {
    try {
      releaseDir(heavyLockPath(), held.token);
    } catch {
      // the state folder may be gone
    }
  }
  held = null;
  delete process.env[TOKEN_ENV];
  env = defaultEnv();
}
