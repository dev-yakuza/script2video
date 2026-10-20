/**
 * Lifecycle of the Python services (PLAN 5.1 / 5.3): spawn on demand as child processes, wait for
 * /health, verify identity, reuse an already running server only when its identity and lock hash
 * match, and stop what we started.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { acquireHeavy, BusyError, readResident, residentProcessAlive } from './heavy-lock.js';
import { forgetGroup, onStop, trackGroup } from './shutdown.js';

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

/** Servers this process started; stopped on exit and on Ctrl-C / kill (no orphans, shutdown.ts). */
const started = new Set<Service>();
onStop(() => {
  for (const s of [...started]) s.stop();
});

export interface EnsureOptions {
  timeoutMs?: number;
  /**
   * Take the machine lock first (S8; default): also when an existing server is reused, since the
   * command that started that server stops it when it ends. `tts-server start` holds it itself.
   */
  lock?: boolean;
}

export class Service {
  private child: ChildProcess | null = null;
  private exit: Promise<{ code: number | string | null; stopped: boolean }> | null = null;
  private stopping = false;

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

  /**
   * A resident tts-server on another port (S2V_TTS_PORT differs): starting one here would load a
   * second TTS model beside it (exit 73). A dead resident.json is left to tts-server start and gen.
   */
  private refuseOtherResidentPort(): void {
    if (this.spec.id !== TTS_SERVER.id) return;
    const r = readResident();
    if (!r || r.port === this.spec.port || !residentProcessAlive(r)) return;
    throw new BusyError(
      'resident',
      `a resident tts-server runs on port ${r.port} (pid ${r.pid}) but this command uses port ${this.spec.port}: use the same S2V_TTS_PORT, or stop it (Ctrl-C the tts-server start terminal)`,
    );
  }

  async ensure(opts: EnsureOptions = {}): Promise<Health> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    if (opts.lock !== false) acquireHeavy('tts');
    this.refuseOtherResidentPort();
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
        // stdin is a lifeline: when this process dies, even by SIGKILL, the pipe closes and the
        // server exits (S8; S2V_LIFELINE, os._exit(1) in its stdin watcher)
        stdio: ['pipe', 'ignore', 'pipe'],
        env: {
          ...process.env,
          HF_HUB_OFFLINE: '1',
          TRANSFORMERS_OFFLINE: '1',
          S2V_LIFELINE: '1',
        },
        // Own process group: stop() ends uv and the Python server it started together.
        detached: true,
      },
    );
    const child = this.child;
    this.stopping = false;
    this.exit = new Promise((resolve) =>
      child.once('exit', (code, signal) =>
        resolve({ code: code ?? signal, stopped: this.stopping }),
      ),
    );
    this.child.stdin?.on('error', () => {}); // EPIPE once the server is gone
    // the lifeline must not keep this process alive
    (this.child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    started.add(this);
    if (this.child.pid !== undefined) trackGroup(this.child.pid);
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
    if (child) this.stopping = true;
    // the group stays tracked (shutdown.ts) until it is seen gone: the lock is released after it.
    // Closing stdin also ends the server through its lifeline (S2V_LIFELINE: os._exit(1)).
    child?.stdin?.destroy();
    this.child = null;
    started.delete(this);
  }

  /** The process group of the server this process started (null when it did not start one). */
  get pgid(): number | null {
    return this.child?.pid ?? null;
  }

  /** How the server this process started ended (null when it did not start one). */
  exited(): Promise<{ code: number | string | null; stopped: boolean }> | null {
    return this.exit;
  }

  /** This process started the server (and can stop it). */
  get owned(): boolean {
    return this.child !== null;
  }

  /**
   * Stop the server this process started and wait until its process group is gone and the port
   * answers no more (stop() only signals): memory is free, and a later ensure() starts a new one.
   */
  async stopAndWait(timeoutMs = 60_000): Promise<void> {
    const pid = this.child?.pid;
    this.stop();
    if (pid === undefined) return;
    const alive = () => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive() && !(await this.health())) {
        forgetGroup(pid);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone
    }
    const hard = Date.now() + 10_000;
    while (alive() && Date.now() < hard) await new Promise((r) => setTimeout(r, 100));
    if (alive()) console.error(`${this.spec.id} (process group ${pid}) did not exit after SIGKILL`);
    else forgetGroup(pid);
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
