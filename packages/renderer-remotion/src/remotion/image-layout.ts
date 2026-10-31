/**
 * Where an image layer sits (pure, so it is tested without rendering): its fit (shared.ts
 * imageFitBox, passed in so this file stays free of React and relative imports), cue zooms
 * and the Ken Burns drift.
 */
import type { TimelineCue } from '@script2video/core';
import { Easing, interpolate } from 'remotion';

const ZOOM_FRAMES = 12;
export const MARK_FADE = 6;
const MARK_MARGIN = 24; // px kept between a mark and the frame edge
const ease = Easing.inOut(Easing.cubic);

const MARKS = ['circle', 'box', 'highlight', 'spotlight', 'arrow'] as const;
type MarkKind = (typeof MARKS)[number];
/** Arrow length as a fraction of the fitted image width. */
export const ARROW_LEN = 0.12;

export interface Focus {
  x: number;
  y: number;
  zoom: number;
  mark?: MarkKind;
  /** w / h were given (spotlight: box instead of circle). */
  sized: boolean;
  /** arrow only: where the arrow comes from. */
  from: 'left' | 'right' | 'top' | 'bottom';
  /** Mark size as a fraction of the image width (circle radius r; box w × h with h of image height). */
  r: number;
  w: number;
  h: number;
}
interface Xform {
  tx: number;
  ty: number;
  s: number;
}

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v === undefined || !Number.isFinite(n) ? d : n;
};

export const focusOf = (c: TimelineCue): Focus => ({
  x: num(c.attrs.x, 0.5),
  y: num(c.attrs.y, 0.5),
  zoom: Math.max(1, num(c.attrs.zoom, 1)),
  ...((MARKS as readonly string[]).includes(c.attrs.mark ?? '')
    ? { mark: c.attrs.mark as MarkKind }
    : {}),
  r: num(c.attrs.r, c.attrs.mark === 'spotlight' ? 0.08 : 0.035),
  w: num(c.attrs.w, 0.16),
  h: num(c.attrs.h, 0.1),
  sized: c.attrs.w !== undefined || c.attrs.h !== undefined,
  from: (['left', 'right', 'top', 'bottom'] as const).find((d) => d === c.attrs.from) ?? 'left',
});

/** Spotlight and highlight use a box when w/h are given, otherwise (spotlight) a circle. */
export const boxed = (f: Focus) =>
  f.mark === 'box' || f.mark === 'highlight' || (f.mark === 'spotlight' && f.sized);

/** Mark half-extent in fitted-image pixels (before zoom). */
const markHalf = (f: Focus, fw: number, fh: number): [number, number] => {
  if (!f.mark) return [0, 0];
  if (f.mark === 'arrow') {
    // The arrow extends from its tip toward `from`; keep the whole shaft in view.
    const len = ARROW_LEN * fw;
    return f.from === 'left' || f.from === 'right' ? [len, len * 0.25] : [len * 0.25, len];
  }
  return boxed(f) ? [(f.w / 2) * fw, (f.h / 2) * fh] : [f.r * fw, f.r * fw];
};

/**
 * Transform that centers (x, y) at zoom z, clamped so no image edge enters the frame. A mark near
 * the image edge (e.g. a button in the very corner) wins over the clamp: the image is shifted just
 * enough to keep the whole mark inside the frame, and only a mark larger than the frame lowers the
 * zoom.
 */
function targetXform(W: number, H: number, fw: number, fh: number, f: Focus): Xform {
  const clampAxis = (area: number, size: number, p: number) =>
    size <= area ? (area - size) / 2 : Math.min(0, Math.max(area - size, area / 2 - p * size));
  // Shift an axis just enough to bring [c - half, c + half] inside [margin, area - margin].
  // This may let the image edge enter the frame (the blurred background shows there).
  const keepInside = (t: number, c: number, half: number, area: number) => {
    if (c - half < MARK_MARGIN) return t + (MARK_MARGIN - (c - half));
    if (c + half > area - MARK_MARGIN) return t - (c + half - (area - MARK_MARGIN));
    return t;
  };
  const [hx, hy] = markHalf(f, fw, fh);
  // Only a mark larger than the frame forces a smaller zoom.
  const maxZ = Math.min(
    hx > 0 ? (W - 2 * MARK_MARGIN) / (2 * hx) : Infinity,
    hy > 0 ? (H - 2 * MARK_MARGIN) / (2 * hy) : Infinity,
  );
  const z = Math.max(1, Math.min(f.zoom, maxZ));
  let tx = clampAxis(W, fw * z, f.x);
  let ty = clampAxis(H, fh * z, f.y);
  if (f.mark) {
    tx = keepInside(tx, tx + f.x * fw * z, hx * z, W);
    ty = keepInside(ty, ty + f.y * fh * z, hy * z, H);
  }
  return { s: z, tx, ty };
}

/** Image shown at each point: the visual's own, then any cue's `show=` from its frame on. */
export interface ImageLayer {
  src: string;
  size: [number, number];
}

const lerp = (a: Xform, b: Xform, t: number): Xform => ({
  s: a.s + (b.s - a.s) * t,
  tx: a.tx + (b.tx - a.tx) * t,
  ty: a.ty + (b.ty - a.ty) * t,
});

const progress = (frame: number, start: number) =>
  interpolate(frame, [start, start + ZOOM_FRAMES], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: ease,
  });

/** Pure function of the frame: each cue animates from wherever the previous move was. */
function xformAt(frame: number, cues: TimelineCue[], W: number, H: number, fw: number, fh: number) {
  let from = targetXform(W, H, fw, fh, {
    x: 0.5,
    y: 0.5,
    zoom: 1,
    r: 0,
    w: 0,
    h: 0,
    sized: false,
    from: 'left',
  });
  let to = from;
  let start: number | null = null;
  for (const cue of cues) {
    if (cue.frame > frame) break;
    if (start !== null) from = lerp(from, to, progress(cue.frame, start));
    to = targetXform(W, H, fw, fh, focusOf(cue));
    start = cue.frame;
  }
  return start === null ? from : lerp(from, to, progress(frame, start));
}

/** Ken Burns' zoom at the end of an image's span. */
export const KENBURNS_MAX = 1.06;

/** Whether the slow Ken Burns zoom runs: on, no cue moves the image, and a known duration. */
export const driftsOf = (cues: TimelineCue[], kenBurns: boolean, duration: number) =>
  kenBurns && duration > 0 && !cues.some((c) => c.attrs.x || c.attrs.y || c.attrs.zoom);

/**
 * Box of one image layer at `frame`, relative to the visual area's top left: fitted by `fit`
 * (given the drift's largest zoom, 1 without drift; centred in its `height`), moved by the cues,
 * and zoomed around its centre by the drift.
 */
export function layerBox(
  frame: number,
  cues: TimelineCue[],
  width: number,
  fit: (kenBurnsMax: number) => { fw: number; fh: number; height: number },
  drifts: boolean,
  duration: number,
): { tx: number; ty: number; w: number; h: number } {
  const drift = drifts
    ? interpolate(frame, [0, duration], [1, KENBURNS_MAX], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;
  // centred in `height`: the frame, or the part above the subtitles (pilot-1 P2)
  const { fw, fh, height } = fit(drifts ? KENBURNS_MAX : 1);
  const x = xformAt(frame, cues, width, height, fw, fh);
  const s = x.s * drift;
  // Ken Burns zooms around the center.
  return {
    tx: x.tx - (fw * x.s * (drift - 1)) / 2,
    ty: x.ty - (fh * x.s * (drift - 1)) / 2,
    w: fw * s,
    h: fh * s,
  };
}
