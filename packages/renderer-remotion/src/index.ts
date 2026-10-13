/**
 * Remotion renderer adapter (ADR 0003): renders each timeline scene to a silent, concat-safe
 * H.264 chunk. Audio mixing, concatenation and muxing happen outside (engine independent).
 */

import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { Timeline, TimelineScene } from '@script2video/core';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { composeFace, composeImported } from './character/compose.js';
import { resolveFace, setOf } from './character/resolve.js';
import {
  characterSource,
  type Framing,
  IMPORTED_PARTS,
  loadCharacterSpec,
} from './character/spec.js';
import type { PartsFace, PartsSet } from './remotion/types.js';
import {
  assignSides,
  stagePlan,
  type DialogueShape,
  type Side,
  type StageSwitch,
} from './shared.js';

export {
  CHARACTER_YAML,
  CharacterSpecError,
  characterSource,
  faceMotions,
  FRAMINGS,
  IMPORTED_PARTS,
  loadCharacterSpec,
  parseCharacterSpec,
  type CharacterSpec,
  type Framing,
  type LayeredSpec,
} from './character/spec.js';
export { FaceError, isSingle, resolveFace, setOf } from './character/resolve.js';
export {
  assignSides,
  dialogueShape,
  MAX_AVATARS,
  stagePlan,
  type DialogueShape,
} from './shared.js';

export type Aspect = '16:9' | '9:16' | '1:1';

export interface RenderOptions {
  timeline: Timeline;
  aspect: Aspect;
  subtitleMode?: 'sentence' | 'word';
  /** Output scale (0.5 = half resolution for drafts). */
  scale?: number;
  /** Directory the script's relative asset paths are resolved against. */
  assetsRoot: string;
  /** Directory containing NotoSansKR-Variable.ttf and NotoSansJP-Variable.ttf. */
  fontsDir: string;
  /** Working directory for the bundle, public dir and chunk cache. */
  workDir: string;
  /** Re-render every scene even if its chunk is cached (determinism checks). */
  noCache?: boolean;
  /** Browser tabs rendering frames in parallel (Remotion's default: half the CPU cores). */
  concurrency?: number;
  layout?: 'presenter' | 'dialogue' | 'fullscreen' | 'shorts';
  /** Speakers in cast order; `avatar` is relative to `assetsRoot`. */
  cast?: CastOption[];
  /** Mouth openness per frame of each sentence ('0' closed, '1' half, '2' open). */
  mouths?: Record<string, string>;
  /** Subtitle style; `font` is a font file relative to `assetsRoot`. */
  subtitleStyle?: SubtitleStyleOption;
  /** Scene boundaries: `fade` dips to the background color. */
  transition?: 'none' | 'fade';
  theme?: { base: 'light' | 'dark'; background?: string; text?: string; accent?: string };
  /** Corner logo; `src` relative to `assetsRoot`. */
  logo?: {
    src: string;
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
    size: number;
    opacity: number;
  } | null;
  log?: (msg: string) => void;
}

export interface SubtitleStyleOption {
  size?: number;
  position?: 'bottom' | 'middle' | 'top';
  color?: string;
  background?: string;
  highlight?: string;
  font?: string;
}

/** Copy a custom subtitle font into the public dir; returns its public path. */
function prepareCustomFont(
  font: string | undefined,
  root: string,
  publicDir: string,
  hashes: Record<string, string>,
): string | undefined {
  if (!font) return undefined;
  const abs = resolve(root, font);
  if (!existsSync(abs)) throw new Error(`subtitle font not found: ${font} (${abs})`);
  const rel = `fonts/custom${abs.slice(abs.lastIndexOf('.'))}`;
  copyFileSync(abs, join(publicDir, rel));
  hashes['font:custom'] = sha256File(abs);
  return rel;
}

export interface CastOption {
  key: string;
  name: string;
  color: string;
  face: string;
  avatar?: string;
  /** Character art folder (relative to assetsRoot) and the way the art looks. */
  character?: { dir: string; facing: 'left' | 'right' | 'front' };
  side?: 'left' | 'right';
}

/** Distinct, readable on white text: used for cast members without a color. */
const CAST_COLORS = ['#2563EB', '#EA580C', '#16A34A', '#9333EA', '#DB2777', '#0891B2'];

export function defaultCastColor(index: number): string {
  return CAST_COLORS[index % CAST_COLORS.length]!;
}

