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
import { Service, TTS_SERVER } from './services.js';
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

/** Run a service in the foreground until Ctrl-C (resident mode for `s2v dev` / `s2v say`). */
export async function runResident(repoRoot: string, log: (m: string) => void): Promise<void> {
  const service = new Service(TTS_SERVER, repoRoot);
  const h = await service.ensure();
  log(`tts-server ready at ${service.url} (${String(h.device)}). Ctrl-C to stop.`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      service.stop();
      resolve();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}
