/**
 * When a scene's picture changes (S6 plan 2.3): the frames `s2v snapshot --frames` takes, with
 * why. The renderer's own rules decide — the visual each segment shows (the first from frame 0),
 * cues, the drawn face of each character on stage (with its hold), stage switches, held motions —
 * and nothing is taken in a fade's last frames.
 */
import type { TimelineScene } from '@script2video/core';
import {
  availableFaces,
  drawnFace,
  drawnFaceChanges,
  FADE_FRAMES,
  faceAt,
  HELD_MOTIONS,
  partsOf,
  STAGE_LEAD,
  STAGE_SLIDE,
  type FaceArt,
  type Side,
  type StageSwitch,
} from './shared.js';

/** Frames after a change before it is taken: a zoom (12) and a mark fade (6) with margin. */
export const SETTLE = 20;
/** Faces switch at once; only the speaking highlight fades (6 frames). */
const FACE_SETTLE = 8;
/** Frames a zoom, mark, visual or pose needs before a still shows any of it. */
const SHOWS = 6;
/** Points closer than this to the first of a group are one still. */
const MERGE = 10;
/** Stills per scene at most; more are thinned evenly (first and last kept). */
export const STILLS_PER_SCENE = 12;

export interface StillPoint {
  /** Scene-local frame. */
  frame: number;
  reasons: string[];
}

export interface SceneStills {
  id: string;
  points: StillPoint[];
  /** How many points there were before thinning to STILLS_PER_SCENE. */
  capped?: { total: number };
}

type Faces = { faces: Record<string, unknown> };

export interface StillPointOptions {
  /** The prepared cast (its art decides which faces can be drawn). */
  cast: FaceArt<Faces>[];
  /** Who stands where, per scene id (empty unless characters are drawn). */
  stage: Record<string, Record<Side, StageSwitch[]>>;
  transition: string;
}

/** Frames until a chart's last bar has grown (bar i grows over [4i, 4i + 18]). */
function settleOf(visual: TimelineScene['visuals'][number]['visual']): number {
  if (visual.type === 'chart') {
    const data = Math.max(0, ((visual as { rows?: string[][] }).rows ?? []).length - 1);
    return Math.max(SETTLE, (data - 1) * 4 + 18 + 2);
  }
  return SETTLE;
}

export function stillPoints(scenes: TimelineScene[], opts: StillPointOptions): SceneStills[] {
  return scenes.map((scene) => {
    const dur = scene.durationFrames;
    const last = Math.max(0, dur - 1 - (opts.transition === 'fade' ? FADE_FRAMES : 0));
    // Visual i shows from its start (the first from frame 0) until the next one starts.
    const segments = scene.visuals.map((v, i) => ({
      v,
      from: i === 0 ? 0 : v.startFrame,
      to: scene.visuals[i + 1]?.startFrame ?? dur,
    }));
    const segmentOf = (frame: number) =>
      Math.max(
        0,
        segments.findIndex((s) => frame >= s.from && frame < s.to),
      );
    const raw: { frame: number; reason: string; segment: number }[] = [];
    /**
     * A change at `change`, taken at `frame` (once settled) but not past `to` (its visual's end)
     * nor into a fade. A change that has not happened by then is not taken at all: its reason
     * would sit on a picture that does not show it.
     */
    const at = (change: number, frame: number, to = dur, lead = 0): number | null => {
      const end = Math.min(to - 1, last);
      // `lead`: frames the change needs to show at all (a zoom, a slide, a pose starting)
      return end - change < lead ? null : Math.max(0, Math.min(frame, end));
    };
    const add = (frame: number | null, reason: string) => {
      if (frame !== null) raw.push({ frame, reason, segment: segmentOf(frame) });
    };
    if (segments.length === 0) add(at(0, SETTLE), 'start');
    segments.forEach((s, i) =>
      i === 0
        ? add(at(0, Math.max(SETTLE, settleOf(s.v.visual)), s.to), 'start')
        : add(at(s.from, s.from + settleOf(s.v.visual), s.to, SHOWS), `visual:${s.v.visual.type}`),
    );
    for (const c of scene.cues)
      add(
        at(c.frame, c.frame + SETTLE, segments[segmentOf(c.frame)]?.to ?? dur, SHOWS),
        `cue:"${c.phrase}"`,
      );

    const sides = opts.stage[scene.id];
    if (sides) {
      const onStage = (key: string, frame: number) =>
        (['left', 'right'] as const).some((side) => {
          let keys: string[] = [];
          for (const sw of sides[side]) if (sw.frame <= frame) keys = sw.keys;
          return keys.includes(key);
        });
      const looks = scene.looks ?? [];
      for (const c of opts.cast) {
        if (!c.character) continue;
        const available = availableFaces(c, partsOf(c, scene.framing));
        if (available.length === 0) continue;
        for (const change of drawnFaceChanges({
          key: c.key,
          defaultFace: c.face,
          available,
          audio: scene.audio,
          reactions: scene.reactions,
          looks,
          durationFrames: dur,
        })) {
          const frame = at(change, change + FACE_SETTLE);
          if (frame === null || !onStage(c.key, frame)) continue;
          const shown = drawnFace(
            faceAt(c.key, c.face, change, scene.audio, scene.reactions, looks),
            c.face,
            available,
          );
          add(frame, `face:${c.key}=${shown}`);
        }
      }
      for (const side of ['left', 'right'] as const)
        for (const sw of sides[side])
          if (sw.frame >= 0)
            add(
              at(
                sw.frame,
                sw.frame + (sw.move ? STAGE_SLIDE : STAGE_LEAD) + 5,
                dur,
                STAGE_LEAD / 2,
              ),
              `stage:${side}`,
            );
      for (const m of scene.motions) {
        if (!HELD_MOTIONS.has(m.motion)) continue;
        const frame = at(m.startFrame, m.startFrame + 12 + 5, dur, SHOWS);
        if (frame !== null && onStage(m.cast, frame)) add(frame, `motion:${m.cast}=${m.motion}`);
      }
    }

    // One still per group: the group's last point (after the earlier ones have settled). A group
    // stays in one visual's segment, or the later picture would carry the earlier one's reasons.
    raw.sort((a, b) => a.frame - b.frame);
    const points: StillPoint[] = [];
    let first = -Infinity;
    let segment = -1;
    for (const p of raw) {
      const cur = points[points.length - 1];
      if (cur && p.segment === segment && p.frame - first <= MERGE) {
        cur.frame = p.frame;
        // a later face of the same cast replaces the earlier: the still shows the later one
        if (p.reason.startsWith('face:')) {
          const who = p.reason.slice(0, p.reason.indexOf('=') + 1);
          cur.reasons = cur.reasons.filter((r) => !r.startsWith(who));
        }
        if (!cur.reasons.includes(p.reason)) cur.reasons.push(p.reason);
      } else {
        first = p.frame;
        segment = p.segment;
        points.push({ frame: p.frame, reasons: [p.reason] });
      }
    }
    if (points.length <= STILLS_PER_SCENE) return { id: scene.id, points };
    const n = points.length;
    const kept = Array.from(
      { length: STILLS_PER_SCENE },
      (_, i) => points[Math.round((i * (n - 1)) / (STILLS_PER_SCENE - 1))]!,
    );
    return { id: scene.id, points: kept, capped: { total: n } };
  });
}
