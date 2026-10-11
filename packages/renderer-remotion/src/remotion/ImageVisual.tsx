import type { TimelineCue } from '@script2video/core';
import type React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { useTheme } from './theme';

const ZOOM_FRAMES = 12;
const MARK_FADE = 6;
const MARK_MARGIN = 24; // px kept between a mark and the frame edge
const ease = Easing.inOut(Easing.cubic);

const MARKS = ['circle', 'box', 'highlight', 'spotlight', 'arrow'] as const;
type MarkKind = (typeof MARKS)[number];
/** Arrow length as a fraction of the fitted image width. */
const ARROW_LEN = 0.12;

interface Focus {
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

const focusOf = (c: TimelineCue): Focus => ({
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
const boxed = (f: Focus) =>
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

const Mark: React.FC<{ focus: Focus; opacity: number }> = ({ focus, opacity }) => {
  const accent = useTheme().accent;
  const at: React.CSSProperties = {
    position: 'absolute',
    left: `${focus.x * 100}%`,
    top: `${focus.y * 100}%`,
    transform: 'translate(-50%, -50%)',
    opacity,
  };
  const size: React.CSSProperties = boxed(focus)
    ? { width: `${focus.w * 100}%`, height: `${focus.h * 100}%`, borderRadius: 16 }
    : { width: `${focus.r * 200}%`, aspectRatio: '1 / 1', borderRadius: '50%' };
  if (focus.mark === 'highlight')
    // Marker pen: translucent yellow over the target.
    return (
      <div
        style={{
          ...at,
          ...size,
          borderRadius: 6,
          background: 'rgba(250, 204, 21, 0.38)',
          mixBlendMode: 'multiply',
        }}
      />
    );
  if (focus.mark === 'spotlight')
    // Everything but the target darkens (a huge shadow around a transparent hole).
    return (
      <div
        style={{
          ...at,
          ...size,
          boxShadow: `0 0 0 9999px rgba(0, 0, 0, ${0.62 * opacity})`,
          opacity: 1,
        }}
      />
    );
  if (focus.mark === 'arrow') {
    const angle = { left: 0, top: 90, right: 180, bottom: 270 }[focus.from];
    // Drawn pointing right with its tip at the origin, then turned to come from `from`.
    return (
      <svg
        viewBox="-120 -30 120 60"
        style={{
          position: 'absolute',
          left: `${focus.x * 100}%`,
          top: `${focus.y * 100}%`,
          width: `${ARROW_LEN * 100}%`,
          overflow: 'visible',
          transform: `translate(-100%, -50%) rotate(${angle}deg)`,
          transformOrigin: '100% 50%',
          opacity,
        }}
      >
        <path d="M -116 0 L -26 0" stroke={accent} strokeWidth={12} strokeLinecap="round" />
        <path d="M -40 -22 L -2 0 L -40 22 Z" fill={accent} />
      </svg>
    );
  }
  const style: React.CSSProperties = {
    position: 'absolute',
    left: `${focus.x * 100}%`,
    top: `${focus.y * 100}%`,
    transform: 'translate(-50%, -50%)',
    border: `6px solid ${accent}`,
    boxSizing: 'border-box',
    opacity,
  };
  if (focus.mark === 'circle')
    return (
      <div
        style={{ ...style, width: `${focus.r * 200}%`, aspectRatio: '1 / 1', borderRadius: '50%' }}
      />
    );
  if (focus.mark === 'box')
    return (
      <div
        style={{
          ...style,
          width: `${focus.w * 100}%`,
          height: `${focus.h * 100}%`,
          borderRadius: 16,
        }}
      />
    );
  return null;
};

const SWITCH_FRAMES = 10;

export const ImageVisual: React.FC<{
  src: string;
  size: [number, number];
  cues: TimelineCue[];
  /** Frame margins kept free (speakers, subtitles); the image fits the rest. */
  area: { left: number; right: number; bottom: number };
  /** Images named by cues'  (public path and size). */
  shows?: Record<string, ImageLayer>;
  /** Frames this visual is on screen (for the slow Ken Burns zoom). */
  duration?: number;
  /** Slow zoom when no cue moves the image ( on ::image disables it). */
  kenBurns?: boolean;
}> = ({ src, size, cues, area, shows = {}, duration = 0, kenBurns = true }) => {
  const frame = useCurrentFrame();
  const { width: fullW, height: fullH } = useVideoConfig();
  const W = fullW - area.left - area.right;
  const H = fullH - area.bottom;

  // Which image is on screen: the last  cue reached, crossfading from the one before.
  const switches = cues.filter((c) => c.attrs.show && shows[c.attrs.show]);
  const reached = switches.filter((c) => c.frame <= frame);
  const cur = reached[reached.length - 1];
  const prev = reached[reached.length - 2];
  const layerOf = (c: TimelineCue | undefined): ImageLayer =>
    c ? shows[c.attrs.show!]! : { src, size };
  const fade = cur
    ? interpolate(frame, [cur.frame, cur.frame + SWITCH_FRAMES], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;

  const moves = cues.some((c) => c.attrs.x || c.attrs.y || c.attrs.zoom);
  const drift =
    kenBurns && !moves && duration > 0
      ? interpolate(frame, [0, duration], [1, 1.06], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        })
      : 1;

  const active = [...cues].reverse().find((c) => c.frame <= frame);
  const focus = active ? focusOf(active) : null;
  const markOpacity = active
    ? interpolate(frame, [active.frame, active.frame + MARK_FADE], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 0;

  const layer = (l: ImageLayer, opacity: number, withMark: boolean, key: string) => {
    const [imgW, imgH] = l.size;
    const fit = Math.min(W / imgW, H / imgH);
    const fw = imgW * fit;
    const fh = imgH * fit;
    const x = xformAt(frame, cues, W, H, fw, fh);
    const s = x.s * drift;
    // Ken Burns zooms around the center.
    const tx = x.tx - (fw * x.s * (drift - 1)) / 2;
    const ty = x.ty - (fh * x.s * (drift - 1)) / 2;
    return (
      <div
        key={key}
        style={{ position: 'absolute', left: tx, top: ty, width: fw * s, height: fh * s, opacity }}
      >
        {/* Layout-sized (not CSS-scaled) so Chrome resamples from the full-resolution source. */}
        <Img src={staticFile(l.src)} style={{ width: '100%', height: '100%', display: 'block' }} />
        {withMark && focus?.mark ? <Mark focus={focus} opacity={markOpacity} /> : null}
      </div>
    );
  };
  const curLayer = layerOf(cur);

  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Img
        src={staticFile(curLayer.src)}
        style={{
          position: 'absolute',
          inset: -60,
          width: fullW + 120,
          height: fullH + 120,
          objectFit: 'cover',
          filter: 'blur(40px) brightness(0.55)',
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: area.left,
          top: 0,
          width: W,
          height: H,
          overflow: 'hidden',
        }}
      >
        {cur && fade < 1 ? layer(layerOf(prev), 1, false, 'prev') : null}
        {layer(curLayer, fade, true, 'cur')}
      </div>
    </AbsoluteFill>
  );
};
