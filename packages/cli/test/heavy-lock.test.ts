/**
 * S8: the directory lock (dir-lock.ts) and the machine lock (heavy-lock.ts) in one process — take,
 * re-enter, break a dead holder under the mutex, release, leftovers, the shared fixtures.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  acquireDir,
  CannotCheck,
  cleanLeftovers,
  defaultEnv,
  parseLstart,
  procStart,
  readOwner,
  releaseDir,
  sameStart,
  type LockEnv,
} from '../src/dir-lock.js';
import {
  acquireHeavy,
  BusyError,
  heavyLockPath,
  heldHere,
  releaseHeavy,
  setLockEnvForTests,
  stateDir,
  TOKEN_ENV,
} from '../src/heavy-lock.js';
import { acquireActor, acquireActors, ActorBusyError, actorLockPath } from '../src/actor-lock.js';
import { ExitError } from '../src/errors.js';
import { ALIGNER, Service, TTS_SERVER } from '../src/services.js';
import {
  deadPid,
  healthStub,
  killChildren,
  livePid,
  REPO,
  tmp,
  writeOwner,
} from './lock-helpers.js';

const FIX = join(REPO, 'packages/cli/test/fixtures/heavy-lock');

afterEach(() => {
  delete process.env[TOKEN_ENV];
});
afterAll(killChildren);

const lockIn = () => join(tmp('lock'), 'heavy.lock.d');
const others = (lock: string) =>
  readdirSync(dirname(lock)).filter((n) => n !== 'heavy.lock.d' && n !== 'op.lock.d');

describe('the machine lock', { timeout: 30_000 }, () => {
  it('L1 takes an empty lock: five keys, its own start time, no leftovers, the token in env', () => {
    acquireHeavy('tts', { holder: 's2v tts /x/script.md' });
    const o = JSON.parse(readFileSync(join(heavyLockPath(), 'owner.json'), 'utf8'));
    expect(Object.keys(o).sort()).toEqual(['holder', 'kind', 'pid', 'pid_start', 'token']);
    expect(o).toMatchObject({ kind: 'tts', pid: process.pid, holder: 's2v tts /x/script.md' });
    expect(o.pid_start).toBe(procStart(process.pid));
    expect(o.token).toMatch(/^[0-9a-f]{32}$/);
    expect(process.env[TOKEN_ENV]).toBe(o.token);
    expect(others(heavyLockPath())).toEqual([]);
    expect(heldHere()).toBe(true);
    // L13: a second call in the same process (as Promise.all of two ensure()) is the same lock
    acquireHeavy('tts');
    releaseHeavy();
    expect(existsSync(heavyLockPath())).toBe(false);
    // L11: the token leaves the environment with the lock
    expect(process.env[TOKEN_ENV]).toBeUndefined();
  });

  it('L2 refuses a live holder at once: exit 73, who holds it, the lock untouched', () => {
    const p = livePid();
    const owner = {
      kind: 'gen',
      pid: p.pid,
      pid_start: p.start,
      holder: 'other',
      token: 'a'.repeat(32),
    };
    writeOwner(heavyLockPath(), owner);
    let err: unknown;
    try {
      acquireHeavy('tts');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BusyError);
    expect((err as BusyError).exitCode).toBe(73);
    expect((err as BusyError).reason).toBe('lock');
    expect((err as Error).message).toMatch(/^busy \(lock\): .*gen — other \(pid \d+/);
    expect((err as Error).message).toMatch(/s2v services status/);
    expect(readOwner(heavyLockPath())).toEqual(owner);
    rmSync(heavyLockPath(), { recursive: true });
  });

  it('L3–L5 re-entry: the same kind with the holder token; another kind or token is refused', () => {
    const p = livePid();
    const token = 'b'.repeat(32);
    writeOwner(heavyLockPath(), {
      kind: 'tts',
      pid: p.pid,
      pid_start: p.start,
      holder: 'wrapper',
      token,
    });
    const before = readFileSync(join(heavyLockPath(), 'owner.json'), 'utf8');
    process.env[TOKEN_ENV] = token;
    acquireHeavy('tts');
    expect(heldHere()).toBe(true);
    releaseHeavy(); // a re-entered lock stays with its holder
    expect(readFileSync(join(heavyLockPath(), 'owner.json'), 'utf8')).toBe(before);
    // started under the wrong kind: a mistake in how it was started (exit 2), not "busy"
    let wrong: unknown;
    try {
      acquireHeavy('gen');
    } catch (e) {
      wrong = e;
    }
    expect(wrong).toBeInstanceOf(ExitError);
    expect(wrong).not.toBeInstanceOf(BusyError);
    expect((wrong as ExitError).exitCode).toBe(2);
    expect((wrong as Error).message).toMatch(
      /S2V_HEAVY_LOCK_TOKEN is held as tts; this command needs a gen lock/,
    );
    process.env[TOKEN_ENV] = 'c'.repeat(32);
    expect(() => acquireHeavy('tts')).toThrow(BusyError);
    rmSync(heavyLockPath(), { recursive: true });
  });

  it('L16 S2V_STATE_DIR must be absolute (exit 2)', () => {
    const was = process.env.S2V_STATE_DIR;
    process.env.S2V_STATE_DIR = 'relative/state';
    try {
      expect(() => stateDir()).toThrow(ExitError);
      try {
        stateDir();
      } catch (e) {
        expect((e as ExitError).exitCode).toBe(2);
      }
    } finally {
      process.env.S2V_STATE_DIR = was;
    }
  });

  it('L12 when ps cannot run, a holder is taken as alive', () => {
    writeOwner(heavyLockPath(), {
      kind: 'tts',
      pid: 1,
      pid_start: 'x',
      holder: 'h',
      token: 'd'.repeat(32),
    });
    setLockEnvForTests({
      procStart: () => {
        throw new CannotCheck('no ps');
      },
    });
    expect(() => acquireHeavy('tts')).toThrow(/cannot check whether it still runs/);
    rmSync(heavyLockPath(), { recursive: true });
  });

  it('L13 two ensure() at once in one process take one lock (stub servers)', async () => {
    const lock = (spec: typeof TTS_SERVER) => new Service(spec, REPO).expectedLockHash();
    const t = await healthStub(() => ({
      id: TTS_SERVER.id,
      lock_hash: lock(TTS_SERVER),
      wrapper_version: TTS_SERVER.wrapper,
    }));
    const a = await healthStub(() => ({
      id: ALIGNER.id,
      lock_hash: lock(ALIGNER),
      wrapper_version: ALIGNER.wrapper,
    }));
    try {
      const tts = new Service({ ...TTS_SERVER, port: t.port }, REPO);
      const al = new Service({ ...ALIGNER, port: a.port }, REPO);
      await Promise.all([tts.ensure(), al.ensure()]);
      expect(readOwner(heavyLockPath())?.pid).toBe(process.pid);
      expect(others(heavyLockPath())).toEqual([]);
    } finally {
      t.server.close();
      a.server.close();
    }
  });
});

describe('the directory lock', { timeout: 30_000 }, () => {
  const fields = () => ({
    kind: 'tts',
    pid: process.pid,
    pid_start: procStart(process.pid)!,
    holder: 't',
  });

  it('L6 breaks a dead holder and leaves nothing behind', () => {
    const lock = lockIn();
    writeOwner(lock, {
      kind: 'tts',
      pid: deadPid(),
      pid_start: 'Mon Oct 19 00:00:00 2026',
      holder: 'd',
      token: 'e'.repeat(32),
    });
    const r = acquireDir(lock, fields());
    expect(r.status).toBe('acquired');
    expect(others(lock)).toEqual([]);
    expect(releaseDir(lock, (r as { token: string }).token)).toBe(true);
  });

  it('L7 a live pid with another start time is a reused pid: broken', () => {
    const p = livePid();
    const lock = lockIn();
    writeOwner(lock, {
      kind: 'tts',
      pid: p.pid,
      pid_start: 'Thu Jan  1 00:00:00 2026',
      holder: 'old',
      token: 'f'.repeat(32),
    });
    expect(acquireDir(lock, fields()).status).toBe('acquired');
  });

  it('L7 start times: exact on macOS, within 2 s on Linux, read as UTC (shared fixture)', () => {
    const { cases } = JSON.parse(readFileSync(join(FIX, 'lstart-cases.json'), 'utf8')) as {
      cases: { a: string; b: string; epoch: number; macos: boolean; linux: boolean }[];
    };
    for (const c of cases) {
      expect(parseLstart(c.a)).toBe(c.epoch);
      expect(sameStart(c.a, c.b, 'darwin')).toBe(c.macos);
      expect(sameStart(c.a, c.b, 'linux')).toBe(c.linux);
    }
  });

  /** A lock another program left without a readable owner (a file in it blocks the rename). */
  const unreadable = () => {
    const lock = lockIn();
    mkdirSync(lock);
    writeFileSync(join(lock, 'junk'), 'x');
    return lock;
  };

  it('L19 an unreadable lock replaced inside the mutex (det.mjs): the new holder keeps it', () => {
    const lock = unreadable();
    let q: { token: string } | null = null;
    const r = acquireDir(lock, fields(), {
      env: {
        ...defaultEnv(),
        hooks: {
          inMutex: () => {
            if (q) return;
            rmSync(lock, { recursive: true }); // it went away, and Q took the lock at once
            q = acquireDir(lock, { ...fields(), holder: 'Q' }) as { token: string };
          },
        },
      },
    });
    expect(q!).not.toBeNull();
    expect(r.status).toBe('held');
    expect(readOwner(lock)?.token).toBe(q!.token);
    expect(others(lock)).toEqual([]);
  });

  it('L19 … replaced between the check and the rename: put back, the new holder keeps it', () => {
    const lock = unreadable();
    let q: { token: string } | null = null;
    const warnings: string[] = [];
    const r = acquireDir(lock, fields(), {
      env: {
        ...defaultEnv(),
        warn: (m) => warnings.push(m),
        hooks: {
          beforeRename: () => {
            if (q) return;
            rmSync(lock, { recursive: true });
            q = acquireDir(lock, { ...fields(), holder: 'Q' }) as { token: string };
          },
        },
      },
    });
    expect(r.status).toBe('held');
    expect(readOwner(lock)?.token).toBe(q!.token);
    expect(warnings.join()).toMatch(/put it back/);
  });

  it('L20 a lock released while it is read (no owner for a moment) is not broken', () => {
    // Q holds; while P reads, Q releases and R takes it: P sees R alive
    const lock = lockIn();
    const q = acquireDir(lock, { ...fields(), holder: 'Q' }) as { token: string };
    let rTok: string | null = null;
    let calls = 0;
    const r = acquireDir(
      lock,
      { ...fields(), holder: 'P' },
      {
        env: {
          ...defaultEnv(),
          hooks: {
            beforeOwnerRead: () => {
              if (calls++ > 0) return;
              releaseDir(lock, q.token);
              // P now reads no owner; another process takes it before P looks again
              rTok = (acquireDir(lock, { ...fields(), holder: 'R' }) as { token: string }).token;
            },
          },
        },
      },
    );
    expect(r.status).toBe('held');
    expect(readOwner(lock)?.token).toBe(rTok);
    // released and nobody takes it: P gets it on the next look
    releaseDir(lock, rTok!);
    const q2 = acquireDir(lock, { ...fields(), holder: 'Q2' }) as { token: string };
    let first = true;
    const r2 = acquireDir(
      lock,
      { ...fields(), holder: 'P2' },
      {
        env: {
          ...defaultEnv(),
          hooks: {
            beforeOwnerRead: () => {
              if (first) releaseDir(lock, q2.token);
              first = false;
            },
          },
        },
      },
    );
    expect(r2.status).toBe('acquired');
  });

  it('L21 the inode check in the mutex: a judged lock that went away is not taken for a new one', () => {
    // without it, the owner check alone (none then, none now) passes and Q's new lock is moved
    const lock = unreadable();
    let q: { token: string } | null = null;
    const warnings: string[] = [];
    const r = acquireDir(lock, fields(), {
      env: {
        ...defaultEnv(),
        warn: (m) => warnings.push(m),
        hooks: {
          inMutex: () => {
            if (existsSync(join(lock, 'junk'))) rmSync(lock, { recursive: true });
          },
          beforeRename: () => {
            if (!q && !existsSync(lock))
              q = acquireDir(lock, { ...fields(), holder: 'Q' }) as { token: string };
          },
        },
      },
    });
    expect(warnings).toEqual([]);
    // nobody's lock was moved: P took the free place (Q never had to)
    expect(r.status).toBe('acquired');
    expect(q).toBeNull();
    expect(readOwner(lock)?.holder).toBe('t');
  });

  it('L22 the owner check in the mutex: the same folder with a live owner now is not broken', () => {
    const p = livePid();
    const lock = lockIn();
    writeOwner(lock, {
      kind: 'tts',
      pid: deadPid(),
      pid_start: 'x',
      holder: 'dead',
      token: 'aa'.repeat(16),
    });
    const live = {
      kind: 'tts',
      pid: p.pid,
      pid_start: p.start,
      holder: 'live',
      token: 'bb'.repeat(16),
    };
    const warnings: string[] = [];
    let swapped = false;
    const r = acquireDir(lock, fields(), {
      env: {
        ...defaultEnv(),
        warn: (m) => warnings.push(m),
        hooks: {
          inMutex: () => {
            if (swapped) return;
            swapped = true;
            writeFileSync(join(lock, 'owner.json'), JSON.stringify(live)); // same folder, new owner
          },
        },
      },
    });
    expect(r.status).toBe('held');
    expect(warnings).toEqual([]);
    expect(readOwner(lock)).toEqual(live);
  });

  it('L23 an owner that appears while it is looked at again is a holder, not a broken lock', () => {
    const p = livePid();
    const lock = unreadable();
    const live = {
      kind: 'tts',
      pid: p.pid,
      pid_start: p.start,
      holder: 'slow',
      token: 'cc'.repeat(16),
    };
    let reads = 0;
    const r = acquireDir(lock, fields(), {
      env: {
        ...defaultEnv(),
        hooks: {
          beforeOwnerRead: () => {
            if (++reads === 3) writeFileSync(join(lock, 'owner.json'), JSON.stringify(live));
          },
        },
      },
    });
    expect(r.status).toBe('held');
    expect(readOwner(lock)).toEqual(live);
  });

  it('L24 taking the machine lock clears old leftovers of dead owners', () => {
    const old = (Date.now() - 120_000) / 1000;
    const left = `${heavyLockPath()}.stale.0badf00d`;
    mkdirSync(left, { recursive: true });
    utimesSync(left, old, old);
    acquireHeavy('tts');
    expect(existsSync(left)).toBe(false);
    releaseHeavy();
  });

  it('L8 an empty lock folder (another implementation mid-way) is renamed over; a broken owner is broken', () => {
    const lock = lockIn();
    mkdirSync(lock);
    expect(acquireDir(lock, fields()).status).toBe('acquired'); // documented: never mix with mkdir-style locks
    const lock2 = lockIn();
    mkdirSync(lock2);
    writeFileSync(join(lock2, 'owner.json'), '{"kind":"tts","pid":');
    expect(acquireDir(lock2, fields()).status).toBe('acquired');
    expect(others(lock2)).toEqual([]);
  });

  it('L9 under the mutex, a lock taken again meanwhile is left alone', () => {
    const p = livePid();
    const lock = lockIn();
    writeOwner(lock, {
      kind: 'tts',
      pid: deadPid(),
      pid_start: 'x',
      holder: 'dead',
      token: '1'.repeat(32),
    });
    const fresh = {
      kind: 'gen',
      pid: p.pid,
      pid_start: p.start,
      holder: 'new',
      token: '2'.repeat(32),
    };
    const env: LockEnv = {
      ...defaultEnv(),
      hooks: {
        inMutex: () => {
          rmSync(lock, { recursive: true });
          writeOwner(lock, fresh);
        },
      },
    };
    const r = acquireDir(lock, fields(), { env });
    expect(r.status).toBe('held');
    expect(readOwner(lock)).toEqual(fresh);
  });

  it('L10a a breaker mutex older (or newer) than 30 s is a dead breaker: removed', () => {
    for (const shift of [-60_000, 60_000]) {
      const lock = lockIn();
      writeOwner(lock, {
        kind: 'tts',
        pid: deadPid(),
        pid_start: 'x',
        holder: 'dead',
        token: '3'.repeat(32),
      });
      mkdirSync(`${lock}.break`);
      const t = (Date.now() + shift) / 1000;
      utimesSync(`${lock}.break`, t, t);
      expect(acquireDir(lock, fields()).status).toBe('acquired');
      expect(existsSync(`${lock}.break`)).toBe(false);
    }
  });

  it('L10b a fresh mutex of a dead breaker: "breaking" after a few tries, one ps per owner', () => {
    const lock = lockIn();
    writeOwner(lock, {
      kind: 'tts',
      pid: 999_999,
      pid_start: 'x',
      holder: 'dead',
      token: '4'.repeat(32),
    });
    mkdirSync(`${lock}.break`);
    let ps = 0;
    const env: LockEnv = { ...defaultEnv(), procStart: () => (ps++, null) };
    const t0 = Date.now();
    expect(acquireDir(lock, fields(), { env }).status).toBe('breaking');
    expect(ps).toBe(1);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(readOwner(lock)?.token).toBe('4'.repeat(32));
    expect(existsSync(`${lock}.break`)).toBe(true);
  });

  it('L10b the machine lock says "breaking", not "lock"', () => {
    writeOwner(heavyLockPath(), {
      kind: 'tts',
      pid: deadPid(),
      pid_start: 'x',
      holder: 'dead',
      token: '5'.repeat(32),
    });
    mkdirSync(`${heavyLockPath()}.break`);
    try {
      acquireHeavy('tts');
      throw new Error('not refused');
    } catch (e) {
      expect((e as BusyError).reason).toBe('breaking');
      expect((e as BusyError).exitCode).toBe(73);
    }
    rmSync(`${heavyLockPath()}.break`, { recursive: true });
    rmSync(heavyLockPath(), { recursive: true });
  });

  it('L18 a moved lock that is not the judged one is put back (or left and reported)', () => {
    const p = livePid();
    const other = {
      kind: 'tts',
      pid: p.pid,
      pid_start: p.start,
      holder: 'mixed',
      token: '6'.repeat(32),
    };
    const lock = lockIn();
    writeOwner(lock, {
      kind: 'tts',
      pid: deadPid(),
      pid_start: 'x',
      holder: 'dead',
      token: '7'.repeat(32),
    });
    const warnings: string[] = [];
    const r = acquireDir(lock, fields(), {
      env: {
        ...defaultEnv(),
        warn: (m) => warnings.push(m),
        hooks: {
          afterBreakRename: (stale) =>
            writeFileSync(join(stale, 'owner.json'), JSON.stringify(other)),
        },
      },
    });
    expect(r.status).toBe('held');
    expect(readOwner(lock)).toEqual(other); // back in place
    expect(warnings.join()).toMatch(/put it back/);
    // the lock was taken again before it could be put back: left where it is, said
    const lock2 = lockIn();
    writeOwner(lock2, {
      kind: 'tts',
      pid: deadPid(),
      pid_start: 'x',
      holder: 'dead',
      token: '8'.repeat(32),
    });
    const r2 = acquireDir(lock2, fields(), {
      env: {
        ...defaultEnv(),
        warn: (m) => warnings.push(m),
        hooks: {
          afterBreakRename: (stale) => {
            writeFileSync(join(stale, 'owner.json'), JSON.stringify(other));
            writeOwner(lock2, { ...other, token: '9'.repeat(32) });
          },
        },
      },
    });
    expect(r2.status).toBe('held');
    expect((r2 as { note?: string }).note).toMatch(/left at .*\.stale\./);
  });

  it('L11 release only by its token', () => {
    const lock = lockIn();
    const r = acquireDir(lock, fields()) as { token: string };
    expect(releaseDir(lock, 'x'.repeat(32))).toBe(false);
    expect(existsSync(lock)).toBe(true);
    expect(releaseDir(lock, r.token)).toBe(true);
    expect(readdirSync(dirname(lock))).toEqual([]);
  });

  it('L14 the shared fixtures read as expected', () => {
    const at = (f: string) => {
      const d = join(tmp('fixture'), 'l');
      mkdirSync(d);
      writeFileSync(join(d, 'owner.json'), readFileSync(join(FIX, f)));
      return readOwner(d);
    };
    expect(at('owner-tts.json')).toMatchObject({ kind: 'tts', pid: 4242 });
    expect(at('owner-gen.json')?.pid_start).toBe('Mon Oct  5 01:02:03 2026');
    expect(at('owner-extra-keys.json')).toMatchObject({ kind: 'tts', version: 2 });
    expect(at('owner-unknown-kind.json')?.kind).toBe('render');
    expect(at('owner-broken.txt')).toBeNull();
    expect(at('actor-owner.json')).toMatchObject({ cmd: expect.stringMatching(/character build/) });
    const r = JSON.parse(readFileSync(join(FIX, 'resident.json'), 'utf8'));
    expect(Object.keys(r).sort()).toEqual([
      'id',
      'pid',
      'pid_start',
      'port',
      'server_pgid',
      'started',
      'wrapper_version',
    ]);
  });

  it('L14 a live holder of an unknown kind holds the machine lock', () => {
    const p = livePid();
    writeOwner(heavyLockPath(), {
      kind: 'render',
      pid: p.pid,
      pid_start: p.start,
      holder: 'x',
      token: 'a1'.repeat(16),
    });
    expect(() => acquireHeavy('tts')).toThrow(/busy \(lock\): .*render/);
    rmSync(heavyLockPath(), { recursive: true });
  });

  it('L15 one process reads the same start time twice', async () => {
    const a = procStart(process.pid);
    await new Promise((r) => setTimeout(r, 1100));
    expect(procStart(process.pid)).toBe(a);
  });

  it('L17 leftovers: only old ones whose owner is dead or missing', () => {
    const lock = lockIn();
    const p = livePid();
    const old = (Date.now() - 120_000) / 1000;
    const make = (name: string, owner: Record<string, unknown> | null, aged: boolean) => {
      const d = `${lock}.${name}`;
      mkdirSync(d);
      if (owner) writeFileSync(join(d, 'owner.json'), JSON.stringify(owner));
      if (aged) utimesSync(d, old, old);
    };
    make('new.aaaa0001', { pid: deadPid(), pid_start: 'x', token: 't' }, true);
    make('gone.aaaa0002', null, true);
    make('stale.aaaa0003', null, false);
    make('new.aaaa0004', { pid: p.pid, pid_start: p.start, token: 't' }, true);
    expect(cleanLeftovers(lock).sort()).toEqual([
      'heavy.lock.d.gone.aaaa0002',
      'heavy.lock.d.new.aaaa0001',
    ]);
    expect(readdirSync(dirname(lock)).sort()).toEqual([
      'heavy.lock.d.new.aaaa0004',
      'heavy.lock.d.stale.aaaa0003',
    ]);
    expect(statSync(`${lock}.stale.aaaa0003`).isDirectory()).toBe(true);
  });
});

