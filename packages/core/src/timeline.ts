/**
 * Timeline: script + synthesized audio manifest → frame-quantized scenes (PLAN 3, 5.4, 5.5).
 *
 * Rules
 * - Scene start frames are accumulated first; every audio placement, cue and subtitle frame is
 *   derived from scene-local seconds rounded once, so long videos do not drift.
 * - Pauses come from pacing: sentenceGap inside a paragraph, paragraphGap after a paragraph,
 *   sceneGap after a scene (tail after the last), lead before the first scene. `:pause` adds to the
 *   gap after its sentence; a paragraph `gap` replaces the gap before it (negative = overlap).
 * - Cues fire at the start time of the first word of their phrase.
 * - Subtitles: one group visible at a time; ko/en break only at whitespace, ja anywhere;
 *   break early after a comma.
 */

import {
  FACE_MOTION,
  type Cue,
  type Framing,
  type Frontmatter,
  type Lang,
  type LookValue,
  type OutputProfile,
  type Script,
  type Sentence,
  type Visual,
} from './schema.js';
import { gainFor, lookFace, paragraphActing } from './acting.js';
import {
  FACE_HOLD_S,
  FADE_S,
  HELD_MOTIONS,
  HOLD_END_S,
  includesParagraph,
  selectScenes,
  STAGE_SLIDE_S,
  stageEvents,
} from './stage.js';
import { isQuestion, textKey } from './keys.js';
import { rhythmGaps, rhythmOn, type RhythmRule } from './rhythm.js';
import { toAlignText, ttsRangeToDisplay } from './tts-text.js';

export { isQuestion, textKey };

export interface AlignedWord {
  /** Token text as returned by the aligner (a substring of the TTS text, modulo normalization). */
  text: string;
  /** Seconds from the start of the sentence audio. */
  start: number;
  end: number;
}

export interface SentenceAudio {
  /** Path of the sentence wav (relative to the audio lock directory). */
  src: string;
  duration: number;
  words: AlignedWord[];
}

/** Synthesized audio keyed by sentence id (see `sentenceId`). */
export type AudioManifest = Record<string, SentenceAudio>;

export function sentenceId(sceneId: string, blockIndex: number, sentenceIndex: number): string {
  return `${sceneId}:${blockIndex}:${sentenceIndex}`;
}

export interface TimelineAudio {
  sentenceId: string;
  cast: string;
  /** Character face while this sentence is spoken (paragraph `face`, its emotion's, else the cast default). */
  face: string;
  src: string;
  startFrame: number;
  durationFrames: number;
  /** Mix gain on top of the loudness normalization (dB; absent = 0): `volume`, `power`. */
  gain?: number;
  /**
   * Seeds of idle motion (acting stage 5a): `textKey(cast, text)` of the displayed sentence, its
   * occurrence among the same key in this output (0 = first), and whether it asks a question.
   */
  contentKey?: string;
  ordinal?: number;
  question?: boolean;
}

export interface TimelineCue {
  frame: number;
  phrase: string;
  attrs: Record<string, string>;
}

/** A listener's (or the speaker's) face from a `:react` point to the end of its paragraph. */
export interface TimelineReaction {
  cast: string;
  face: string;
  startFrame: number;
  endFrame: number;
}

/** A character motion (jump, shake …) from a paragraph start or a `:react` to its end. */
export interface TimelineMotion {
  cast: string;
  motion: string;
  startFrame: number;
  endFrame: number;
}

export interface TimelineSubtitle {
  startFrame: number;
  endFrame: number;
  text: string;
  cast: string;
  /** Words inside `text` ([start, end) char offsets) with their scene-local start frame. */
  words: { start: number; end: number; frame: number }[];
}

export interface TimelineVisual {
  startFrame: number;
  visual: Visual;
}

/**
 * A listener's look (acting stage 5b): the face it shows from `startFrame` to `endFrame`. `hold`:
 * it ends with its paragraph (held FACE_HOLD more, like a reaction); otherwise a later look ended it.
 * It neither lights the listener nor brings it on stage.
 */