export interface RenderedChunk {
  sceneId: string;
  path: string;
  frames: number;
  cached: boolean;
}

const RENDERER_VERSION = 'remotion-adapter-0.1.0';
// macOS: ANGLE on the GPU. Linux / Docker (no GPU): SwiftShader through ANGLE. S2V_GL overrides.
type GlMode = 'angle' | 'swangle' | 'swiftshader' | 'egl' | 'vulkan' | 'angle-egl';
const GL = (process.env.S2V_GL ?? (process.platform === 'linux' ? 'swangle' : 'angle')) as GlMode;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(PACKAGE_ROOT, 'src', 'remotion', 'index.ts');
const FONT_FILES = [
  'NotoSansKR-Variable.ttf',
  'NotoSansJP-Variable.ttf',
  'JetBrainsMono-Variable.ttf',
];

// Concat-safe H.264: no B-frames, one closed GOP per chunk (IDR only at frame 0), fixed mp4
// timescale. Injected into Remotion's libx264 encode call (verified in M0b).
const CONCAT_ARGS = [
  '-bf',
  '0',
  '-g',
  '100000',
  '-keyint_min',
  '100000',
  '-sc_threshold',
  '0',
  '-flags',
  '+cgop',
  '-x264-params',
  'open-gop=0:scenecut=0',
  '-video_track_timescale',
  '15360',
];

/** Hash of the composition source: any change to the visual code invalidates cached chunks. */
function rendererSourceHash(): string {
  const dir = join(PACKAGE_ROOT, 'src', 'remotion');
  const h = createHash('sha256');
  for (const f of readdirSync(dir).sort()) h.update(f).update(readFileSync(join(dir, f)));
  h.update(readFileSync(join(PACKAGE_ROOT, 'src', 'shared.ts')));
  return h.digest('hex').slice(0, 16);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Read width/height from a PNG or JPEG header. */
export function imageSize(path: string): [number, number] {
  const b = readFileSync(path);
  if (b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0xff && b[1] === 0xd8) {
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = b[off + 1]!;
      const len = b.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return [b.readUInt16BE(off + 7), b.readUInt16BE(off + 5)];
      }
      off += 2 + len;
    }
  }
  throw new Error(`unsupported image format (PNG/JPEG only): ${path}`);
}

function referencedImages(timeline: Timeline): string[] {
  const out = new Set<string>();
  for (const s of timeline.scenes)
    for (const v of s.visuals)
      if ((v.visual.type === 'image' || v.visual.type === 'video') && v.visual.attrs.src)
        out.add(v.visual.attrs.src);
      else if (v.visual.type === 'gallery' || v.visual.type === 'split')
        for (const im of v.visual.images ?? []) out.add(im.src);
  // Images a cue switches to (`show=`).
  for (const s of timeline.scenes) for (const c of s.cues) if (c.attrs.show) out.add(c.attrs.show);
  return [...out];
}

function prepareFonts(publicDir: string, fontsDir: string): Record<string, string> {
  rmSync(publicDir, { recursive: true, force: true });
  mkdirSync(join(publicDir, 'fonts'), { recursive: true });
  const hashes: Record<string, string> = {};
  for (const f of FONT_FILES) {
    const src = join(fontsDir, f);
    if (!existsSync(src)) throw new Error(`font missing: ${src}`);
    copyFileSync(src, join(publicDir, 'fonts', f));
    hashes[`font:${f}`] = sha256File(src);
  }
  return hashes;
}

const CHARACTER_FILE = /^([a-z][a-z0-9-]*?)(?:-(talk|half|blink))?\.png$/;

export interface CharacterFiles {
  base?: string;
  talk?: string;
  half?: string;
  blink?: string;
}

/**
 * Faces in a character folder: `<face>.png` (mouth closed), `<face>-talk.png` (open),
 * `<face>-half.png` (half open), `<face>-blink.png` (eyes closed). Values are file names.
 */
export function characterFaces(dir: string): Record<string, CharacterFiles> {
  const faces: Record<string, CharacterFiles> = {};
  for (const f of readdirSync(dir).sort()) {
    const m = CHARACTER_FILE.exec(f);
    if (!m) continue;
    const face = (faces[m[1]!] ??= {});
    face[(m[2] ?? 'base') as keyof CharacterFiles] = f;
  }
  return faces;
}

