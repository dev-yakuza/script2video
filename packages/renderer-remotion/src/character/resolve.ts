/**
 * Face → layers for one (framing, face, side) of a layered character (plan 3.2, C3, C4, C10, C11).
 * Pure: no image IO. Positions are in the set's widened canvas (margin `m` on both sides).
 *
 * Flip rule: a layer group is mirrored when its facing equals the side it stands on (it would look
 * toward the frame edge). Body and front layers flip about the view pivot x; the head group is
 * placed at the effective pivot e = pivot + (body offset + group offset)·(B ? −1 : 1) and flips
 * about e.x. With `mirror: false` the `@flip` twin is used instead of flipping.
 */

import { join } from 'node:path';
import type { Side } from '../shared.js';
import type { BodyDef, Facing, Framing, HeadDef, LayeredSpec, SetDef, ViewDef } from './spec.js';

export interface Placement {
  /** Absolute path of the source PNG (set canvas size). */
  file: string;
  flip: boolean;
  /** Top-left of the (possibly flipped) source canvas inside the widened canvas. */
  x: number;
  y: number;
}

export interface ResolvedFace {
  /** Widened canvas [W, H] and the set's own art size [W0, H0] (the size rule uses the art size). */
  canvas: [number, number];
  baseWidth: number;
  baseHeight: number;
  body?: Placement;
  front?: Placement;
  /** Head state images are stacks of these files (head + parts) on the set canvas, then placed. */
  head: {
    states: { closed: string[]; half: string[]; talk: string[]; blink: string[] };
    flip: boolean;
    x: number;
    y: number;
  };
  /** Effective pivot in the widened canvas (head transform origin), or null without one. */
  pivot: [number, number] | null;
  /** Everything that decided the pixels (for the composition hash). */
  key: Record<string, unknown>;
}

export class FaceError extends Error {}

/** One-image view: `layers: single`, or a turned view without `layers` (plan Q4). */
export const isSingle = (v: ViewDef): boolean =>
  v.layers ? v.layers === 'single' : v.facing !== 'front';

interface SetView {
  root: string;
  views: Record<string, ViewDef>;
  heads: SetDef['heads'];
  bodies: SetDef['bodies'];
  groups: SetDef['groups'];
}

export function setOf(dir: string, spec: LayeredSpec, framing: Framing): SetView {
  if (framing === 'full')
    return {
      root: dir,
      views: spec.views,
      heads: spec.heads,
      bodies: spec.bodies,
      groups: spec.groups,
    };
  const s = spec.sets[framing];
  if (!s) throw new FaceError(`no "${framing}" set in character.yaml (sets.${framing})`);
  return {
    root: join(dir, 'sets', framing),
    views: s.views,
    heads: s.heads,
    bodies: s.bodies,
    groups: s.groups,
  };
}

/** Margin each side of the set canvas so any flip/offset stays inside (same for every face). */
export function setMargin(set: SetView, width: number): number {
  let m = 0;
  const dx = Math.max(
    0,
    ...Object.values(set.bodies).map((b) => Math.abs(b.offset?.[0] ?? 0)),
    ...Object.values(set.groups).map((g) => Math.abs(g.offset?.[0] ?? 0)),
  );
  for (const v of Object.values(set.views)) {
    const px = v.pivot?.[0] ?? (width - 1) / 2;
    m = Math.max(m, Math.abs(2 * px - (width - 1)));
  }
  return Math.ceil(m + 4 * dx);
}

/** Room above the art so a head raised by offsets (negative dy) is not cropped. */
export function setTopMargin(set: SetView): number {
  const up = (vals: number[]) => Math.max(0, ...vals.map((v) => -v));
  return Math.ceil(
    up(Object.values(set.bodies).map((b) => b.offset?.[1] ?? 0)) +
      up(Object.values(set.groups).map((g) => g.offset?.[1] ?? 0)),
  );
}

/** Which way the partner stands for `gaze: toward|away` (plan C11). */
function gazeFile(gaze: string | undefined, side: Side): string | null {
  if (!gaze) return null;
  if (gaze === 'up' || gaze === 'down') return `eyes@${gaze}.png`;
  const partner = side === 'left' ? 'right' : 'left';
  const dir = gaze === 'toward' ? partner : side;
  return `eyes@screen-${dir}.png`;
}

/**
 * The head the head close-up turns a turned face with (closeup-look plan): the set's turned
 * front head (a `glance` preset first, then the first by name), or null for a front face or a set
 * without one. With `mirror: false` a head without its `@flip` twin is not used on either side
 * (one side would need the twin), so the face stays frontal on both.
 */
function turnedHead(spec: LayeredSpec, set: SetView, view: string): string | null {
  if ((spec.views[view.replace(/@flip$/, '')]?.facing ?? 'front') === 'front') return null;
  const heads = Object.entries(set.heads)
    .filter(
      ([k, h]) =>
        k.startsWith('front/') && !k.endsWith('@flip') && (h.facing ?? 'front') !== 'front',
    )
    .sort(
      ([a, x], [b, y]) =>
        Number(y.preset === 'glance') - Number(x.preset === 'glance') || a.localeCompare(b),
    );
  const k = heads[0]?.[0];
  if (!k || (!spec.mirror && !set.heads[`${k}@flip`])) return null;
  return k.slice('front/'.length);
}

