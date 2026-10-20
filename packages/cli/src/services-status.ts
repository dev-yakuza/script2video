/**
 * `s2v services status [--json]` (S8 plan 3.9): the machine lock, the resident TTS server and who
 * owns each server answering the TTS and aligner ports — a server nobody owns (left by a command
 * that was killed) is reported with how to stop it. It only reads, and removes leftovers of the
 * lock older than a minute whose owner is dead; it never breaks a lock or removes resident.json.
 *
 * Also the image-generation preflight (gen may start: no resident server, nothing on the ports).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { cleanLeftovers, displayText, MUTEX_STALE_MS } from './dir-lock.js';
import {
  BusyError,
  heavyLockPath,
  readHeavy,
  readResident,
  removeResident,
  residentProcessAlive,
  stateDir,
  type BusyReason,
} from './heavy-lock.js';
import { ALIGNER, Service, TTS_SERVER, type ServiceSpec } from './services.js';

/**
 * Image generation may start (S8): no resident TTS server, no server answering the TTS or aligner
 * port (exit 73). Run while holding the gen lock: only then is a dead resident.json removed (by its
 * process only — a server still loading does not answer yet).
 */
export async function genPreflight(repoRoot: string): Promise<void> {
  const resident = readResident();
  if (resident) {
    if (residentProcessAlive(resident))
      throw new BusyError(
        'resident',
        `a resident tts-server is running (pid ${resident.pid}, port ${resident.port}): stop it (Ctrl-C the tts-server start terminal) before generating`,
      );
    removeResident(resident);
  }
  for (const spec of [TTS_SERVER, ALIGNER])
    if (await new Service(spec, repoRoot).health())
      throw new BusyError(
        'orphan',
        `${spec.id} is running on port ${spec.port} and no s2v command owns it: stop it before generating (both need tens of GB); see: s2v services status`,
      );
}

type Busy = { reason: BusyReason } | null;

export interface ServerStatus {
  id: string;
  port: number;
  answering: boolean;
  health: { id: unknown; wrapper_version: unknown; lock_hash: unknown; uptime_s: unknown } | null;
  pid: number | null;
  pgid: number | null;
  owner: 'resident' | 'lock' | 'none' | null;
  stop: string | null;
}

export interface ServicesStatus {
  version: 1;
  state_dir: string;
  busy: { tts: Busy; gen: Busy };
  lock: {
    state: 'held' | 'stale' | 'invalid';
    kind: string | null;
    pid: number | null;
    pid_start: string | null;
    holder: string | null;
    alive: boolean;
  } | null;
  breaking: boolean;
  resident: {
    pid: number;
    pid_start: string;
    port: number;
    server_pgid: number | null;
    alive: boolean;
    healthy: boolean;
  } | null;
  servers: ServerStatus[];
  orphans: number;
  cleaned: string[];
  warnings: string[];
}