export interface TimelineLook {
  cast: string;
  face: string;
  startFrame: number;
  endFrame: number;
  hold?: true;
}

export interface TimelineScene {
  id: string;
  title: string;
  /** Absolute start frame in the whole video. Everything else below is scene-local. */
  startFrame: number;
  durationFrames: number;
  visuals: TimelineVisual[];
  audio: TimelineAudio[];
  cues: TimelineCue[];
  subtitles: TimelineSubtitle[];
  reactions: TimelineReaction[];
  motions: TimelineMotion[];
  /** Listener looks (acting stage 5b); absent in timelines built before it. */
  looks?: TimelineLook[];
  /**
   * Entrances and exits (acting stage 5c): an entrance slides in from frame 0, an exit slides
   * out from its frame (after everything in the scene and its face hold). Absent when none.
   */
  stage?: { cast: string; kind: 'enter' | 'exit'; frame: number }[];
  /**
   * Framing of every cast member in this scene: the scene's `::shot`, else inherited from the
   * previous scene of this output (the first starts full). All full when the output sets `shot: full`.
   */
  framing: Record<string, Framing>;
}

export interface Timeline {
  fps: number;
  lang: Lang;
  output: string;
  totalFrames: number;
  scenes: TimelineScene[];
}

export interface TimelineIssue {
  sentenceId: string;
  message: string;
}

export const SUBTITLE_MAX_CHARS: Record<Lang, number> = { ko: 20, en: 42, ja: 18 };
const COMMAS = new Set([',', '、', '，']);
const LAST_SUBTITLE_HOLD_S = 0.4;
const SUBTITLE_BRIDGE_S = 0.6;

function norm(s: string): string {
  return s.normalize('NFKC');
}

export interface WordSpan {
  /** [start, end) in the display sentence text. */
  start: number;
  end: number;
  t0: number;
  t1: number;
}

/** Map aligner tokens (on the TTS text) back to display-text ranges, in order. */
export function displayWordSpans(
  sentence: Sentence,
  words: AlignedWord[],
  pronounce: Record<string, string>,
  lang: Lang = 'ko',
): WordSpan[] {
  // Aligner tokens come from the align text (dictionary applied + numbers spelled out).
  const tts = toAlignText(sentence.text, pronounce, lang);
  const hay = norm(tts.tts);
  const spans: WordSpan[] = [];
  let cursor = 0;
  for (const w of words) {
    const needle = norm(w.text);
    if (!needle) continue;
    const at = hay.indexOf(needle, cursor);
    if (at < 0) continue;
    cursor = at + needle.length;
    const [start, end] = ttsRangeToDisplay(tts, at, at + needle.length);
    const prev = spans[spans.length - 1];
    // Tokens inside (or straddling) one dictionary replacement map to overlapping display ranges:
    // merge them so display words never overlap.
    if (prev && start < prev.end) {
      prev.end = Math.max(prev.end, end);
      prev.t1 = w.end;
    } else spans.push({ start, end, t0: w.start, t1: w.end });
  }
  return spans;
}

export function groupSubtitles(
  text: string,
  spans: WordSpan[],
  lang: Lang,
  maxChars = SUBTITLE_MAX_CHARS[lang],
  /** Character ranges that must stay in one subtitle group (cue phrases). */
  keepTogether: { start: number; end: number }[] = [],
): WordSpan[] {
  const groups: WordSpan[] = [];
  let cur: WordSpan | null = null;
  for (const s of spans) {
    const open: WordSpan | null = cur;
    if (open) {
      const gap = text.slice(open.end, s.start);
      const insidePhrase = keepTogether.some((r) => s.start > r.start && s.start < r.end);
      const breakable = !insidePhrase && (lang === 'ja' || /\s/.test(gap));
      const afterComma = [...gap.trim()].some((ch) => COMMAS.has(ch));
      // A phrase that starts here and would not fit in the open group starts a new group.
      const phrase = keepTogether.find((r) => r.start === s.start);
      const phraseOverflows = phrase !== undefined && phrase.end - open.start > maxChars;
      if (breakable && (s.end - open.start > maxChars || afterComma || phraseOverflows)) {
        groups.push(open);
        cur = { ...s };
        continue;
      }
      cur = { ...open, end: s.end, t1: s.t1 };
    } else {
      cur = { ...s };
    }
  }
  if (cur) groups.push(cur);
  // Attach trailing punctuation (up to the next group) to each group.
  return groups.map((g, k) => {
    const next = groups[k + 1]?.start ?? text.length;
    const tail = text.slice(g.end, next);
    const punct = /^[^\p{L}\p{N}\s]+/u.exec(tail);
    return punct ? { ...g, end: g.end + punct[0].length } : g;
  });
}

