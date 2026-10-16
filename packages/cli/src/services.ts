/**
 * Lifecycle of the Python services (PLAN 5.1 / 5.3): spawn on demand as child processes, wait for
 * /health, verify identity, reuse an already running server only when its identity and lock hash
 * match, and stop what we started.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ServiceSpec {
  id: string;
  dir: string;
  port: number;
  /** The server's WRAPPER_VERSION this CLI speaks to (endpoints and fields). */
  wrapper: string;
}

export interface Health {
  id: string;
  lock_hash: string;
  [key: string]: unknown;
}

/** Servers this process started; stopped on exit and on Ctrl-C / kill (no orphans). */
const started = new Set<Service>();
let watching = false;
function watchSignals(): void {
  if (watching) return;
  watching = true;
  const stopAll = () => {
    for (const s of [...started]) s.stop();
  };
  process.once('exit', stopAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
    process.once(sig, () => {
      stopAll();
      process.exit(sig === 'SIGINT' ? 130 : 143);
    });
}

export class Service {
  private child: ChildProcess | null = null;

  constructor(
    readonly spec: ServiceSpec,
    readonly repoRoot: string,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.spec.port}`;
  }

  expectedLockHash(): string {
    const data = Buffer.concat([
      readFileSync(join(this.repoRoot, 'models.lock.json')),
      readFileSync(join(this.repoRoot, this.spec.dir, 'uv.lock')),
    ]);
    return createHash('sha256').update(data).digest('hex').slice(0, 16);
  }

  async health(): Promise<Health | null> {
    try {
      const res = await fetch(`${this.url}/health`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? ((await res.json()) as Health) : null;
    } catch {
      return null;
    }
  }

  async ensure(timeoutMs = 120_000): Promise<Health> {
    const running = await this.health();
    if (running) {
      if (running.id !== this.spec.id || running.lock_hash !== this.expectedLockHash()) {
        throw new Error(
          `port ${this.spec.port} is used by another server (${running.id}, lock ${running.lock_hash}); stop it or change the port`,
        );
      }
      if (running.wrapper_version !== this.spec.wrapper)
        throw new Error(
          `${this.spec.id} on port ${this.spec.port} is version ${String(running.wrapper_version)}, ` +
            `this s2v needs ${this.spec.wrapper}; stop that server so a current one starts`,
        );
      return running;
    }
    this.child = spawn(
      'uv',
      ['run', '--frozen', '--offline', 'python', 'server.py', '--port', String(this.spec.port)],
      {
        cwd: join(this.repoRoot, this.spec.dir),
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
        // Own process group: stop() ends uv and the Python server it started together.
        detached: true,
      },
    );
    started.add(this);
    watchSignals();
    let stderr = '';
    this.child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.child.exitCode !== null) {
        throw new Error(`${this.spec.id} exited early:\n${stderr}`);
      }
      const h = await this.health();
      if (h) return h;
      await new Promise((r) => setTimeout(r, 500));
    }
    this.stop();
    throw new Error(`${this.spec.id} did not become healthy in ${timeoutMs / 1000}s:\n${stderr}`);
  }

  stop(): void {
    const child = this.child;
    if (child && child.exitCode === null && child.pid !== undefined) {
      try {
        process.kill(-child.pid, 'SIGTERM'); // the whole group: uv and python
      } catch {
        child.kill('SIGTERM');
      }
    }
    this.child = null;
    started.delete(this);
  }

  async post<T>(path: string, body: unknown): Promise<{ data: T; headers: Headers }> {
    const res = await fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`${this.spec.id} ${path} failed (${res.status}): ${await res.text()}`);
    const type = res.headers.get('content-type') ?? '';
    const data = (
      type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer())
    ) as T;
    return { data, headers: res.headers };
  }
}

/** A port from the environment (S2V_TTS_PORT / S2V_ALIGNER_PORT), else the default. */
const portFrom = (name: string, fallback: number) => {
  const p = Number(process.env[name]);
  return Number.isInteger(p) && p > 0 && p < 65536 ? p : fallback;
};

export const TTS_SERVER: ServiceSpec = {
  id: 'script2video-tts',
  dir: 'tts-server',
  get port() {
    return portFrom('S2V_TTS_PORT', 47861);
  },
  wrapper: '0.4.0',
};
export const ALIGNER: ServiceSpec = {
  id: 'script2video-aligner',
  dir: 'aligner',
  get port() {
    return portFrom('S2V_ALIGNER_PORT', 47862);
  },
  wrapper: '0.4.0',
};
