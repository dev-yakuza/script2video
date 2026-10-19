/**
 * What a character composition reads (S4b plan 3): the input plan of each face — files, their
 * sha256, placements and the fallbacks taken — without running ffmpeg. `render` composes from
 * these plans (compose.ts) and `s2v inspect` hashes them, so both read the same inputs.
 *
 * Order is kept as given (faces, framings): the renderer records its hashes in this order and the
 * chunk keys depend on it (plan 3.1). Nothing here sorts.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { Side } from '../shared.js';
import { characterFaces, findHeadImage, imageSize, subdirs, type CharacterFiles } from './files.js';
import { type Placement, resolveFace, type ResolvedFace, setOf } from './resolve.js';
import {
  characterSource,
  type Framing,
  IMPORTED_PARTS,
  type ImportedSpec,
  type LayeredSpec,
  loadCharacterSpec,
} from './spec.js';

/** sha256 (hex) of a file. */
export type Sha = (absPath: string) => string;

/** A picture a face needs is missing or unreadable (the message names it). */
export class ArtMissing extends Error {}

export interface Layer {
  file: string;
  x: number;
  y: number;
  flip: boolean;
  /** 0–1, for semi-transparent layers. */
  opacity?: number;
}

export interface LayeredFacePlan {
  kind: 'layered';
  resolved: ResolvedFace;
  /** Head state stacks after the fallbacks (half → talk → closed, blink → closed). */
  states: { closed: string[]; half: string[]; talk: string[]; blink: string[] };
  /** The front layer, only when its file exists. */
  front?: Placement;
  /** [absolute path, sha256] of every input, in the composition hash's order. */
  files: [string, string][];
}

export interface ImportedFacePlan {
  kind: 'imported';
  size: [number, number];
  flip: boolean;
  /** Layers of the base, talk, half and blink images. */
  layers: Layer[][];
  /** sha256 by absolute path of every layer file. */
  sha: Record<string, string>;
}

export interface ClassicFacePlan {
  kind: 'classic';
  /** File names of the face (the ones that exist). */
  files: CharacterFiles;
  sha: Partial<Record<keyof CharacterFiles, string>>;
}

export type FacePlan = LayeredFacePlan | ImportedFacePlan | ClassicFacePlan;

/** One layered (framing, face, side): the files composeFace reads, with its fallbacks. */
export function planLayeredFace(resolved: ResolvedFace, sha: Sha): LayeredFacePlan {
  const exists = (f: string) => existsSync(f);
  const { states } = resolved.head;
  if (!exists(states.closed[0]!)) throw new ArtMissing(`head image missing: ${states.closed[0]}`);
  for (const f of states.closed.slice(1))
    if (!exists(f)) throw new ArtMissing(`eye part missing: ${f}`);
  // Optional parts fall back: half → talk → closed; blink → closed.
  const talk = exists(states.talk.at(-1)!) ? states.talk : states.closed;
  const half = exists(states.half.at(-1)!) ? states.half : talk;
  const blink = exists(states.blink.at(-1)!) ? states.blink : states.closed;
  if (resolved.body && !exists(resolved.body.file))
    throw new ArtMissing(`body image missing: ${resolved.body.file}`);
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
  return {
    kind: 'layered',
    resolved,
    states: { closed: states.closed, half, talk, blink },
    ...(front ? { front } : {}),
    files: inputs.map((f) => [f, sha(f)]),
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

function normalize(sel: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(sel).map(([k, v]) => [slotKey(k.normalize('NFC')), v.normalize('NFC')]),
  );
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Layers of an imported YMM4 face for one side (plan C2 b). Faces name a file stem per folder;
 * folders a face leaves out use `faces.neutral`. The mouth uses `stem.0` closed, the middle
 * intermediate frame half, `stem` open; eyes `stem.0` for the blink.
 */
export function planImportedFace(
  dir: string,
  spec: ImportedSpec,
  face: string,
  side: Side,
  size: [number, number],
  sha: Sha,
): ImportedFacePlan {
  dir = join(dir, IMPORTED_PARTS);
  const pick: Record<string, string> = {
    ...normalize(spec.faces.neutral ?? {}),
    ...normalize(spec.faces[face] ?? {}),
  };
  if (pick['髪']) pick['髪(半透明)'] = pick['髪'];
  if (!spec.faces[face]) throw new ArtMissing(`face "${face}" is not defined in character.yaml`);
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
      if (!existsSync(file)) throw new ArtMissing(`part missing: ${file}`);
      return {
        file,
        x: 0,
        y: 0,
        flip,
        ...(k === '髪(半透明)' ? { opacity: HAIR_OVER_OPACITY } : {}),
      };
    });
  const layers = (['base', 'talk', 'half', 'blink'] as const).map((s) => layersFor(s));
  const shas: Record<string, string> = {};
  for (const ls of layers) for (const l of ls) shas[l.file] ??= sha(l.file);
  return { kind: 'imported', size, flip, layers, sha: shas };
}

