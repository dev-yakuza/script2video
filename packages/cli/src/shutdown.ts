/**
 * How s2v ends (S8 plan 3.3a): the servers this process started go first (their process groups
 * are waited for), then the locks it holds are released — so the next holder never adopts a
 * server that is still going down.
 *
 * - normal end and errors: `await shutdown()` in main, then a natural exit with process.exitCode
 *   (process.exit would cut piped stdout at 64 KB).
 * - signals: one handler per signal. The exit code is 128 + n from the first signal on (130
 *   SIGINT, 143 SIGTERM, 129 SIGHUP), also when the command then ends with an error (a browser or
 *   child that the signal stopped). While runWatched stops its child (watchChild), the handler does
 *   nothing more: the command comes down through main. Otherwise it waits for the groups, releases,
 *   flushes and exits. Other listeners (Remotion's browser) do not count. A second signal kills
 *   at once.
 * - `exit` (a command's own process.exit): synchronous fallback.
 */

import { execFileSync } from 'node:child_process';
import { constants } from 'node:os';

/** Process groups this process started (servers), until they are seen gone. */
const groups = new Set<number>();
/** Stops (SIGTERM) what is still running: registered by services.ts. */
const stoppers = new Set<() => void>();
/** Lock releases (synchronous, idempotent). */
const releasers = new Set<() => void>();

let armed = false;
let signalled = 0;
/** The first signal this process got: it sets the exit code (an error after it does not). */
let signalledWith: NodeJS.Signals | null = null;
/** runWatched children being run: a signal is theirs to stop. */
let watching = 0;
const handlers = new Map<NodeJS.Signals, () => void>();
let onExit: (() => void) | null = null;

export const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
export const signalCode = (sig: NodeJS.Signals) => 128 + (constants.signals[sig] ?? 0);

export function trackGroup(pgid: number): void {
  groups.add(pgid);
  arm();
}

export function forgetGroup(pgid: number): void {
  groups.delete(pgid);
}

/** runWatched runs a child it stops itself on a signal; call the returned function when done. */
export function watchChild(): () => void {
  watching++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watching--;
  };
}

/** A signal arrived: the first one sets the exit code (128 + n), also for runWatched's own handler. */
export function noteSignal(sig: NodeJS.Signals): void {
  if (signalledWith) return;
  signalledWith = sig;
  process.exitCode = signalCode(sig);
}

/** The first signal this process got, if any. */
export const signalledBy = (): NodeJS.Signals | null => signalledWith;

export function onStop(stop: () => void): void {
  stoppers.add(stop);
}

export function onRelease(release: () => void): () => void {
  releasers.add(release);
  arm();
  return () => releasers.delete(release);
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A group is gone: no such group, or (macOS) only zombies left (EPERM). */
function groupGone(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ESRCH' || code === 'EPERM';
  }
}

/**
 * The same without the event loop: a child that exited is not reaped then and stays in its group
 * as a zombie (Linux answers kill(-pgid, 0) for it), so zombies are left out by ps. `ps -A -o`
 * lists every process on macOS and on Linux (procps) alike (E4 runs on both in CI).
 */
function groupGoneSync(pgid: number): boolean {
  if (groupGone(pgid)) return true;
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pgid=,stat='], {
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    return !out
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .some(([g, stat]) => Number(g) === pgid && stat !== undefined && !stat.startsWith('Z'));
  } catch {
    return false;
  }
}

function signalGroups(sig: NodeJS.Signals): void {
  for (const g of groups)
    try {
      process.kill(-g, sig);
    } catch {
      // gone
    }
}

function stopAll(): void {
  for (const s of stoppers) s();
}

function releaseAll(): void {
  for (const r of [...releasers])
    try {
      r();
    } catch {
      // best effort on the way out
    }
}

/** Wait (async) until every tracked group is gone, at most `ms`. */
export async function waitGroups(ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const g of [...groups]) if (groupGone(g)) groups.delete(g);
    if (groups.size === 0 || Date.now() >= deadline) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function waitGroupsSync(ms = 10_000): void {
  const deadline = Date.now() + ms;
  for (;;) {
    for (const g of [...groups]) if (groupGoneSync(g)) groups.delete(g);
    if (groups.size === 0 || Date.now() >= deadline) return;
    sleepSync(100);
  }
}

const nothingToDo = () => groups.size === 0 && releasers.size === 0;

/** Normal end: stop servers, wait for their groups, release locks. A no-op when nothing is held. */
export async function shutdown(): Promise<void> {
  if (nothingToDo()) return;
  stopAll();
  await waitGroups();
  releaseAll();
}

/** Write nothing to a stream and wait until what it holds is out. */
export const flush = (s: NodeJS.WriteStream) =>
  new Promise<void>((resolve) => {
    if (!s.writable) return resolve();
    s.write('', () => resolve());
  });

/**
 * Run the CLI's main: then servers down and locks released, and a natural exit with
 * process.exitCode (a command may have set it). On an error: its message, its code, the same
 * clean-up, flushed output, and an exit within 2 s even when a timer or socket is left behind.
 */
export function runMain(main: () => Promise<void>, codeOf: (e: unknown) => number): void {
  main().then(
    () => shutdown(),
    async (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      // after a signal the command ends as signalled (128 + n), whatever error it came down with
      if (!signalledWith) process.exitCode = codeOf(e);
      await shutdown();
      await Promise.all([flush(process.stdout), flush(process.stderr)]);
      setTimeout(() => process.exit(process.exitCode), 2000).unref();
    },
  );
}

function onSignal(sig: NodeJS.Signals): void {
  signalled++;
  noteSignal(sig);
  if (signalled > 1) {
    signalGroups('SIGKILL');
    releaseAll();
    process.exit(signalCode(sig));
  }
  // runWatched is stopping its child: the command ends through main
  if (watching > 0) return;
  void (async () => {
    if (groups.size) console.error('stopping servers …');
    stopAll();
    await waitGroups();
    releaseAll();
    await flush(process.stdout);
    process.exit(signalCode(sig));
  })();
}

export function arm(): void {
  if (armed) return;
  armed = true;
  for (const sig of SIGNALS) {
    const h = () => onSignal(sig);
    handlers.set(sig, h);
    process.on(sig, h);
  }
  onExit = () => {
    if (nothingToDo()) return;
    stopAll();
    signalGroups('SIGTERM');
    waitGroupsSync();
    releaseAll();
  };
  process.on('exit', onExit);
}

/** Tests: forget everything and take the handlers off. */
export function resetShutdownForTests(): void {
  for (const [sig, h] of handlers) process.off(sig, h);
  handlers.clear();
  if (onExit) process.off('exit', onExit);
  onExit = null;
  armed = false;
  signalled = 0;
  // a signal emitted in a test set the exit code of the test process: take it back
  if (signalledWith && process.exitCode === signalCode(signalledWith)) process.exitCode = undefined;
  signalledWith = null;
  watching = 0;
  groups.clear();
  stoppers.clear();
  releasers.clear();
}
