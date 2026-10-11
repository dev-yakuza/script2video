/**
 * Music and sound effects under the narration (PLAN 5.9).
 * - Effects are synthesized by ffmpeg from fixed formulas (and a fixed noise seed), so they are
 *   identical everywhere and carry no sample license.
 * - The music is leveled to `bgm.level` LUFS, looped to the video length, faded in / out and
 *   ducked under speech with a sidechain compressor keyed by the narration.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Bgm, SfxEvent } from '@script2video/core';
import { integratedLoudness } from './media.js';
import { readPcm16 } from './pauses.js';

const run = promisify(execFile);
const RATE = 48_000;

/** ffmpeg source per preset, and its level in the effects track. */
const PRESETS: Record<string, { src: string; gain: number }> = {
  pop: {
    src: "aevalsrc='0.9*sin(2*PI*(650+550*exp(-t*28))*t)*exp(-t*22)':d=0.18",
    gain: 0.45,
  },
  click: { src: "aevalsrc='0.9*sin(2*PI*2300*t)*exp(-t*180)':d=0.05", gain: 0.35 },
  whoosh: {
    src: 'anoisesrc=color=pink:seed=7:amplitude=0.8:d=0.5,highpass=f=350,lowpass=f=2800,afade=t=in:d=0.22,afade=t=out:st=0.22:d=0.28',
    gain: 0.3,
  },
  ding: {
    src: "aevalsrc='0.6*sin(2*PI*1318.5*t)*exp(-t*3.5)+0.3*sin(2*PI*2637*t)*exp(-t*6)':d=1.2",
    gain: 0.35,
  },
};

/** Preset wav files (48 kHz mono), cached by their definition. */
export async function ensureSfx(repoRoot: string): Promise<Record<string, string>> {
  const dir = join(repoRoot, '.s2v-cache', 'sfx');
  mkdirSync(dir, { recursive: true });
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(PRESETS)) {
    const id = createHash('sha256').update(p.src).digest('hex').slice(0, 10);
    const path = join(dir, `${name}-${id}.wav`);
    if (!existsSync(path))
      await run('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        p.src,
        '-ar',
        String(RATE),
        '-ac',
        '1',
        '-c:a',
        'pcm_s16le',
        path,
      ]);
    out[name] = path;
  }
  return out;
}

/** The effects track as a float wav the length of the video. */
export async function buildSfxTrack(
  events: SfxEvent[],
  fps: number,
  totalFrames: number,
  repoRoot: string,
  outPath: string,
): Promise<void> {
  const presets = await ensureSfx(repoRoot);
  const total = Math.ceil((totalFrames / fps) * RATE);
  const mix = new Float32Array(total);
  for (const e of events) {
    const preset = PRESETS[e.name];
    const path = presets[e.name];
    if (!preset || !path) continue;
    const { samples } = readPcm16(path);
    const at = Math.round((e.frame / fps) * RATE);
    for (let i = 0; i < samples.length && at + i < total; i++)
      mix[at + i]! += (samples[i]! / 32768) * preset.gain;
  }
  const data = Buffer.alloc(total * 4);
  for (let i = 0; i < total; i++) data.writeFloatLE(mix[i]!, i * 4);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); // IEEE float
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(32, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(outPath, Buffer.concat([h, data]));
}

/**
 * Narration + (ducked, leveled, looped) music + effects → one float wav for mastering.
 * Returns the gain applied to the music.
 */
export async function mixSoundtrack(opts: {
  narration: string;
  seconds: number;
  bgm: (Bgm & { path: string }) | null;
  sfx: string | null;
  out: string;
}): Promise<{ bgmGainDb: number | null }> {
  const inputs = ['-i', opts.narration];
  const layout = opts.bgm ? 'stereo' : 'mono';
  const parts: string[] = [];
  const mixIn = ['[n1]'];
  let bgmGainDb: number | null = null;
  const d = opts.seconds.toFixed(3);
  if (opts.bgm) {
    const { lufs } = await integratedLoudness(opts.bgm.path);
    bgmGainDb = opts.bgm.level - lufs;
    inputs.push('-stream_loop', '-1', '-i', opts.bgm.path);
    const fadeOut = Math.max(0, opts.seconds - 3).toFixed(3);
    parts.push(
      `[1:a]aformat=sample_rates=${RATE}:channel_layouts=stereo,atrim=0:${d},asetpts=N/SR/TB,` +
        `volume=${bgmGainDb.toFixed(2)}dB,afade=t=in:d=1.5,afade=t=out:st=${fadeOut}:d=3[bg]`,
    );
    if (opts.bgm.duck) {
      parts.push(
        '[bg][n2]sidechaincompress=threshold=0.02:ratio=6:attack=30:release=500:makeup=1[bgd]',
      );
      mixIn.push('[bgd]');
    } else mixIn.push('[bg]');
  }
  if (opts.sfx) {
    inputs.push('-i', opts.sfx);
    parts.push(`[${opts.bgm ? 2 : 1}:a]aformat=channel_layouts=${layout}[fx]`);
    mixIn.push('[fx]');
  }
  // Stereo when there is music (it keeps its width); voice and effects sit in the center.
  const split = opts.bgm?.duck
    ? `[0:a]aformat=channel_layouts=${layout},asplit=2[n1][n2]`
    : `[0:a]aformat=channel_layouts=${layout}[n1]`;
  const graph = [
    split,
    ...parts,
    `${mixIn.join('')}amix=inputs=${mixIn.length}:normalize=0:duration=first[out]`,
  ].join(';');
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    graph,
    '-map',
    '[out]',
    '-c:a',
    'pcm_f32le',
    '-ar',
    String(RATE),
    '-ac',
    opts.bgm ? '2' : '1',
    opts.out,
  ]);
  return { bgmGainDb };
}