/** A classic (single image) face: its `<face>.png` and the variants that exist. */
export function planClassicFace(dir: string, face: string, sha: Sha): ClassicFacePlan {
  const files = characterFaces(dir)[face];
  if (!files?.base) throw new ArtMissing(`${face}.png is missing (face "${face}")`);
  const shas: ClassicFacePlan['sha'] = {};
  for (const [kind, name] of Object.entries(files) as [keyof CharacterFiles, string][])
    shas[kind] = sha(join(dir, name));
  return { kind: 'classic', files, sha: shas };
}

export type CharacterPlan =
  | {
      source: 'imported';
      size: [number, number];
      faces: [string, ImportedFacePlan][];
      /** Framings the faces were asked for that imported art does not have (only full). */
      ignoredFramings: Framing[];
    }
  | {
      source: 'layered';
      sets: {
        framing: Framing;
        /** The set's own art size and its widened canvas. */
        size: [number, number];
        canvas: [number, number];
        faces: [string, LayeredFacePlan][];
      }[];
    }
  | { source: 'classic'; faces: [string, ClassicFacePlan][] };

const sizeOf = (path: string): [number, number] => {
  try {
    return imageSize(path);
  } catch (e) {
    throw new ArtMissing((e as Error).message, { cause: e });
  }
};

/**
 * Plans of one cast member's faces per framing on one side (the first part of the renderer's
 * prepareParts). The size of a layered set comes from `defaultFace` (the renderer's first face of
 * every framing). `who` names the cast in messages, as the renderer always did.
 */
export function planCharacter(
  dir: string,
  used: Map<Framing, Iterable<string>>,
  defaultFace: string,
  side: Side,
  sha: Sha,
  who: { key: string; dir: string },
): CharacterPlan {
  if (characterSource(dir) !== 'parts') {
    const seen = new Set<string>();
    const faces: [string, ClassicFacePlan][] = [];
    for (const names of used.values())
      for (const face of names) {
        if (seen.has(face)) continue;
        seen.add(face);
        faces.push([face, planClassicFace(dir, face, sha)]);
      }
    return { source: 'classic', faces };
  }
  const spec = loadCharacterSpec(dir);
  if (spec.source === 'imported') {
    const parts = join(dir, IMPORTED_PARTS);
    const first = subdirs(parts).flatMap((f) =>
      readdirSync(join(parts, f))
        .filter((x) => x.endsWith('.png') && !x.startsWith('.'))
        .map((x) => join(parts, f, x)),
    )[0];
    if (!first) throw new ArtMissing(`character ${who.key}: no parts found in ${parts}`);
    const size = (spec.size as [number, number] | undefined) ?? sizeOf(first);
    const faces: [string, ImportedFacePlan][] = [];
    for (const face of used.get('full') ?? [defaultFace])
      faces.push([face, planImportedFace(dir, spec, face, side, size, sha)]);
    return {
      source: 'imported',
      size,
      faces,
      ignoredFramings: [...used.keys()].filter((f) => f !== 'full'),
    };
  }
  return { source: 'layered', sets: planLayeredSets(dir, spec, used, defaultFace, side, sha, who) };
}

