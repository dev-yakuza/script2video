/**
 * Composition of parts characters with ffmpeg (plan 3.3), cached by content.
 *
 * Inputs are straight-alpha RGBA PNGs of one canvas size. Every input goes through
 * `format=rgba` and is overlaid with `overlay=format=rgb` (exact straight-alpha "over"; the
 * default yuv420 overlay shifts colors and mishandles transparent destinations).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Side } from '../shared.js';
import {
  type ImportedFacePlan,
  type Layer,
  type LayeredFacePlan,
  planImportedFace,
  planLayeredFace,
} from './plan.js';
import { type Placement, type ResolvedFace } from './resolve.js';
import { type ImportedSpec } from './spec.js';

export { HAIR_OVER_OPACITY, type Layer, YMM4_ORDER } from './plan.js';

/** Bump when composition output changes for the same inputs. */
export const COMPOSER_VERSION = 1;

let ffmpegVersionCache: string | null = null;
export function ffmpegVersion(): string {
  if (ffmpegVersionCache === null) {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('ffmpeg is required to compose parts characters');
    ffmpegVersionCache = r.stdout.split('\n')[0]!.trim();
  }
  return ffmpegVersionCache;
}

const fileHash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Stack layers on a transparent W×H canvas into `out` (one ffmpeg call). */
export function composite(out: string, size: [number, number], layers: Layer[]): void {
  const [W, H] = size;
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black@0.0:s=${W}x${H}:d=1,format=rgba`,
  ];
  const chains: string[] = [];
  let prev = '[0:v]';
  layers.forEach((l, i) => {
    args.push('-i', l.file);
    const fx = [
      'format=rgba',
      ...(l.flip ? ['hflip'] : []),
      ...(l.opacity !== undefined && l.opacity < 1 ? [`colorchannelmixer=aa=${l.opacity}`] : []),
    ];
    chains.push(`[${i + 1}:v]${fx.join(',')}[l${i}]`);
    chains.push(
      `${prev}[l${i}]overlay=x=${Math.round(l.x)}:y=${Math.round(l.y)}:format=rgb[b${i}]`,
    );
    prev = `[b${i}]`;
  });
  const graph = layers.length > 0 ? chains.join(';') : '[0:v]null[b]';
  const tmp = `${out}.tmp.png`;
  args.push(
    '-filter_complex',
    graph,
    '-map',
    layers.length > 0 ? prev : '[b]',
    '-frames:v',
    '1',
    '-pix_fmt',
    'rgba',
    tmp,
  );
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg composition failed for ${out}: ${r.stderr.trim()}`);
  renameSync(tmp, out);
}

export interface ComposedFace {
  /** Absolute paths of the composed images (widened canvas). */
  body?: string;
  front?: string;
  head: { base: string; talk: string; half: string; blink: string };
  pivot: [number, number] | null;
  canvas: [number, number];
  baseWidth: number;
  baseHeight: number;
  /** Content hash of everything above (render chunk keys use it). */
  hash: string;
}

/** Compose one resolved (framing, face, side) into `cacheRoot/<hash>/`, reusing a cached result. */
export function composeFace(resolved: ResolvedFace, cacheRoot: string): ComposedFace {
  return composePlanned(planLayeredFace(resolved, fileHash), cacheRoot);
}

/** Run a layered face plan (plan.ts): the cache key is the same as before the plan split (S4b). */
export function composePlanned(plan: LayeredFacePlan, cacheRoot: string): ComposedFace {
  const { resolved, states, front } = plan;
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        v: COMPOSER_VERSION,
        ffmpeg: ffmpegVersion(),
        key: resolved.key,
        canvas: resolved.canvas,
        head: { flip: resolved.head.flip, x: resolved.head.x, y: resolved.head.y },
        body: resolved.body ? { ...resolved.body, file: null } : null,
        front: front ? { ...front, file: null } : null,
        states: {
          closed: states.closed,
          half: states.half,
          talk: states.talk,
          blink: states.blink,
        },
        files: plan.files,
      }),
    )
    .digest('hex')
    .slice(0, 20);
  const dir = join(cacheRoot, hash);
  const out = (n: string) => join(dir, n);
  const headLayers = (files: string[]): Layer[] =>
    files.map((file) => ({
      file,
      x: resolved.head.x,
      y: resolved.head.y,
      flip: resolved.head.flip,
    }));
  const place = (p: Placement): Layer => ({ file: p.file, x: p.x, y: p.y, flip: p.flip });
  const done = out('.done');
  if (!existsSync(done)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    if (resolved.body) composite(out('body.png'), resolved.canvas, [place(resolved.body)]);
    if (front) composite(out('front.png'), resolved.canvas, [place(front)]);
    composite(out('head.png'), resolved.canvas, headLayers(states.closed));
    composite(out('head-talk.png'), resolved.canvas, headLayers(states.talk));
    composite(out('head-half.png'), resolved.canvas, headLayers(states.half));
    composite(out('head-blink.png'), resolved.canvas, headLayers(states.blink));
    writeFileSync(done, '');
  }
  return {
    ...(resolved.body ? { body: out('body.png') } : {}),
    ...(front ? { front: out('front.png') } : {}),
    head: {
      base: out('head.png'),
      talk: out('head-talk.png'),
      half: out('head-half.png'),
      blink: out('head-blink.png'),
    },
    pivot: resolved.pivot,
    canvas: resolved.canvas,
    baseWidth: resolved.baseWidth,
    baseHeight: resolved.baseHeight,
    hash,
  };
}

export interface ImportedFrames {
  base: string;
  talk: string;
  half: string;
  blink: string;
  hash: string;
}

/** Whole images (closed / half / open / blink) of an imported YMM4 face for one side (plan C2 b). */
export function composeImported(
  dir: string,
  spec: ImportedSpec,
  face: string,
  side: Side,
  size: [number, number],
  cacheRoot: string,
): ImportedFrames {
  return composeImportedPlanned(planImportedFace(dir, spec, face, side, size, fileHash), cacheRoot);
}

/** Run an imported face plan (plan.ts): the cache key is the same as before the plan split. */
export function composeImportedPlanned(plan: ImportedFacePlan, cacheRoot: string): ImportedFrames {
  const { size, flip, layers: all } = plan;
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        v: COMPOSER_VERSION,
        ffmpeg: ffmpegVersion(),
        size,
        flip,
        layers: all.map((ls) => ls.map((l) => [l.file, plan.sha[l.file]!, l.opacity ?? 1])),
      }),
    )
    .digest('hex')
    .slice(0, 20);
  const outDir = join(cacheRoot, hash);
  const out = (n: string) => join(outDir, n);
  if (!existsSync(out('.done'))) {
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    const names = ['face.png', 'face-talk.png', 'face-half.png', 'face-blink.png'];
    all.forEach((ls, i) => composite(out(names[i]!), size, ls));
    writeFileSync(out('.done'), '');
  }
  return {
    base: out('face.png'),
    talk: out('face-talk.png'),
    half: out('face-half.png'),
    blink: out('face-blink.png'),
    hash,
  };
}
