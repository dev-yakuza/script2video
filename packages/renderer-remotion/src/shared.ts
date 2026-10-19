/**
 * Dialogue geometry shared by the Node adapter (`s2v check`) and the Remotion bundle, so the
 * measured subtitle box is exactly the rendered one. No imports on purpose.
 */

/** Above this many speakers the dialogue layout shows name tags only. */
export const MAX_AVATARS = 4;
/** Frames before a line starts that the speaker's character steps in (when sides alternate). */
export const STAGE_LEAD = 8;
/** Frames an entrance or exit slides (core STAGE_SLIDE_S at 30 fps). */
export const STAGE_SLIDE = 15;
/** Frames a fade transition takes at each scene edge (core FADE_S at 30 fps). */
export const FADE_FRAMES = 9;

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
  /** An entrance or exit (acting stage 5c): this character slides STAGE_SLIDE frames from here. */
  move?: { key: string; kind: 'enter' | 'exit' };
}

/**
 * Who stands on each side over the whole video.
 * - One character per side: the side's latest speaker, stepping in STAGE_LEAD frames before
 *   their line. The first speaker of each side is on stage from the start.
 * - `:react` brings the reacting characters of a side on stage until the reaction ends (+hold).
 *   If that side's speaker is talking or reacting too, they stay and the others stand beside
 *   them; otherwise the reactors take the side for that time.
 * - `::enter` / `::exit` (acting stage 5c, the scene's `stage`): an entrance takes the side at
 *   the scene's first frame (a cast whose first event it is is not on stage before); an exit
 *   leaves the side empty until its next speaker, who never steps in before the next scene.
 * Returns each scene's switches, starting with whoever is on stage at its first frame.
 */
