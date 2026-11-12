/**
 * `s2v doctor`: is this machine ready to synthesize and render? Each check says what is missing
 * and the command that fixes it. Nothing is installed or downloaded.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import {
  imagegenPython,
  imagegenSupported,
  MIN_RAM_GB,
  modelsDir,
  modelStates,
  oldModelsHint,
  ramGb,
  readImagegenLock,
} from './imagegen.js';
import { fontsDir } from './media.js';
import { ALIGNER, Service, TTS_SERVER } from './services.js';

const run = promisify(execFile);

export interface Check {
  name: string;
  ok: boolean;
  /** Not required for every use (e.g. a model only personas need). */
  optional?: boolean;
  detail: string;
  fix?: string;
}

/** Models every final render needs; the rest are needed only for some features. */
const REQUIRED_MODELS = new Set([
  'qwen3-tts-1.7b-customvoice',
  'qwen3-asr-0.6b',
  'qwen3-forcedaligner-0.6b',
]);
const MODEL_USE: Record<string, string> = {
  'qwen3-tts-0.6b-customvoice': 'smaller Qwen model (optional)',
  'qwen3-tts-1.7b-voicedesign': 'persona voices: s2v voice create',
  'qwen3-tts-1.7b-base': 'persona voices: synthesis',
  'supertonic-3': 'supertonic: voices and drafts',
};

async function version(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout, stderr } = await run(cmd, args);
    return (stdout || stderr).split('\n')[0]!.trim();
  } catch {
    return null;
  }
}

export interface EnvSync {
  state: 'ok' | 'stale' | 'missing' | 'error';
  detail: string;
}

/**
 * Is the uv environment in `dir` usable offline? A Python patch upgrade makes uv see the venv as
 * stale: `uv run --frozen --offline` then removes it and cannot reinstall it. A dry run changes
 * nothing and needs no network; `--inexact` because `uv run` accepts extra packages, `--color
 * never` because FORCE_COLOR puts ANSI codes before `Would`. The `Would` lines go to stderr.
 */
export function envSyncCheck(dir: string, uvCmd = 'uv', timeoutMs = 20_000): Promise<EnvSync> {
  const args = ['sync', '--frozen', '--offline', '--inexact', '--dry-run', '--color', 'never'];
  return new Promise((done) =>
    execFile(uvCmd, args, { cwd: dir, timeout: timeoutMs }, (err, stdout, stderr) => {
      const lines = `${stdout}\n${stderr}`.split('\n').map((l) => l.trimEnd());
      if (err) {
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') return done({ state: 'error', detail: `${uvCmd} not found` });
        if (e.killed)
          return done({
            state: 'error',
            detail: `uv sync --dry-run took over ${timeoutMs / 1000} s`,
          });
        const at = lines.findIndex((l) => /^error:/.test(l));
        const cause = at < 0 ? undefined : lines.slice(at + 1).find((l) => /^\s*cause:/.test(l));
        const detail =
          at < 0
            ? (lines.filter((l) => l.trim()).at(-1) ?? `exit ${String(e.code)}`)
            : [lines[at]!, ...(cause ? [cause.trim()] : [])].join(' ');
        return done({ state: 'error', detail });
      }
      // "Would make no changes" is printed even with these: it describes the packages only
      if (lines.some((l) => /^Would create project environment/.test(l)))
        return done({ state: 'missing', detail: 'not created' });
      const changed = lines.find((l) =>
        /^Would (replace project environment|install|uninstall|download)/.test(l),
      );
      if (changed)
        return done({
          state: 'stale',
          detail: `${changed}: Python or the lock changed since the environment was made`,
        });
      done({ state: 'ok', detail: 'in sync' });
    }),
  );
}

