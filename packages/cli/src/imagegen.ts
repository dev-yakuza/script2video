/**
 * Character image generation environment (plan C13, C14, 4.5): the optional `imagegen/` uv
 * environment, its pinned models (imagegen.lock.json), `s2v character setup`, and the runner that
 * starts one Python process per round under a memory watchdog.
 *
 * MLX's own memory limit crashes Metal, so the limit is enforced from outside: the venv's python
 * runs in its own process group and `footprint` (phys_footprint, what Activity Monitor shows) is
 * read every 3 s. Over the limit: SIGTERM to the group, SIGKILL 30 s later, exit code 75.
 */

import { execFile, spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
} from 'node:fs';
import { constants, homedir, tmpdir, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

export const IMAGEGEN_DIR = 'imagegen';
export const IMAGEGEN_LOCK = 'imagegen.lock.json';
/** Exit code of a process stopped for memory (EX_TEMPFAIL: run again to resume). */
export const EXIT_MEMORY = 75;
/** Minimum machine (plan C14). */
export const MIN_RAM_GB = 32;
const MARKER = '.s2v-complete';
const GB = 1e9;
/** RAM is sold in binary GB: a 32 GB Mac has 32 GiB. */
const RAM_GB = 2 ** 30;
export const ramGb = (bytes = totalmem()) => bytes / RAM_GB;

interface LockModel {
  repo: string;
  revision: string;
  license: string;
  size_gb: number;
  allow_patterns?: string[];
}
export interface ImagegenLock {
  models: Record<string, LockModel>;
  quantized: { name: string; from: string; bits: number; size_gb: number };
  lora: { model: string; file: string; steps: number };
}

export const imagegenSupported = (platform = process.platform, arch = process.arch) =>
  platform === 'darwin' && arch === 'arm64';

export function readImagegenLock(repoRoot: string): ImagegenLock {
  return JSON.parse(readFileSync(join(repoRoot, IMAGEGEN_LOCK), 'utf8')) as ImagegenLock;
}

/** Absolute: the Python steps run in imagegen/ and get it through the environment. */
export const modelsDir = () =>
  resolve(process.env.S2V_MODELS_DIR ?? join(homedir(), '.cache', 'script2video', 'models'));

/** Environment for the Python steps: the same models folder, unbuffered output, the lifeline. */
const pythonEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  S2V_MODELS_DIR: modelsDir(),
  PYTHONUNBUFFERED: '1',
  S2V_LIFELINE: '1',
  ...extra,
});

/** Same rule as imagegen/models.py: the lock name as is, then the revision's first 12. */
export const modelPath = (name: string, revision: string) =>
  join(modelsDir(), `${name}__${revision.slice(0, 12)}`);

export const imagegenPython = (repoRoot: string) =>
  join(repoRoot, IMAGEGEN_DIR, '.venv', 'bin', 'python');

export interface ModelState {
  name: string;
  path: string;
  /** Downloaded or quantized to the end (its marker file exists). */
  complete: boolean;
  sizeGb: number;
}

/** The three pieces: the bf16 source, the LoRA, and the 4-bit model made from the source. */
export function modelStates(lock: ImagegenLock): {
  source: ModelState;
  lora: ModelState;
  quantized: ModelState;
} {
  const state = (name: string, revision: string, sizeGb: number): ModelState => {
    const path = modelPath(name, revision);
    return { name, path, complete: existsSync(join(path, MARKER)), sizeGb };
  };
  const src = lock.models[lock.quantized.from]!;
  const lora = lock.models[lock.lora.model]!;
  return {
    source: state(lock.quantized.from, src.revision, src.size_gb),
    lora: state(lock.lora.model, lora.revision, lora.size_gb),
    quantized: state(lock.quantized.name, src.revision, lock.quantized.size_gb),
  };
}