/** Highlight units for word-level subtitles: ko/en merge tokens up to whitespace (eojeol / word). */
function highlightUnits(text: string, spans: WordSpan[], lang: Lang): WordSpan[] {
  if (lang === 'ja') return spans;
  const out: WordSpan[] = [];
  for (const s of spans) {
    const prev = out[out.length - 1];
    if (prev && !/\s/.test(text.slice(prev.end, s.start))) {
      prev.end = s.end;
      prev.t1 = s.t1;
    } else out.push({ ...s });
  }
  return out;
}

function cueFrame(cue: Cue, spans: WordSpan[]): number | null {
  const hit = spans.find((s) => s.end > cue.start && s.start < cue.end);
  return hit ? hit.t0 : null;
}

/**
 * Motion for a face change: the explicit one (`none` = no motion), else the face's own motion
 * when the cast member allows automatic motions. A paragraph without a face change has none.
 */
function motionFor(
  meta: Script['meta'],
  cast: string,
  face: string | undefined,
  explicit: string | undefined,
): string | undefined {
  if (explicit === 'none') return undefined;
  if (explicit) return explicit;
  const member = meta.cast[cast];
  if (!face || member?.motion === 'off') return undefined;
  // Parts characters bring their own face → motion table (from character.yaml).
  if (member?.faceMotions) {
    const m = member.faceMotions[face];
    return m === 'none' ? undefined : m;
  }
  return FACE_MOTION[face];
}

/** Framing per cast member for each selected scene: `::shot` sets, later scenes inherit. */
export function sceneFramings(
  meta: Script['meta'],
  scenes: Script['scenes'],
  profile: OutputProfile,
): Record<string, Framing>[] {
  const current: Record<string, Framing> = Object.fromEntries(
    Object.keys(meta.cast).map((k) => [k, 'full' as Framing]),
  );
  return scenes.map((scene) => {
    if (profile.shot !== 'full') Object.assign(current, scene.shot ?? {});
    return { ...current };
  });
}

/**
 * Listener looks of one paragraph (stage 5b plan 3). Per listener, reactions and looks in time
 * order: a look shows the variant of the reaction face then active (else the cast face) and ends
 * at the listener's next look; a reaction starting during a look takes the look's variant;
 * `partner` during a reaction shows the reaction's own face again. Mutates `reactions`' faces.
 */
function listenerLooks(
  meta: Frontmatter,
  reactions: TimelineReaction[],
  looks: { cast: string; look: LookValue; startFrame: number; order: number }[],
  blockEnd: number,
  framing: Record<string, Framing>,
): TimelineLook[] {
  const out: TimelineLook[] = [];
  for (const cast of new Set(looks.map((l) => l.cast))) {
    const fr = framing[cast] ?? 'full';
    const base = meta.cast[cast]?.face ?? 'neutral';
    type Ev =
      | { kind: 'look'; frame: number; order: number; look: LookValue }
      | { kind: 'react'; frame: number; order: number; r: TimelineReaction };
    const events: Ev[] = [
      ...looks
        .filter((l) => l.cast === cast)
        .map((l) => ({ kind: 'look' as const, frame: l.startFrame, order: l.order, look: l.look })),
      ...reactions
        .filter((r) => r.cast === cast)
        .map((r, i, all) => ({
          kind: 'react' as const,
          frame: r.startFrame,
          order: i - all.length,
          r,
        })),
    ].sort((a, b) => a.frame - b.frame || a.order - b.order);
    let look: LookValue = 'partner';
    let react: string | undefined; // the active reaction's own face
    let open: TimelineLook | undefined;
    const close = (frame: number) => {
      if (open) {
        open.endFrame = Math.max(open.startFrame, frame);
        delete open.hold;
      }
      open = undefined;
    };
    for (const e of events) {
      if (e.kind === 'react') {
        react = e.r.face;
        e.r.face = lookFace(meta, cast, e.r.face, look, fr).face;
        continue;
      }
      close(e.frame);
      look = e.look;
      if (look === 'partner' && react === undefined) continue;
      open = {
        cast,
        face: lookFace(meta, cast, react ?? base, look, fr).face,
        startFrame: e.frame,
        endFrame: blockEnd,
        hold: true,
      };
      out.push(open);
    }
  }
  return out;
}

