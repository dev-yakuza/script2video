import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imagegenCheck } from '../src/doctor.js';
import { DUP_WINDOW_MS, resetShutdownForTests } from '../src/shutdown.js';
import {
  defaultMemoryLimitGb,
  EXIT_MEMORY,
  imagegenSupported,
  MIN_RAM_GB,
  modelsDir,
  modelStates,
  oldModelsDir,
  oldModelsHint,
  planSetup,
  readImagegenLock,
  runRound,
  runWatched,
  setupStop,
  type ModelState,
  type SetupPlan,
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
    expect(r).toEqual({
      code: EXIT_MEMORY,
      peakGb: 21.5,
      stoppedForMemory: true,
      interrupted: false,
    });
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
    expect(r).toEqual({ code: 3, peakGb: 0, stoppedForMemory: false, interrupted: false });
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
    expect(r).toMatchObject({ code: 130, stoppedForMemory: false, interrupted: true });
    expect(process.listenerCount('SIGINT')).toBe(0);
    await new Promise((res) => setTimeout(res, 100));
    expect(alive(grandchild)).toBe(false);
  });

  // A child that takes its time over SIGTERM and then ends with 0 when it got one SIGTERM (5 when
  // more): a SIGKILL instead, or a 5, ends the run as 130.
  const slowTerm = (ms: number) =>
    `let n = 0; process.on("SIGTERM", () => { n++; setTimeout(() => process.exit(n === 1 ? 0 : 5), ${ms}); }); console.log("ready"); setInterval(() => {}, 1000)`;
  const twice = async (first: NodeJS.Signals, second: NodeJS.Signals, gapMs: number) => {
    try {
      return await runWatched(node, ['-e', slowTerm(gapMs + 1500)], {
        maxGb: 1,
        everyMs: 30,
        sample: async () => 0.5,
        onLine: () => {
          process.emit(first);
          if (gapMs === 0) process.emit(second);
          else setTimeout(() => process.emit(second), gapMs);
        },
      });
    } finally {
      resetShutdownForTests();
    }
  };

  it('the same signal twice at once is one signal: the child ends its own way', async () => {
    const r = await twice('SIGTERM', 'SIGTERM', 0);
    expect(r).toMatchObject({ code: 0, interrupted: false });
  });

  it('the same signal again after the duplicate window kills the group', async () => {
    const r = await twice('SIGINT', 'SIGINT', DUP_WINDOW_MS + 200);
    expect(r).toMatchObject({ code: 130, interrupted: true });
  });

  it('another signal right after the first kills the group', async () => {
    const r = await twice('SIGINT', 'SIGTERM', 0);
    expect(r).toMatchObject({ code: 130, interrupted: true });
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
    // a stale environment (doctor's uv dry run) is a warning that names setup
    const stale = imagegenCheck(REPO, true, true, MIN_RAM_GB);
    expect(stale).toMatchObject({ ok: false, optional: true, fix: 's2v character setup' });
    expect(stale.detail).toContain('environment out of date');
    expect(imagegenCheck(REPO, true, true, MIN_RAM_GB - 1).detail).toContain(
      'not supported on this Mac',
    );
  });

  it('runRound asks for setup when the environment is missing (or the platform is wrong)', async () => {
    await expect(
      runRound(tempDir('s2v-repo-'), ['--smoke', tmpdir()], { maxGb: 24 }),
    ).rejects.toThrow(imagegenSupported() ? /s2v character setup/ : /Apple silicon/);
  });
});

describe('models folder (default ~/.cache/models, old-folder hint)', () => {
  const saved = { HOME: process.env.HOME, S2V_MODELS_DIR: process.env.S2V_MODELS_DIR };
  const temps: string[] = [];
  let home: string;
  beforeEach(() => {
    // homedir() follows HOME: the real ~/.cache is never looked at
    home = mkdtempSync(join(tmpdir(), 's2v-home-'));
    temps.push(home);
    process.env.HOME = home;
    delete process.env.S2V_MODELS_DIR;
  });
  afterEach(() => {
    for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
  const old = () => join(home, '.cache', 'script2video', 'models');
  const NEST = 'mv ~/.cache/script2video/models ~/.cache/models`';
  const INTO =
    'mv ~/.cache/script2video/models/* ~/.cache/models/ && rmdir ~/.cache/script2video/models`';

  it('defaults to ~/.cache/models when S2V_MODELS_DIR is unset', () => {
    expect(modelsDir()).toBe(join(home, '.cache', 'models'));
    expect(oldModelsDir()).toBe(old());
  });

  it('hints only when a needed model is in the old folder', () => {
    expect(oldModelsHint(['a__1'])).toBeUndefined(); // no old folder
    mkdirSync(old(), { recursive: true });
    expect(oldModelsHint(['a__1'])).toBeUndefined(); // emptied
    mkdirSync(join(old(), 'unrelated__2'));
    expect(oldModelsHint(['a__1'])).toBeUndefined(); // unrelated
    mkdirSync(join(old(), 'a__1'));
    const h = oldModelsHint(['b__3', 'a__1'])!;
    expect(h).toMatch(/^models are in the old folder ~\/\.cache\/script2video\/models: /);
    expect(h).toContain(NEST);
    expect(h).toMatch(/or set S2V_MODELS_DIR$/);
    // the new folder exists: mv would nest the old one inside it
    mkdirSync(modelsDir(), { recursive: true });
    expect(oldModelsHint(['a__1'])).toContain(INTO);
    // a set S2V_MODELS_DIR is the user's choice: no hint
    process.env.S2V_MODELS_DIR = join(home, 'elsewhere');
    expect(oldModelsHint(['a__1'])).toBeUndefined();
  });

  it('setupStop: stops before a download or quantize step whose folder is in the old folder', () => {
    const lock = readImagegenLock(REPO);
    const s = modelStates(lock);
    const plan = (steps: SetupPlan['steps']): SetupPlan => ({ steps, needGb: 0, freeGb: 0 });
    const all = plan(['sync', 'download-source', 'download-lora', 'quantize', 'smoke']);
    const base = (m: ModelState) => m.path.split('/').at(-1)!;
    expect(setupStop(all, s, old())).toBeUndefined(); // no old folder
    mkdirSync(join(old(), 'unrelated__2'), { recursive: true });
    expect(setupStop(all, s, old())).toBeUndefined();
    mkdirSync(join(old(), base(s.lora)));
    expect(setupStop(all, s, old())).toContain(NEST);
    // not passed (S2V_MODELS_DIR set): never stops
    expect(setupStop(all, s)).toBeUndefined();
    // a step that is done does not look
    expect(
      setupStop(plan(['sync', 'download-source', 'quantize', 'smoke']), s, old()),
    ).toBeUndefined();
    mkdirSync(join(old(), base(s.quantized)));
    expect(setupStop(plan(['sync', 'quantize', 'smoke']), s, old())).toContain(NEST);
    mkdirSync(modelsDir(), { recursive: true });
    expect(setupStop(plan(['sync', 'quantize', 'smoke']), s, old())).toContain(INTO);
    expect(setupStop(plan(['sync', 'smoke']), s, old())).toBeUndefined();
  });
});