function planLayeredSets(
  dir: string,
  spec: LayeredSpec,
  used: Map<Framing, Iterable<string>>,
  defaultFace: string,
  side: Side,
  sha: Sha,
  who: { key: string; dir: string },
): Extract<CharacterPlan, { source: 'layered' }>['sets'] {
  const sets: Extract<CharacterPlan, { source: 'layered' }>['sets'] = [];
  for (const [framing, names] of used) {
    let set: ReturnType<typeof setOf>;
    try {
      set = setOf(dir, spec, framing);
    } catch (e) {
      throw new ArtMissing(`character ${who.key} (${who.dir}): ${(e as Error).message}`, {
        cause: e,
      });
    }
    if (!findHeadImage(set.root))
      throw new ArtMissing(
        `character ${who.key}: no head images in the ${framing} set (${set.root})`,
      );
    // a face that cannot be resolved names the cast, the framing and the side (plan 5.3)
    const resolveIn = (face: string, size: [number, number]) => {
      try {
        return resolveFace(dir, spec, framing, face, side, size);
      } catch (e) {
        throw new ArtMissing(
          `character ${who.key} (${who.dir}): ${(e as Error).message} (${framing}, ${side})`,
          { cause: e },
        );
      }
    };
    // The canvas is the size of the art the output uses (`size` describes the full set).
    const first = resolveIn(defaultFace, [1, 1]).head.states.closed[0]!;
    const size =
      framing === 'full' && spec.size
        ? (spec.size as [number, number])
        : existsSync(first)
          ? sizeOf(first)
          : sizeOf(findHeadImage(set.root)!);
    const faces: [string, LayeredFacePlan][] = [];
    let canvas: [number, number] = size;
    for (const face of names) {
      const resolved = resolveIn(face, size);
      const plan = planLayeredFace(resolved, sha);
      canvas = resolved.canvas;
      faces.push([face, plan]);
    }
    sets.push({ framing, size, canvas, faces });
  }
  return sets;
}

/** Path inside the character folder, with `/` separators. */
const inside = (dir: string, abs: string) => relative(dir, abs).split(sep).join('/');

/**
 * What decides a face's pixels, for hashing (S4b plan 4.2): paths relative to the character
 * folder, files by sha256, placements — no absolute path, no ffmpeg version.
 */
export function planIdentity(plan: FacePlan, dir: string): unknown {
  const rel = (p: string) => inside(dir, p);
  if (plan.kind === 'layered') {
    const r = plan.resolved;
    const place = (p: Placement | undefined) =>
      p && { file: rel(p.file), flip: p.flip, x: p.x, y: p.y };
    return {
      kind: 'layered',
      key: r.key,
      canvas: r.canvas,
      baseWidth: r.baseWidth,
      baseHeight: r.baseHeight,
      head: { flip: r.head.flip, x: r.head.x, y: r.head.y },
      body: place(r.body),
      front: place(plan.front),
      pivot: r.pivot,
      states: {
        closed: plan.states.closed.map(rel),
        half: plan.states.half.map(rel),
        talk: plan.states.talk.map(rel),
        blink: plan.states.blink.map(rel),
      },
      files: plan.files.map(([f, s]) => [rel(f), s]),
    };
  }
  if (plan.kind === 'imported')
    return {
      kind: 'imported',
      size: plan.size,
      flip: plan.flip,
      layers: plan.layers.map((ls) =>
        ls.map((l) => [rel(l.file), plan.sha[l.file], l.opacity ?? 1]),
      ),
    };
  return {
    kind: 'classic',
    ...Object.fromEntries(
      Object.entries(plan.files).map(([k, name]) => [
        k,
        `${name}@${plan.sha[k as keyof CharacterFiles]}`,
      ]),
    ),
  };
}
