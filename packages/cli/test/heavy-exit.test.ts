/**
 * S8 plan 3.3a: how a lock holder ends (E1–E10) — every way out releases the lock, after the
 * servers it started are gone; output piped past 64 KB arrives whole; an error with a timer left
 * behind still ends. Drivers run the built shutdown.js with a fake `uv` (no real server).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ALIGNER, Service, TTS_SERVER } from '../src/services.js';
import {
  CLI,
  dist,
  driver,
  fakeUvDir,
  freePort,
  healthStub,
  killChildren,
  livePid,
  REPO,
  tmp,
  writeOwner,
} from './lock-helpers.js';

afterAll(killChildren);

const DRIVER = driver(`
import { runMain, trackGroup } from ${JSON.stringify(dist('shutdown.js'))};
import { acquireHeavy } from ${JSON.stringify(dist('heavy-lock.js'))};
import { Service, TTS_SERVER } from ${JSON.stringify(dist('services.js'))};
import { runWatched } from ${JSON.stringify(dist('imagegen.js'))};
import { ExitError } from ${JSON.stringify(dist('errors.js'))};
import { spawn } from 'node:child_process';
const [mode, repo] = process.argv.slice(2);
runMain(async () => {
  if (mode === 'nothing') {
    process.on('exit', () => console.log('listeners ' + process.listenerCount('SIGINT')));
    return;
  }
  if (mode === 'timer') {
    setInterval(() => {}, 1000);
    throw new ExitError('failed with a timer left', 3);
  }
  acquireHeavy('tts', { holder: 'driver ' + mode });
  if (mode.startsWith('server')) {
    const s = new Service(TTS_SERVER, repo);
    await s.ensure();
    console.log('server ' + s.pgid);
    if (mode === 'server-stop') s.stop();
    if (mode === 'server-stop-big') {
      s.stop();
      process.stdout.write(JSON.stringify({ big: 'x'.repeat(2_000_000) }) + '\\n');
      process.exitCode = 1;
    }
    if (mode === 'server-exit') process.exit(0);
    if (mode === 'server-wait') await new Promise((r) => setTimeout(r, 60000));
    return;
  }
  if (mode === 'zombie') {
    const c = spawn('sh', ['-c', 'trap "exit 0" TERM; sleep 30 & wait'], { detached: true, stdio: 'ignore' });
    trackGroup(c.pid);
    await new Promise((r) => setTimeout(r, 200));
    process.exit(0);
  }
  if (mode === 'watched') {
    console.log('locked');
    const child = "const fs = require('fs'); process.on('SIGTERM', () => { fs.writeFileSync(process.env.WATCHED_LOG, 'SIGTERM'); process.exit(143); }); fs.writeFileSync(process.env.WATCHED_LOG + '.ready', ''); setTimeout(() => {}, 30000);";
    const r = await runWatched(process.execPath, ['-e', child], { maxGb: 1000, log: () => {} });
    // as a character round reports it (commands.ts roundFailed)
    throw new ExitError(r.code === 130 ? 'round 2 interrupted; finished images are kept' : 'round 2 ended ' + r.code, r.code);
  }
  if (mode === 'foreign') {
    // another library's listeners (Remotion's browser) do not hold the signal back
    for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => {});
    console.log('locked');
    await new Promise((r) => setTimeout(r, 5000));
    throw new ExitError('the signal was not handled', 1);
  }
  if (mode === 'foreign-race') {
    console.log('locked');
    setInterval(() => {}, 1000); // the browser keeps the process going
    // the signal stops what the command waits for (a browser): it fails right after
    await new Promise((_, reject) =>
      process.on('SIGTERM', () => setImmediate(() => reject(new Error('browser closed')))),
    );
  }
  console.log('locked');
  if (mode === 'throw') throw new ExitError('boom', 1);
  if (mode === 'exit') process.exit(1);
  if (mode === 'wait') await new Promise((r) => setTimeout(r, 60000));
}, (e) => (e && typeof e.exitCode === 'number' ? e.exitCode : 1));
`);

const lockHash = (spec: typeof TTS_SERVER) => new Service(spec, REPO).expectedLockHash();

interface Ctx {
  state: string;
  env: NodeJS.ProcessEnv;
  exitLog: string;
}

async function ctx(extra: Record<string, string> = {}): Promise<Ctx> {
  const state = tmp('exit-state');
  const exitLog = join(tmp('exit-log'), 'log');
  writeFileSync(exitLog, '');
  return {
    state,
    exitLog,
    env: {
      ...process.env,
      S2V_STATE_DIR: state,
      PATH: `${fakeUvDir()}:${process.env.PATH}`,
      S2V_TTS_PORT: String(await freePort()),
      FAKE_UV_LOCK_TTS: lockHash(TTS_SERVER),
      FAKE_UV_LOCK_ALIGNER: lockHash(ALIGNER),
      FAKE_UV_EXIT_LOG: exitLog,
      ...extra,
    },
  };
}

function start(
  mode: string,
  c: Ctx,
): { p: ChildProcess; out: () => string; exit: Promise<number | null> } {
  const p = spawn(process.execPath, [DRIVER, mode, REPO], {
    env: c.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout!.on('data', (d) => (out += d));
  p.stderr!.on('data', (d) => (out += d));
  const exit = new Promise<number | null>((r) =>
    p.on('exit', (code, sig) => r(code ?? (sig ? -1 : null))),
  );
  return { p, out: () => out, exit };
}

async function until(f: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const lockGone = (c: Ctx) => !existsSync(join(c.state, 'heavy.lock.d'));

describe('ending a lock holder', { timeout: 90_000 }, () => {
  it('E1 every way out releases the lock, with the right code (SIGHUP 129)', async () => {
    for (const [mode, sig, code] of [
      ['ok', null, 0],
      ['throw', null, 1],
      ['exit', null, 1],
      ['wait', 'SIGINT', 130],
      ['wait', 'SIGTERM', 143],
      ['wait', 'SIGHUP', 129],
    ] as const) {
      const c = await ctx();
      const d = start(mode, c);
      if (sig) {
        await until(() => d.out().includes('locked'));
        d.p.kill(sig);
      }
      expect(await d.exit).toBe(code);
      expect(lockGone(c)).toBe(true);
    }
  });

  it('E2 a killed holder leaves its lock; the next one breaks it', async () => {
    const c = await ctx();
    const d = start('wait', c);
    await until(() => d.out().includes('locked'));
    d.p.kill('SIGKILL');
    await d.exit;
    expect(lockGone(c)).toBe(false);
    const again = start('ok', c);
    expect(await again.exit).toBe(0);
    expect(lockGone(c)).toBe(true);
  });

  it('E3 the lock is released only after the server group is gone (signal, stopped, process.exit, re-entered)', async () => {
    const runs: [string, NodeJS.Signals | null, Record<string, string>][] = [
      ['server-wait', 'SIGINT', {}],
      ['server-stop', null, {}],
      ['server-exit', null, {}],
    ];
    // a re-entered process waits for the server it started too
    const p = livePid();
    const token = 'e3'.repeat(16);
    runs.push(['server-stop', null, { S2V_HEAVY_LOCK_TOKEN: token }]);
    for (const [mode, sig, extra] of runs) {
      const c = await ctx({ FAKE_UV_SLOW_TERM: '1000', FAKE_UV_NO_LIFELINE: '1', ...extra });
      if (extra.S2V_HEAVY_LOCK_TOKEN)
        writeOwner(join(c.state, 'heavy.lock.d'), {
          kind: 'tts',
          pid: p.pid,
          pid_start: p.start,
          holder: 'wrapper',
          token,
        });
      const d = start(mode, c);
      await until(() => d.out().includes('server '));
      if (sig) d.p.kill(sig);
      await d.exit;
      // the slow server had already written its exit when the holder ended
      expect(readFileSync(c.exitLog, 'utf8'), `${mode} ${JSON.stringify(extra)}`).toMatch(
        /exit script2video-tts/,
      );
      expect(lockGone(c)).toBe(!extra.S2V_HEAVY_LOCK_TOKEN);
    }
  });

  it('E4 a group of zombies is gone: the synchronous exit does not wait 10 s', async () => {
    const c = await ctx();
    const t0 = Date.now();
    const d = start('zombie', c);
    expect(await d.exit).toBe(0);
    expect(Date.now() - t0).toBeLessThan(6000);
    expect(lockGone(c)).toBe(true);
  });

  it('E5 Ctrl-C while runWatched stops its child: runWatched handles it, the command ends with its own message (130)', async () => {
    const watched = join(tmp('watched'), 'log');
    const c = await ctx({ WATCHED_LOG: watched });
    const d = start('watched', c);
    // its SIGTERM handler is in place
    await until(() => existsSync(`${watched}.ready`));
    d.p.kill('SIGINT');
    expect(await d.exit).toBe(130);
    // the child was stopped by runWatched (SIGTERM to its group) and the command went on to say so
    expect(readFileSync(watched, 'utf8')).toBe('SIGTERM');
    expect(d.out()).toMatch(/round 2 interrupted; finished images are kept/);
    expect(lockGone(c)).toBe(true);
  });

  it('E5 SIGTERM while runWatched stops its child: the same message, exit 143', async () => {
    const watched = join(tmp('watched'), 'log');
    const c = await ctx({ WATCHED_LOG: watched });
    const d = start('watched', c);
    await until(() => existsSync(`${watched}.ready`));
    d.p.kill('SIGTERM');
    expect(await d.exit).toBe(143);
    expect(readFileSync(watched, 'utf8')).toBe('SIGTERM');
    expect(d.out()).toMatch(/round 2 interrupted; finished images are kept/);
    expect(lockGone(c)).toBe(true);
  });

  it('E11 another library listening for SIGTERM / SIGHUP: still 143 / 129', async () => {
    for (const [sig, code] of [
      ['SIGTERM', 143],
      ['SIGHUP', 129],
    ] as const) {
      const c = await ctx();
      const d = start('foreign', c);
      await until(() => d.out().includes('locked'));
      const sent = Date.now();
      d.p.kill(sig);
      expect(await d.exit).toBe(code);
      // ended by our handler, not by the command giving up 5 s later
      expect(Date.now() - sent).toBeLessThan(3000);
      expect(d.out()).not.toMatch(/not handled/);
      expect(lockGone(c)).toBe(true);
    }
  });

  it('E12 the command fails because of the signal: the signal code wins (143, not 1)', async () => {
    const c = await ctx();
    const d = start('foreign-race', c);
    await until(() => d.out().includes('locked'));
    d.p.kill('SIGTERM');
    // whichever ends first (the signal handler or main's error path), the code is the signal's
    expect(await d.exit).toBe(143);
    expect(lockGone(c)).toBe(true);
  });

  it('E6 Ctrl-C of a command that reused a server (no spawn) still releases', async () => {
    let synth = 0;
    const stub = await healthStub(
      (url) =>
        url === '/health'
          ? {
              id: TTS_SERVER.id,
              lock_hash: lockHash(TTS_SERVER),
              wrapper_version: TTS_SERVER.wrapper,
            }
          : null,
      (url) => {
        if (url === '/synthesize') synth++;
      },
    );
    try {
      const c = await ctx({ S2V_TTS_PORT: String(stub.port) });
      const p = spawn(process.execPath, [CLI, 'say', '--no-play', '--', '안녕하세요'], {
        env: c.env,
        stdio: 'ignore',
      });
      const exit = new Promise((r) => p.on('exit', (code) => r(code)));
      await until(() => synth > 0);
      expect(lockGone(c)).toBe(false);
      p.kill('SIGINT');
      expect(await exit).toBe(130);
      expect(lockGone(c)).toBe(true);
    } finally {
      stub.server.closeAllConnections();
      stub.server.close();
    }
  });

  it('E7 a second Ctrl-C ends at once, the server group killed', async () => {
    const c = await ctx({ FAKE_UV_SLOW_TERM: '60000', FAKE_UV_NO_LIFELINE: '1' });
    const d = start('server-wait', c);
    await until(() => d.out().includes('server '));
    const pgid = Number(/server (\d+)/.exec(d.out())![1]);
    d.p.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 500));
    const t0 = Date.now();
    d.p.kill('SIGINT');
    expect(await d.exit).toBe(130);
    expect(Date.now() - t0).toBeLessThan(3000);
    await until(() => {
      try {
        process.kill(-pgid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000);
    expect(lockGone(c)).toBe(true);
  });

  it('E8 2 MB on a pipe arrives whole after the clean-up; the exit code a command set stays', async () => {
    const c = await ctx({ FAKE_UV_SLOW_TERM: '300' });
    const r = spawnSync(process.execPath, [DRIVER, 'server-stop-big', REPO], {
      env: c.env,
      maxBuffer: 64 << 20,
    });
    expect(r.status).toBe(1);
    const lines = r.stdout.toString().trim().split('\n');
    expect(JSON.parse(lines.at(-1)!).big.length).toBe(2_000_000);
    expect(lockGone(c)).toBe(true);
  });

  it('E8 the CLI without anything to clean up: a big inspect --json arrives whole', () => {
    const dir = tmp('big-script');
    const script = join(dir, 'script.ko.md');
    const scenes = Array.from(
      { length: 400 },
      (_, i) =>
        `# 장면 ${i} {#s${i}}\n\n장면 ${i}의 첫 문장입니다. 두 번째 문장도 여기에 있습니다.\n`,
    ).join('\n');
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, `---\nlang: ko\ntitle: 큰 대본\n---\n\n${scenes}`);
    const r = spawnSync(process.execPath, [CLI, 'inspect', script, '--json'], {
      env: { ...process.env },
      maxBuffer: 64 << 20,
    });
    expect(r.status, r.stderr.toString()).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(65_536);
    expect(() => JSON.parse(r.stdout.toString())).not.toThrow();
  });

  it('E9 nothing to clean up: no handler is registered', async () => {
    const c = await ctx();
    const r = spawnSync(process.execPath, [DRIVER, 'nothing', REPO], { env: c.env });
    expect(r.status).toBe(0);
    expect(r.stdout.toString()).toMatch(/listeners 0/);
  });

  it('E10 an error with a timer left behind still ends within 2 s, with its code', async () => {
    const c = await ctx();
    const t0 = Date.now();
    const d = start('timer', c);
    expect(await d.exit).toBe(3);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
