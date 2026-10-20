/**
 * `s2v say "<sentence>"`: synthesize one sentence and play it, to decide quickly whether a word
 * needs a pronunciation-dictionary entry (PLAN 4.4). Uses a resident tts-server when one is running
 * (`s2v tts-server start`), otherwise starts one for this call.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toTtsText, type Lang } from '@script2video/core';
import { compressPausesInFile } from './pauses.js';
import {
  acquireHeavy,
  BusyError,
  describeOwner,
  ownProcessStart,
  readHeavy,
  readResident,
  releaseHeavy,
  removeResident,
  residentProcessAlive,
  writeResident,
  type Resident,
} from './heavy-lock.js';
import { ExitError } from './errors.js';
import { Service, TTS_SERVER } from './services.js';
import { onRelease, onStop } from './shutdown.js';
import { postprocess, wavDuration } from './tts.js';

export interface SayOptions {
  voice: string;
  lang: Lang;
  style?: string;
  pronounce: Record<string, string>;
  maxPause: number;
  play: boolean;
  log: (m: string) => void;
}

export async function say(text: string, repoRoot: string, opts: SayOptions): Promise<string> {
  const [engine, voice] = opts.voice.split(':') as [string, string];
  if (engine !== 'qwen' && engine !== 'supertonic')
    throw new Error(`say supports qwen:<speaker> or supertonic:<F1-M5>, got ${opts.voice}`);
  const ttsText = toTtsText(text, opts.pronounce).tts;
  if (ttsText !== text) opts.log(`tts text: ${ttsText}`);

  const service = new Service(TTS_SERVER, repoRoot);
  const wasRunning = (await service.health()) !== null;
  if (!wasRunning)
    opts.log(
      'starting tts-server (keep one running with `s2v tts-server start` for faster calls) ...',
    );
  await service.ensure();
  try {
    const key = createHash('sha256')
      .update(JSON.stringify([opts.voice, opts.lang, opts.style, ttsText]))
      .digest('hex')
      .slice(0, 16);
    const { data } = await service.post<Buffer>('/synthesize', {
      engine,
      voice,
      lang: opts.lang,
      text: ttsText,
      ...(engine === 'qwen' && opts.style ? { instruct: opts.style } : {}),
      seed_material: `say:${key}`,
    });
    const dir = join(repoRoot, '.s2v-cache', 'say');
    mkdirSync(dir, { recursive: true });
    const raw = join(dir, `${key}.raw.wav`);
    const out = join(dir, `${key}.wav`);
    writeFileSync(raw, data);
    await postprocess(raw, out, null);
    const removed = compressPausesInFile(out, opts.maxPause);
    opts.log(
      `${wavDuration(out).toFixed(2)}s${removed > 0 ? ` (-${removed.toFixed(2)}s pauses)` : ''} → ${out}`,
    );
    if (opts.play) {
      const player =
        process.platform === 'darwin'
          ? ['afplay', [out]]
          : ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', out]];
      await new Promise<void>((res) =>
        spawn(player[0] as string, player[1] as string[], { stdio: 'ignore' }).on('exit', () =>
          res(),
        ),
      );
    }
    return out;
  } finally {
    if (!wasRunning) service.stop();
  }
}

/**
 * `s2v tts-server start` (S8 plan 3.5): keep a TTS server running for later commands. It takes the
 * machine lock only while the server starts (no generation can start meanwhile), records itself
 * in resident.json, and releases the lock: TTS commands then take turns and reuse it. Ctrl-C stops
 * the server and removes the record.
 */
export async function runResident(repoRoot: string, log: (m: string) => void): Promise<void> {
  const service = new Service(TTS_SERVER, repoRoot);
  acquireHeavy('tts', { holder: 's2v tts-server start', reentry: false });
  const old = readResident();
  if (old && residentProcessAlive(old)) {
    const h = await new Service({ ...TTS_SERVER, port: old.port }, repoRoot).health();
    releaseHeavy();
    if (h?.id === TTS_SERVER.id) {
      log(`a resident tts-server is already running (pid ${old.pid}, port ${old.port})`);
      return;
    }
    throw new BusyError(
      'resident',
      `a resident tts-server (pid ${old.pid}) does not answer on port ${old.port}; stop it (pid ${old.pid})`,
    );
  }
  if (old) removeResident(old);
  if (await service.health()) {
    releaseHeavy();
    throw new BusyError(
      'orphan',
      `port ${service.spec.port} answers but no s2v command owns it; see: s2v services status`,
    );
  }
  const h = await service.ensure({ lock: false });
  const record: Resident = {
    pid: process.pid,
    pid_start: ownProcessStart(),
    port: service.spec.port,
    server_pgid: service.pgid,
    id: TTS_SERVER.id,
    wrapper_version: TTS_SERVER.wrapper,
    started: new Date().toISOString(),
  };
  writeResident(record);
  releaseHeavy();
  onStop(() => {
    const lock = readHeavy();
    if (lock?.alive && lock.owner?.kind === 'tts')
      console.error(`warning: ${describeOwner(lock.owner)} may be using this server; it will fail`);
  });
  onRelease(() => removeResident(record));
  log(`tts-server ready at ${service.url} (${String(h.device)}). Ctrl-C to stop.`);
  // until a signal (shutdown.ts stops the server and exits), or the server ends on its own
  const end = await service.exited()!;
  if (end.stopped) await new Promise<never>(() => {});
  removeResident(record);
  throw new ExitError(`tts-server exited (${String(end.code)}); it is not running any more`, 1);
}
