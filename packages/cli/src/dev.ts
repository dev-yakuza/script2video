/**
 * `s2v dev <script>` (PLAN 7): an edit loop. The TTS and alignment servers stay up for the whole
 * session; every save of the script (or a file next to it) runs lint → tts (only changed
 * sentences are synthesized) → snapshot, or a draft render with `--video`. The steps are the
 * normal commands run as child processes, so they behave exactly like running them by hand.
 */

import { spawn } from 'node:child_process';
import { readFileSync, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import { parseScript, type Script } from '@script2video/core';
import { profileOf } from './args.js';
import { ALIGNER, Service, TTS_SERVER } from './services.js';

export interface DevOptions {
  output: string;
  video: boolean;
  asr: boolean;
  cliPath: string;
  repoRoot: string;
  log: (m: string) => void;
}

function step(cli: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * Before any server starts (S11 plan 3.9): the output must exist (exit 2). Lint errors do not stop
 * dev (it reruns on every save), and a script that does not parse is dev's own to report.
 */
export function checkDevOutput(path: string, output: string): void {
  let script: Script | null;
  try {
    script = parseScript(readFileSync(path, 'utf8')).script;
  } catch {
    return;
  }
  if (script) profileOf(script, output);
}

export async function dev(path: string, opts: DevOptions): Promise<void> {
  opts.log('starting tts-server and aligner (kept running; Ctrl-C to stop) ...');
  await Promise.all([
    new Service(TTS_SERVER, opts.repoRoot).ensure(),
    new Service(ALIGNER, opts.repoRoot).ensure(),
  ]);

  let running = false;
  let again = false;
  const cycle = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    const started = Date.now();
    opts.log(`\n── ${new Date().toLocaleTimeString()} ${basename(path)} ──`);
    const lint = await step(opts.cliPath, ['lint', path]);
    if (lint === 0) {
      const tts = await step(opts.cliPath, ['tts', path, ...(opts.asr ? [] : ['--no-asr'])]);
      if (tts === 0)
        await step(
          opts.cliPath,
          opts.video
            ? ['render', path, '--output', opts.output, '--draft']
            : ['snapshot', path, '--output', opts.output],
        );
    }
    opts.log(`── done in ${((Date.now() - started) / 1000).toFixed(1)}s; watching for changes ──`);
    running = false;
    if (again) {
      again = false;
      void cycle();
    }
  };

  // Debounce: editors write files in several steps.
  let timer: NodeJS.Timeout | null = null;
  watch(dirname(path), { recursive: true }, (_event, file) => {
    // Character generation writes .work/ and provenance.json while it runs: not script edits.
    if (
      !file ||
      /(^|\/)(audio|\.s2v-cache|out|\.work)\//.test(file) ||
      file.endsWith('provenance.json') ||
      file.endsWith('~')
    )
      return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void cycle(), 300);
  });
  await cycle();
  await new Promise<never>(() => {}); // until Ctrl-C (services stop with the process)
}
