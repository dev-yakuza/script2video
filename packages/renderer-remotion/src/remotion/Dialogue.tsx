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
import { useMemo } from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import {
  assignSides,
  BLINK_FRAMES,
  blinkFrames,
  breath,
  crowdScale,
  crowdStep,
  drawnFace,
  drawnFaceChanges,
  FACE_HOLD,
  faceAt,
  hash,
  HOLD_END,
  IDLE,
  listenerNods,
  STAGE_LEAD,
  type DialogueGeometry,
  type Nod,
  type StageSwitch,
} from '../shared';
import type { CastInfo, CharacterFace, PartsFace, PartsSet } from './types';

const FADE = 6; // frames for the speaking highlight to come and go
/**
 * Where the highlight starts coming in: FADE frames before the line, but never before the scene
 * (scenes render apart; a line at the scene start would otherwise pop in on its first frame).
 */
const fadeFrom = (start: number) => Math.max(0, start - FADE);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** 0–1: how much `key` is speaking at `frame` (eased in and out). */
export function speaking(key: string, frame: number, audio: TimelineAudio[]): number {
  let v = 0;
  for (const a of audio) {
    if (a.cast !== key) continue;
    const end = a.startFrame + a.durationFrames;
    const from = fadeFrom(a.startFrame);
    v = Math.max(
      v,
      Math.min(
        interpolate(frame, [from, from + FADE], [0, 1], clamp),
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

/** Idle motion off (`acting.idle: false`): one blink per 4 s window, at a position that depends only on (cast, window). */
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
  const face = faceAt(c.key, c.face, frame, audio, reactions);
  let mouth = 0;
  for (const a of audio) {
    if (a.cast !== c.key) continue;
    const local = frame - a.startFrame;
    if (local >= 0 && local < a.durationFrames) mouth = Number(mouths[a.sentenceId]?.[local] ?? 0);
  }
  // Reacting listeners are lit halfway, so their faces read while someone else talks.
  let reacting = 0;
  for (const r of reactions) {
    if (r.cast !== c.key) continue;
    const end = r.endFrame + FACE_HOLD;
    reacting = Math.max(
      reacting,
      Math.min(
        interpolate(frame, [fadeFrom(r.startFrame), fadeFrom(r.startFrame) + FADE], [0, 1], clamp),
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

/** Head motions and what they become without a head layer (whole-body channel). */
const HEAD_FALLBACK: Record<string, string> = { 'head-nod': 'nod', 'head-tilt': 'lean' };

/**
 * Offset of one motion at a frame. One-shot motions (jump, shake, nod, bounce, shiver,
 * head-nod) play once from their start; `sink`, `lean` and `head-tilt` hold until their face
 * ends. `toCenter` is +1 on the left side, -1 on the right (lean / nod / tilt go that way).
 */
function offsetOf(
  m: TimelineMotion,
  motion: string,
  frame: number,
  toCenter: number,
  scale = 1,
): MotionOffset {
  const o = offsetAt(m, motion, frame, toCenter);
  return scale === 1 ? o : { x: o.x * scale, y: o.y * scale, rot: o.rot * scale };
}

function offsetAt(
  m: TimelineMotion,
  motion: string,
  frame: number,
  toCenter: number,
): MotionOffset {
  const none = { x: 0, y: 0, rot: 0 };
  const t = frame - m.startFrame;
  const fade = (len: number) => Math.max(0, 1 - t / len);
  // Holding motions: ease in, hold while the face lasts, ease out.
  const held = () =>
    Math.min(
      interpolate(t, [0, 12], [0, 1], { ...clamp, easing: Easing.out(Easing.cubic) }),
      interpolate(
        frame,
        [m.endFrame + FACE_HOLD, m.endFrame + FACE_HOLD + HOLD_END],
        [1, 0],
        clamp,
      ),
    );
  switch (motion) {
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
    // Head layer only (rotation about the neck pivot).
    case 'head-nod': {
      if (t >= 24) return none;
      const d = Math.sin((Math.PI * t) / 12) ** 2;
      return { x: 0, y: 6 * d, rot: 4 * d * toCenter };
    }
    case 'head-tilt':
      return { x: 0, y: 0, rot: 9 * held() * toCenter };
    default:
      return none;
  }
}

/** Pivot of the face a parts character shows at a frame (null: no head layer). */
type PivotAt = (frame: number) => [number, number] | null;

/**
 * Motion channels (plan C7): the body channel and the head channel each play their most recent
 * motion. A head motion goes to the head channel when the face shown at its start has a head
 * pivot; otherwise it falls back (head-nod → nod, head-tilt → lean) on the body channel. A head
 * motion stops when the pivot changes (the face changed to another view or head).
 */
function motionChannels(
  key: string,
  frame: number,
  motions: TimelineMotion[],
  toCenter: number,
  pivotAt: PivotAt | null,
  /** Frames where this character's face can change (line / reaction starts and holds' ends). */
  changes: number[] = [],
): { body: MotionOffset; head: MotionOffset } {
  const none = { x: 0, y: 0, rot: 0 };
  let body: { m: TimelineMotion; name: string } | null = null;
  let head: { m: TimelineMotion; name: string } | null = null;
  for (const m of motions) {
    if (m.cast !== key || m.startFrame > frame) continue;
    const fallback = HEAD_FALLBACK[m.motion];
    const onHead = fallback !== undefined && pivotAt !== null && pivotAt(m.startFrame) !== null;
    const entry = { m, name: fallback !== undefined && !onHead ? fallback : m.motion };
    if (onHead) {
      if (!head || m.startFrame >= head.m.startFrame) head = entry;
    } else if (!body || m.startFrame >= body.m.startFrame) body = entry;
  }
  let headOffset = head ? offsetOf(head.m, head.name, frame, toCenter) : none;
  if (head && pivotAt) {
    // Cancelled for good once the pivot changes (even if the face comes back later).
    const a = pivotAt(head.m.startFrame);
    const same = (b: [number, number] | null) => !!a && !!b && a[0] === b[0] && a[1] === b[1];
    const checks = [...changes.filter((f) => f > head!.m.startFrame && f <= frame), frame];
    if (!checks.every((f) => same(pivotAt(f)))) headOffset = none;
  }
  return { body: body ? offsetOf(body.m, body.name, frame, toCenter) : none, head: headOffset };
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
  headMotion: MotionOffset;
  parts: PartsSet | null;
  /** Breathing: vertical scale − 1. */
  breathe: number;
}> = ({
  c,
  side,
  geometry,
  state,
  blink,
  presence,
  x,
  scale,
  z,
  motion,
  headMotion,
  parts,
  breathe,
}) => {
  const ch = c.character!;
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
        transform: `translate(${mx}px, ${drop + motion.y * k}px) rotate(${motion.rot}deg) scale(${0.94 + 0.06 * a})${breathe ? ` scaleY(${1 + breathe})` : ''}`,
        transformOrigin: 'bottom center',
        filter: `brightness(${0.62 + 0.38 * a}) saturate(${0.7 + 0.3 * a})`,
      }}
    >
      {parts ? (
        <PartsImage
          set={parts}
          face={partsFace(parts, state.face, c.face)}
          state={state}
          blink={blink}
          boxW={geometry.boxW * scale}
          boxH={geometry.boxH * scale}
          headMotion={headMotion}
          k={k}
          side={side}
        />
      ) : (
        <Img
          src={staticFile(pickImage(classicFace(c, state.face), state.mouth, blink))}
          style={
            ch.size
              ? // Imported parts art: the parts size rule (plan 5.3), so mixed casts match.
                (() => {
                  const s = Math.min(
                    (geometry.boxW * scale) / ch.size[0],
                    (geometry.boxH * scale) / ch.size[1],
                  );
                  return { width: ch.size[0] * s, height: ch.size[1] * s, flexShrink: 0 };
                })()
              : {
                  maxWidth: '100%',
                  maxHeight: '100%',
                  objectFit: 'contain',
                  transform: mirror ? 'scaleX(-1)' : undefined,
                }
          }
        />
      )}
    </div>
  );
};

function classicFace(c: CastInfo, face: string): CharacterFace {
  const faces = c.character!.faces;
  return faces[drawnFace(face, c.face, Object.keys(faces))]!;
}

function partsFace(set: PartsSet, face: string, fallback: string): PartsFace {
  return set.faces[drawnFace(face, fallback, Object.keys(set.faces))]!;
}

/** Parts set a character uses in this scene's framing (null: classic art). */
function partsOf(c: CastInfo, framing: Record<string, string>): PartsSet | null {
  return c.character?.parts
    ? (c.character.parts[framing[c.key] ?? 'full'] ?? c.character.parts.full ?? null)
    : null;
}

/** Faces the art can draw in this scene (the order is the art's own: its first face is the last resort). */
function availableFaces(c: CastInfo, parts: PartsSet | null): string[] {
  return Object.keys(parts ? parts.faces : (c.character?.faces ?? {}));
}

/** Additive listener nod of a character at a frame (40% of nod / head-nod). */
function nodOffset(nods: Nod[], key: string, frame: number, toCenter: number, head: boolean) {
  const none = { x: 0, y: 0, rot: 0 };
  for (const n of nods)
    if (n.cast === key && n.head === head && frame >= n.frame && frame < n.frame + n.length)
      return offsetOf(
        { cast: key, motion: head ? 'head-nod' : 'nod', startFrame: n.frame, endFrame: n.frame },
        head ? 'head-nod' : 'nod',
        frame,
        toCenter,
        IDLE.nod.scale,
      );
  return none;
}

const add = (a: MotionOffset, b: MotionOffset): MotionOffset => ({
  x: a.x + b.x,
  y: a.y + b.y,
  rot: a.rot + b.rot,
});

/**
 * A parts character: body → head (mouth / blink state) → front, stacked on one canvas. Size rule
 * (plan 5.3): scale = min(boxW / art width, boxH / height), so it matches the classic `contain`
 * path; the widened canvas is centered and bottom-aligned (its margins may overflow the box).
 */
const PartsImage: React.FC<{
  set: PartsSet;
  face: PartsFace;
  state: CharacterState;
  blink: boolean;
  boxW: number;
  boxH: number;
  headMotion: MotionOffset;
  k: number;
  side: 'left' | 'right';
}> = ({ set, face, state, blink, boxW, boxH, headMotion, k, side }) => {
  const [W, H] = set.canvas;
  const s = Math.min(boxW / set.baseWidth, boxH / set.baseHeight);
  const layer: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
  };
  const head = pickImage(face.head, state.mouth, blink);
  const origin = face.pivot
    ? `${(face.pivot[0] / W) * 100}% ${(face.pivot[1] / H) * 100}%`
    : 'center';
  const hx = headMotion.x * k * (side === 'left' ? 1 : -1);
  return (
    <div style={{ position: 'relative', width: W * s, height: H * s, flexShrink: 0 }}>
      {face.body ? <Img src={staticFile(face.body)} style={layer} /> : null}
      <Img
        src={staticFile(head)}
        style={{
          ...layer,
          transformOrigin: origin,
          transform: `translate(${hx}px, ${headMotion.y * k}px) rotate(${headMotion.rot}deg)`,
        }}
      />
      {face.front ? <Img src={staticFile(face.front)} style={layer} /> : null}
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
  /** This scene's framing per cast member (`::shot`). */
  framing: Record<string, string>;
  sceneId: string;
  durationFrames: number;
  /** Idle motion (acting stage 5a); off: the old blink rule. */
  idle: boolean;
  /** A still: no blinks. */
  still: boolean;
  output: string;
}> = ({
  cast,
  audio,
  reactions,
  motions,
  mouths,
  geometry,
  stage,
  fps,
  framing,
  sceneId,
  durationFrames,
  idle,
  still,
  output,
}) => {
  const frame = useCurrentFrame();
  // Blinks and nods of the whole scene, once (before any early return: hooks keep their order).
  const plan = useMemo(() => {
    const blinks = new Map<string, Set<number>>();
    if (!idle) return { blinks, nods: [] as Nod[] };
    for (const c of cast) {
      if (!c.character) continue;
      const mouth = new Uint8Array(Math.max(0, durationFrames));
      for (const a of audio) {
        if (a.cast !== c.key) continue;
        const m = mouths[a.sentenceId] ?? '';
        for (let i = 0; i < a.durationFrames; i++) {
          const f = a.startFrame + i;
          if (f >= 0 && f < durationFrames) mouth[f] = Number(m[i] ?? 0);
        }
      }
      const parts = partsOf(c, framing);
      const starts = blinkFrames({
        cast: c.key,
        sceneId,
        output,
        fps,
        durationFrames,
        audio,
        mouth,
        faceChanges: drawnFaceChanges({
          key: c.key,
          defaultFace: c.face,
          available: availableFaces(c, parts),
          audio,
          reactions,
          durationFrames,
        }),
      });
      const on = new Set<number>();
      for (const f of starts) for (let i = 0; i < BLINK_FRAMES; i++) on.add(f + i);
      blinks.set(c.key, on);
    }
    const byKey = new Map(cast.map((c) => [c.key, c]));
    const nods = listenerNods({
      sceneId,
      output,
      durationFrames,
      audio,
      reactions,
      motions,
      stage,
      hasHead: (key, f) => {
        const c = byKey.get(key);
        const parts = c ? partsOf(c, framing) : null;
        return (
          !!c &&
          !!parts &&
          partsFace(parts, faceAt(key, c.face, f, audio, reactions), c.face).pivot !== null
        );
      },
    });
    return { blinks, nods };
  }, [
    cast,
    audio,
    reactions,
    motions,
    mouths,
    stage,
    fps,
    framing,
    sceneId,
    durationFrames,
    idle,
    output,
  ]);
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
      const parts = partsOf(c, framing);
      const pivotAt: PivotAt | null = parts
        ? (f) => partsFace(parts, characterState(c, f, audio, reactions, mouths).face, c.face).pivot
        : null;
      const changes = [
        ...audio
          .filter((a) => a.cast === key)
          .flatMap((a) => [a.startFrame, a.startFrame + a.durationFrames + FACE_HOLD]),
        ...reactions
          .filter((r) => r.cast === key)
          .flatMap((r) => [r.startFrame, r.endFrame + FACE_HOLD]),
      ];
      const toCenter = side === 'left' ? 1 : -1;
      const channels = motionChannels(key, frame, motions, toCenter, pivotAt, changes);
      const blink = still
        ? false
        : idle
          ? (plan.blinks.get(key)?.has(frame) ?? false)
          : blinking(c.key, frame, fps);
      return (
        <Character
          key={key}
          c={c}
          side={side}
          geometry={g}
          state={state}
          blink={state.mouth === 0 && blink}
          presence={presence}
          x={from.x + (to.x - from.x) * t}
          scale={from.s + (to.s - from.s) * t}
          z={20 - order + Math.round(state.amount * 10)}
          motion={add(channels.body, nodOffset(plan.nods, key, frame, toCenter, false))}
          headMotion={add(channels.head, nodOffset(plan.nods, key, frame, toCenter, true))}
          parts={parts}
          breathe={
            idle
              ? breath({
                  cast: key,
                  output,
                  sceneId,
                  frame,
                  fps,
                  durationFrames,
                  speaking: speaking(key, frame, audio),
                })
              : 0
          }
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