type PreparedCharacter = {
  faces: Record<string, CharacterFiles>;
  facing: 'left' | 'right' | 'front';
  parts?: Record<string, PartsSet>;
  /** Imported material: art size, so it is scaled like parts art (plan 5.3). */
  size?: [number, number];
};

/** Subfolders, skipping dot entries (`.DS_Store`, `.git`) and files. */
function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isDirectory())
    .sort();
}

/** First `head.png` under a set's views (its size is the set canvas). */
function findHeadImage(root: string): string | null {
  const views = join(root, 'views');
  for (const v of subdirs(views))
    for (const h of subdirs(join(views, v, 'face')))
      for (const e of subdirs(join(views, v, 'face', h))) {
        const f = join(views, v, 'face', h, e, 'head.png');
        if (existsSync(f)) return f;
      }
  return null;
}

/**
 * Faces a cast member shows per framing in this output: its default face plus the faces of its
 * lines and reactions, in each scene's framing. The stage only ever shows these (a character
 * still on stage after a boundary shows its default face), and lint checks exactly the same set.
 */
function usedFaces(
  timeline: Timeline,
  key: string,
  defaultFace: string,
): Map<Framing, Set<string>> {
  const out = new Map<Framing, Set<string>>();
  for (const s of timeline.scenes) {
    const framing = s.framing?.[key] ?? 'full';
    const set = out.get(framing) ?? out.set(framing, new Set()).get(framing)!;
    for (const f of sceneFaces(s, key, defaultFace)) set.add(f);
  }
  return out;
}

/** Faces a cast member can show in one scene. */
function sceneFaces(scene: TimelineScene, key: string, defaultFace: string): string[] {
  return [
    defaultFace,
    ...scene.audio.filter((a) => a.cast === key).map((a) => a.face),
    ...scene.reactions.filter((r) => r.cast === key).map((r) => r.face),
  ];
}

function publish(publicDir: string, abs: string, rel: string): string {
  mkdirSync(dirname(join(publicDir, rel)), { recursive: true });
  copyFileSync(abs, join(publicDir, rel));
  return rel;
}

/**
 * Parts characters (character.yaml): composed per (framing, face) for the side the character
 * stands on in this output (plan C2, C3). Layered art gets body/head/front layers; imported YMM4
 * art is composed into whole images and uses the classic path, already facing the center.
 */
function prepareParts(
  opts: RenderOptions,
  c: CastOption & { character: NonNullable<CastOption['character']> },
  dir: string,
  side: Side,
  publicDir: string,
  hashes: Record<string, string>,
): PreparedCharacter {
  const spec = loadCharacterSpec(dir);
  const cacheRoot = join(opts.workDir, 'characters');
  const used = usedFaces(opts.timeline, c.key, c.face);
  if (spec.source === 'imported') {
    const parts = join(dir, IMPORTED_PARTS);
    const first = subdirs(parts).flatMap((f) =>
      readdirSync(join(parts, f))
        .filter((x) => x.endsWith('.png') && !x.startsWith('.'))
        .map((x) => join(parts, f, x)),
    )[0];
    if (!first) throw new Error(`character ${c.key}: no parts found in ${parts}`);
    const size = (spec.size as [number, number] | undefined) ?? imageSize(first);
    const faces: Record<string, CharacterFiles> = {};
    for (const face of used.get('full') ?? [c.face]) {
      const f = composeImported(dir, spec, face, side, size, cacheRoot);
      const base = `characters/${c.key}/full/${face}`;
      faces[face] = {
        base: publish(publicDir, f.base, `${base}/face.png`),
        talk: publish(publicDir, f.talk, `${base}/face-talk.png`),
        half: publish(publicDir, f.half, `${base}/face-half.png`),
        blink: publish(publicDir, f.blink, `${base}/face-blink.png`),
      };
      hashes[`character:${c.key}/full/${face}/${side}`] = f.hash;
    }
    return { faces, facing: 'front', size };
  }
  const parts: Record<string, PartsSet> = {};
  for (const [framing, names] of used) {
    const set = setOf(dir, spec, framing);
    if (!findHeadImage(set.root))
      throw new Error(`character ${c.key}: no head images in the ${framing} set (${set.root})`);
    // The canvas is the size of the art the output uses (`size` describes the full set).
    const first = resolveFace(dir, spec, framing, [...names][0]!, side, [1, 1]).head.states
      .closed[0]!;
    const size =
      framing === 'full' && spec.size
        ? (spec.size as [number, number])
        : existsSync(first)
          ? imageSize(first)
          : imageSize(findHeadImage(set.root)!);
    const faces: Record<string, PartsFace> = {};
    let canvas: [number, number] = size;
    for (const face of names) {
      let resolved;
      try {
        resolved = resolveFace(dir, spec, framing, face, side, size);
      } catch (e) {
        throw new Error(`character ${c.key} (${c.character.dir}): ${(e as Error).message}`, {
          cause: e,
        });
      }
      const comp = composeFace(resolved, cacheRoot);
      canvas = comp.canvas;
      const base = `characters/${c.key}/${framing}/${face}`;
      faces[face] = {
        ...(comp.body ? { body: publish(publicDir, comp.body, `${base}/body.png`) } : {}),
        ...(comp.front ? { front: publish(publicDir, comp.front, `${base}/front.png`) } : {}),
        head: {
          base: publish(publicDir, comp.head.base, `${base}/head.png`),
          talk: publish(publicDir, comp.head.talk, `${base}/head-talk.png`),
          half: publish(publicDir, comp.head.half, `${base}/head-half.png`),
          blink: publish(publicDir, comp.head.blink, `${base}/head-blink.png`),
        },
        pivot: comp.pivot,
      };
      hashes[`character:${c.key}/${framing}/${face}/${side}`] = comp.hash;
    }
    parts[framing] = { canvas, baseWidth: size[0], baseHeight: size[1], faces };
  }
  // Classic faces stay empty: the stage draws parts characters from `parts`.
  return { faces: {}, facing: 'front', parts };
}

