/**
 * S8 through the built CLI: busy commands (73), `tts-server start` and resident.json with a fake
 * `uv`, `services status [--json]`, `audio prune`, `character missing --apply` and the work lock.
 * Every run has its own S2V_STATE_DIR; no real server starts.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { step } from '../src/dev.js';
import { ALIGNER, Service, TTS_SERVER } from '../src/services.js';
import {
  CLI,
  deadPid,
  driver,
  fakeUvDir,
  freePort,
  healthStub,
  killChildren,
  livePid,
  REPO,
  tmp,
  track,
  writeOwner,
} from './lock-helpers.js';

// every CLI this file starts is killed at the end, also after a failed test
afterAll(killChildren);

const lockHash = (spec: typeof TTS_SERVER) => new Service(spec, REPO).expectedLockHash();
const health = (spec: typeof TTS_SERVER) => () => ({
  id: spec.id,
  lock_hash: lockHash(spec),
  wrapper_version: spec.wrapper,
  uptime_s: 1,
});

async function env(extra: Record<string, string> = {}) {
  const state = tmp('cli-state');
  const startLog = join(tmp('uv-log'), 'log');
  writeFileSync(startLog, '');
  return {
    state,
    startLog,
    env: {
      ...process.env,
      S2V_STATE_DIR: state,
      PATH: `${fakeUvDir()}:${process.env.PATH}`,
      S2V_TTS_PORT: String(await freePort()),
      S2V_ALIGNER_PORT: String(await freePort()),
      FAKE_UV_LOCK_TTS: lockHash(TTS_SERVER),
      FAKE_UV_LOCK_ALIGNER: lockHash(ALIGNER),
      FAKE_UV_LOG: startLog,
      ...extra,
    } as NodeJS.ProcessEnv,
  };
}

/** Run the CLI without blocking this process (stub servers here must answer meanwhile). */
const cli = (args: string[], e: NodeJS.ProcessEnv) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const p = track(spawn(process.execPath, [CLI, ...args], { env: e }));
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });

function heavyOwner(state: string, kind: string, token = 'ab'.repeat(16)) {
  const p = livePid();
  writeOwner(join(state, 'heavy.lock.d'), {
    kind,
    pid: p.pid,
    pid_start: p.start,
    holder: `other ${kind}`,
    token,
  });
  return p;
}

const residentOf = (state: string) =>
  JSON.parse(readFileSync(join(state, 'resident.json'), 'utf8'));

