/**
 * Speakers on screen (PLAN 5.8), any number of them.
 *
 * Character mode (every speaker has character art; also a single lecturer): bust-up characters
 * in the bottom-left / bottom-right corners, one per side at a time (speakers of a side take
 * turns, so at most two are visible). The speaker is lit, the other dimmed; the mouth follows the voice loudness, the face follows the paragraph's `face`,
 * and idle characters blink now and then.
 *
 * Avatar mode (dialogue layout without character art, 2–4 speakers): colored circles beside
 * (16:9) or above (portrait) the subtitle. 5+ speakers: name tags on the subtitles only.
 */

import type { TimelineAudio, TimelineMotion, TimelineReaction } from '@script2video/core';
import type React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import {
  assignSides,
  crowdScale,
  crowdStep,
  FACE_HOLD,
  STAGE_LEAD,
  type DialogueGeometry,
  type StageSwitch,
} from '../shared';
import type { CastInfo, CharacterFace } from './types';

const FADE = 6; // frames for the speaking highlight to come and go
const BLINK_FRAMES = 4;
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** 0–1: how much `key` is speaking at `frame` (eased in and out). */
export function speaking(key: string, frame: number, audio: TimelineAudio[]): number {
  let v = 0;
  for (const a of audio) {
    if (a.cast !== key) continue;
    const end = a.startFrame + a.durationFrames;
    v = Math.max(
      v,
      Math.min(
        interpolate(frame, [a.startFrame - FADE, a.startFrame], [0, 1], clamp),
        interpolate(frame, [end, end + FADE], [1, 0], clamp),
      ),
    );
  }
  return v;
}

