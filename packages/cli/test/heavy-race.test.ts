/**
 * S8: the lock across processes (R1–R6). Drivers import the built dir-lock.js; they start
 * together after a barrier file. Time budgets count `ps` at ~0.2 s a call on macOS.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { acquireDir, procStart, readOwner, releaseDir } from '../src/dir-lock.js';
import { deadPid, dist, driver, killChildren, tmp, writeOwner } from './lock-helpers.js';

afterAll(killChildren);

const DRIVER = driver(`
import { acquireDir, defaultEnv, procStart, readOwner, releaseDir } from ${JSON.stringify(dist('dir-lock.js'))};
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
const [lock, barrier, log, loops, hold, mode, n] = process.argv.slice(2);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const start = procStart(process.pid);
const env = mode === 'slow-break'
  ? { ...defaultEnv(), hooks: { inMutex: () => { appendFileSync(log, 'inmutex ' + process.pid + '\\n'); sleep(400); } } }
  : undefined;
appendFileSync(log, 'ready ' + process.pid + '\\n');
while (!existsSync(barrier)) sleep(2);
const deadline = Date.now() + 60000;
for (let k = 0; k < Number(loops); k++) {
  let r;
  for (;;) {
    r = acquireDir(lock, { kind: 'tts', pid: process.pid, pid_start: start, holder: 'race' }, { env, envToken: process.env.RACE_TOKEN });
    if (Number(loops) === 1 || r.status === 'acquired' || Date.now() > deadline) break;
    sleep(25); // each try runs ps: do not burn the machine other tests run on
  }
  if (r.status === 'acquired') {
    appendFileSync(log, 'enter ' + process.pid + '\\n');
    if (mode === 'hold-all') {
      const end = Date.now() + 30000;
      while (Date.now() < end) {
        const c = readFileSync(log, 'utf8').split('\\n').filter((l) => l.startsWith('result ')).length;
        if (c >= Number(n) - 1) break;
        sleep(20);
      }
    } else sleep(Number(hold));
    appendFileSync(log, 'exit ' + process.pid + ' stillmine=' + (readOwner(lock)?.token === r.token) + '\\n');
    releaseDir(lock, r.token);
  }
  appendFileSync(log, 'result ' + process.pid + ' ' + r.status + '\\n');
}
`);

interface Run {
  log: string[];
  results: string[];
}

/** Start `n` drivers on `lock`, release them together, wait for all. */
async function race(
  lock: string,
  n: number,
  opts: { loops?: number; hold?: number; mode?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  const dir = tmp('race');
  const barrier = join(dir, 'barrier');
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const procs = Array.from({ length: n }, () =>
    spawn(
      process.execPath,
      [
        DRIVER,
        lock,
        barrier,
        log,
        String(opts.loops ?? 1),
        String(opts.hold ?? 0),
        opts.mode ?? 'hold-all',
        String(n),
      ],
      { stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, ...opts.env } },
    ),
  );
  const done = Promise.all(procs.map((p) => new Promise((r) => p.on('exit', r))));
  const ready = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('ready')).length;
  while (ready() < n) await new Promise((r) => setTimeout(r, 20));
  writeFileSync(barrier, '');
  await done;
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return {
    log: lines,
    results: lines.filter((l) => l.startsWith('result ')).map((l) => l.split(' ')[2]!),
  };
}

const count = (xs: string[], x: string) => xs.filter((y) => y === x).length;

/** enter/exit pairs never interleave. */
function overlaps(log: string[]): number {
  let cur: string | null = null;
  let bad = 0;
  for (const l of log) {
    const [w, pid] = l.split(' ');
    if (w === 'enter') {
      if (cur !== null) bad++;
      cur = pid!;
    } else if (w === 'exit') {
      if (cur !== pid) bad++;
      cur = null;
    }
  }
  return bad;
}

const deadOwner = (lock: string) =>
  writeOwner(lock, {
    kind: 'tts',
    pid: deadPid(),
    pid_start: 'Mon Oct 19 00:00:00 2026',
    holder: 'dead',
    token: 'deadbeef',
  });