/** A paragraph gap as rhythm (acting stage 5d) made it, for the `timeline` gap table. */
export interface TimelineGap {
  sceneId: string;
  line: number;
  rules: RhythmRule[];
  factor: number;
  /** The gap in seconds before the paragraph. */
  seconds: number;
}

export function buildTimeline(
  script: Script,
  outputName: string,
  manifest: AudioManifest,
  fps = 30,
  opts: { rhythm?: boolean } = {},
): { timeline: Timeline; issues: TimelineIssue[]; gaps?: TimelineGap[] } {
  const { meta } = script;
  const profile = meta.outputs[outputName];
  if (!profile) throw new Error(`unknown output "${outputName}"`);
  const pacing = meta.pacing;
  const issues: TimelineIssue[] = [];
  const toFrame = (seconds: number) => Math.round(seconds * fps);

  const scenes: TimelineScene[] = [];
  const seen = new Map<string, number>();
  const selected = selectScenes(script, profile);
  const framings = sceneFramings(meta, selected, profile);
  const stage = stageEvents(script, outputName).events;
  const fade = (profile.transition ?? meta.transition) === 'fade';
  // Rhythm (5d plan 4): factors per paragraph, kept out of the timeline itself.
  const rhythm = rhythmOn(script, outputName, opts.rhythm)
    ? new Map(rhythmGaps(script, outputName).map((g) => [g.paragraph, g]))
    : null;
  const gaps: TimelineGap[] = [];
  let sceneStart = 0;

  selected.forEach((scene, sceneIndex) => {
    const isFirst = sceneIndex === 0;
    const isLast = sceneIndex === selected.length - 1;
    let t = isFirst ? pacing.lead : 0; // scene-local seconds
    let pendingGap = 0;
    let started = false;
    let anyAudio = false;
    // the first subtitle of a paragraph whose gap rhythm widened, and by how many frames: the
    // bridge to it widens exactly as much (factor 1 or less: 0, as with rhythm off)
    const widened = new Map<TimelineSubtitle, number>();
    const events = stage.get(scene.id) ?? [];
    const entering = new Set(events.filter((e) => e.kind === 'enter').map((e) => e.cast));
    const out: TimelineScene = {
      id: scene.id,
      title: scene.title,
      startFrame: sceneStart,
      durationFrames: 0,
      visuals: [],
      audio: [],
      cues: [],
      subtitles: [],
      reactions: [],
      motions: [],
      looks: [],
      framing: framings[sceneIndex]!,
    };
    const pendingVisuals: Visual[] = [];

    scene.blocks.forEach((block, blockIndex) => {
      if (block.kind === 'visual') {
        if (block.type === 'thumbnail') return;
        pendingVisuals.push(block);
        return;
      }
      if (!includesParagraph(block, outputName)) return;
      const rg = rhythm?.get(block);
      let extra = 0;
      if (started) {
        const gap = block.gap ?? pendingGap * (rg?.factor ?? 1);
        if (block.gap === undefined)
          extra = Math.max(0, toFrame(t + gap) - toFrame(t + pendingGap));
        t += gap;
        if (rg)
          gaps.push({
            sceneId: scene.id,
            line: rg.line,
            rules: rg.rules,
            factor: rg.factor,
            seconds: gap,
          });
      }
      const firstSubtitle = out.subtitles.length;
      started = true;
      const blockReactions: (TimelineReaction & { motion?: string })[] = [];
      const blockLooks: { cast: string; look: LookValue; startFrame: number; order: number }[] = [];
      let blockStart: number | null = null;
      const acting = paragraphActing(meta, block, out.framing[block.cast] ?? 'full');
      const sentenceStart: (number | undefined)[] = [];
      block.sentences.forEach((sentence, si) => {
        const id = sentenceId(scene.id, blockIndex, si);
        const audio = manifest[id];
        if (!audio) {
          issues.push({ sentenceId: id, message: 'no synthesized audio for sentence' });
          return;
        }
        if (si > 0) t += pacing.sentenceGap;
        // The scene's first line waits for its speaker to slide in (5c plan 4).
        if (!anyAudio && entering.has(block.cast)) t = Math.max(t, STAGE_SLIDE_S);
        anyAudio = true;
        const startFrame = toFrame(t);
        blockStart ??= startFrame;
        for (const v of pendingVisuals.splice(0)) out.visuals.push({ startFrame, visual: v });
        sentenceStart[si] = startFrame;
        const gain = gainFor(meta, block, sentence);
        const contentKey = textKey(block.cast, sentence.text);
        const ordinal = seen.get(contentKey) ?? 0;
        seen.set(contentKey, ordinal + 1);
        out.audio.push({
          sentenceId: id,
          cast: block.cast,
          face: acting.faces[si]!.shown,
          src: audio.src,
          startFrame,
          durationFrames: Math.ceil(audio.duration * fps),
          ...(gain !== 0 ? { gain } : {}),
          contentKey,
          ordinal,
          question: isQuestion(sentence.text),
        });
        const spans = displayWordSpans(sentence, audio.words, meta.pronounce, meta.lang);
        for (const cue of sentence.cues) {
          const at = cueFrame(cue, spans);
          if (at === null) {
            issues.push({
              sentenceId: id,
              message: `cue "${sentence.text.slice(cue.start, cue.end)}" not aligned`,
            });
            continue;
          }
          out.cues.push({
            frame: toFrame(t + at),
            phrase: sentence.text.slice(cue.start, cue.end),
            attrs: cue.attrs,
          });
        }
        for (const g of groupSubtitles(sentence.text, spans, meta.lang, undefined, sentence.cues)) {
          const raw = sentence.text.slice(g.start, g.end);
          const lead = raw.length - raw.trimStart().length;
          const base = g.start + lead;
          out.subtitles.push({
            startFrame: toFrame(t + g.t0),
            endFrame: toFrame(t + g.t1),
            text: raw.trim(),
            cast: block.cast,
            words: highlightUnits(
              sentence.text,
              spans.filter((w) => w.start >= g.start && w.end <= g.end),
              meta.lang,
            ).map((w) => ({ start: w.start - base, end: w.end - base, frame: toFrame(t + w.t0) })),
          });
        }
        for (const r of sentence.reacts ?? []) {
          // From the first word at or after the point (the sentence start if it leads the line).
          const word = spans.find((w) => w.end > r.at);
          const at = r.at === 0 || !word ? (r.at === 0 ? 0 : audio.duration) : word.t0;
          for (const [cast, face] of Object.entries(r.faces)) {
            const motion = motionFor(meta, cast, face, r.motions?.[cast]);
            blockReactions.push({
              cast,
              face,
              startFrame: toFrame(t + at),
              endFrame: 0,
              ...(motion ? { motion } : {}),
            });
          }
        }
        for (const l of sentence.looks ?? []) {
          const word = spans.find((w) => w.end > l.at);
          const at = l.at === 0 || !word ? (l.at === 0 ? 0 : audio.duration) : word.t0;
          for (const [cast, look] of Object.entries(l.looks))
            if (cast !== block.cast)
              blockLooks.push({
                cast,
                look,
                startFrame: toFrame(t + at),
                order: blockLooks.length,
              });
        }
        t += audio.duration;
        if (sentence.pauseAfter) t += sentence.pauseAfter;
      });
      const blockEnd = toFrame(t);
      out.looks!.push(...listenerLooks(meta, blockReactions, blockLooks, blockEnd, out.framing));
      for (const { motion, ...r } of blockReactions) {
        out.reactions.push({ ...r, endFrame: blockEnd });
        if (motion)
          out.motions.push({ cast: r.cast, motion, startFrame: r.startFrame, endFrame: blockEnd });
      }
      // a run starts at its sentence (or the next one that has audio) and lasts until the next run
      const at = (si: number) => sentenceStart.slice(si).find((f) => f !== undefined);
      acting.runs.forEach((run, k) => {
        const startFrame = at(run.sentence);
        if (!run.motion || startFrame === undefined) return;
        const next = acting.runs[k + 1];
        out.motions.push({
          cast: block.cast,
          motion: run.motion,
          startFrame,
          endFrame: (next && at(next.sentence)) ?? blockEnd,
        });
      });
      if (extra > 0 && out.subtitles[firstSubtitle])
        widened.set(out.subtitles[firstSubtitle]!, extra);
      pendingGap = pacing.paragraphGap;
    });

    // Visuals after the last narration (rare) still show from where narration ended.
    for (const v of pendingVisuals.splice(0))
      out.visuals.push({ startFrame: toFrame(t), visual: v });
    const contentEnd = started ? toFrame(t) : 0;
    t += isLast ? pacing.tail : pacing.sceneGap;
    out.durationFrames = Math.max(1, toFrame(t));
    if (events.length > 0) {
      // An exit slides out after everything in the scene and its face hold (5c plan 4).
      const hold = toFrame(FACE_HOLD_S);
      const slide = toFrame(STAGE_SLIDE_S);
      const end = Math.max(
        contentEnd,
        ...out.audio.map((a) => a.startFrame + a.durationFrames),
        ...out.reactions.map((r) => r.endFrame),
        ...out.looks!.map((l) => l.endFrame),
        ...out.motions.map(
          (m) => m.endFrame + (HELD_MOTIONS.has(m.motion) ? toFrame(HOLD_END_S) : 0),
        ),
      );
      const exitAt = Math.max(end + hold, entering.size > 0 ? slide : 0);
      out.stage = events.map((e) => ({
        cast: e.cast,
        kind: e.kind,
        frame: e.kind === 'enter' ? 0 : exitAt,
      }));
      if (events.some((e) => e.kind === 'exit'))
        out.durationFrames = Math.max(
          out.durationFrames,
          exitAt + slide + 1 + (fade ? toFrame(FADE_S) : 0),
        );
    }

    // One subtitle group at a time: close each group when the next starts; hold the last briefly.
    out.subtitles.sort((a, b) => a.startFrame - b.startFrame);
    // Same speaker: bridge short gaps so the text does not flicker, otherwise hold briefly.
    // Different speakers overlapping (negative gap): keep both visible (PLAN 5.4 exception).
    const hold = toFrame(LAST_SUBTITLE_HOLD_S);
    const bridge = toFrame(SUBTITLE_BRIDGE_S);
    out.subtitles.forEach((s, k) => {
      const next = out.subtitles[k + 1];
      let end = s.endFrame + hold;
      if (next) {
        // a paragraph gap rhythm widened bridges as much wider (5d plan 4)
        // (+2: earlier shifts and the first word's offset are rounded on their own — up to two
        // frames either way; it may bridge two frames more than rhythm off would)
        const reach = bridge + (widened.has(next) ? widened.get(next)! + 2 : 0);
        if (next.cast === s.cast)
          end =
            next.startFrame - s.endFrame <= reach
              ? next.startFrame
              : Math.min(end, next.startFrame);
        else if (next.startFrame >= s.endFrame) end = Math.min(end, next.startFrame);
        else end = s.endFrame;
      }
      s.endFrame = Math.min(end, out.durationFrames);
    });

    scenes.push(out);
    sceneStart += out.durationFrames;
  });

  return {
    timeline: { fps, lang: meta.lang, output: outputName, totalFrames: sceneStart, scenes },
    issues,
    ...(rhythm ? { gaps } : {}),
  };
}
