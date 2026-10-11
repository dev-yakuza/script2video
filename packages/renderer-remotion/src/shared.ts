/**
 * Dialogue geometry shared by the Node adapter (`s2v check`) and the Remotion bundle, so the
 * measured subtitle box is exactly the rendered one. No imports on purpose.
 */

/** Above this many speakers the dialogue layout shows name tags only. */
export const MAX_AVATARS = 4;
/** Frames before a line starts that the speaker's character steps in (when sides alternate). */
export const STAGE_LEAD = 8;

export type Side = 'left' | 'right';

/** Left / right side of each speaker: `side` wins, the rest alternate in cast order. */
export function assignSides<T extends { side?: Side | undefined }>(
  cast: T[],
): { left: T[]; right: T[] } {
  const left: T[] = [];
  const right: T[] = [];
  for (const c of cast) {
    const side = c.side ?? (left.length <= right.length ? 'left' : 'right');
    (side === 'left' ? left : right).push(c);
  }
  return { left, right };
}

export interface DialogueShape {
  /**
   * `character`: every speaker has character art (any layout, also a single lecturer);
   * `avatar`: dialogue layout with circle avatars; `none`: plain centered subtitles.
   */
  mode: 'none' | 'avatar' | 'character';
  left: number;
  right: number;
  /** Frames narrower than 1500 px (9:16, 1:1) use portrait metrics. */
  portrait: boolean;
}

/**
 * How speakers sit on screen for an output: character mode when every speaker has character
 * art, circle avatars for the dialogue layout, otherwise none.
 */
export function dialogueShape(
  layout: string,
  cast: { character?: unknown; side?: 'left' | 'right' }[],
): Omit<DialogueShape, 'portrait'> {
  const { left, right } = assignSides(cast);
  const mode =
    cast.length > 0 && cast.every((c) => c.character)
      ? 'character'
      : layout === 'dialogue'
        ? 'avatar'
        : 'none';
  // Characters: one on stage per side at a time (they take turns), so at most two are visible.
  const cap = (n: number) => (mode === 'character' ? Math.min(1, n) : n);
  return { mode, left: cap(left.length), right: cap(right.length) };
}

export interface SubtitleMetrics {
  fontSize: number;
  maxWidth: number;
  lineHeight: number;
  maxLines: number;
  /** Distance from the frame bottom to the subtitle box bottom. */
  bottom: number;
  paddingX: number;
  paddingY: number;
  /** Speaker-side placement (character mode): inset of the box from each frame edge. */
  sideInset: { left: number; right: number } | null;
  /** Where the box sits; `bottom` uses `bottom` as the gap to the frame's bottom edge. */
  anchor: 'bottom' | 'middle' | 'top';
}

/** The parts of the subtitle style that change the box geometry (the rest is only color). */
export interface SubtitleLayoutStyle {
  size?: number | undefined;
  position?: 'bottom' | 'middle' | 'top' | undefined;
}

export interface DialogueGeometry {
  mode: DialogueShape['mode'];
  avatar: { size: number; sideWidth: number; rowHeight: number } | null;
  character: {
    /** Box each character image is fitted into (bottom-anchored), at full size. */
    boxW: number;
    boxH: number;
  } | null;
  subtitle: SubtitleMetrics;
  /** Space kept free of visuals (images shrink into the rest). */
  visual: { left: number; right: number; bottom: number };
}

/** Characters shrink when several stand on one side (a group reacting together). */
export const crowdScale = (k: number) => (k <= 1 ? 1 : k === 2 ? 0.85 : 0.75);
/** Horizontal distance between neighbours in a group (they overlap by half a character). */
export const crowdStep = (boxW: number, k: number) => Math.round(boxW * crowdScale(k) * 0.5);
/** Width a group of `k` characters takes on its side. */
export const characterSideWidth = (boxW: number, k: number) =>
  k === 0 ? 0 : Math.round(boxW * crowdScale(k)) + (k - 1) * crowdStep(boxW, k);
/** Frames a face (a line's or a reaction's) is held after it ends. */
export const FACE_HOLD = 20;

