/**
 * `s2v snapshot`: one representative frame per scene, tiled into a contact sheet (PLAN 5.12).
 * The frame is shortly after the scene's first cue (so zoom / marks are visible), otherwise the
 * middle of the scene. The tile legend is logged (ffmpeg drawtext is often unavailable).
 */

import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Timeline } from '@script2video/core';
import { renderStills, type RenderOptions } from '@script2video/renderer-remotion';

const run = promisify(execFile);
const CUE_SETTLE_FRAMES = 20; // zoom (12) + mark fade (6) + margin

export function snapshotFrames(timeline: Timeline): { sceneId: string; frame: number }[] {
  return timeline.scenes.map((s) => ({
    sceneId: s.id,
    frame:
      s.cues.length > 0 ? s.cues[0]!.frame + CUE_SETTLE_FRAMES : Math.floor(s.durationFrames / 2),
  }));
}

export async function snapshot(opts: RenderOptions, output: string): Promise<string> {
  const dir = join(opts.workDir, 'snapshot');
  mkdirSync(dir, { recursive: true });
  const frames = snapshotFrames(opts.timeline);
  const files = frames.map((f, i) => ({
    ...f,
    path: join(dir, `${String(i).padStart(2, '0')}.png`),
  }));
  await renderStills(
    { ...opts, scale: opts.scale ?? 0.5 },
    files.map((f) => ({ sceneId: f.sceneId, frame: f.frame, output: f.path })),
  );
  const cols = Math.min(3, files.length);
  const inputs = files.flatMap((f) => ['-i', f.path]);
  // xstack places tile i at column i % cols, row floor(i / cols) (all tiles share one size).
  const at = (n: number, unit: string) =>
    n === 0 ? '0' : Array.from({ length: n }, () => unit).join('+');
  const layout = files
    .map((_, i) => `${at(i % cols, 'w0')}_${at(Math.floor(i / cols), 'h0')}`)
    .join('|');
  const filter =
    files.length === 1
      ? 'null'
      : `${files.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${files.length}:layout=${layout}:fill=#111827`;
  // No text overlay: ffmpeg builds without drawtext/freetype are common. The legend is logged.
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    ...inputs,
    '-filter_complex',
    filter,
    '-frames:v',
    '1',
    output,
  ]);
  files.forEach((f, i) =>
    opts.log?.(
      `  ${i + 1}. (row ${Math.floor(i / cols) + 1}, col ${(i % cols) + 1}) ${f.sceneId} @ frame ${f.frame}`,
    ),
  );
  return output;
}