export function resolveFace(
  dir: string,
  spec: LayeredSpec,
  framing: Framing,
  faceName: string,
  side: Side,
  size: [number, number],
): ResolvedFace {
  const set = setOf(dir, spec, framing);
  if (framing !== 'full' && !spec.sets[framing]!.faces.includes(faceName))
    throw new FaceError(`face "${faceName}" is not in sets.${framing}.faces`);
  const fd = spec.faces[faceName];
  if (!fd) throw new FaceError(`face "${faceName}" is not defined in character.yaml faces`);
  let view = fd.view;
  let body = fd.body ?? 'stand';
  let head = fd.head ?? 'base';
  const expr = fd.expression;
  // Close-up sets have one (front) view: every face is drawn from it, keeping its expression
  // and head; the head set has no bodies (upper keeps a body the set defines). In the head
  // close-up a turned face turns the head instead: without a body, turn and glance look alike.
  if (framing !== 'full') {
    const turned = framing === 'head' && !fd.head ? turnedHead(spec, set, fd.view) : null;
    view = 'front';
    if (framing === 'head' || (body !== 'stand' && !set.bodies[`front/${body}`])) body = 'stand';
    if (turned) head = turned;
    else if (head !== 'base' && !set.heads[`front/${head}`]) head = 'base';
  }

  const viewDef = (v: string) => {
    const d = set.views[v];
    if (!d) throw new FaceError(`face "${faceName}": view "${v}" is not defined`);
    return d;
  };
  const bodyDef = (v: string, b: string): BodyDef => {
    if (b === 'stand') return {};
    const d = set.bodies[`${v}/${b}`];
    if (!d) throw new FaceError(`face "${faceName}": body "${v}/${b}" is not defined`);
    return d;
  };
  const headDef = (v: string, h: string): HeadDef => {
    if (h === 'base') return {};
    const d = set.heads[`${v}/${h}`];
    if (!d) throw new FaceError(`face "${faceName}": head "${v}/${h}" is not defined`);
    return d;
  };

  let vd = viewDef(view);
  let bd = bodyDef(view, body);
  let hd = headDef(view, head);
  const bodyFacing = (): Facing => bd.facing ?? vd.facing;
  const headFacing = (): Facing => hd.facing ?? vd.facing;
  let B = bodyFacing() === side;
  let H = headFacing() === side;

  if (!spec.mirror) {
    // Swap in the opposite-facing twins instead of flipping (asymmetric designs).
    if (B) {
      if (bd.facing && body !== 'stand') body = `${body}@flip`;
      else {
        view = `${view}@flip`;
        vd = viewDef(view);
      }
      bd = bodyDef(view, body);
      hd = headDef(view, head);
    }
    if (headFacing() === side && head !== 'base') {
      head = `${head}@flip`;
      hd = headDef(view, head);
    }
    if (bodyFacing() === side || headFacing() === side)
      throw new FaceError(`face "${faceName}": no @flip twin faces the center on the ${side} side`);
    B = false;
    H = false;
  }

  const [W0, Ht] = size;
  const m = setMargin(set, W0);
  const mt = setTopMargin(set);
  const noBody = framing === 'head' || isSingle(vd);
  // Without a pivot (hand-drawn, head framing) flips use the canvas center and head motions fall back.
  const pivot = vd.pivot ?? null;
  const px = pivot?.[0] ?? (W0 - 1) / 2;
  const py = pivot?.[1] ?? Ht;
  // One-image views and the head framing have no head group to move: offsets do not apply.
  const bo: [number, number] = noBody ? [0, 0] : (bd.offset ?? [0, 0]);
  const go: [number, number] = noBody
    ? [0, 0]
    : (set.groups[`${view}/${head}/${expr}`]?.offset ?? [0, 0]);
  const dx = bo[0] + go[0];
  const dy = bo[1] + go[1];
  const ex = px + dx * (B ? -1 : 1);
  const ey = py + dy + mt;

  const viewDir = join(set.root, 'views', view);
  const faceDir = join(viewDir, 'face', head, expr);
  const f = (name: string) => join(faceDir, name);
  const gaze = gazeFile(spec.expressions[expr]?.gaze, side);
  const eyes = gaze ? [f(gaze)] : [];
  const flipX = (flip: boolean, axis: number) => (flip ? m + 2 * axis - (W0 - 1) : m);

  const resolved: ResolvedFace = {
    canvas: [W0 + 2 * m, Ht + mt],
    baseWidth: W0,
    baseHeight: Ht,
    head: {
      states: {
        closed: [f('head.png'), ...eyes],
        half: [f('head.png'), ...eyes, f('mouth.1.png')],
        talk: [f('head.png'), ...eyes, f('mouth.png')],
        blink: [f('head.png'), f('eyes.0.png')],
      },
      flip: H,
      // Unflipped: shifted by (e − pivot); flipped: mirrored about e.x.
      x: H ? m + ex + px - (W0 - 1) : m + (ex - px),
      y: mt + dy,
    },
    pivot: pivot && !noBody ? [m + ex, ey] : null,
    key: {
      framing,
      view,
      body,
      head,
      expr,
      side,
      B,
      H,
      m,
      mt,
      px,
      py,
      dx,
      dy,
      gaze,
      mirror: spec.mirror,
    },
  };
  if (!noBody) {
    resolved.body = { file: join(viewDir, 'body', `${body}.png`), flip: B, x: flipX(B, px), y: mt };
    resolved.front = {
      file: join(viewDir, 'front', `${body}.png`),
      flip: B,
      x: flipX(B, px),
      y: mt,
    };
  }
  return resolved;
}

/** Screen-space flip check used by tests: where a canvas x of a layer lands. */
export function landingX(p: { flip: boolean; x: number }, sourceX: number, width: number): number {
  return p.flip ? p.x + (width - 1 - sourceX) : p.x + sourceX;
}