function prepareCharacters(
  opts: RenderOptions,
  publicDir: string,
  hashes: Record<string, string>,
): Record<string, PreparedCharacter> {
  const out: Record<string, PreparedCharacter> = {};
  const { left } = assignSides(opts.cast ?? []);
  const leftKeys = new Set(left.map((c) => c.key));
  for (const c of opts.cast ?? []) {
    if (!c.character) continue;
    const dir = resolve(opts.assetsRoot, c.character.dir);
    if (!existsSync(dir))
      throw new Error(`character folder not found: ${c.character.dir} (${dir})`);
    if (characterSource(dir) === 'parts') {
      const side: Side = leftKeys.has(c.key) ? 'left' : 'right';
      out[c.key] = prepareParts(
        opts,
        { ...c, character: c.character },
        dir,
        side,
        publicDir,
        hashes,
      );
      continue;
    }
    const faces: Record<string, CharacterFiles> = {};
    for (const [face, files] of Object.entries(characterFaces(dir))) {
      if (!files.base) continue; // a face needs its mouth-closed image
      const pub: CharacterFiles = {};
      for (const [kind, file] of Object.entries(files) as [keyof CharacterFiles, string][]) {
        const rel = `characters/${c.key}/${file}`;
        mkdirSync(join(publicDir, 'characters', c.key), { recursive: true });
        copyFileSync(join(dir, file), join(publicDir, rel));
        hashes[`character:${c.key}/${file}`] = sha256File(join(dir, file));
        pub[kind] = rel;
      }
      faces[face] = pub;
    }
    if (Object.keys(faces).length === 0)
      throw new Error(`character folder has no <face>.png: ${c.character.dir}`);
    out[c.key] = { faces, facing: c.character.facing };
  }
  return out;
}

/** Characters on stage per scene (character mode only; sides take turns). */
function stages(opts: RenderOptions): Record<string, Record<Side, StageSwitch[]>> {
  const cast = opts.cast ?? [];
  if (!(cast.length > 0 && cast.every((c) => c.character))) return {};
  const { left, right } = assignSides(cast);
  const sideOf: Record<string, Side> = Object.fromEntries([
    ...left.map((c) => [c.key, 'left'] as const),
    ...right.map((c) => [c.key, 'right'] as const),
  ]);
  const plan = stagePlan(opts.timeline.scenes, sideOf);
  return Object.fromEntries(opts.timeline.scenes.map((s, i) => [s.id, plan[i]!]));
}