/** Height of a full (maxLines) subtitle box. */
export const subtitleBoxHeight = (m: SubtitleMetrics) =>
  m.fontSize * m.lineHeight * m.maxLines + 2 * m.paddingY;

export function dialogueGeometry(
  shape: DialogueShape,
  style: SubtitleLayoutStyle = {},
): DialogueGeometry {
  const { portrait } = shape;
  const frameW = portrait ? 1080 : 1920;
  const k = style.size ?? 1;
  const anchor = style.position ?? 'bottom';
  const base: SubtitleMetrics = {
    fontSize: Math.round((portrait ? 56 : 48) * k),
    maxWidth: portrait ? 900 : 1600,
    lineHeight: 1.4,
    maxLines: 2,
    bottom: portrait ? 220 : 64,
    paddingX: Math.round(32 * k),
    paddingY: Math.round(14 * k),
    sideInset: null,
    anchor,
  };
  const n = shape.left + shape.right;

  if (shape.mode === 'character' && n >= 1) {
    const boxW = portrait ? 380 : 420;
    const boxH = portrait ? 540 : 580;
    const width = {
      left: characterSideWidth(boxW, shape.left),
      right: characterSideWidth(boxW, shape.right),
    };
    const character = { boxW, boxH };
    if (portrait) {
      // Above the characters, pushed toward the speaker; the tail points down at them.
      const subtitle: SubtitleMetrics =
        anchor === 'bottom'
          ? { ...base, bottom: Math.round(boxH * 0.8), sideInset: { left: 40, right: 40 } }
          : base;
      return {
        mode: 'character',
        avatar: null,
        character,
        subtitle,
        visual: { left: 0, right: 0, bottom: subtitle.bottom + subtitleBoxHeight(subtitle) + 40 },
      };
    }
    // 16:9: between the characters, next to the speaker; the tail points sideways at them.
    const inset = { left: width.left + 8, right: width.right + 8 };
    const subtitle: SubtitleMetrics = {
      ...base,
      bottom: 48,
      maxWidth: Math.min(base.maxWidth, frameW - inset.left - inset.right - 24),
      sideInset: anchor === 'bottom' ? inset : null,
    };
    return {
      mode: 'character',
      avatar: null,
      character,
      subtitle,
      visual: {
        left: Math.round(width.left * 0.55),
        right: Math.round(width.right * 0.55),
        bottom: subtitle.bottom + subtitleBoxHeight(subtitle) + 24,
      },
    };
  }

  if (shape.mode !== 'none' && n >= 2 && n <= MAX_AVATARS) {
    const size = portrait ? 132 : 128;
    const perSide = Math.max(shape.left, shape.right);
    const sideWidth = portrait ? 0 : 48 + perSide * size + (perSide - 1) * 20;
    const rowHeight = portrait ? size + 72 : 0;
    const subtitle = { ...base, maxWidth: Math.min(base.maxWidth, frameW - 2 * sideWidth - 32) };
    return {
      mode: 'avatar',
      avatar: { size, sideWidth, rowHeight },
      character: null,
      subtitle,
      visual: portrait
        ? {
            left: 0,
            right: 0,
            bottom: subtitle.bottom + subtitleBoxHeight(subtitle) + rowHeight + 40,
          }
        : { left: 0, right: 0, bottom: 250 },
    };
  }

  return {
    mode: 'none',
    avatar: null,
    character: null,
    subtitle: base,
    visual: { left: 0, right: 0, bottom: 0 },
  };
}

export interface StageSwitch {
  /** Scene-local frame the group starts stepping in (-1000: already on stage). */
  frame: number;
  /** Characters on this side, outermost first (usually one; several while reacting together). */
  keys: string[];
}

/**
 * Who stands on each side over the whole video.
 * - One character per side: the side's latest speaker, stepping in STAGE_LEAD frames before
 *   their line. The first speaker of each side is on stage from the start.
 * - `:react` brings the reacting characters of a side on stage until the reaction ends (+hold).
 *   If that side's speaker is talking or reacting too, they stay and the others stand beside
 *   them; otherwise the reactors take the side for that time.
 * Returns each scene's switches, starting with whoever is on stage at its first frame.
 */
