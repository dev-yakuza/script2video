/**
 * The public dir a render or a still serves (fonts, assets, characters) and the hashes of what
 * went into it — the chunk keys read them, in the order they are written (S4b plan 2.3). Not
 * part of the package API: `index.ts` re-exports what others use.
 */

import type { Timeline, TimelineScene } from '@script2video/core';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { composeImportedPlanned, composePlanned } from './character/compose.js';
import { characterFaces, type CharacterFiles, imageSize } from './character/files.js';
import { planCharacter } from './character/plan.js';
import { characterSource, type Framing } from './character/spec.js';
import type { CastOption, RenderOptions } from './index.js';
import type { PartsFace, PartsSet } from './remotion/types.js';
import { assignSides, type Side } from './shared.js';

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

export const FONT_FILES = [
  'NotoSansKR-Variable.ttf',
  'NotoSansJP-Variable.ttf',
  'JetBrainsMono-Variable.ttf',
];

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Files a `::video` plays (by extension); every other picture must be a PNG or JPEG. */
export const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

/** Pictures and clips the timeline shows (lint holds its own list to this, S12). */
export function referencedImages(timeline: Timeline): string[] {
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

export function prepareFonts(publicDir: string, fontsDir: string): Record<string, string> {
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

type PreparedCharacter = {
  faces: Record<string, CharacterFiles>;
  facing: 'left' | 'right' | 'front';
  parts?: Record<string, PartsSet>;
  /** Imported material: art size, so it is scaled like parts art (plan 5.3). */
  size?: [number, number];
};

/**
 * Faces a cast member shows per framing in this output: its default face plus the faces of its
 * lines and reactions, in each scene's framing. The stage only ever shows these (a character
 * still on stage after a boundary shows its default face), and lint checks exactly the same set.
 */
export function usedFaces(
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

/** Faces a cast member can show in one scene (its lines, reactions and looks). */
export function sceneFaces(scene: TimelineScene, key: string, defaultFace: string): string[] {
  return [
    defaultFace,
    ...scene.audio.filter((a) => a.cast === key).map((a) => a.face),
    ...scene.reactions.filter((r) => r.cast === key).map((r) => r.face),
    ...(scene.looks ?? []).filter((l) => l.cast === key).map((l) => l.face),
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
  const cacheRoot = join(opts.workDir, 'characters');
  // The plan keeps the order of the used faces: hashes (and chunk keys) are written in it.
  const plan = planCharacter(
    dir,
    usedFaces(opts.timeline, c.key, c.face),
    c.face,
    side,
    sha256File,
    { key: c.key, dir: c.character.dir },
  );
  if (plan.source === 'imported') {
    const faces: Record<string, CharacterFiles> = {};
    for (const [face, p] of plan.faces) {
      const f = composeImportedPlanned(p, cacheRoot);
      const base = `characters/${c.key}/full/${face}`;
      faces[face] = {
        base: publish(publicDir, f.base, `${base}/face.png`),
        talk: publish(publicDir, f.talk, `${base}/face-talk.png`),
        half: publish(publicDir, f.half, `${base}/face-half.png`),
        blink: publish(publicDir, f.blink, `${base}/face-blink.png`),
      };
      hashes[`character:${c.key}/full/${face}/${side}`] = f.hash;
    }
    return { faces, facing: 'front', size: plan.size };
  }
  // planCharacter gives `classic` only for folders without character.yaml (not parts): narrows
  if (plan.source !== 'layered') throw new Error(`character ${c.key}: not a parts character`);
  const parts: Record<string, PartsSet> = {};
  for (const set of plan.sets) {
    const faces: Record<string, PartsFace> = {};
    let canvas: [number, number] = set.size;
    for (const [face, p] of set.faces) {
      const comp = composePlanned(p, cacheRoot);
      canvas = comp.canvas;
      const base = `characters/${c.key}/${set.framing}/${face}`;
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
      hashes[`character:${c.key}/${set.framing}/${face}/${side}`] = comp.hash;
    }
    parts[set.framing] = {
      canvas,
      baseWidth: set.size[0],
      baseHeight: set.size[1],
      faces,
    };
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

export function preparePublicDir(opts: RenderOptions) {
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
    if (!VIDEO_EXT.test(abs)) imageSizes[src] = imageSize(abs);
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