const run = (cmd: string, args: string[]): string | null => {
  try {
    return execFileSync(cmd, args, {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch {
    return null;
  }
};

/** The process listening on a local TCP port (lsof), or null. */
function listener(port: number): number | null {
  const out = run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  const m = out ? /^p(\d+)$/m.exec(out) : null;
  return m ? Number(m[1]) : null;
}

const pgidOf = (pid: number): number | null => {
  const n = Number(run('ps', ['-o', 'pgid=', '-p', String(pid)])?.trim());
  return Number.isInteger(n) && n > 0 ? n : null;
};

const commandOf = (pid: number): string => run('ps', ['-o', 'command=', '-p', String(pid)]) ?? '';

/** How to stop a server nobody owns: the group only when its leader is our `uv run … server.py`. */
function stopHint(port: number, pid: number | null, pgid: number | null): string {
  if (pgid !== null && /\buv\b.*\bserver\.py\b/.test(commandOf(pgid))) return `kill -TERM -${pgid}`;
  if (pid !== null) return `kill -TERM ${pid}`;
  return `lsof -nP -iTCP:${port} -sTCP:LISTEN   (find it, then kill it)`;
}

export async function servicesStatus(repoRoot: string): Promise<ServicesStatus> {
  const warnings: string[] = [];
  const lockPath = heavyLockPath();
  const cleaned = existsSync(stateDir()) ? cleanLeftovers(lockPath) : [];
  const l = readHeavy();
  const lockAlive = l?.alive === true;
  let breaking = false;
  try {
    const m = statSync(`${lockPath}.break`).mtimeMs;
    // a breaker takes milliseconds; an older mutex is a dead breaker's, removed by the next lock
    breaking = Math.abs(Date.now() - m) <= MUTEX_STALE_MS;
    if (!breaking)
      warnings.push(
        'a stale breaker mutex (heavy.lock.d.break): the next s2v that locks removes it',
      );
  } catch {
    // none
  }
  const r = readResident();
  const residentAlive = r ? residentProcessAlive(r) : false;
  let residentHealthy = false;
  if (r && residentAlive) {
    const h = await new Service({ ...TTS_SERVER, port: r.port }, repoRoot).health();
    residentHealthy = h?.id === TTS_SERVER.id;
  }
  const servers: ServerStatus[] = [];
  for (const spec of [TTS_SERVER, ALIGNER] as ServiceSpec[]) {
    const h = await new Service(spec, repoRoot).health();
    if (!h) {
      servers.push({
        id: spec.id,
        port: spec.port,
        answering: false,
        health: null,
        pid: null,
        pgid: null,
        owner: null,
        stop: null,
      });
      continue;
    }
    const pid = listener(spec.port);
    const pgid = pid === null ? null : pgidOf(pid);
    const owner: ServerStatus['owner'] =
      r && residentAlive && r.port === spec.port && spec.id === TTS_SERVER.id
        ? 'resident'
        : lockAlive && l?.owner?.kind === 'tts'
          ? 'lock'
          : 'none';
    if (owner === 'none' && lockAlive && l?.owner?.kind === 'gen')
      warnings.push(`${spec.id} is up on port ${spec.port} while image generation holds the lock`);
    if (owner === 'none')
      warnings.push(`${spec.id} on port ${spec.port} has no owner (left by a stopped command?)`);
    servers.push({
      id: spec.id,
      port: spec.port,
      answering: true,
      health: {
        id: h.id,
        wrapper_version: h.wrapper_version,
        lock_hash: h.lock_hash,
        uptime_s: h.uptime_s,
      },
      pid,
      pgid,
      owner,
      stop: owner === 'none' ? stopHint(spec.port, pid, pgid) : null,
    });
  }
  const orphans = servers.filter((s) => s.owner === 'none').length;
  const deadBehindMutex = breaking && !lockAlive && l !== null;
  const tts: Busy = lockAlive
    ? { reason: 'lock' }
    : deadBehindMutex
      ? { reason: 'breaking' }
      : null;
  const gen: Busy =
    tts ??
    (residentAlive
      ? { reason: 'resident' }
      : servers.some((s) => s.answering)
        ? { reason: 'orphan' }
        : null);
  return {
    version: 1,
    state_dir: stateDir(),
    busy: { tts, gen },
    lock: l
      ? {
          state: l.state,
          kind: l.owner ? displayText(l.owner.kind, 20) : null,
          pid: l.owner?.pid ?? null,
          pid_start: l.owner?.pid_start ?? null,
          holder: l.owner ? displayText(l.owner.holder) : null,
          alive: l.alive,
        }
      : null,
    breaking,
    resident: r
      ? {
          pid: r.pid,
          pid_start: r.pid_start,
          port: r.port,
          server_pgid: r.server_pgid ?? null,
          alive: residentAlive,
          healthy: residentHealthy,
        }
      : null,
    servers,
    orphans,
    cleaned,
    warnings,
  };
}

export function printServicesStatus(s: ServicesStatus, out: (m: string) => void): void {
  const l = s.lock;
  out(
    l
      ? l.state === 'held'
        ? `lock: ${l.kind} — ${l.holder} (pid ${l.pid}, since ${l.pid_start} UTC)`
        : l.state === 'stale'
          ? `lock: left by a process that ended (${l.kind} — ${l.holder}, pid ${l.pid}); the next command clears it`
          : 'lock: unreadable (no owner); the next command clears it'
      : 'lock: free',
  );
  if (s.breaking) out('lock: another s2v is clearing a stale lock');
  const r = s.resident;
  if (r)
    out(
      r.alive
        ? `resident: tts-server pid ${r.pid} on ${r.port} (${r.healthy ? 'healthy' : 'not answering'})`
        : `resident: recorded pid ${r.pid} has ended`,
    );
  for (const v of s.servers)
    out(
      !v.answering
        ? `${v.port} ${v.id}: not running`
        : v.owner === 'none'
          ? `${v.port} ${v.id}: NO OWNER (left by a stopped command?) — stop it: ${v.stop}`
          : `${v.port} ${v.id}: ${v.owner}`,
    );
  for (const c of s.cleaned) out(`removed ${c}`);
  for (const w of s.warnings.filter((x) => !x.includes('has no owner'))) out(`warning: ${w}`);
  out(`state: ${s.state_dir}`);
}