describe('the lock across processes', { timeout: 240_000 }, () => {
  it('R1 8 at once on a free lock: one holds it while every other returns', async () => {
    for (let rep = 0; rep < 1; rep++) {
      const lock = join(tmp('r1'), 'heavy.lock.d');
      const r = await race(lock, 8);
      expect(count(r.results, 'acquired')).toBe(1);
      expect(
        count(r.results, 'acquired') + count(r.results, 'held') + count(r.results, 'breaking'),
      ).toBe(8);
      expect(r.log.filter((l) => l.includes('stillmine=false'))).toEqual([]);
      expect(existsSync(lock)).toBe(false);
    }
  });

  it('R2 8 at once on a dead holder: one holds it while every other returns (v1 let 6–8 in)', async () => {
    for (let rep = 0; rep < 2; rep++) {
      const lock = join(tmp('r2'), 'heavy.lock.d');
      deadOwner(lock);
      const r = await race(lock, 8);
      expect(count(r.results, 'acquired')).toBe(1);
      expect(r.log.filter((l) => l.includes('stillmine=false'))).toEqual([]);
    }
  });

  it('R3 4 × 12 take-and-release from a dead holder: never two inside', async () => {
    for (let rep = 0; rep < 2; rep++) {
      const lock = join(tmp('r3'), 'heavy.lock.d');
      deadOwner(lock);
      const r = await race(lock, 4, { loops: 12, hold: 5, mode: 'hold' });
      expect(count(r.results, 'acquired')).toBe(48);
      expect(overlaps(r.log)).toBe(0);
      expect(r.log.filter((l) => l.includes('stillmine=false'))).toEqual([]);
    }
  });

  it('R4 while one breaks a dead lock, the others say "breaking" or "held" (or take it after); never two inside', async () => {
    const lock = join(tmp('r4'), 'heavy.lock.d');
    deadOwner(lock);
    const dir = tmp('r4log');
    const barrier = join(dir, 'barrier');
    const log = join(dir, 'log');
    writeFileSync(barrier, '');
    writeFileSync(log, '');
    // A holds 3 s after breaking: B and C come while it breaks or holds
    const start = (mode: string, hold: string) =>
      new Promise((r) =>
        spawn(process.execPath, [DRIVER, lock, barrier, log, '1', hold, mode, '3'], {
          stdio: 'ignore',
        }).on('exit', r),
      );
    const a = start('slow-break', '3000');
    while (!readFileSync(log, 'utf8').includes('inmutex'))
      await new Promise((r) => setTimeout(r, 5));
    await Promise.all([a, start('hold', '0'), start('hold', '0')]);
    const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const results = lines.filter((l) => l.startsWith('result ')).map((l) => l.split(' ')[2]!);
    // on a loaded machine B or C may come after A let go and take it then: never at once
    expect(count(results, 'acquired')).toBeGreaterThanOrEqual(1);
    expect(overlaps(lines)).toBe(0);
    expect(lines.filter((l) => l.includes('stillmine=false'))).toEqual([]);
    expect(results.every((x) => ['acquired', 'breaking', 'held'].includes(x))).toBe(true);
  });

  it('R5 children given the holder token all re-enter; the lock stays with the holder', async () => {
    const lock = join(tmp('r5'), 'heavy.lock.d');
    const r0 = acquireDir(lock, {
      kind: 'tts',
      pid: process.pid,
      pid_start: procStart(process.pid)!,
      holder: 'parent',
    });
    if (r0.status !== 'acquired') throw new Error(r0.status);
    const r = await race(lock, 6, { mode: 'hold', env: { RACE_TOKEN: r0.token } });
    expect(count(r.results, 'reentered')).toBe(6);
    expect(readOwner(lock)?.token).toBe(r0.token);
    expect(releaseDir(lock, r0.token)).toBe(true);
  });

  it('R6 the same on a character work lock', async () => {
    const lock = join(tmp('r6'), '.work', 'op.lock.d');
    deadOwner(lock);
    const r = await race(lock, 8);
    expect(count(r.results, 'acquired')).toBe(1);
    const lock2 = join(tmp('r6b'), '.work', 'op.lock.d');
    deadOwner(lock2);
    const r2 = await race(lock2, 3, { loops: 10, hold: 5, mode: 'hold' });
    expect(count(r2.results, 'acquired')).toBe(30);
    expect(overlaps(r2.log)).toBe(0);
  });
});
