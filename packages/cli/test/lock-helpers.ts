/** Helpers of the S8 lock tests: live and dead processes, owners, drivers on the built CLI. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { procStart } from '../src/dir-lock.js';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const CLI = join(REPO, 'packages/cli/dist/main.js');
export const dist = (name: string) => pathToFileURL(join(REPO, 'packages/cli/dist', name)).href;
const dirs: string[] = [];
/** A temporary folder, removed by `killChildren` at the end of the test file. */
export const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `s2v-${name}-`));
  dirs.push(d);
  return d;
};

const children: ChildProcess[] = [];

/** Kill it with the others at the end of the test file (or when a test fails half-way). */
export function track<T extends ChildProcess>(c: T): T {
  children.push(c);
  return c;
}

/** A process that stays alive (until the test file ends). */
export function livePid(): { pid: number; start: string; kill: () => void } {
  const c = spawn('sleep', ['120'], { stdio: 'ignore' });
  children.push(c);
  const pid = c.pid!;
  return { pid, start: procStart(pid)!, kill: () => c.kill('SIGKILL') };
}

/** A pid that has ended. */
export function deadPid(): number {
  return spawnSync('true').pid!;
}

/** End of a test file: kill what it started, remove its temporary folders. */
export function killChildren(): void {
  for (const c of children.splice(0)) if (c.exitCode === null) c.kill('SIGKILL');
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** Put an owner into a lock directory as another program would have. */
export function writeOwner(lock: string, owner: Record<string, unknown>): void {
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify(owner));
}

/** A live foreign holder of the machine lock in the current S2V_STATE_DIR. */
export function foreignHeavy(kind = 'tts', token = 'f'.repeat(32)) {
  const p = livePid();
  writeOwner(join(process.env.S2V_STATE_DIR!, 'heavy.lock.d'), {
    kind,
    pid: p.pid,
    pid_start: p.start,
    holder: `someone else (${kind})`,
    token,
  });
  return p;
}

/** Write an ES module to a temporary folder (it imports the built CLI by URL). */
export function driver(code: string): string {
  const f = join(tmp('driver'), 'driver.mjs');
  writeFileSync(f, code);
  return f;
}

/** A /health server answering as `id` (TTS or aligner stub). */
export async function healthStub(
  body: (url: string) => Record<string, unknown> | null,
  onRequest?: (url: string) => void,
): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    onRequest?.(req.url ?? '');
    const b = body(req.url ?? '');
    if (b === null) return; // hang
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(b));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

/** A free TCP port (listen on 0, close). */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/**
 * A folder with a fake `uv`: `uv run … server.py --port N` starts a node server answering /health
 * as the TTS server or aligner (by the folder it runs in), with the lock hash given in
 * FAKE_UV_LOCK_<ID>. It records its start in $FAKE_UV_LOG, exits when stdin closes (the lifeline)
 * (unless FAKE_UV_NO_LIFELINE) and, with FAKE_UV_SLOW_TERM=ms, exits that long after SIGTERM;
 * FAKE_UV_DIE_AFTER=ms ends it on its own (exit 3).
 */
export function fakeUvDir(): string {
  const d = tmp('fake-uv');
  const uv = join(d, 'uv');
  writeFileSync(
    uv,
    `#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
const isTts = path.basename(process.cwd()) === 'tts-server';
const id = isTts ? 'script2video-tts' : 'script2video-aligner';
if (process.env.FAKE_UV_LOG) fs.appendFileSync(process.env.FAKE_UV_LOG, 'start ' + id + ' ' + process.pid + '\\n');
const lock = process.env[isTts ? 'FAKE_UV_LOCK_TTS' : 'FAKE_UV_LOCK_ALIGNER'];
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id, lock_hash: lock, wrapper_version: '0.4.0', device: 'fake', uptime_s: 1 }));
  }
  res.writeHead(404); res.end();
});
server.listen(port, '127.0.0.1');
const bye = () => {
  if (process.env.FAKE_UV_EXIT_LOG) fs.appendFileSync(process.env.FAKE_UV_EXIT_LOG, 'exit ' + id + ' ' + Date.now() + '\\n');
  process.exit(0);
};
process.on('SIGTERM', () => setTimeout(bye, Number(process.env.FAKE_UV_SLOW_TERM || 0)));
if (process.env.S2V_LIFELINE === '1' && !process.env.FAKE_UV_NO_LIFELINE) { process.stdin.on('end', bye); process.stdin.resume(); }
if (process.env.FAKE_UV_DIE_AFTER) setTimeout(() => process.exit(3), Number(process.env.FAKE_UV_DIE_AFTER));
`,
  );
  spawnSync('chmod', ['755', uv]);
  return d;
}
