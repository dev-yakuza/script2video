import type { TimelineCue } from '@script2video/core';
import type React from 'react';
import {
  AbsoluteFill,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { imageFitBox, type SubtitleMetrics } from '../shared';
import {
  ARROW_LEN,
  boxed,
  driftsOf,
  focusOf,
  layerBox,
  MARK_FADE,
  type Focus,
  type ImageLayer,
} from './image-layout';
import { useTheme } from './theme';

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
  /** The output's subtitle box: an image that does not fill the frame fits above it. */
  subtitle?: SubtitleMetrics | null;
}> = ({ src, size, cues, area, shows = {}, duration = 0, kenBurns = true, subtitle = null }) => {
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

  const drifts = driftsOf(cues, kenBurns, duration);

  const active = [...cues].reverse().find((c) => c.frame <= frame);
  const focus = active ? focusOf(active) : null;
  const markOpacity = active
    ? interpolate(frame, [active.frame, active.frame + MARK_FADE], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 0;

  const layer = (l: ImageLayer, opacity: number, withMark: boolean, key: string) => {
    const b = layerBox(
      frame,
      cues,
      W,
      (k) => imageFitBox({ width: W, height: H, bottom: area.bottom }, l.size, subtitle, k),
      drifts,
      duration,
    );
    return (
      <div
        key={key}
        style={{ position: 'absolute', left: b.tx, top: b.ty, width: b.w, height: b.h, opacity }}
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