async function until(f: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function startResident(e: NodeJS.ProcessEnv): {
  p: ChildProcess;
  err: () => string;
  exit: Promise<number | null>;
} {
  const p = track(
    spawn(process.execPath, [CLI, 'tts-server', 'start'], {
      env: e,
      stdio: ['ignore', 'ignore', 'pipe'],
    }),
  );
  let err = '';
  p.stderr!.on('data', (d) => (err += d));
  return { p, err: () => err, exit: new Promise((r) => p.on('exit', (c) => r(c))) };
}

describe('busy commands', { timeout: 60_000 }, () => {
  it('C1 say: 73 while another holds the machine; the server is not asked to speak', async () => {
    let synth = 0;
    const stub = await healthStub(health(TTS_SERVER), (u) => {
      if (u === '/synthesize') synth++;
    });
    try {
      const c = await env({ S2V_TTS_PORT: String(stub.port) });
      heavyOwner(c.state, 'gen');
      const r = await cli(['say', '--no-play', '--', '안녕'], c.env);
      expect(r.status).toBe(73);
      expect(r.stderr).toMatch(
        /^busy \(lock\): another heavy job holds this machine: gen — other gen/m,
      );
      expect(synth).toBe(0);
    } finally {
      stub.server.close();
    }
  });

  it('C9 audio prune: 73 while another holds the machine, nothing removed', async () => {
    const dir = join(tmp('prune'), 'sample');
    cpSync(join(REPO, 'videos/sample-ko'), dir, { recursive: true });
    const lockDir = join(dir, 'audio', 'ko');
    const before = readdirSync(lockDir).sort();
    writeFileSync(join(lockDir, 'unused.wav'), 'x');
    const c = await env();
    heavyOwner(c.state, 'tts');
    const r = await cli(['audio', 'prune', join(dir, 'script.ko.md')], c.env);
    expect(r.status).toBe(73);
    expect(readdirSync(lockDir).sort()).toEqual([...before, 'unused.wav'].sort());
    // the contract (README): exit 73, and the reason on the one line starting with `busy (<reason>): `
    // — not the first line: the script's lint warnings come before it
    const lines = r.stderr.split('\n');
    const busy = lines.filter((l) => /^busy \([a-z]+\): /.test(l));
    expect(busy).toHaveLength(1);
    expect(busy[0]).toMatch(/^busy \(lock\): another heavy job holds this machine: tts/);
    expect(lines.indexOf(busy[0]!)).toBeGreaterThan(0);
    expect(lines[0]).toMatch(/script\.ko\.md:\d+/);
  });

  it('C13 a resident tts-server on another port: busy (resident), no second server', async () => {
    const c = await env();
    const p = livePid();
    const other = await freePort();
    writeFileSync(
      join(c.state, 'resident.json'),
      JSON.stringify({
        pid: p.pid,
        pid_start: p.start,
        port: other,
        server_pgid: null,
        id: TTS_SERVER.id,
        wrapper_version: TTS_SERVER.wrapper,
        started: new Date().toISOString(),
      }),
    );
    const r = await cli(['say', '--no-play', '--', '안녕'], c.env);
    expect(r.status).toBe(73);
    expect(r.stderr).toMatch(
      new RegExp(
        `^busy \\(resident\\): a resident tts-server runs on port ${other} .* uses port ${c.env.S2V_TTS_PORT}`,
        'm',
      ),
    );
    expect(readFileSync(c.startLog, 'utf8')).toBe('');
  });

  it('C12 services takes status and --json only', async () => {
    const c = await env();
    expect((await cli(['services'], c.env)).status).toBe(2);
    expect((await cli(['services', 'status', '--foo'], c.env)).status).toBe(2);
    expect((await cli(['services', 'status', '--json'], c.env)).status).toBe(0);
  });
});

describe('tts-server start (fake uv)', { timeout: 90_000 }, () => {
  it('C4 (a)(b) refused while any lock is held, also with the holder token; nothing starts', async () => {
    for (const kind of ['tts', 'gen']) {
      const c = await env();
      const token = 'cd'.repeat(16);
      heavyOwner(c.state, kind, token);
      for (const extra of [{}, { S2V_HEAVY_LOCK_TOKEN: token }]) {
        const r = await cli(['tts-server', 'start'], { ...c.env, ...extra });
        expect(r.status).toBe(73);
        expect(readFileSync(c.startLog, 'utf8')).toBe('');
      }
    }
  });

  it('C4 (c) a server nobody owns on the port: 73 orphan, not adopted', async () => {
    const stub = await healthStub(health(TTS_SERVER));
    try {
      const c = await env({ S2V_TTS_PORT: String(stub.port) });
      const r = await cli(['tts-server', 'start'], c.env);
      expect(r.status).toBe(73);
      expect(r.stderr).toMatch(/busy \(orphan\): port \d+ answers but no s2v command owns it/);
      expect(existsSync(join(c.state, 'resident.json'))).toBe(false);
      expect(existsSync(join(c.state, 'heavy.lock.d'))).toBe(false);
    } finally {
      stub.server.close();
    }
  });

  it('C4 (d)(e)(g) starts, records itself, holds no lock while resident; Ctrl-C stops and forgets', async () => {
    const c = await env();
    const r1 = startResident(c.env);
    await until(() => r1.err().includes('Ctrl-C to stop'));
    const res = residentOf(c.state);
    expect(res).toMatchObject({
      pid: r1.p.pid,
      port: Number(c.env.S2V_TTS_PORT),
      id: 'script2video-tts',
      wrapper_version: TTS_SERVER.wrapper,
    });
    expect(typeof res.pid_start).toBe('string');
    expect(typeof res.server_pgid).toBe('number');
    expect(existsSync(join(c.state, 'heavy.lock.d'))).toBe(false);
    // status: owned by the resident record
    const s = JSON.parse((await cli(['services', 'status', '--json'], c.env)).stdout);
    expect(s.servers[0]).toMatchObject({ answering: true, owner: 'resident', stop: null });
    expect(s.busy).toEqual({ tts: null, gen: { reason: 'resident' } });
    // (e) a second start: already running, exit 0
    const r2 = await cli(['tts-server', 'start'], c.env);
    expect(r2.status).toBe(0);
    expect(r2.stderr).toMatch(/already running/);
    // (g) a TTS command holds the lock while it stops: warned
    heavyOwner(c.state, 'tts');
    r1.p.kill('SIGINT');
    expect(await r1.exit).toBe(130);
    expect(r1.err()).toMatch(/may be using this server; it will fail/);
    expect(existsSync(join(c.state, 'resident.json'))).toBe(false);
    await until(() => {
      try {
        process.kill(-res.server_pgid, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000);
  });

  it('C4 (h) the server ends on its own: tts-server start says so and exits 1, resident.json removed', async () => {
    const c = await env({ FAKE_UV_DIE_AFTER: '1500' });
    const r = startResident(c.env);
    await until(() => r.err().includes('Ctrl-C to stop'));
    expect(existsSync(join(c.state, 'resident.json'))).toBe(true);
    expect(await r.exit).toBe(1);
    expect(r.err()).toMatch(/tts-server exited \(3\); it is not running any more/);
    expect(existsSync(join(c.state, 'resident.json'))).toBe(false);
  });

  it('C4 (f) a dead resident.json is replaced; (f′) a live one that does not answer is refused and kept', async () => {
    const c = await env();
    writeFileSync(
      join(c.state, 'resident.json'),
      JSON.stringify({
        pid: deadPid(),
        pid_start: 'x',
        port: 1,
        server_pgid: null,
        id: 'script2video-tts',
        wrapper_version: '0',
        started: '',
      }),
    );
    const r = startResident(c.env);
    await until(() => r.err().includes('Ctrl-C to stop'));
    expect(residentOf(c.state).pid).toBe(r.p.pid);
    r.p.kill('SIGTERM');
    expect(await r.exit).toBe(143);
    const c2 = await env();
    const p = livePid();
    const rec = {
      pid: p.pid,
      pid_start: p.start,
      port: Number(c2.env.S2V_TTS_PORT),
      server_pgid: null,
      id: 'script2video-tts',
      wrapper_version: '0',
      started: '',
    };
    writeFileSync(join(c2.state, 'resident.json'), JSON.stringify(rec));
    const r2 = await cli(['tts-server', 'start'], c2.env);
    expect(r2.status).toBe(73);
    expect(r2.stderr).toMatch(
      /busy \(resident\): a resident tts-server \(pid \d+\) does not answer.*stop it \(pid \d+\)/,
    );
    expect(residentOf(c2.state)).toEqual(rec);
  });
});

describe('services status', { timeout: 60_000 }, () => {
  it('C11 (a) nothing: free, nothing busy, servers not running; the text says so', async () => {
    const c = await env();
    const r = await cli(['services', 'status', '--json'], c.env);
    const s = JSON.parse(r.stdout);
    expect(s).toMatchObject({
      version: 1,
      state_dir: c.state,
      busy: { tts: null, gen: null },
      lock: null,
      breaking: false,
      resident: null,
      orphans: 0,
    });
    expect(s.servers.map((x: { answering: boolean }) => x.answering)).toEqual([false, false]);
    const text = await cli(['services', 'status'], c.env);
    expect(text.stdout).toMatch(/^lock: free$/m);
    expect(text.stdout).toMatch(/script2video-tts: not running/);
  });

  it('C11 (b)(c′)(d) the owner of each server, what is busy, how to stop an orphan', async () => {
    const t = await healthStub(health(TTS_SERVER));
    try {
      // (b) a live TTS holder: its server
      const c = await env({ S2V_TTS_PORT: String(t.port) });
      heavyOwner(c.state, 'tts', '12'.repeat(16));
      const s = JSON.parse((await cli(['services', 'status', '--json'], c.env)).stdout);
      expect(s.lock).toMatchObject({
        state: 'held',
        kind: 'tts',
        holder: 'other tts',
        alive: true,
      });
      expect(s.servers[0]).toMatchObject({ answering: true, owner: 'lock', stop: null });
      expect(s.busy).toEqual({ tts: { reason: 'lock' }, gen: { reason: 'lock' } });
      expect(JSON.stringify(s)).not.toContain('12'.repeat(16)); // (g) never the token
      // (c′) a resident whose port is quiet: generation is busy, TTS is not
      const c2 = await env();
      const p = livePid();
      writeFileSync(
        join(c2.state, 'resident.json'),
        JSON.stringify({
          pid: p.pid,
          pid_start: p.start,
          port: 1,
          server_pgid: null,
          id: 'script2video-tts',
          wrapper_version: '0',
          started: '',
        }),
      );
      const s2 = JSON.parse((await cli(['services', 'status', '--json'], c2.env)).stdout);
      expect(s2.busy).toEqual({ tts: null, gen: { reason: 'resident' } });
      expect(s2.resident).toMatchObject({ alive: true, healthy: false });
      // (d) nobody owns it: an orphan, TTS commands are not refused by it
      const c3 = await env({ S2V_TTS_PORT: String(t.port) });
      const r3 = await cli(['services', 'status', '--json'], c3.env);
      expect(r3.status).toBe(0);
      const s3 = JSON.parse(r3.stdout);
      expect(s3.servers[0]).toMatchObject({ owner: 'none', pid: process.pid });
      expect(s3.servers[0].stop).toBe(`kill -TERM ${process.pid}`); // its leader is not uv … server.py
      expect(s3.orphans).toBe(1);
      expect(s3.busy).toEqual({ tts: null, gen: { reason: 'orphan' } });
      expect(s3.warnings.join()).toMatch(/has no owner/);
      expect((await cli(['services', 'status'], c3.env)).stdout).toMatch(
        /NO OWNER .* stop it: kill -TERM \d+/,
      );
    } finally {
      t.server.close();
    }
  });

  it('C11 (d) an orphan started as `uv run … server.py` is stopped by its group', async () => {
    const c = await env();
    const uv = join(fakeUvDir(), 'uv');
    const cwd = join(tmp('orphan'), 'tts-server');
    mkdirSync(cwd);
    const o = spawn(uv, ['run', '--frozen', 'python', 'server.py', '--port', c.env.S2V_TTS_PORT!], {
      cwd,
      env: c.env,
      detached: true,
      stdio: 'ignore',
    });
    try {
      for (let i = 0; i < 100; i++) {
        if ((await cli(['services', 'status', '--json'], c.env)).stdout.includes('"owner": "none"'))
          break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const s = JSON.parse((await cli(['services', 'status', '--json'], c.env)).stdout);
      const hasLsof = spawnSync('lsof', ['-v']).error === undefined;
      expect(s.servers[0].stop).toBe(
        hasLsof
          ? `kill -TERM -${o.pid}`
          : `lsof -nP -iTCP:${c.env.S2V_TTS_PORT} -sTCP:LISTEN   (find it, then kill it)`,
      );
    } finally {
      process.kill(-o.pid!, 'SIGKILL');
    }
  });

  it('C11 (e)(e′)(f)(h) stale, breaking, invalid; old dead leftovers cleaned, a dead resident.json kept', async () => {
    const c = await env();
    const lock = join(c.state, 'heavy.lock.d');
    writeOwner(lock, {
      kind: 'tts',
      pid: deadPid(),
      pid_start: 'x',
      holder: 'gone',
      token: '34'.repeat(16),
    });
    let s = JSON.parse((await cli(['services', 'status', '--json'], c.env)).stdout);
    expect(s.lock).toMatchObject({ state: 'stale', alive: false });
    expect(s.busy.tts).toBeNull();
    expect(existsSync(lock)).toBe(true);
    mkdirSync(`${lock}.break`);
    // a fresh mutex: someone is breaking it now
    s = JSON.parse((await cli(['services', 'status', '--json'], c.env)).stdout);
    expect(s.breaking).toBe(true);
    expect(s.busy.tts).toEqual({ reason: 'breaking' });
    // a mutex older than 30 s is a dead breaker's: not "breaking", a warning
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(`${lock}.break`, old, old);
    s = JSON.parse((await cli(['services', 'status', '--json'], c.env)).stdout);
    expect(s.breaking).toBe(false);
    expect(s.busy.tts).toBeNull();
    expect(s.warnings.join()).toMatch(/stale breaker mutex/);
    const c2 = await env();
    mkdirSync(join(c2.state, 'heavy.lock.d'));
    mkdirSync(join(c2.state, 'heavy.lock.d.stale.0000abcd'));
    utimesSync(join(c2.state, 'heavy.lock.d.stale.0000abcd'), old, old);
    const dead = {
      pid: deadPid(),
      pid_start: 'x',
      port: 1,
      server_pgid: null,
      id: 'script2video-tts',
      wrapper_version: '0',
      started: '',
    };
    writeFileSync(join(c2.state, 'resident.json'), JSON.stringify(dead));
    s = JSON.parse((await cli(['services', 'status', '--json'], c2.env)).stdout);
    expect(s.lock).toMatchObject({ state: 'invalid', alive: false });
    expect(s.cleaned).toEqual(['heavy.lock.d.stale.0000abcd']);
    expect(s.resident).toMatchObject({ alive: false });
    expect(existsSync(join(c2.state, 'resident.json'))).toBe(true);
    expect(statSync(join(c2.state, 'heavy.lock.d')).isDirectory()).toBe(true);
  });
});

describe('character missing --apply and the work lock', { timeout: 60_000 }, () => {
  const yaml = `source: generated\nlicense: test\nviews:\n  front: { facing: front, pivot: [20, 30] }\nheads:\n  front/glance: { facing: right }\nbodies:\n  front/wave: {}\nexpressions:\n  neutral: {}\n  happy: {}\nfaces:\n  neutral: { view: front, expression: neutral }\n  glance-neutral: { view: front, head: glance, expression: neutral }\n  wave: { view: front, body: wave, expression: happy }\nsets:\n  head:\n    views: { front: {} }\n    faces: [neutral]\n`;

  function fixture() {
    const dir = tmp('apply');
    for (const k of ['c', 'd']) {
      mkdirSync(join(dir, k));
      writeFileSync(join(dir, k, 'character.yaml'), yaml);
    }
    const script = join(dir, 'script.ko.md');
    // c needs faces in its head set; d is only in the full shot (nothing to add)
    writeFileSync(
      script,
      `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: c }\n  b: { voice: "qwen:Sohee", character: d }\n---\n# s\n\n::shot{a=head}\n\na{face=wave}: 안녕.\n\nb: 네.\n`,
    );
    return { dir, script };
  }

  it('C6 a busy character it would write: 74, nothing written; a busy one it would not write does not stop it', async () => {
    const c = await env();
    const f = fixture();
    const p = livePid();
    const busy = (k: string) =>
      writeOwner(join(f.dir, k, '.work', 'op.lock.d'), {
        pid: p.pid,
        pid_start: p.start,
        cmd: `s2v character build ${k}`,
        token: '56'.repeat(16),
      });
    busy('c');
    const r = await cli(['character', 'missing', f.script, '--apply', '--json'], c.env);
    expect(r.status).toBe(74);
    expect(r.stderr).toMatch(/^actor busy: s2v character build c is working on this character/m);
    expect(readFileSync(join(f.dir, 'c', 'character.yaml'), 'utf8')).toBe(yaml);
    // the read-only report says who works on it
    const json = JSON.parse(
      (await cli(['character', 'missing', f.script, '--json'], c.env)).stdout,
    );
    expect(json.find((x: { cast: string }) => x.cast === 'a').running).toMatchObject({
      pid: p.pid,
      cmd: 's2v character build c',
    });
    // only d busy: d has nothing to add, c is written
    const g = fixture();
    writeOwner(join(g.dir, 'd', '.work', 'op.lock.d'), {
      pid: p.pid,
      pid_start: p.start,
      cmd: 's2v character build d',
      token: '78'.repeat(16),
    });
    const r2 = await cli(['character', 'missing', g.script, '--apply', '--json'], c.env);
    expect(r2.status).not.toBe(74);
    expect(readFileSync(join(g.dir, 'c', 'character.yaml'), 'utf8')).not.toBe(yaml);
    expect(readFileSync(join(g.dir, 'd', 'character.yaml'), 'utf8')).toBe(yaml);
    expect(existsSync(join(g.dir, 'c', '.work', 'op.lock.d'))).toBe(false); // released at the end
  });
});

describe('dev', () => {
  it('C8 its steps get the holder token', async () => {
    const out = join(tmp('step'), 'out');
    const cli = driver(
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(out)}, process.env.S2V_HEAVY_LOCK_TOKEN ?? 'none');`,
    );
    process.env.S2V_HEAVY_LOCK_TOKEN = 'ef'.repeat(16);
    try {
      expect(await step(cli, [])).toBe(0);
    } finally {
      delete process.env.S2V_HEAVY_LOCK_TOKEN;
    }
    expect(readFileSync(out, 'utf8')).toBe('ef'.repeat(16));
  });
});