/**
 * Quantization reads the bf16 weights: its footprint peaks at 30–32 GB (measured on a 64 GB Mac,
 * MLX cache limited). It runs once, so its default limit sits above that peak.
 */
export const QUANTIZE_PEAK_GB = 32;

/** Default memory limit: max(24 GB, 60 % of RAM) (plan C14). */
export const defaultMemoryLimitGb = (ramBytes = totalmem()) =>
  Math.max(24, Math.round((ramBytes / GB) * 0.6));

/** phys_footprint of one process in GB; null when it cannot be read in time (e.g. swapping). */
export function footprintGb(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      'footprint',
      ['-f', 'bytes', '--noCategories', '-p', String(pid)],
      { timeout: 20_000 },
      (err, stdout) => {
        const m = /phys_footprint:\s*(\d+)\s*B/.exec(stdout ?? '');
        resolve(err && !m ? null : m ? Number(m[1]) / GB : null);
      },
    );
  });
}

export interface WatchOptions {
  maxGb: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Sampling interval (default 3 s) and SIGTERM → SIGKILL grace (default 30 s). */
  everyMs?: number;
  graceMs?: number;
  /** Memory reader (tests replace it; default: footprint). */
  sample?: (pid: number) => Promise<number | null>;
  onLine?: (line: string) => void;
  log?: (message: string) => void;
}

export interface WatchResult {
  /** The child's exit code; EXIT_MEMORY when stopped for memory, 130 on Ctrl-C / hangup. */
  code: number;
  peakGb: number;
  stoppedForMemory: boolean;
}

/**
 * Run a command in its own process group under the memory watchdog. stdout lines go to onLine;
 * stderr is passed through. Ctrl-C / hangup stops the whole group (it is not in the terminal's
 * group); a second Ctrl-C kills it at once. stdin is a lifeline: if this process dies without
 * cleanup (SIGKILL), the pipe closes and the Python side exits (S2V_LIFELINE, imagegen/models.py).
 */
export function runWatched(cmd: string, args: string[], opts: WatchOptions): Promise<WatchResult> {
  const log = opts.log ?? (() => {});
  const sample = opts.sample ?? footprintGb;
  const graceMs = opts.graceMs ?? 30_000;
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
    detached: true,
  });
  const pid = child.pid;
  let peak = 0;
  let stopped = false;
  let interrupted = false;
  let reading = false;
  let slowReads = 0;
  let closed = false;
  let kill: NodeJS.Timeout | undefined;
  const signalGroup = (sig: NodeJS.Signals) => {
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig);
    } catch {
      // Already gone.
    }
  };
  const stop = () => {
    signalGroup('SIGTERM');
    kill ??= setTimeout(() => signalGroup('SIGKILL'), graceMs);
  };
  const onSignal = () => {
    if (interrupted) signalGroup('SIGKILL');
    interrupted = true;
    stop();
  };
  const onExit = () => signalGroup('SIGKILL');
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const sig of signals) process.on(sig, onSignal);
  process.on('exit', onExit);
  child.stdin?.on('error', () => {}); // EPIPE when the child exits first
  if (child.stdout) {
    if (opts.onLine) createInterface({ input: child.stdout }).on('line', opts.onLine);
    else child.stdout.resume(); // never let a full pipe block the child
  }
  const timer = setInterval(() => {
    if (reading || pid === undefined || stopped || interrupted) return;
    reading = true;
    void sample(pid)
      .then((gb) => {
        if (gb === null) {
          // footprint stalls when the machine swaps hard: say so, keep watching.
          if (child.exitCode === null && ++slowReads === 1)
            log(
              'warning: could not read memory use (footprint missing, or the machine is swapping)',
            );
          return;
        }
        slowReads = 0;
        peak = Math.max(peak, gb);
        // A slow reading may come back after the child is gone: never stop a finished run.
        if (gb > opts.maxGb && !stopped && !interrupted && !closed) {
          stopped = true;
          log(`memory ${gb.toFixed(1)} GB > limit ${opts.maxGb} GB: stopping`);
          stop();
        }
      })
      .finally(() => {
        reading = false;
      });
  }, opts.everyMs ?? 3000);
  return new Promise((resolve, reject) => {
    const done = () => {
      closed = true;
      clearInterval(timer);
      if (kill) clearTimeout(kill);
      for (const sig of signals) process.off(sig, onSignal);
      process.off('exit', onExit);
    };
    child.once('error', (e) => {
      done();
      reject(e);
    });
    child.once('close', (code, signal) => {
      done();
      // A child that finished on its own while being stopped did its work: report that.
      const finished = code === 0 && !signal;
      const exit = finished
        ? 0
        : stopped
          ? EXIT_MEMORY
          : interrupted
            ? 130
            : (code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
      resolve({ code: exit, peakGb: peak, stoppedForMemory: stopped && !finished });
    });
  });
}