function preparePublicDir(opts: RenderOptions) {
  const publicDir = join(opts.workDir, 'public');
  const hashes = prepareFonts(publicDir, opts.fontsDir);
  const imageSizes: Record<string, [number, number]> = {};
  const assetPaths: Record<string, string> = {};
  const images = [
    ...new Set([
      ...referencedImages(opts.timeline),
      ...(opts.cast ?? []).flatMap((c) => (c.avatar ? [c.avatar] : [])),
      ...(opts.logo ? [opts.logo.src] : []),
    ]),
  ];
  images.forEach((src, i) => {
    const abs = resolve(opts.assetsRoot, src);
    if (!existsSync(abs)) throw new Error(`asset not found: ${src} (${abs})`);
    const ext = abs.slice(abs.lastIndexOf('.'));
    const rel = `assets/${i}${ext}`;
    mkdirSync(join(publicDir, 'assets'), { recursive: true });
    copyFileSync(abs, join(publicDir, rel));
    // Videos are copied but have no image size (they fit with object-fit).
    if (!/\.(mp4|webm|mov|m4v)$/i.test(abs)) imageSizes[src] = imageSize(abs);
    assetPaths[src] = rel;
    hashes[`asset:${src}`] = sha256File(abs);
  });
  const characters = prepareCharacters(opts, publicDir, hashes);
  const customFontPath = prepareCustomFont(
    opts.subtitleStyle?.font,
    opts.assetsRoot,
    publicDir,
    hashes,
  );
  const subtitleStyle = opts.subtitleStyle
    ? { ...opts.subtitleStyle, ...(customFontPath ? { font: customFontPath } : {}) }
    : undefined;
  const cast = (opts.cast ?? []).map(({ avatar, character: _dir, ...c }) => ({
    ...c,
    ...(avatar ? { avatar: assetPaths[avatar]! } : {}),
    ...(characters[c.key] ? { character: characters[c.key] } : {}),
  }));
  const logo = opts.logo ? { ...opts.logo, src: assetPaths[opts.logo.src]! } : undefined;
  return { publicDir, imageSizes, assetPaths, hashes, cast, subtitleStyle, logo };
}

/**
 * Character hashes a scene depends on: classic art (`character:<key>/<file>`) always; composed
 * parts (`character:<key>/<framing>/<face>/<side>`) only in the scene's framing for that cast.
 */
function characterKeyFor(k: string, c: CastOption, scene: TimelineScene): boolean {
  if (!k.startsWith(`character:${c.key}/`)) return false;
  const rest = k.slice(`character:${c.key}/`.length).split('/');
  if (rest.length !== 3) return true;
  return (
    rest[0] === (scene.framing?.[c.key] ?? 'full') &&
    sceneFaces(scene, c.key, c.face).includes(rest[1]!)
  );
}

function chunkKey(
  scene: TimelineScene,
  opts: RenderOptions,
  hashes: Record<string, string>,
  stage: unknown,
): string {
  // Scene-local timeline slice (already frame-quantized) + everything that affects pixels.
  // Audio placement drives speaker highlights, faces and mouths (its file path does not).
  const { startFrame: _absoluteStart, audio, ...local } = scene;
  const speech = audio.map(({ src: _src, ...a }) => ({
    ...a,
    mouth: opts.mouths?.[a.sentenceId] ?? '',
  }));
  const relevant = Object.fromEntries(
    Object.entries(hashes).filter(
      ([k]) =>
        k.startsWith('font:') ||
        scene.visuals.some(
          (v) =>
            k === `asset:${v.visual.attrs.src}` ||
            (v.visual.images ?? []).some((im) => k === `asset:${im.src}`),
        ) ||
        scene.cues.some((c) => k === `asset:${c.attrs.show}`) ||
        k === `asset:${opts.logo?.src}` ||
        (opts.cast ?? []).some((c) => k === `asset:${c.avatar}` || characterKeyFor(k, c, scene)),
    ),
  );
  return createHash('sha256')
    .update(
      JSON.stringify({
        local,
        speech,
        stage,
        aspect: opts.aspect,
        subtitleMode: opts.subtitleMode ?? 'sentence',
        layout: opts.layout ?? 'presenter',
        cast: opts.cast ?? [],
        subtitleStyle: opts.subtitleStyle ?? null,
        transition: opts.transition ?? 'none',
        theme: opts.theme ?? null,
        logo: opts.logo ?? null,
        scale: opts.scale ?? 1,
        lang: opts.timeline.lang,
        fps: opts.timeline.fps,
        relevant,
        RENDERER_VERSION,
        source: rendererSourceHash(),
        gl: GL,
        remotion: '4.0.534',
      }),
    )
    .digest('hex')
    .slice(0, 20);
}

