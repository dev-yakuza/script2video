/**
 * A small Chrome DevTools Protocol client over `--remote-debugging-pipe` (S5 plan 2.1): the
 * browser reads NUL-terminated JSON messages on fd 3 and writes them on fd 4. No TCP port is
 * opened. Messages are cut from a byte buffer before decoding, so a multibyte character split
 * across chunks stays whole.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';

/** Cuts NUL-terminated messages out of a byte stream (chunks may split or join them). */
export class FrameReader {
  private parts: Buffer[] = [];

  push(chunk: Buffer): string[] {
    const out: string[] = [];
    let start = 0;
    for (let at = chunk.indexOf(0); at !== -1; at = chunk.indexOf(0, start)) {
      this.parts.push(chunk.subarray(start, at));
      out.push(Buffer.concat(this.parts).toString('utf8'));
      this.parts = [];
      start = at + 1;
    }
    if (start < chunk.length) this.parts.push(chunk.subarray(start));
    return out;
  }
}

// CDP results are untyped JSON; each caller reads the fields it asked for
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
export type CdpEvent = { method: string; params: Json; sessionId?: string };

export class CdpError extends Error {}

export class Cdp {
  private next = 1;
  private pending = new Map<
    number,
    { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }
  >();
  private listeners = new Set<(e: CdpEvent) => void>();
  private closed: Error | null = null;

  constructor(
    private readonly out: Writable,
    input: Readable,
  ) {
    const reader = new FrameReader();
    input.on('data', (chunk: Buffer) => {
      for (const text of reader.push(chunk)) this.receive(JSON.parse(text) as Json);
    });
    const end = () => this.close(new CdpError('the browser closed'));
    input.on('end', end);
    input.on('error', end);
    out.on('error', end);
  }

  private receive(msg: Json): void {
    if (typeof msg.id === 'number') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result ?? {});
      return;
    }
    const event: CdpEvent = { method: msg.method, params: msg.params ?? {} };
    if (msg.sessionId) event.sessionId = msg.sessionId;
    for (const l of [...this.listeners]) l(event);
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.next++;
    const msg: Json = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.out.write(JSON.stringify(msg) + '\0');
    });
  }

  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(reason: Error): void {
    if (this.closed) return;
    this.closed = reason;
    for (const p of this.pending.values()) p.reject(reason);
    this.pending.clear();
  }
}

export interface Browser {
  cdp: Cdp;
  /** Kill the browser and remove its profile (safe to call twice). */
  close(): Promise<void>;
  /** The browser's last stderr lines (for an error message). */
  stderr(): string;
}

/** Start a headless browser on a fresh profile, CDP over the pipe. */
export function launchBrowser(path: string, args: string[]): Browser {
  const profile = mkdtempSync(join(tmpdir(), 's2v-capture-'));
  const child: ChildProcess = spawn(
    path,
    [...args, `--user-data-dir=${profile}`, '--remote-debugging-pipe'],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  );
  let err = '';
  child.stderr!.on('data', (c: Buffer) => {
    err = (err + c.toString('utf8')).slice(-4000);
  });
  const cdp = new Cdp(child.stdio[3] as Writable, child.stdio[4] as Readable);
  const exited = new Promise<void>((resolve) => {
    if (child.exitCode !== null) resolve();
    child.once('exit', () => resolve());
    child.once('error', (e) => {
      err += `\n${e.message}`;
      cdp.close(new CdpError(`cannot start the browser: ${e.message}`));
      resolve();
    });
  });
  child.once('exit', () => cdp.close(new CdpError('the browser closed')));
  let closing: Promise<void> | null = null;
  return {
    cdp,
    stderr: () => err.trim(),
    close() {
      closing ??= (async () => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
        rmSync(profile, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}