/** An error with the exit code the CLI should end with. */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
  ) {
    super(message);
  }
}

/** Exit code of a Python step for a bad round or a broken environment (run.py). */
export const EXIT_USAGE = 2;

export type RoundEvent =
  | { event: 'loaded'; s: number }
  | { event: 'encoded'; jobs: number }
  | { event: 'skipped'; out: string }
  | { event: 'done'; out: string; index: number; total: number; s: number; peak_gb: number }
  | { event: 'error'; message: string };

/** A round file for `imagegen/run.py` (checked there by check_round). */
export interface Round {
  /** 64–1024, multiples of 16. */
  width: number;
  height: number;
  /** Must equal the Lightning LoRA's steps (imagegen.lock.json); omitted = that value. */
  steps?: number;
  jobs: RoundJob[];
}

export interface RoundJob {
  out: string;
  prompt: string;
  /** Reference image; null edits a plain gray canvas (candidates). */
  image: string | null;
  seed: number;
}

/** Run `imagegen/run.py` on a round file (or `--smoke <dir>`) under the watchdog. */
export async function runRound(
  repoRoot: string,
  args: string[],
  opts: { maxGb: number; onEvent?: (e: RoundEvent) => void; log?: (m: string) => void },
): Promise<WatchResult> {
  if (!imagegenSupported())
    throw new Error('character generation needs macOS on Apple silicon (MLX)');
  const python = imagegenPython(repoRoot);
  if (!existsSync(python))
    throw new Error('the image generation environment is missing: run s2v character setup');
  return runWatched(python, [join(repoRoot, IMAGEGEN_DIR, 'run.py'), ...args], {
    maxGb: opts.maxGb,
    cwd: join(repoRoot, IMAGEGEN_DIR),
    env: pythonEnv({ HF_HUB_OFFLINE: '1' }),
    ...(opts.log ? { log: opts.log } : {}),
    onLine: (line) => {
      try {
        const e = JSON.parse(line) as RoundEvent;
        if (e && typeof e === 'object' && 'event' in e) {
          opts.onEvent?.(e);
          return;
        }
      } catch {
        // A plain line from a library: show it as is.
      }
      opts.log?.(line);
    },
  });
}

/** Free space (GB) where the models go; the nearest existing parent folder is measured. */
function freeGb(dir: string): number {
  let d = dir;
  while (!existsSync(d)) d = join(d, '..');
  const fs = statfsSync(d);
  return (fs.bavail * fs.bsize) / GB;
}

/** Bytes under a folder (symlinks not followed); 0 when it does not exist. */
export function folderBytes(path: string): number {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let names: string[];
  try {
    names = readdirSync(path);
  } catch {
    return 0; // unreadable: count nothing rather than fail the plan
  }
  let total = 0;
  for (const f of names) total += folderBytes(join(path, f));
  return total;
}

export interface SetupPlan {
  steps: ('sync' | 'download-source' | 'download-lora' | 'quantize' | 'smoke')[];
  needGb: number;
  freeGb: number;
}