const Avatar: React.FC<{ c: CastInfo; size: number; amount: number; fontFamily: string }> = ({
  c,
  size,
  amount,
  fontFamily,
}) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 10,
      opacity: 0.45 + 0.55 * amount,
      transform: `scale(${1 + 0.08 * amount})`,
    }}
  >
    <div
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        overflow: 'hidden',
        background: c.color,
        boxShadow: `0 0 0 ${3 + 5 * amount}px ${amount > 0.01 ? c.color : 'rgba(17,24,39,0.25)'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#ffffff',
        fontFamily,
        fontWeight: 700,
        fontSize: size * 0.42,
      }}
    >
      {c.avatar ? (
        <Img
          src={staticFile(c.avatar)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        [...c.name][0]
      )}
    </div>
    <div
      style={{
        fontFamily,
        fontWeight: 700,
        fontSize: 26,
        color: '#ffffff',
        background: c.color,
        padding: '2px 14px',
        borderRadius: 999,
      }}
    >
      {c.name}
    </div>
  </div>
);

export const CastStrip: React.FC<{
  cast: CastInfo[];
  audio: TimelineAudio[];
  geometry: DialogueGeometry;
  portrait: boolean;
  fontFamily: string;
}> = ({ cast, audio, geometry, portrait, fontFamily }) => {
  const frame = useCurrentFrame();
  const a = geometry.avatar;
  if (!a) return null;
  const m = geometry.subtitle;
  const render = (c: CastInfo) => (
    <Avatar
      key={c.key}
      c={c}
      size={a.size}
      amount={speaking(c.key, frame, audio)}
      fontFamily={fontFamily}
    />
  );
  if (portrait)
    return (
      <AbsoluteFill
        style={{
          justifyContent: 'flex-end',
          alignItems: 'center',
          paddingBottom: geometry.visual.bottom - a.rowHeight - 16,
        }}
      >
        <div style={{ display: 'flex', gap: 36 }}>{cast.map(render)}</div>
      </AbsoluteFill>
    );
  const { left, right } = assignSides(cast);
  const side = (list: CastInfo[], align: 'flex-start' | 'flex-end') => (
    <div style={{ display: 'flex', gap: 20, justifyContent: align, width: a.sideWidth - 48 }}>
      {list.map(render)}
    </div>
  );
  return (
    <AbsoluteFill
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        padding: `0 24px ${Math.max(24, m.bottom - 24)}px`,
      }}
    >
      {side(left, 'flex-start')}
      {side(right, 'flex-end')}
    </AbsoluteFill>
  );
};

/** Small deterministic hash (FNV-1a) for blink timing: no Math.random in renders. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** One blink per 4 s window, at a position that depends only on (cast, window). */
function blinking(key: string, frame: number, fps: number): boolean {
  const period = Math.round(fps * 4);
  const w = Math.floor(frame / period);
  const at = w * period + (hash(`${key}:${w}`) % (period - BLINK_FRAMES));
  return frame >= at && frame < at + BLINK_FRAMES;
}

interface CharacterState {
  face: string;
  /** 0 closed, 1 half, 2 open */
  mouth: number;
  amount: number;
}

/**
 * Face: the most recent of the character's own line (its paragraph face) and any `:react`
 * aimed at it, each held FACE_HOLD frames after it ends; otherwise the default face.
 */
function characterState(
  c: CastInfo,
  frame: number,
  audio: TimelineAudio[],
  reactions: TimelineReaction[],
  mouths: Record<string, string>,
): CharacterState {
  let face = c.face;
  let since = -Infinity;
  let mouth = 0;
  const consider = (start: number, end: number, f: string) => {
    if (frame >= start && frame < end + FACE_HOLD && start >= since) {
      face = f;
      since = start;
    }
  };
  for (const a of audio) {
    if (a.cast !== c.key) continue;
    consider(a.startFrame, a.startFrame + a.durationFrames, a.face);
    const local = frame - a.startFrame;
    if (local >= 0 && local < a.durationFrames) mouth = Number(mouths[a.sentenceId]?.[local] ?? 0);
  }
  // Reacting listeners are lit halfway, so their faces read while someone else talks.
  let reacting = 0;
  for (const r of reactions) {
    if (r.cast !== c.key) continue;
    consider(r.startFrame, r.endFrame, r.face);
    const end = r.endFrame + FACE_HOLD;
    reacting = Math.max(
      reacting,
      Math.min(
        interpolate(frame, [r.startFrame - FADE, r.startFrame], [0, 1], clamp),
        interpolate(frame, [end, end + FADE], [1, 0], clamp),
      ),
    );
  }
  return { face, mouth, amount: Math.max(speaking(c.key, frame, audio), 0.6 * reacting) };
}

/** Offset of a character's motion at a frame, in px for a 580 px tall character. */
interface MotionOffset {
  x: number;
  y: number;
  rot: number;
}

/**
 * The most recent motion of this character that is still playing. One-shot motions (jump,
 * shake, nod, bounce, shiver) play once from their start; `sink` and `lean` hold until their
 * face ends. `toCenter` is +1 on the left side, -1 on the right (lean / nod tilt that way).
 */
function motionOffset(
  key: string,
  frame: number,
  motions: TimelineMotion[],
  toCenter: number,
): MotionOffset {
  const none = { x: 0, y: 0, rot: 0 };
  const m = motions
    .filter((x) => x.cast === key && x.startFrame <= frame)
    .sort((a, b) => b.startFrame - a.startFrame)[0];
  if (!m) return none;
  const t = frame - m.startFrame;
  const fade = (len: number) => Math.max(0, 1 - t / len);
  // Holding motions: ease in, hold while the face lasts, ease out.
  const held = () =>
    Math.min(
      interpolate(t, [0, 12], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) }),
      interpolate(frame, [m.endFrame + FACE_HOLD, m.endFrame + FACE_HOLD + 12], [1, 0], clamp),
    );
  switch (m.motion) {
    case 'jump':
      return t < 14 ? { x: 0, y: -70 * Math.sin((Math.PI * t) / 14), rot: 0 } : none;
    case 'shake':
      return t < 18 ? { x: 22 * Math.sin((2 * Math.PI * t) / 6) * fade(18), y: 0, rot: 0 } : none;
    case 'nod': {
      if (t >= 20) return none;
      const d = Math.sin((Math.PI * t) / 10) ** 2;
      return { x: 0, y: 16 * d, rot: 3 * d * toCenter };
    }
    case 'bounce':
      return t < 24
        ? { x: 0, y: -32 * Math.abs(Math.sin((Math.PI * t) / 8)) * fade(24), rot: 0 }
        : none;
    case 'shiver':
      return t < 30 ? { x: 5 * Math.sin((2 * Math.PI * t) / 3), y: 0, rot: 0 } : none;
    case 'sink':
      return { x: 0, y: 30 * held(), rot: 0 };
    case 'lean':
      return { x: 0, y: 0, rot: 5 * held() * toCenter };
    default:
      return none;
  }
}

function pickImage(f: CharacterFace, mouth: number, blink: boolean): string {
  if (mouth === 2) return f.talk ?? f.half ?? f.base;
  if (mouth === 1) return f.half ?? f.talk ?? f.base;
  return blink && f.blink ? f.blink : f.base;
}

const Character: React.FC<{
  c: CastInfo;
  side: 'left' | 'right';
  geometry: NonNullable<DialogueGeometry['character']>;
  state: CharacterState;
  blink: boolean;
  /** 0 = off stage (below the frame), 1 = on stage. */
  presence: number;
  /** Distance from the frame edge and size factor (groups stand closer and smaller). */
  x: number;
  scale: number;
  z: number;
  motion: MotionOffset;
}> = ({ c, side, geometry, state, blink, presence, x, scale, z, motion }) => {
  const ch = c.character!;
  const faces = ch.faces[state.face] ?? ch.faces[c.face] ?? Object.values(ch.faces)[0]!;
  const src = pickImage(faces, state.mouth, blink);
  // Mirror art that looks toward the frame edge so every character faces the center.
  const mirror =
    (side === 'left' && ch.facing === 'left') || (side === 'right' && ch.facing === 'right');
  const a = state.amount;
  const drop = (1 - presence) * geometry.boxH * 0.6 + (1 - a) * 18;
  // Motions are designed for a 580 px tall character; scale them with the box.
  const k = (geometry.boxH * scale) / 580;
  const mx = motion.x * k * (side === 'left' ? 1 : -1);
  return (
    <div
      style={{
        position: 'absolute',
        bottom: 0,
        [side]: x,
        width: geometry.boxW * scale,
        height: geometry.boxH * scale,
        zIndex: z,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'center',
        opacity: presence,
        transform: `translate(${mx}px, ${drop + motion.y * k}px) rotate(${motion.rot}deg) scale(${0.94 + 0.06 * a})`,
        transformOrigin: 'bottom center',
        filter: `brightness(${0.62 + 0.38 * a}) saturate(${0.7 + 0.3 * a})`,
      }}
    >
      <Img
        src={staticFile(src)}
        style={{
          maxWidth: '100%',
          maxHeight: '100%',
          objectFit: 'contain',
          transform: mirror ? 'scaleX(-1)' : undefined,
        }}
      />
    </div>
  );
};

const ease = Easing.inOut(Easing.cubic);

/**
 * Characters on each side follow the stage plan: usually one per side; a group while several
 * react together. On a change, those who stay slide to their new place, newcomers rise from
 * below and those leaving sink (STAGE_LEAD frames).
 */
export const CharacterStage: React.FC<{
  cast: CastInfo[];
  audio: TimelineAudio[];
  reactions: TimelineReaction[];
  motions: TimelineMotion[];
  mouths: Record<string, string>;
  geometry: DialogueGeometry;
  stage: Record<'left' | 'right', StageSwitch[]>;
  fps: number;
}> = ({ cast, audio, reactions, motions, mouths, geometry, stage, fps }) => {
  const frame = useCurrentFrame();
  const g = geometry.character;
  if (!g) return null;
  const byKey = new Map(cast.map((c) => [c.key, c]));
  const slot = (i: number, k: number) => i * crowdStep(g.boxW, k);
  const render = (side: 'left' | 'right') => {
    const list = stage[side];
    let i = -1;
    for (let k = 0; k < list.length; k++) if (list[k]!.frame <= frame) i = k;
    if (i < 0) return null;
    const cur = list[i]!;
    const prev = list[i - 1]?.keys ?? cur.keys;
    const p = interpolate(frame, [cur.frame, cur.frame + STAGE_LEAD], [0, 1], {
      ...clamp,
      easing: ease,
    });
    const keys = [...new Set([...prev, ...cur.keys])];
    return keys.map((key) => {
      const c = byKey.get(key);
      if (!c) return null;
      const pi = prev.indexOf(key);
      const ci = cur.keys.indexOf(key);
      const presence = pi >= 0 && ci >= 0 ? 1 : ci >= 0 ? p : 1 - p;
      if (presence <= 0) return null;
      const from = { x: slot(Math.max(pi, 0), prev.length), s: crowdScale(prev.length) };
      const to = { x: slot(Math.max(ci, 0), cur.keys.length), s: crowdScale(cur.keys.length) };
      const t = pi >= 0 && ci >= 0 ? p : ci >= 0 ? 1 : 0;
      const state = characterState(c, frame, audio, reactions, mouths);
      const order = ci >= 0 ? ci : pi;
      return (
        <Character
          key={key}
          c={c}
          side={side}
          geometry={g}
          state={state}
          blink={state.mouth === 0 && blinking(c.key, frame, fps)}
          presence={presence}
          x={from.x + (to.x - from.x) * t}
          scale={from.s + (to.s - from.s) * t}
          z={20 - order + Math.round(state.amount * 10)}
          motion={motionOffset(key, frame, motions, side === 'left' ? 1 : -1)}
        />
      );
    });
  };
  return (
    <AbsoluteFill>
      {render('left')}
      {render('right')}
    </AbsoluteFill>
  );
};