export async function doctor(repoRoot: string): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  const major = Number(process.versions.node.split('.')[0]);
  add({
    name: 'Node.js',
    ok: major >= 22,
    detail: `v${process.versions.node}`,
    ...(major >= 22 ? {} : { fix: 'install Node.js 22 or newer' }),
  });

  const ff = await version('ffmpeg', ['-hide_banner', '-version']);
  let filters = '';
  if (ff) filters = (await run('ffmpeg', ['-hide_banner', '-filters'])).stdout;
  const missing = ['ebur128', 'alimiter', 'atempo', 'silenceremove', 'aresample', 'xstack'].filter(
    (f) => !new RegExp(`\\s${f}\\s`).test(filters),
  );
  add({
    name: 'ffmpeg',
    ok: ff !== null && missing.length === 0,
    detail: ff
      ? `${ff}${missing.length ? `; missing filters: ${missing.join(', ')}` : ''}`
      : 'not found',
    ...(ff && missing.length === 0 ? {} : { fix: 'brew install ffmpeg (or your package manager)' }),
  });

  const uv = await version('uv', ['--version']);
  add({
    name: 'uv',
    ok: uv !== null,
    detail: uv ?? 'not found',
    ...(uv ? {} : { fix: 'curl -LsSf https://astral.sh/uv/install.sh | sh' }),
  });
  // in sync, not only present: a stale venv cannot be rebuilt offline
  for (const dir of ['tts-server', 'aligner']) {
    const r: EnvSync = uv
      ? await envSyncCheck(join(repoRoot, dir))
      : { state: 'error', detail: 'uv not found' };
    const ok = r.state === 'ok';
    add({
      name: `${dir} environment`,
      ok,
      detail: ok ? `${dir}/.venv` : r.detail,
      ...(ok || !uv ? {} : { fix: `(cd ${dir} && uv sync --frozen)  # needs the network` }),
    });
  }

  const models = (
    JSON.parse(readFileSync(join(repoRoot, 'models.lock.json'), 'utf8')) as {
      models: Record<string, { revision: string }>;
    }
  ).models;
  const notFound: string[] = [];
  for (const [name, { revision }] of Object.entries(models)) {
    const dir = join(
      modelsDir(),
      `${name.replace(/[^0-9A-Za-z_]/g, '_')}__${revision.slice(0, 12)}`,
    );
    const ok = existsSync(dir);
    if (!ok) notFound.push(basename(dir));
    const required = REQUIRED_MODELS.has(name);
    add({
      name: `model ${name}`,
      ok,
      optional: !required,
      detail: ok
        ? 'installed'
        : required
          ? 'missing'
          : `missing — ${MODEL_USE[name] ?? 'optional'}`,
      ...(ok
        ? {}
        : { fix: `(cd tts-server && uv run --frozen python scripts/fetch_models.py ${name})` }),
    });
  }

  const supported = imagegenSupported();
  if (supported) {
    // the image models too; the bf16 source only while the 4-bit model is not made
    const s = modelStates(readImagegenLock(repoRoot));
    for (const m of s.quantized.complete ? [s.lora] : [s.quantized, s.source, s.lora])
      if (!m.complete) notFound.push(basename(m.path));
  }
  const hint = oldModelsHint(notFound);
  if (hint) add({ name: 'models folder', ok: false, optional: true, detail: hint });

  // imagegen runs .venv/bin/python directly: a stale environment still works, so only a warning
  let stale: boolean | undefined;
  if (uv && supported && ramGb() >= MIN_RAM_GB - 0.5 && existsSync(imagegenPython(repoRoot))) {
    const r = await envSyncCheck(join(repoRoot, 'imagegen'));
    stale = r.state === 'stale';
    if (r.state === 'error')
      add({ name: 'imagegen environment', ok: false, optional: true, detail: r.detail });
  }
  checks.push(imagegenCheck(repoRoot, supported, stale));

  const fontLock = JSON.parse(readFileSync(join(repoRoot, 'fonts.lock.json'), 'utf8')) as {
    fonts: Record<string, unknown>;
  };
  const fontFiles = Object.keys(fontLock.fonts);
  const missingFonts = fontFiles.filter((f) => !existsSync(join(fontsDir(), f)));
  add({
    name: 'fonts',
    ok: missingFonts.length === 0,
    optional: true,
    detail: missingFonts.length
      ? `not downloaded yet: ${missingFonts.join(', ')} (render fetches them once)`
      : `${fontFiles.length} pinned fonts`,
  });

  const fs = statfsSync(homedir());
  const freeGb = (fs.bavail * fs.bsize) / 1e9;
  add({
    name: 'disk space',
    ok: freeGb > 5,
    detail: `${freeGb.toFixed(0)} GB free`,
    ...(freeGb > 5 ? {} : { fix: 'models need ~15 GB; renders need a few GB of cache' }),
  });

  for (const spec of [TTS_SERVER, ALIGNER]) {
    const h = await new Service(spec, repoRoot).health();
    add({
      name: `${spec.id} (resident)`,
      ok: true,
      optional: true,
      detail: h ? `running on port ${spec.port}` : 'not running (started on demand)',
    });
  }
  return checks;
}

/** Character generation is optional: never a failure, only "not installed" or "not supported". */
export function imagegenCheck(
  repoRoot: string,
  supported = imagegenSupported(),
  /** `uv sync --dry-run` would change imagegen/.venv (doctor's envSyncCheck). */
  stale?: boolean,
  ram = ramGb(),
): Check {
  const name = 'character generation (optional)';
  if (!supported)
    return {
      name,
      ok: true,
      optional: true,
      detail: 'not supported on this platform (macOS on Apple silicon only)',
    };
  if (ram < MIN_RAM_GB - 0.5)
    return {
      name,
      ok: true,
      optional: true,
      detail: `not supported on this Mac: needs ${MIN_RAM_GB} GB of RAM (${ram.toFixed(0)} GB)`,
    };
  const lock = readImagegenLock(repoRoot);
  const s = modelStates(lock);
  const missing = [
    ...(existsSync(imagegenPython(repoRoot)) ? [] : ['imagegen/.venv']),
    ...(s.quantized.complete ? [] : [s.quantized.name]),
    ...(s.lora.complete && existsSync(join(s.lora.path, lock.lora.file)) ? [] : [s.lora.name]),
  ];
  const outdated = 'environment out of date: `s2v character setup` rebuilds it (network)';
  if (missing.length === 0 && !stale)
    return { name, ok: true, optional: true, detail: 'installed' };
  return {
    name,
    ok: false,
    optional: true,
    detail: [
      ...(missing.length ? [`not installed: ${missing.join(', ')}`] : []),
      ...(stale ? [outdated] : []),
    ].join('; '),
    fix: 's2v character setup',
  };
}