export async function renderScenes(opts: RenderOptions): Promise<RenderedChunk[]> {
  const log = opts.log ?? (() => {});
  mkdirSync(opts.workDir, { recursive: true });
  const { publicDir, imageSizes, assetPaths, hashes, cast, subtitleStyle, logo } =
    preparePublicDir(opts);
  const chunkDir = join(opts.workDir, 'chunks');
  mkdirSync(chunkDir, { recursive: true });

  const stage = stages(opts);
  const plan = opts.timeline.scenes.map((scene) => {
    const key = chunkKey(scene, opts, hashes, stage[scene.id] ?? null);
    const path = join(chunkDir, `${scene.id}-${opts.aspect.replace(':', 'x')}-${key}.mp4`);
    return { scene, path, cached: !opts.noCache && existsSync(path) && statSync(path).size > 0 };
  });
  if (plan.every((p) => p.cached)) {
    log('all scene chunks cached');
    return plan.map((p) => ({
      sceneId: p.scene.id,
      path: p.path,
      frames: p.scene.durationFrames,
      cached: true,
    }));
  }

  log('bundling ...');
  const serveUrl = await bundle({
    entryPoint: ENTRY,
    outDir: join(opts.workDir, 'bundle'),
    publicDir,
  });
  const results: RenderedChunk[] = [];
  for (const p of plan) {
    if (p.cached) {
      results.push({
        sceneId: p.scene.id,
        path: p.path,
        frames: p.scene.durationFrames,
        cached: true,
      });
      continue;
    }
    const inputProps = {
      scene: p.scene,
      lang: opts.timeline.lang,
      fps: opts.timeline.fps,
      aspect: opts.aspect,
      subtitleMode: opts.subtitleMode ?? 'sentence',
      imageSizes,
      assetPaths,
      layout: opts.layout ?? 'presenter',
      cast,
      mouths: Object.fromEntries(
        p.scene.audio.map((a) => [a.sentenceId, opts.mouths?.[a.sentenceId] ?? '']),
      ),
      stage: stage[p.scene.id] ?? { left: [], right: [] },
      ...(subtitleStyle ? { subtitleStyle } : {}),
      transition: opts.transition ?? 'none',
      ...(opts.theme ? { theme: opts.theme } : {}),
      ...(logo ? { logo } : {}),
    };
    const composition = await selectComposition({
      serveUrl,
      id: 'S2VScene',
      inputProps,
      logLevel: 'warn',
    });
    const started = Date.now();
    const tmp = `${p.path}.part.mp4`;
    await renderMedia({
      serveUrl,
      composition,
      inputProps,
      codec: 'h264',
      muted: true,
      ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
      pixelFormat: 'yuv420p',
      scale: opts.scale ?? 1,
      outputLocation: tmp,
      overwrite: true,
      logLevel: 'warn',
      chromiumOptions: { gl: GL },
      ffmpegOverride: ({ args }) =>
        args.includes('libx264')
          ? [...args.slice(0, -1), ...CONCAT_ARGS, args[args.length - 1]!]
          : args,
    });
    const { renameSync } = await import('node:fs');
    renameSync(tmp, p.path);
    log(
      `  scene ${p.scene.id}: ${p.scene.durationFrames} frames in ${((Date.now() - started) / 1000).toFixed(1)}s`,
    );
    results.push({
      sceneId: p.scene.id,
      path: p.path,
      frames: p.scene.durationFrames,
      cached: false,
    });
  }
  return results;
}

export interface StillRequest {
  sceneId: string;
  /** Scene-local frame. */
  frame: number;
  output: string;
}

/**
 * Render single frames (PNG) of scenes without encoding video — used by `s2v snapshot` to
 * review the layout of every scene in seconds (PLAN 5.12).
 */
