/**
 * `s2v doctor`: is this machine ready to synthesize and render? Each check says what is missing
 * and the command that fixes it. Nothing is installed or downloaded.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
  for (const dir of ['tts-server', 'aligner']) {
    const venv = existsSync(join(repoRoot, dir, '.venv'));
    add({
      name: `${dir} environment`,
      ok: venv,
      detail: venv ? `${dir}/.venv` : 'not created',
      ...(venv ? {} : { fix: `(cd ${dir} && uv sync --frozen)` }),
    });
  }

  const models = (
    JSON.parse(readFileSync(join(repoRoot, 'models.lock.json'), 'utf8')) as {
      models: Record<string, { revision: string }>;
    }
  ).models;
  const modelsDir =
    process.env.S2V_MODELS_DIR ?? join(homedir(), '.cache', 'script2video', 'models');
  for (const [name, { revision }] of Object.entries(models)) {
    const dir = join(modelsDir, `${name.replace(/[^0-9A-Za-z_]/g, '_')}__${revision.slice(0, 12)}`);
    const ok = existsSync(dir);
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