describe('the work lock of a character', { timeout: 30_000 }, () => {
  it('holds per folder, refuses a live holder (exit 74), takes several all or none', () => {
    const root = tmp('actors');
    const a = join(root, 'a');
    const b = join(root, 'b');
    mkdirSync(a);
    mkdirSync(b);
    const p = livePid();
    writeOwner(actorLockPath(b), {
      pid: p.pid,
      pid_start: p.start,
      cmd: 's2v character build b',
      token: 'c1'.repeat(16),
    });
    let err: unknown;
    try {
      acquireActors([a, b], 's2v character missing x --apply');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ActorBusyError);
    expect((err as ActorBusyError).exitCode).toBe(74);
    expect((err as Error).message).toMatch(
      /^actor busy: s2v character build b is working on this character/,
    );
    expect(existsSync(actorLockPath(a))).toBe(false); // the first one was let go
    // .work/ stays out of git: a .gitignore without it gets the line
    writeFileSync(join(a, '.gitignore'), 'notes.txt');
    acquireActor(a);
    expect(readFileSync(join(a, '.gitignore'), 'utf8')).toBe('notes.txt\n.work/\n');
    // its token never goes into the environment (only Studio's is read)
    expect(process.env.S2V_ACTOR_LOCK_TOKEN).toBeUndefined();
    // Studio's token: the lock is ours
    process.env.S2V_ACTOR_LOCK_TOKEN = 'c1'.repeat(16);
    try {
      acquireActor(b);
    } finally {
      delete process.env.S2V_ACTOR_LOCK_TOKEN;
    }
  });
});