export async function renderStills(opts: RenderOptions, requests: StillRequest[]): Promise<void> {
  mkdirSync(opts.workDir, { recursive: true });
  const { publicDir, imageSizes, assetPaths, cast, subtitleStyle, logo } = preparePublicDir(opts);
  const serveUrl = await bundle({
    entryPoint: ENTRY,
    outDir: join(opts.workDir, 'bundle'),
    publicDir,
  });
  const stage = stages(opts);
  for (const r of requests) {
    const scene = opts.timeline.scenes.find((s) => s.id === r.sceneId);
    if (!scene) throw new Error(`unknown scene ${r.sceneId}`);
    const inputProps = {
      scene,
      lang: opts.timeline.lang,
      fps: opts.timeline.fps,
      aspect: opts.aspect,
      subtitleMode: opts.subtitleMode ?? 'sentence',
      imageSizes,
      assetPaths,
      layout: opts.layout ?? 'presenter',
      cast,
      mouths: Object.fromEntries(
        scene.audio.map((a) => [a.sentenceId, opts.mouths?.[a.sentenceId] ?? '']),
      ),
      stage: stage[scene.id] ?? { left: [], right: [] },
      ...(subtitleStyle ? { subtitleStyle } : {}),
      transition: opts.transition ?? 'none',
      ...(opts.theme ? { theme: opts.theme } : {}),
      ...(logo ? { logo } : {}),
    };
    const composition = await selectComposition({
      serveUrl,
      id: 'S2VScene',
      inputProps,
      logLevel: 'warn',
    });
    await renderStill({
      serveUrl,
      composition,
      inputProps,
      frame: Math.min(Math.max(0, r.frame), scene.durationFrames - 1),
      output: r.output,
      imageFormat: 'png',
      scale: opts.scale ?? 1,
      logLevel: 'warn',
      chromiumOptions: { gl: GL },
    });
  }
}

export interface SubtitleMeasureOptions {
  lang: string;
  /** Texts to measure per frame aspect, speaker arrangement and subtitle style. */
  groups: {
    aspect: Aspect;
    shape?: Omit<DialogueShape, 'portrait'>;
    style?: SubtitleStyleOption;
    texts: string[];
  }[];
  /** Directory a style's `font` is relative to. */
  assetsRoot?: string;
  fontsDir: string;
  workDir: string;
}

export interface SubtitleMeasure {
  lines: number;
  maxLines: number;
  width: number;
}

/**
 * Lines each subtitle text needs when laid out by the real subtitle component in Chromium
 * (`s2v check`). The rendered box shows at most `maxLines` lines and silently hides the rest.
 * Returns one array per group, in order.
 */
export async function measureSubtitleLines(
  opts: SubtitleMeasureOptions,
): Promise<SubtitleMeasure[][]> {
  mkdirSync(opts.workDir, { recursive: true });
  const publicDir = join(opts.workDir, 'public');
  prepareFonts(publicDir, opts.fontsDir);
  const fonts = new Map<string, string>();
  for (const g of opts.groups)
    if (g.style?.font && !fonts.has(g.style.font)) {
      const abs = resolve(opts.assetsRoot ?? '.', g.style.font);
      if (!existsSync(abs)) throw new Error(`subtitle font not found: ${g.style.font}`);
      const rel = `fonts/custom-${fonts.size}${abs.slice(abs.lastIndexOf('.'))}`;
      copyFileSync(abs, join(publicDir, rel));
      fonts.set(g.style.font, rel);
    }
  const serveUrl = await bundle({
    entryPoint: ENTRY,
    outDir: join(opts.workDir, 'bundle'),
    publicDir,
  });
  const out: SubtitleMeasure[][] = [];
  for (const g of opts.groups) {
    const inputProps = {
      lang: opts.lang,
      // Same rule as the subtitle component: frames narrower than 1500 px use portrait metrics.
      shape: { mode: 'none', left: 0, right: 0, ...g.shape, portrait: g.aspect !== '16:9' },
      style: {
        ...(g.style?.size ? { size: g.style.size } : {}),
        ...(g.style?.position ? { position: g.style.position } : {}),
        ...(g.style?.font ? { font: fonts.get(g.style.font)! } : {}),
      },
      items: g.texts.map((text, i) => ({ id: String(i), text })),
      results: [],
    };
    const composition = await selectComposition({
      serveUrl,
      id: 'S2VProbe',
      inputProps,
      logLevel: 'warn',
    });
    const results = (composition.props as { results: SubtitleMeasure[] }).results;
    out.push(results.map(({ lines, maxLines, width }) => ({ lines, maxLines, width })));
  }
  return out;
}