/** Disk headroom on top of the downloads (temporary files). */
const DISK_MARGIN_GB = 8;

/**
 * What `setup` still has to do. The bf16 source is needed only until the 4-bit model exists:
 * once it does, the source is neither downloaded nor checked. `uv sync` always runs (cheap, and
 * it follows uv.lock changes). Space already taken by an interrupted download, or by a leftover
 * `.partial` quantization (deleted before quantizing), counts toward what is needed.
 */
export function planSetup(_repoRoot: string, lock: ImagegenLock): SetupPlan {
  const s = modelStates(lock);
  const steps: SetupPlan['steps'] = ['sync'];
  let need = 0;
  const remaining = (m: ModelState) => Math.max(0, m.sizeGb - folderBytes(m.path) / GB);
  if (!s.quantized.complete && !s.source.complete) {
    steps.push('download-source');
    need += remaining(s.source);
  }
  if (!s.lora.complete) {
    steps.push('download-lora');
    need += remaining(s.lora);
  }
  if (!s.quantized.complete) {
    steps.push('quantize');
    need += Math.max(
      0,
      s.quantized.sizeGb -
        (folderBytes(s.quantized.path) + folderBytes(`${s.quantized.path}.partial`)) / GB,
    );
  }
  steps.push('smoke');
  return {
    steps,
    needGb: need > 0 ? Math.ceil(need + DISK_MARGIN_GB) : 0,
    freeGb: freeGb(modelsDir()),
  };
}

/**
 * Run a step with the terminal's output. With `lifeline` (Python steps; pythonEnv sets
 * S2V_LIFELINE), stdin is a pipe kept open by this process, never the terminal: the Python side
 * exits when it closes.
 */
function run(
  cmd: string,
  args: string[],
  cwd: string,
  opts: { env?: NodeJS.ProcessEnv; lifeline?: boolean } = {},
): Promise<number> {
  return new Promise((done, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: [opts.lifeline ? 'pipe' : 'inherit', 'inherit', 'inherit'],
      env: opts.env ?? process.env,
    });
    child.stdin?.on('error', () => {});
    child.once('error', (e: NodeJS.ErrnoException) =>
      reject(
        e.code === 'ENOENT'
          ? new Error(`${cmd} is not installed (see s2v doctor for how to install it)`)
          : e,
      ),
    );
    child.once('close', (code, signal) =>
      done(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1)),
    );
  });
}

/**
 * `s2v character setup`: RAM and disk checks → uv sync → bf16 download (54 GB) → 4-bit
 * quantization (27 GB) → smoke generation → how to delete the bf16 source. Every step is skipped
 * when done, so it can be rerun after an interruption.
 */
