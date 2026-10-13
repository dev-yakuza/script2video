/**
 * Composition of parts characters with ffmpeg (plan 3.3), cached by content.
 *
 * Inputs are straight-alpha RGBA PNGs of one canvas size. Every input goes through
 * `format=rgba` and is overlaid with `overlay=format=rgb` (exact straight-alpha "over"; the
 * default yuv420 overlay shifts colors and mishandles transparent destinations).
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Side } from '../shared.js';
import { type Placement, type ResolvedFace } from './resolve.js';
import { IMPORTED_PARTS, type ImportedSpec } from './spec.js';

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

export interface Layer {
  file: string;
  x: number;
  y: number;
  flip: boolean;
  /** 0–1, for semi-transparent layers. */
  opacity?: number;
}

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
  const exists = (f: string) => existsSync(f);
  const { states } = resolved.head;
  if (!exists(states.closed[0]!)) throw new Error(`head image missing: ${states.closed[0]}`);
  for (const f of states.closed.slice(1)) if (!exists(f)) throw new Error(`eye part missing: ${f}`);
  // Optional parts fall back: half → talk → closed; blink → closed.
  const talk = exists(states.talk.at(-1)!) ? states.talk : states.closed;
  const half = exists(states.half.at(-1)!) ? states.half : talk;
  const blink = exists(states.blink.at(-1)!) ? states.blink : states.closed;
  if (resolved.body && !exists(resolved.body.file))
    throw new Error(`body image missing: ${resolved.body.file}`);
  const front = resolved.front && exists(resolved.front.file) ? resolved.front : undefined;

  const inputs = [
    ...new Set([
      ...talk,
      ...half,
      ...blink,
      ...states.closed,
      ...(resolved.body ? [resolved.body.file] : []),
      ...(front ? [front.file] : []),
    ]),
  ];
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
        states: { closed: states.closed, half, talk, blink },
        files: inputs.map((f) => [f, fileHash(f)]),
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
  if (!exists(done)) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    if (resolved.body) composite(out('body.png'), resolved.canvas, [place(resolved.body)]);
    if (front) composite(out('front.png'), resolved.canvas, [place(front)]);
    composite(out('head.png'), resolved.canvas, headLayers(states.closed));
    composite(out('head-talk.png'), resolved.canvas, headLayers(talk));
    composite(out('head-half.png'), resolved.canvas, headLayers(half));
    composite(out('head-blink.png'), resolved.canvas, headLayers(blink));
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

/**
 * YMM4 「動く立ち絵」 draw order, back to front (plan 3.2). Selection keys `後1`–`後3` / `他1`–`他3`
 * pick files in the 後 / 他 folders; a bare `後` / `他` is slot 1.
 */
export const YMM4_ORDER = [
  '後3',
  '後2',
  '後1',
  '体',
  '顔色',
  '髪',
  '口',
  '目',
  '眉',
  '髪(半透明)',
  '他3',
  '他2',
  '他1',
] as const;
/** Opacity of the second hair pass that lets eyes and brows show through the bangs (YMM4). */
export const HAIR_OVER_OPACITY = 0.5;
const folderOf = (key: string) => (key === '髪(半透明)' ? '髪' : key.replace(/[123]$/, ''));
const slotKey = (key: string) => (key === '後' || key === '他' ? `${key}1` : key);

export interface ImportedFrames {
  base: string;
  talk: string;
  half: string;
  blink: string;
  hash: string;
}

/**
 * Whole images (closed / half / open / blink) of an imported YMM4 face for one side (plan C2 b).
 * Faces name a file stem per folder; folders a face leaves out use `faces.neutral`. The mouth uses
 * `stem.0` closed, the middle intermediate frame half, `stem` open; eyes `stem.0` for the blink.
 */
export function composeImported(
  dir: string,
  spec: ImportedSpec,
  face: string,
  side: Side,
  size: [number, number],
  cacheRoot: string,
): ImportedFrames {
  dir = join(dir, IMPORTED_PARTS);
  const pick: Record<string, string> = {
    ...normalize(spec.faces.neutral ?? {}),
    ...normalize(spec.faces[face] ?? {}),
  };
  if (pick['髪']) pick['髪(半透明)'] = pick['髪'];
  if (!spec.faces[face]) throw new Error(`face "${face}" is not defined in character.yaml`);
  const fileOf = (key: string, name: string) => join(dir, folderOf(key), name);
  const frames = (key: string, stem: string) => {
    const folder = join(dir, folderOf(key));
    const mids = existsSync(folder)
      ? readdirSync(folder)
          .map((f) => new RegExp(`^${escape(stem)}\\.(\\d+)\\.png$`).exec(f.normalize('NFC')))
          .filter((m): m is RegExpExecArray => !!m && m[1] !== '0')
          .map((m) => Number(m[1]))
          .sort((a, b) => a - b)
      : [];
    const open = fileOf(key, `${stem}.png`);
    const closed = existsSync(fileOf(key, `${stem}.0.png`)) ? fileOf(key, `${stem}.0.png`) : open;
    const half =
      mids.length > 0
        ? fileOf(key, `${stem}.${mids[Math.floor((mids.length - 1) / 2)]}.png`)
        : open;
    return { open, closed, half };
  };
  const flip = spec.facing === side;
  const layersFor = (state: 'base' | 'talk' | 'half' | 'blink'): Layer[] =>
    YMM4_ORDER.filter((k) => pick[k]).map((k) => {
      const stem = pick[k]!;
      let file = fileOf(k, `${stem}.png`);
      if (k === '口') {
        const fr = frames(k, stem);
        file = state === 'talk' ? fr.open : state === 'half' ? fr.half : fr.closed;
      } else if (k === '目') {
        const fr = frames(k, stem);
        file = state === 'blink' ? fr.closed : fr.open;
      }
      if (!existsSync(file)) throw new Error(`part missing: ${file}`);
      return {
        file,
        x: 0,
        y: 0,
        flip,
        ...(k === '髪(半透明)' ? { opacity: HAIR_OVER_OPACITY } : {}),
      };
    });
  const all = (['base', 'talk', 'half', 'blink'] as const).map((s) => layersFor(s));
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        v: COMPOSER_VERSION,
        ffmpeg: ffmpegVersion(),
        size,
        flip,
        layers: all.map((ls) => ls.map((l) => [l.file, fileHash(l.file), l.opacity ?? 1])),
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

function normalize(sel: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sel).map(([k, v]) => [slotKey(k.normalize('NFC')), v.normalize('NFC')]),
  );
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
