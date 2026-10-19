/**
 * `s2v snapshot`: one representative frame per scene, tiled into a contact sheet (PLAN 5.12).
 * The frame is shortly after the scene's first cue (so zoom / marks are visible), otherwise the
 * middle of the scene. The tile legend is logged (ffmpeg drawtext is often unavailable).
 *
 * With `--frames` (S6 plan 2.3) it also writes every scene's stills at full size, at each point
 * the picture changes by the renderer's rules, with an index.json saying why.
 */

import { execFile } from 'node:child_process';
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Timeline } from '@script2video/core';
import {
  renderStills,
  type RenderOptions,
  type SceneStills,
  type StillRequest,
} from '@script2video/renderer-remotion';

const run = promisify(execFile);
const CUE_SETTLE_FRAMES = 20; // zoom (12) + mark fade (6) + margin

export function snapshotFrames(timeline: Timeline): { sceneId: string; frame: number }[] {
  return timeline.scenes.map((s) => ({
    sceneId: s.id,
    frame:
      s.cues.length > 0 ? s.cues[0]!.frame + CUE_SETTLE_FRAMES : Math.floor(s.durationFrames / 2),
  }));
}

/** What `--frames` writes beside the stills (S6 plan 2.3). */
export interface FramesIndex {
  output: string;
  lang: string;
  draft: boolean;
  fps: number;
  s2v_version: string;
  script_sha256: string;
  scale: 1;
  scenes: {
    id: string;
    title: string;
    startFrame: number;
    frames: { file: string; frame: number; seconds: number; reasons: string[] }[];
    capped?: { total: number };
  }[];
}

export type FramesMeta = Omit<FramesIndex, 'scenes' | 'fps' | 'scale'>;

/** Still files and index of `--frames`: NNN-<scene>-<frame>.png, numbered over the video. */
export function framesPlan(
  timeline: Timeline,
  points: SceneStills[],
  meta: FramesMeta,
): { index: FramesIndex; stills: { sceneId: string; frame: number; file: string }[] } {
  let n = 0;
  const stills: { sceneId: string; frame: number; file: string }[] = [];
  const scenes = timeline.scenes.map((scene) => {
    const p = points.find((x) => x.id === scene.id);
    const frames = (p?.points ?? []).map((pt) => {
      const file = `${String(n++).padStart(3, '0')}-${scene.id}-${pt.frame}.png`;
      stills.push({ sceneId: scene.id, frame: pt.frame, file });
      return {
        file,
        frame: pt.frame,
        seconds: Math.round(((scene.startFrame + pt.frame) / timeline.fps) * 1000) / 1000,
        reasons: pt.reasons,
      };
    });
    return {
      id: scene.id,
      title: scene.title,
      startFrame: scene.startFrame,
      frames,
      ...(p?.capped ? { capped: p.capped } : {}),
    };
  });
  return { index: { ...meta, fps: timeline.fps, scale: 1, scenes }, stills };
}

/** Remove one of our results: a real file or folder, never through a link. */
export function dropResult(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a link: not removed`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  rmSync(path, { recursive: true, force: true });
}

export interface SnapshotTargets {
  /** The contact sheet: `<out>/<output>.<lang>.snapshot.png`. */
  sheet: string;
  /** `--frames`: the stills folder and what its index.json says about the run. */
  frames?: { dir: string; meta: FramesMeta };
}

const sheetTmp = (to: SnapshotTargets) => to.sheet.replace(/\.png$/, '.tmp.png');
const framesTmp = (to: SnapshotTargets) => (to.frames ? `${to.frames.dir}.tmp` : null);

/** Last run's results go before anything runs, so a failed run leaves none (S2 rule). */
export function clearSnapshot(to: SnapshotTargets): void {
  dropResult(to.sheet);
  dropResult(sheetTmp(to));
  if (to.frames) {
    dropResult(to.frames.dir);
    dropResult(framesTmp(to)!);
  }
}

/** Contact sheet (and stills), written beside and moved in place at the end. */
export async function snapshot(opts: RenderOptions, to: SnapshotTargets): Promise<string> {
  clearSnapshot(to); // main clears before synthesizing too; here for other callers
  const tmpSheet = sheetTmp(to);
  const tmpFrames = framesTmp(to);
  const dir = join(opts.workDir, 'snapshot');
  mkdirSync(dir, { recursive: true });
  const tiles = snapshotFrames(opts.timeline).map((f, i) => ({
    ...f,
    path: join(dir, `${String(i).padStart(2, '0')}.png`),
  }));
  const cols = Math.min(3, tiles.length);
  let index: FramesIndex | null = null;
  try {
    // one bundle and browser: the tiles at half size, the stills at full size
    await renderStills({ ...opts, scale: 1 }, ({ points }) => {
      const requests: StillRequest[] = tiles.map((f) => ({
        sceneId: f.sceneId,
        frame: f.frame,
        output: f.path,
        scale: opts.scale ?? 0.5,
      }));
      if (to.frames && tmpFrames) {
        mkdirSync(tmpFrames, { recursive: true });
        const plan = framesPlan(opts.timeline, points(), to.frames.meta);
        index = plan.index;
        for (const s of plan.stills)
          requests.push({ sceneId: s.sceneId, frame: s.frame, output: join(tmpFrames, s.file) });
      }
      return requests;
    });
    const inputs = tiles.flatMap((f) => ['-i', f.path]);
    // xstack places tile i at column i % cols, row floor(i / cols) (all tiles share one size).
    const at = (n: number, unit: string) =>
      n === 0 ? '0' : Array.from({ length: n }, () => unit).join('+');
    const layout = tiles
      .map((_, i) => `${at(i % cols, 'w0')}_${at(Math.floor(i / cols), 'h0')}`)
      .join('|');
    const filter =
      tiles.length === 1
        ? 'null'
        : `${tiles.map((_, i) => `[${i}:v]`).join('')}xstack=inputs=${tiles.length}:layout=${layout}:fill=#111827`;
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
      tmpSheet,
    ]);
    if (to.frames && tmpFrames && index)
      writeFileSync(join(tmpFrames, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
    renameSync(tmpSheet, to.sheet);
    if (to.frames && tmpFrames && index) {
      try {
        renameSync(tmpFrames, to.frames.dir);
      } catch (e) {
        dropResult(to.sheet); // both or neither
        throw e;
      }
    }
  } finally {
    dropResult(tmpSheet);
    if (tmpFrames) dropResult(tmpFrames);
  }
  tiles.forEach((f, i) =>
    opts.log?.(
      `  ${i + 1}. (row ${Math.floor(i / cols) + 1}, col ${(i % cols) + 1}) ${f.sceneId} @ frame ${f.frame}`,
    ),
  );
  const written = index as FramesIndex | null;
  if (to.frames && written)
    opts.log?.(
      `frames: ${written.scenes.reduce((k, s) => k + s.frames.length, 0)} stills → ${to.frames.dir}`,
    );
  return to.sheet;
}