export function stagePlan(
  scenes: {
    startFrame: number;
    durationFrames: number;
    audio: { cast: string; startFrame: number; durationFrames: number }[];
    reactions?: { cast: string; startFrame: number; endFrame: number }[];
  }[],
  sideOf: Record<string, Side>,
): Record<Side, StageSwitch[]>[] {
  const lines = scenes
    .flatMap((s) =>
      s.audio.map((a) => ({
        cast: a.cast,
        at: s.startFrame + a.startFrame,
        end: s.startFrame + a.startFrame + a.durationFrames,
      })),
    )
    .sort((a, b) => a.at - b.at);
  const reacts = scenes.flatMap((s) =>
    (s.reactions ?? []).map((r) => ({
      cast: r.cast,
      at: s.startFrame + r.startFrame,
      end: s.startFrame + r.endFrame,
    })),
  );
  const timeline: Record<Side, { at: number; keys: string[] }[]> = { left: [], right: [] };
  for (const side of ['left', 'right'] as const) {
    const sideLines = lines.filter((l) => sideOf[l.cast] === side);
    const sideReacts = reacts.filter((r) => sideOf[r.cast] === side);
    const first = sideLines[0]?.cast ?? sideReacts[0]?.cast;
    if (!first) continue;
    const base = (t: number) => {
      let key = first;
      for (const l of sideLines) if (l.at - STAGE_LEAD <= t) key = l.cast;
      return key;
    };
    // A speaker counts as talking until their face hold ends, so a reaction to their own line
    // does not push them off right after they stop.
    const talking = (key: string, t: number) =>
      sideLines.some((l) => l.cast === key && l.at - STAGE_LEAD <= t && t < l.end + FACE_HOLD);
    const reactors = (t: number) => [
      ...new Set(
        sideReacts
          .filter((r) => r.at - STAGE_LEAD <= t && t < r.end + FACE_HOLD)
          .sort((a, b) => a.at - b.at)
          .map((r) => r.cast),
      ),
    ];
    const groupAt = (t: number): string[] => {
      const b = base(t);
      const r = reactors(t);
      if (r.length === 0) return [b];
      if (r.includes(b) || talking(b, t)) return [b, ...r.filter((k) => k !== b)];
      return r;
    };
    const points = [
      ...new Set([
        ...sideLines.map((l) => l.at - STAGE_LEAD),
        ...sideLines.map((l) => l.end + FACE_HOLD),
        ...sideReacts.flatMap((r) => [r.at - STAGE_LEAD, r.end + FACE_HOLD]),
      ]),
    ].sort((a, b) => a - b);
    const list = timeline[side];
    list.push({ at: -Infinity, keys: groupAt(-Infinity) });
    for (const t of points) {
      const keys = groupAt(t);
      if (keys.join() !== list[list.length - 1]!.keys.join()) list.push({ at: t, keys });
    }
  }
  return scenes.map((s) => {
    const per = (side: Side): StageSwitch[] => {
      const list = timeline[side];
      const out: StageSwitch[] = [];
      for (let i = 0; i < list.length; i++) {
        const sw = list[i]!;
        const next = list[i + 1];
        if (sw.at <= s.startFrame && (!next || next.at > s.startFrame))
          out.push({ frame: -1000, keys: sw.keys });
        else if (sw.at > s.startFrame && sw.at < s.startFrame + s.durationFrames)
          out.push({ frame: sw.at - s.startFrame, keys: sw.keys });
      }
      return out;
    };
    return { left: per('left'), right: per('right') };
  });
}

/** Largest group on a side between two scene-local frames. */
export function maxGroup(list: StageSwitch[], from: number, to: number): number {
  let k = 0;
  for (let i = 0; i < list.length; i++) {
    const sw = list[i]!;
    const end = list[i + 1]?.frame ?? Infinity;
    if (sw.frame < to && end > from) k = Math.max(k, sw.keys.length);
  }
  return k;
}
