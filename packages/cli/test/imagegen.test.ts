import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { imagegenCheck } from '../src/doctor.js';
import {
  defaultMemoryLimitGb,
  EXIT_MEMORY,
  imagegenSupported,
  modelsDir,
  modelStates,
  planSetup,
  readImagegenLock,
  runRound,
  runWatched,
} from '../src/imagegen.js';

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const node = process.execPath;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A child that starts a grandchild (same process group), prints its pid and waits. */
const parentScript = (ignoreTerm: boolean) => `
const { spawn } = require('node:child_process');
${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''}
const g = spawn(process.execPath, ['-e', ${JSON.stringify(`${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000)`)}], { stdio: 'ignore' });
console.log('grandchild ' + g.pid);
setInterval(() => {}, 1000);
`;

describe('runWatched (memory watchdog)', () => {
  it('stops the whole process group over the limit and exits 75', async () => {
    let grandchild = 0;
    const logs: string[] = [];
    const r = await runWatched(node, ['-e', parentScript(false)], {
      maxGb: 20,
      everyMs: 50,
      sample: async () => (grandchild ? 21.5 : 1),
      onLine: (l) => (grandchild = Number(l.split(' ')[1])),
      log: (m) => logs.push(m),
    });
    expect(r).toEqual({ code: EXIT_MEMORY, peakGb: 21.5, stoppedForMemory: true });
    expect(logs).toEqual(['memory 21.5 GB > limit 20 GB: stopping']);
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it('kills a group that ignores SIGTERM after the grace period', async () => {
    let grandchild = 0;
    const t = Date.now();
    const r = await runWatched(node, ['-e', parentScript(true)], {
      maxGb: 1,
      everyMs: 50,
      graceMs: 300,
      sample: async () => (grandchild ? 2 : 0.5),
      onLine: (l) => (grandchild = Number(l.split(' ')[1])),
    });
    expect(r.code).toBe(EXIT_MEMORY);
    expect(Date.now() - t).toBeGreaterThanOrEqual(300);
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it('passes the exit code and stdout lines through; slow readings only warn', async () => {
    const lines: string[] = [];
    const logs: string[] = [];
    const r = await runWatched(
      node,
      ['-e', 'console.log("a"); console.log("b"); setTimeout(() => process.exit(3), 300)'],
      {
        maxGb: 1,
        everyMs: 30,
        sample: async () => null,
        onLine: (l) => lines.push(l),
        log: (m) => logs.push(m),
      },
    );
    expect(r).toEqual({ code: 3, peakGb: 0, stoppedForMemory: false });
    expect(lines).toEqual(['a', 'b']);
    expect(logs).toEqual([
      'warning: could not read memory use (footprint missing, or the machine is swapping)',
    ]);
  });

  it('a child that finishes on its own while being stopped reports its own exit', async () => {
    let ready = false;
    const r = await runWatched(
      node,
      [
        '-e',
        'process.on("SIGTERM", () => process.exit(0)); console.log("ready"); setInterval(() => {}, 1000)',
      ],
      {
        maxGb: 1,
        everyMs: 30,
        sample: async () => (ready ? 2 : 0.5),
        onLine: () => (ready = true),
      },
    );
    expect(r).toMatchObject({ code: 0, stoppedForMemory: false });
  });

  it('Ctrl-C stops the group with 130, not as a memory stop', async () => {
    let grandchild = 0;
    const r = await runWatched(node, ['-e', parentScript(false)], {
      maxGb: 1,
      everyMs: 30,
      sample: async () => 0.5,
      onLine: (l) => {
        grandchild = Number(l.split(' ')[1]);
        process.emit('SIGINT');
      },
    });
    expect(r).toMatchObject({ code: 130, stoppedForMemory: false });
    expect(process.listenerCount('SIGINT')).toBe(0);
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(grandchild)).toBe(false);
  });

  it('drains stdout when nobody reads it (a full pipe would block the child)', async () => {
    const r = await runWatched(node, ['-e', 'process.stdout.write("x".repeat(4e6))'], {
      maxGb: 1,
      sample: async () => 0.1,
    });
    expect(r.code).toBe(0);
  });
});

describe('imagegen setup plan', () => {
  const saved = process.env.S2V_MODELS_DIR;
  const temps: string[] = [];
  const tempDir = (prefix: string) => {
    const d = mkdtempSync(join(tmpdir(), prefix));
    temps.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
    if (saved === undefined) delete process.env.S2V_MODELS_DIR;
    else process.env.S2V_MODELS_DIR = saved;
  });
  const lock = readImagegenLock(REPO);
  const complete = (path: string) => {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, '.s2v-complete'), '{}');
  };

  it('defaults the memory limit to max(24 GB, 60 % of RAM)', () => {
    expect(defaultMemoryLimitGb(64e9)).toBe(38);
    expect(defaultMemoryLimitGb(32e9)).toBe(24);
  });

  it('needs ~90 GB from scratch, credits partial downloads and skips what is done', () => {
    process.env.S2V_MODELS_DIR = tempDir('s2v-models-');
    const fresh = tempDir('s2v-repo-');
    expect(planSetup(fresh, lock)).toMatchObject({
      steps: ['sync', 'download-source', 'download-lora', 'quantize', 'smoke'],
      needGb: 90,
    });
    const s = modelStates(lock);
    expect(s.quantized.path.endsWith('qwen-image-edit-2511-q4__6f3ccc0b56e4')).toBe(true);
    // An interrupted download: what is on disk is no longer needed.
    mkdirSync(s.source.path, { recursive: true });
    writeFileSync(join(s.source.path, 'part'), '');
    truncateSync(join(s.source.path, 'part'), 20e9); // sparse: 20 GB by size, no real space
    expect(planSetup(fresh, lock).needGb).toBe(70);
    // The source is only needed until the 4-bit model exists.
    complete(s.quantized.path);
    expect(planSetup(fresh, lock).steps).toEqual(['sync', 'download-lora', 'smoke']);
    complete(s.lora.path);
    expect(planSetup(fresh, lock)).toMatchObject({ steps: ['sync', 'smoke'], needGb: 0 });
  });

  it('a relative S2V_MODELS_DIR becomes absolute (Python runs in imagegen/)', () => {
    process.env.S2V_MODELS_DIR = 'rel-models';
    expect(modelsDir()).toBe(resolve('rel-models'));
  });

  it('doctor: optional, and never a failure', () => {
    process.env.S2V_MODELS_DIR = tempDir('s2v-models-');
    expect(imagegenCheck(REPO, false)).toMatchObject({ ok: true, optional: true });
    const c = imagegenCheck(REPO, true);
    expect(c.optional).toBe(true);
  });

  it('runRound asks for setup when the environment is missing (or the platform is wrong)', async () => {
    await expect(
      runRound(tempDir('s2v-repo-'), ['--smoke', tmpdir()], { maxGb: 24 }),
    ).rejects.toThrow(imagegenSupported() ? /s2v character setup/ : /Apple silicon/);
  });
});