export async function setupImagegen(
  repoRoot: string,
  opts: {
    /** Generation limit (smoke test); also the quantization limit when `explicit`. */
    maxGb: number;
    /** The user set --max-memory-gb: use it for every step. */
    explicit?: boolean;
    log: (m: string) => void;
  },
): Promise<void> {
  const { log } = opts;
  if (!imagegenSupported())
    throw new Error(
      'character generation needs macOS on Apple silicon (MLX); parts characters still render here',
    );
  const ram = ramGb();
  if (ram < MIN_RAM_GB - 0.5)
    throw new Error(
      `character generation needs ${MIN_RAM_GB} GB of RAM (this Mac: ${ram.toFixed(0)} GB)`,
    );
  const lock = readImagegenLock(repoRoot);
  const plan = planSetup(repoRoot, lock);
  if (opts.explicit && plan.steps.includes('quantize') && opts.maxGb < QUANTIZE_PEAK_GB)
    throw new Error(
      `quantization needs about ${QUANTIZE_PEAK_GB} GB: --max-memory-gb ${opts.maxGb} would stop it every time`,
    );
  if (plan.needGb > plan.freeGb)
    throw new Error(
      `not enough disk space in ${modelsDir()}: ${plan.needGb} GB needed, ${plan.freeGb.toFixed(0)} GB free (set S2V_MODELS_DIR to use another disk)`,
    );
  log(`setup: ${plan.steps.join(' → ')}${plan.needGb ? ` (needs ${plan.needGb} GB of disk)` : ''}`);
  mkdirSync(modelsDir(), { recursive: true });
  const dir = join(repoRoot, IMAGEGEN_DIR);
  const python = imagegenPython(repoRoot);
  const quantizeGb = opts.explicit ? opts.maxGb : Math.max(opts.maxGb, QUANTIZE_PEAK_GB + 4);
  const fail = (step: string, code: number, limitGb = opts.maxGb, reason?: string) =>
    code === EXIT_USAGE && reason
      ? // A broken environment: rerunning does not fix it.
        new ExitError(`${step} failed: ${reason}`, 1)
      : code === EXIT_MEMORY
        ? new ExitError(
            `${step} stopped at the memory limit (${limitGb} GB); close other apps or raise --max-memory-gb, then run s2v character setup again`,
            EXIT_MEMORY,
          )
        : code === 130
          ? new ExitError(`${step} interrupted; run s2v character setup again to resume`, 130)
          : new ExitError(
              `${step} failed (exit ${code}); run s2v character setup again to resume`,
              1,
            );
  const states = modelStates(lock);
  for (const step of plan.steps) {
    if (step === 'sync') {
      log('setup: imagegen/.venv (uv sync)');
      const code = await run('uv', ['sync', '--frozen'], dir);
      if (code !== 0) throw fail('uv sync', code);
    } else if (step === 'download-source' || step === 'download-lora') {
      const name = step === 'download-source' ? states.source.name : states.lora.name;
      const code = await run(python, ['setup_models.py', 'download', name], dir, {
        env: pythonEnv(),
        lifeline: true,
      });
      if (code !== 0) throw fail(`download of ${name}`, code);
    } else if (step === 'quantize') {
      log(`setup: quantizing to 4 bits (a few minutes; memory limit ${quantizeGb} GB)`);
      if (ram < QUANTIZE_PEAK_GB * 1.5)
        log(
          `warning: quantization peaks near ${QUANTIZE_PEAK_GB} GB and this Mac has ${ram.toFixed(0)} GB: close other apps (it may swap)`,
        );
      const r = await runWatched(python, ['setup_models.py', 'quantize'], {
        maxGb: quantizeGb,
        cwd: dir,
        env: pythonEnv({ HF_HUB_OFFLINE: '1' }),
        onLine: log,
        log,
      });
      if (r.code !== 0) {
        // The unfinished copy can be ~20 GB: do not leave it until the next run.
        rmSync(`${states.quantized.path}.partial`, { recursive: true, force: true });
        throw fail('quantization', r.code, quantizeGb);
      }
      log(`setup: quantized (peak ${r.peakGb.toFixed(1)} GB)`);
    } else {
      log('setup: smoke test (loads the model and makes one 64×64 image)');
      const out = mkdtempSync(join(tmpdir(), 's2v-smoke-'));
      let reason: string | undefined;
      const r = await runRound(repoRoot, ['--smoke', out], {
        maxGb: opts.maxGb,
        log,
        onEvent: (e) => {
          if (e.event === 'loaded') log(`setup: model loaded in ${e.s}s`);
          if (e.event === 'error') reason = e.message;
        },
      }).finally(() => rmSync(out, { recursive: true, force: true }));
      if (r.code !== 0) throw fail('smoke test', r.code, opts.maxGb, reason);
      log(`setup: ready (peak ${r.peakGb.toFixed(1)} GB)`);
    }
  }
  const src = modelStates(lock).source;
  if (existsSync(src.path))
    log(
      `the bf16 source (${src.sizeGb} GB) is no longer needed; delete it to free space:\n  rm -rf "${src.path}"`,
    );
}