export function stagePlan(
  scenes: {
    startFrame: number;
    durationFrames: number;
    audio: { cast: string; startFrame: number; durationFrames: number }[];
    reactions?: { cast: string; startFrame: number; endFrame: number }[];
    stage?: { cast: string; kind: 'enter' | 'exit'; frame: number }[];
  }[],
  sideOf: Record<string, Side>,
): Record<Side, StageSwitch[]>[] {
  const moves = scenes.flatMap((s) =>
    (s.stage ?? []).map((e) => ({
      cast: e.cast,
      kind: e.kind,
      at: s.startFrame + e.frame,
      sceneStart: s.startFrame,
      sceneEnd: s.startFrame + s.durationFrames,
    })),
  );
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
  const timeline: Record<Side, { at: number; keys: string[]; move?: StageSwitch['move'] }[]> = {
    left: [],
    right: [],
  };
  for (const side of ['left', 'right'] as const) {
    const sideMoves = moves.filter((m) => sideOf[m.cast] === side);
    // When a line takes the side: STAGE_LEAD early, but not before its speaker's entrance in the
    // scene, nor before the scene after an exit on this side (no stepping in while one leaves).
    const sideLines = lines
      .filter((l) => sideOf[l.cast] === side)
      .map((l) => {
        let from = l.at - STAGE_LEAD;
        for (const m of sideMoves) {
          if (m.kind === 'enter' && m.cast === l.cast && m.at <= l.at && l.at < m.sceneEnd)
            from = Math.max(from, m.at);
          if (m.kind === 'exit' && m.at < l.at) from = Math.max(from, m.sceneEnd);
        }
        return { ...l, from };
      });
    // Reactions after an exit on this side wait for the next scene too (no cutting the slide).
    const sideReacts = reacts
      .filter((r) => sideOf[r.cast] === side)
      .map((r) => {
        let from = r.at - STAGE_LEAD;
        for (const m of sideMoves)
          if (m.kind === 'exit' && m.at < r.at) from = Math.max(from, m.sceneEnd);
        return { ...r, from };
      });
    const first =
      sideLines[0]?.cast ?? sideReacts[0]?.cast ?? sideMoves.find((m) => m.kind === 'enter')?.cast;
    if (!first) continue;
    // A cast whose first event is its entrance is not on stage before it.
    const firstSeen = Math.min(
      ...sideLines.filter((l) => l.cast === first).map((l) => l.at),
      ...sideReacts.filter((r) => r.cast === first).map((r) => r.at),
    );
    const firstEnter = sideMoves.find((m) => m.kind === 'enter' && m.cast === first);
    const initial = firstEnter && firstEnter.at <= firstSeen ? null : first;
    const changes = [
      ...sideLines.map((l) => ({ at: l.from, key: l.cast as string | null })),
      ...sideMoves.map((m) => ({ at: m.at, key: m.kind === 'enter' ? m.cast : null })),
    ].sort((a, b) => a.at - b.at);
    const base = (t: number) => {
      let key = initial;
      for (const c of changes) if (c.at <= t) key = c.key;
      return key;
    };
    // A speaker counts as talking until their face hold ends, so a reaction to their own line
    // does not push them off right after they stop.
    const talking = (key: string, t: number) =>
      sideLines.some((l) => l.cast === key && l.from <= t && t < l.end + FACE_HOLD);
    const reactors = (t: number) => [
      ...new Set(
        sideReacts
          .filter((r) => r.from <= t && t < r.end + FACE_HOLD)
          .sort((a, b) => a.at - b.at)
          .map((r) => r.cast),
      ),
    ];
    const groupAt = (t: number): string[] => {
      const b = base(t);
      const r = reactors(t);
      if (r.length === 0) return b ? [b] : [];
      // a character that entered this scene stays beside reactions of its side (it never sinks
      // right after sliding in)
      const sliding = sideMoves.some(
        (m) => m.kind === 'enter' && m.cast === b && m.at <= t && t < m.sceneEnd,
      );
      if (b && (r.includes(b) || talking(b, t) || sliding)) return [b, ...r.filter((k) => k !== b)];
      return r;
    };
    const points = [
      ...new Set([
        ...sideLines.map((l) => l.from),
        ...sideLines.map((l) => l.end + FACE_HOLD),
        ...sideReacts.flatMap((r) => [r.from, r.end + FACE_HOLD]),
        ...sideMoves.map((m) => m.at),
      ]),
    ].sort((a, b) => a - b);
    const list = timeline[side];
    list.push({ at: -Infinity, keys: groupAt(-Infinity) });
    for (const t of points) {
      const keys = groupAt(t);
      const m = sideMoves.find((x) => x.at === t);
      const move = m ? { key: m.cast, kind: m.kind } : undefined;
      if (move || keys.join() !== list[list.length - 1]!.keys.join())
        list.push({ at: t, keys, ...(move ? { move } : {}) });
    }
  }
  return scenes.map((s) => {
    // An entrance at the scene's first frame is drawn in the scene (it slides from frame 0);
    // any other switch at that frame is already on stage, as before.
    const inScene = (x: { at: number; move?: unknown }) =>
      x.at > s.startFrame || (x.at === s.startFrame && !!x.move);
    const per = (side: Side): StageSwitch[] => {
      const list = timeline[side];
      const out: StageSwitch[] = [];
      for (let i = 0; i < list.length; i++) {
        const sw = list[i]!;
        const next = list[i + 1];
        if (!inScene(sw) && sw.at <= s.startFrame && (!next || inScene(next)))
          out.push({ frame: -1000, keys: sw.keys });
        else if (inScene(sw) && sw.at < s.startFrame + s.durationFrames)
          out.push({
            frame: sw.at - s.startFrame,
            keys: sw.keys,
            ...(sw.move ? { move: sw.move } : {}),
          });
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

// ---------- idle motion (acting stage 5a) ----------

/** Small deterministic hash (FNV-1a, 32 bits): no Math.random in renders. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A value in [lo, hi) from a hash. FNV-1a's high bits barely move when only the last character
 * of the seed changes (…|0, …|1), so they are mixed first (murmur3 fmix32).
 */
function uniform(h: number, lo: number, hi: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return lo + ((h >>> 0) / 2 ** 32) * (hi - lo);
}

/** Frames a holding motion (sink, lean, head-tilt) takes to ease out after its face hold. */
export const HOLD_END = 12;
/** Frames one blink shows closed eyes. */
export const BLINK_FRAMES = 4;
/** Idle constants (E5 may tune them). */
export const IDLE = {
  breath: { amplitude: 0.015, period: [3.5, 4.5] as const, edgeS: 0.5 },
  blink: {
    firstS: [0.5, 3] as const,
    intervalS: [2, 6] as const,
    doublePct: 10,
    /** Frames between the end of a blink and its second blink. */
    doubleGap: 3,
    /** No face-change blink this close to a clock blink (before or after) or to any blink. */
    faceWindowS: 1,
    faceSpacingS: 0.5,
    /** A face-change blink waits at most this long for a closed mouth. */
    faceWaitS: 0.5,
  },
  nod: { pct: 50, every: 2, scale: 0.4, body: 20, head: 24 },
};

interface IdleAudio {
  sentenceId: string;
  cast: string;
  face: string;
  startFrame: number;
  durationFrames: number;
  contentKey?: string;
  ordinal?: number;
  question?: boolean;
}

interface IdleReaction {
  cast: string;
  face: string;
  startFrame: number;
  endFrame: number;
}

/** A listener's look (acting stage 5b): `hold` = ended with its paragraph (held FACE_HOLD more). */
export interface IdleLook {
  cast: string;
  face: string;
  startFrame: number;
  endFrame: number;
  hold?: true;
}

/** A line's seed material: what is said (its occurrence), else its id (old timelines, tests). */
const material = (a: IdleAudio) =>
  a.contentKey !== undefined ? `${a.contentKey}#${a.ordinal ?? 0}` : a.sentenceId;

/** Lines by start frame, then by timeline order (paragraph gaps can be negative). */
const sortedAudio = <T extends IdleAudio>(audio: T[]): T[] =>
  audio
    .map((a, i) => ({ a, i }))
    .sort((x, y) => x.a.startFrame - y.a.startFrame || x.i - y.i)
    .map((x) => x.a);

/**
 * The face a character shows at a frame: the most recent of its own line (paragraph face), any
 * `:react` aimed at it, each held FACE_HOLD frames after it ends, and its looks (held only when
 * they end with their paragraph); otherwise the default.
 */
export function faceAt(
  key: string,
  defaultFace: string,
  frame: number,
  audio: IdleAudio[],
  reactions: IdleReaction[],
  looks: IdleLook[] = [],
): string {
  let face = defaultFace;
  let since = -Infinity;
  const consider = (start: number, end: number, f: string) => {
    if (frame >= start && frame < end + FACE_HOLD && start >= since) {
      face = f;
      since = start;
    }
  };
  for (const a of audio)
    if (a.cast === key) consider(a.startFrame, a.startFrame + a.durationFrames, a.face);
  for (const r of reactions) if (r.cast === key) consider(r.startFrame, r.endFrame, r.face);
  for (const l of looks)
    if (l.cast === key)
      consider(l.startFrame, l.hold ? l.endFrame : l.endFrame - FACE_HOLD, l.face);
  return face;
}

/** The face really drawn: the face, else the default face, else the art's first face. */
export function drawnFace(face: string, defaultFace: string, available: string[]): string {
  return available.includes(face)
    ? face
    : available.includes(defaultFace)
      ? defaultFace
      : available[0]!;
}

/** Scene frames where the drawn face of `key` changes (from the frame before). */
export function drawnFaceChanges(input: {
  key: string;
  defaultFace: string;
  available: string[];
  audio: IdleAudio[];
  reactions: IdleReaction[];
  looks?: IdleLook[];
  durationFrames: number;
}): number[] {
  const { key, defaultFace, available, audio, reactions, durationFrames } = input;
  const looks = input.looks ?? [];
  const drawn = (f: number) =>
    drawnFace(faceAt(key, defaultFace, f, audio, reactions, looks), defaultFace, available);
  const points = new Set<number>();
  for (const a of audio)
    if (a.cast === key) {
      points.add(a.startFrame);
      points.add(a.startFrame + a.durationFrames + FACE_HOLD);
    }
  for (const r of reactions)
    if (r.cast === key) {
      points.add(r.startFrame);
      points.add(r.endFrame + FACE_HOLD);
    }
  for (const l of looks)
    if (l.cast === key) {
      points.add(l.startFrame);
      points.add(l.hold ? l.endFrame + FACE_HOLD : l.endFrame);
    }
  return [...points]
    .filter((f) => f > 0 && f < durationFrames && drawn(f) !== drawn(f - 1))
    .sort((a, b) => a - b);
}

/**
 * Blink start frames of one character in one scene (acting plan 4.1, 4.6). One clock per scene:
 * the first blink 0.5–3 s in, each next one 2–6 s after the previous blink's real frame, the
 * interval seeded by the line that opened the segment the blink fell in. A blink needs
 * BLINK_FRAMES closed-mouth frames and waits for the next such run. 10% get a second blink;
 * a change of the drawn face adds one (not within 1 s of a clock blink, waiting at most 0.5 s).
 */
export function blinkFrames(input: {
  cast: string;
  sceneId: string;
  output: string;
  fps: number;
  durationFrames: number;
  /** Every line of the scene (all speakers): segments run from one line start to the next. */
  audio: IdleAudio[];
  /** This character's mouth per scene frame (0 closed, 1 half, 2 open). */
  mouth: ArrayLike<number>;
  faceChanges: number[];
}): number[] {
  const { cast, sceneId, output, fps, durationFrames: dur, mouth, faceChanges } = input;
  const c = IDLE.blink;
  const segs = sortedAudio(input.audio);
  const materialAt = (f: number) => {
    let m = `scene:${sceneId}`;
    for (const a of segs) if (a.startFrame <= f) m = material(a);
    return m;
  };
  const busy = new Uint8Array(Math.max(0, dur));
  const canPlace = (f: number) => {
    if (f < 0 || f + BLINK_FRAMES > dur) return false;
    for (let i = f; i < f + BLINK_FRAMES; i++) if (busy[i] || (mouth[i] ?? 0) !== 0) return false;
    return true;
  };
  const next = (from: number, limit = dur) => {
    for (let f = Math.max(0, from); f <= Math.min(limit, dur - BLINK_FRAMES); f++)
      if (canPlace(f)) return f;
    return -1;
  };
  const out: number[] = [];
  const place = (f: number) => {
    busy.fill(1, f, f + BLINK_FRAMES);
    out.push(f);
  };
  const base = `${cast}|${output}|${sceneId}`;
  const clock: number[] = [];
  const doubles: number[] = [];
  let planned = Math.round(fps * uniform(hash(`${base}|first`), c.firstS[0], c.firstS[1]));
  for (let k = 0; planned < dur; k++) {
    const f = next(planned);
    if (f < 0) break;
    place(f);
    clock.push(f);
    const seed = `${base}|${materialAt(f)}|${k}`;
    if (hash(`${seed}|double`) % 100 < c.doublePct) doubles.push(f + BLINK_FRAMES + c.doubleGap);
    planned = f + Math.round(fps * uniform(hash(seed), c.intervalS[0], c.intervalS[1]));
  }
  for (const d of doubles) if (canPlace(d)) place(d);
  const near = Math.round(fps * c.faceWindowS);
  const spacing = Math.round(fps * c.faceSpacingS);
  for (const ch of faceChanges) {
    if (clock.some((b) => Math.abs(b - ch) <= near)) continue;
    const f = next(ch, ch + Math.round(fps * c.faceWaitS));
    if (f >= 0 && !out.some((b) => Math.abs(b - f) < BLINK_FRAMES + spacing)) place(f);
  }
  return out.sort((a, b) => a - b);
}

export interface Nod {
  cast: string;
  frame: number;
  /** On the head layer (head-nod) or the whole body (nod). */
  head: boolean;
  length: number;
}

/**
 * Listener nods (acting plan 4.2, 4.6): at the end of a line, the character standing on the
 * other side may nod a little — 50% (E5) by a hash of (listener, line, output), at most every second
 * line of others in the scene; never after a question, while reacting, holding a motion,
 * speaking or about to speak, stepping in or out, or when the nod would run past the scene end.
 */
export function listenerNods(input: {
  sceneId: string;
  output: string;
  durationFrames: number;
  audio: IdleAudio[];
  reactions: IdleReaction[];
  motions: { cast: string; motion: string; startFrame: number; endFrame: number }[];
  stage: Record<Side, StageSwitch[]>;
  hasHead: (cast: string, frame: number) => boolean;
}): Nod[] {
  const { output, durationFrames: dur, audio, reactions, motions, stage, hasHead } = input;
  const c = IDLE.nod;
  const sideOf = (key: string): Side | undefined => {
    for (const side of ['left', 'right'] as const)
      if (stage[side].some((sw) => sw.keys.includes(key))) return side;
    return undefined;
  };
  const held = new Set(['sink', 'lean', 'head-tilt']);
  // Lines of others ended since each character's last nod (absent: no nod yet in this scene).
  const since = new Map<string, number>();
  const everyone = new Set([
    ...audio.map((a) => a.cast),
    ...stage.left.flatMap((s) => s.keys),
    ...stage.right.flatMap((s) => s.keys),
  ]);
  const nods: Nod[] = [];
  const lastEnd = new Map<string, number>();
  const ends = sortedAudio(audio)
    .map((a, i) => ({ a, i, end: a.startFrame + a.durationFrames }))
    .sort((x, y) => x.end - y.end || x.i - y.i);
  for (const { a, end: E } of ends) {
    for (const key of everyone)
      if (key !== a.cast && since.has(key)) since.set(key, since.get(key)! + 1);
    const speakerSide = sideOf(a.cast);
    if (!speakerSide) continue;
    const list = stage[speakerSide === 'left' ? 'right' : 'left'];
    let i = -1;
    for (let k = 0; k < list.length; k++) if (list[k]!.frame <= E) i = k;
    if (i < 0) continue;
    const sw = list[i]!;
    for (const key of sw.keys) {
      if (key === a.cast) continue;
      if (a.question) continue;
      const lead = sw.move?.key === key ? STAGE_SLIDE : STAGE_LEAD;
      const entering = !(list[i - 1]?.keys.includes(key) ?? true) && E < sw.frame + lead;
      if (entering) continue;
      const head = hasHead(key, E);
      const length = head ? c.head : c.body;
      if (E + length > dur) continue;
      if (list.some((s) => s.frame >= E && s.frame < E + length && !s.keys.includes(key))) continue;
      if (list.some((s) => s.move?.key === key && s.move.kind === 'exit' && E + length > s.frame))
        continue;
      // Reacting now, or starting to within the nod (its face may move the head's pivot).
      if (
        reactions.some(
          (r) => r.cast === key && r.startFrame < E + length && E < r.endFrame + FACE_HOLD,
        )
      )
        continue;
      if (E < (lastEnd.get(key) ?? -Infinity)) continue;
      if (
        motions.some(
          (m) =>
            m.cast === key &&
            held.has(m.motion) &&
            m.startFrame <= E &&
            E < m.endFrame + FACE_HOLD + HOLD_END,
        )
      )
        continue;
      if (
        audio.some(
          (o) =>
            o.cast === key &&
            ((o.startFrame <= E && E < o.startFrame + o.durationFrames) ||
              (o.startFrame >= E && o.startFrame < E + length) ||
              // its own face hold ending inside the nod changes the face (and maybe the pivot)
              (o.startFrame + o.durationFrames + FACE_HOLD > E &&
                o.startFrame + o.durationFrames + FACE_HOLD < E + length)),
        )
      )
        continue;
      if ((since.get(key) ?? c.every) < c.every) continue;
      if (hash(`${key}|${material(a)}|${output}`) % 100 >= c.pct) continue;
      nods.push({ cast: key, frame: E, head, length });
      since.set(key, 0);
      lastEnd.set(key, E + length);
    }
  }
  return nods;
}

/**
 * Breathing (acting plan 4.1): vertical scale − 1 of a character at a scene frame. 1.5% at most (E5),
 * half while speaking, a 3.5–4.5 s period per character, faded in and out over 0.5 s at the
 * scene edges (scenes render apart, so a cut cannot jump).
 */
export function breath(input: {
  cast: string;
  output: string;
  sceneId: string;
  frame: number;
  fps: number;
  durationFrames: number;
  /** 0–1: how much the character is speaking. */
  speaking: number;
}): number {
  const { cast, output, sceneId, frame, fps, durationFrames, speaking } = input;
  const b = IDLE.breath;
  const T = uniform(hash(`${cast}|${output}|breath`), b.period[0], b.period[1]);
  const phase = uniform(hash(`${cast}|${output}|${sceneId}|phase`), 0, T);
  const edge = Math.min(frame, durationFrames - 1 - frame) / (b.edgeS * fps);
  const x = Math.max(0, Math.min(1, edge));
  const envelope = x * x * (3 - 2 * x);
  const t = frame / fps + phase;
  return (
    b.amplitude * envelope * (1 - 0.5 * speaking) * (1 - Math.cos((2 * Math.PI * t) / T)) * 0.5
  );
}
