/**
 * Acting (acting plan 2–3, stage 2 plan 2): emotion templates, gates and the rules that turn a
 * line's voice attributes (`emo`, `power`, `say`, `volume`, `speed`) into an instruction, a gain, a
 * face and a motion. Pure tables and functions; the CLI applies them.
 */

import {
  FACE_MOTION,
  type Acting,
  type CastMember,
  type Framing,
  type Frontmatter,
  type LookValue,
  type Paragraph,
  type Sentence,
  type UserEmotion,
} from './schema.js';

/**
 * Bump when a template, a gate or a table below changes after it has been released (it goes into the
 * synthesis key of templated lines). Template text is in the key anyway, as the instruction.
 */
export const ACTING_VERSION = 1;

/** Standard emotions = the face names of the `standard@1` set (acting plan A2). */
export const EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'anxious',
  'excited',
  'calm',
  'serious',
  'puzzled',
  'moved',
  'playful',
] as const;
export type Emotion = (typeof EMOTIONS)[number];
export const isStandardEmotion = (e: string): e is Emotion =>
  (EMOTIONS as readonly string[]).includes(e);

/** Emotions whose pitch may rise further (acting plan 3.5). */
export const HIGH_PITCH: readonly Emotion[] = ['happy', 'surprised', 'excited', 'angry', 'playful'];
/** Low-arousal emotions: the normal take is the weakest (stage 3). */
export const LOW_AROUSAL: readonly Emotion[] = ['calm', 'sad', 'serious', 'moved'];
/** Emotions whose ending should not fall (stage 3 take selection). */
export const ENDING_LIFT: readonly Emotion[] = ['happy', 'excited', 'playful', 'angry', 'moved'];

/**
 * Template version 1 (E1b v1, acting plan appendix A; calm rewritten before release because the old
 * text sounded sick, stage 2 plan 13); every language uses the English text.
 */
export const TEMPLATES_V1: Record<Emotion, string> = {
  neutral: 'Speak in a natural, relaxed conversational tone, as if chatting with a friend.',
  happy:
    'Sound happy: smile while speaking, the voice bright and lifted, ending on an upward note.',
  sad: 'Sound sad: the voice low and heavy, a little slower, the end falling softly.',
  angry: 'Sound angry: the voice tight and firm, words clipped, pressing on the key words.',
  surprised: 'Sound surprised: the voice jumps up on the first words, quick, rising at the end.',
  anxious: 'Sound anxious: the voice a little unsteady and hesitant, unsure of itself.',
  excited:
    'Sound excited: fast and energetic, the pitch lively, keeping the energy up to the last word.',
  calm: 'Sound calm and at ease: a relaxed smile in the voice, even and steady, speaking clearly at a comfortable pace.',
  serious: 'Sound serious: firm and steady, a lower voice, deliberate pace, no smile.',
  puzzled: 'Sound puzzled: questioning and unsure, slowing down, the end rising as if asking.',
  moved: 'Sound touched and grateful: warm and soft, sincere, speaking from the heart.',
  playful: 'Sound playful: teasing and light, a mischievous smile in the voice, bouncy rhythm.',
};

/**
 * The strong wording of a template (stage 4 plan 2): "Sound very …" where the E1b experiments put
 * their power slot. Only a trained speaker's `power=strong` emotion lines use it.
 */
export const STRONG_TEMPLATES_V1: Record<Emotion, string> = Object.fromEntries(
  Object.entries(TEMPLATES_V1).map(([emo, t]) => [emo, t.replace(/^Sound /, 'Sound very ')]),
) as Record<Emotion, string>;
/** Appended to every emotion instruction: emotional prompts invite sighs and breaths (E1). */
export const CLOSE = ' Say only the words, with no sighs, breaths, laughter or other sounds.';

/** Motion an emotion brings (acting plan 4.4 order: after the character's own face motions). */
export const EMOTION_MOTION: Record<Emotion, string> = {
  neutral: 'none',
  happy: 'bounce',
  sad: 'sink',
  angry: 'shake',
  surprised: 'jump',
  anxious: 'shiver',
  excited: 'bounce',
  calm: 'none',
  serious: 'none',
  puzzled: 'head-tilt',
  moved: 'none',
  playful: 'none',
};

/** Gain on top of the loudness normalization (dB, acting plan 3.4). */
export const VOLUME_DB = { soft: -6, loud: 3 } as const;
/** `power` of voices that cannot act (persona clone, supertonic): a level change instead. */
export const POWER_DB = { weak: -2, strong: 2 } as const;

/**
 * Length of an emotion take over the same line without instruction (median per voice, mean of
 * Sohee and the trained guest; stage 2 measurement 2026-10-15, 16 lines per emotion; calm
 * re-measured with its new template, stage 2 plan 13).
 */
export const SPEED_MULTIPLIER: Record<Emotion, number> = {
  neutral: 1,
  happy: 0.998,
  sad: 1.05,
  angry: 0.951,
  surprised: 1.014,
  anxious: 1.133,
  excited: 0.993,
  calm: 1.068,
  serious: 0.985,
  puzzled: 1.171,
  moved: 1.011,
  playful: 1.062,
};

/**
 * Lowest acceptable ending (semitones against the take's median) per emotion and end mark, for
 * the take selection of stage 3: Sohee's median − 3 (same measurement). Cells with fewer than 5
 * lines take the other cell's value. Calm re-measured with its new template (stage 2 plan 13).
 */
export const ENDING_FLOOR: Record<Emotion, { question: number; other: number }> = {
  neutral: { question: -3, other: -3 },
  happy: { question: -4.87, other: -4.87 },
  sad: { question: -4.2, other: -4.2 },
  angry: { question: -3.6, other: -5.6 },
  surprised: { question: -3.08, other: -3.08 },
  anxious: { question: -1.93, other: -4.8 },
  excited: { question: -5.4, other: -5.4 },
  calm: { question: -4.65, other: -4.65 },
  serious: { question: -5.87, other: -5.87 },
  puzzled: { question: -1.85, other: -1.85 },
  moved: { question: -5.48, other: -5.48 },
  playful: { question: -2.42, other: -2.42 },
};

/**
 * Gates of new emotion takes (stage 2 plan 4.2; values from the stage 2 measurement: the strictest
 * candidate that keeps ≥ 90% of plain takes in every length band).
 */
export const GATES = {
  /** Non-speech before the first / after the last voiced frame (s). */
  edgeS: 0.35,
  /** Non-speech inside the take: max(noiseS, noisePerS × raw length). */
  noiseS: 0.75,
  noisePerS: 0.15,
  /** Raw length over the expected length. */
  length: [0.7, 1.35] as [number, number],
  /** …or within this many seconds of it. */
  lengthSlackS: 0.5,
  /** Lines shorter than this (normalized characters) skip the length gate. */
  lengthMinChars: 8,
  /** Longest quiet gap inside the raw take (s). */
  pauseS: 0.9,
} as const;

/**
 * Pitch window (semitones from the reference) of emotion lines: wider than plain lines. The
 * HIGH_PITCH ceiling is the 90th percentile of Sohee's emotion takes against her plain reference
 * (+8.2 st, stage 2 real-model check 2026-10-15; E1c's +6 rejected half of happy and excited).
 */
export const EMOTION_PITCH = { low: 4.5, high: 4.5, highPitch: 9, rising: 1 } as const;
/**
 * Similarity floor of emotion lines: max(min, the reference's lowest take − margin). Emotion takes
 * sound less like the plain reference (Sohee: 90% at ≥ 0.955, the plain floor 0.971 kept 71%).
 */
export const EMOTION_SIM = { min: 0.94, margin: 0.03 } as const;

/** Similarity floor of an emotion line for a reference whose takes scored `sims`. */
export function emotionSimFloor(sims: number[]): number {
  return Math.max(EMOTION_SIM.min, Math.min(...sims) - EMOTION_SIM.margin);
}

/** Everything above, for hashing (inspect `engine.templates`). */
export function actingTable(): unknown {
  return {
    version: ACTING_VERSION,
    templates: TEMPLATES_V1,
    strong: STRONG_TEMPLATES_V1,
    close: CLOSE,
    sets: { HIGH_PITCH, LOW_AROUSAL, ENDING_LIFT },
    motion: EMOTION_MOTION,
    volume: VOLUME_DB,
    power: POWER_DB,
    speed: SPEED_MULTIPLIER,
    ending: ENDING_FLOOR,
    gates: GATES,
    pitch: EMOTION_PITCH,
    similarity: EMOTION_SIM,
  };
}

/**
 * Engines: Qwen preset speakers, a persona as a clone of its reference, a persona as its trained
 * speaker (stage 4), Supertonic.
 */
export type Engine = 'qwen' | 'persona' | 'trained' | 'supertonic';

/** Engines that follow an instruction: emotion templates, `say` and the cast style. */
export const actsEmotion = (engine: Engine) => engine === 'qwen' || engine === 'trained';

/** Speeds Supertonic takes (the server accepts 1.05 × speed within 0.7–2.0, tts-server/server.py). */
export const SUPERTONIC_SPEED: [number, number] = [0.7 / 1.05, 2.0 / 1.05];

/** The engine of a cast voice as written in the script. */
export function engineOf(member: CastMember): Engine {
  const kind = member.voice.split(':')[0];
  if (kind === 'qwen') return 'qwen';
  if (kind === 'supertonic') return 'supertonic';
  return member.personaModel === 'trained' ? 'trained' : 'persona';
}

const userEmotion = (meta: Frontmatter, emo: string | undefined): UserEmotion | undefined =>
  emo !== undefined && Object.hasOwn(meta.acting?.emotions ?? {}, emo)
    ? meta.acting!.emotions![emo]
    : undefined;

/**
 * An emotion line: an emotion template goes into the instruction (an engine that acts, emo other
 * than neutral). Only these get the new gates and, from stage 3, several takes.
 */
export function emotionSentence(
  engine: Engine,
  acting: Acting | undefined,
  draft = false,
): boolean {
  return !draft && actsEmotion(engine) && acting?.emo !== undefined && acting.emo !== 'neutral';
}

/**
 * The instruction sent to the model: `[style] [template or user emotion voice + CLOSE] [say]`.
 * Without `emo` and `say` it is the cast style alone, as before (A3). A trained speaker's
 * `power=strong` emotion line takes the strong wording (stage 4 plan 2; the Qwen presets choose a
 * stronger take instead).
 */
export function instructFor(
  meta: Frontmatter,
  style: string | undefined,
  acting: Acting | undefined,
  engine: Engine,
): { instruct: string; template: boolean } {
  const parts: string[] = [];
  if (style) parts.push(style);
  let template = false;
  const emo = acting?.emo;
  if (emo !== undefined) {
    const user = userEmotion(meta, emo);
    const strong =
      engine === 'trained' && acting?.power === 'strong' && emotionSentence(engine, acting);
    // CLOSE is part of the acting table: a user emotion's instruction is versioned too.
    if (user) parts.push((strong ? 'Very strongly: ' : '') + user.voice.trim() + CLOSE);
    else if (isStandardEmotion(emo))
      parts.push((strong ? STRONG_TEMPLATES_V1[emo] : TEMPLATES_V1[emo]) + CLOSE);
    template = !!user || isStandardEmotion(emo);
  }
  if (acting?.say) parts.push(acting.say);
  return { instruct: parts.join(' '), template };
}

/** Tempo / speed of a line: cast × line `speed` × the user emotion's `speed`. */
export function speedProduct(
  meta: Frontmatter,
  member: CastMember,
  acting: Acting | undefined,
): number {
  return member.speed * (acting?.speed ?? 1) * (userEmotion(meta, acting?.emo)?.speed ?? 1);
}

/** Expected-length factor of a line (1 unless it is an emotion line of a standard emotion). */
export function lengthMultiplier(
  meta: Frontmatter,
  emotional: boolean,
  acting: Acting | undefined,
): number {
  if (!emotional || !acting?.emo || userEmotion(meta, acting.emo)) return 1;
  return isStandardEmotion(acting.emo) ? SPEED_MULTIPLIER[acting.emo] : 1;
}

/** Longest allowed pause of a take: the user emotion's `maxPause`, else the gate. */
export function maxPauseFor(meta: Frontmatter, acting: Acting | undefined): number {
  return userEmotion(meta, acting?.emo)?.maxPause ?? GATES.pauseS;
}

/**
 * Pitch window of an emotion line (semitones from the reference): at least as wide as the plain
 * window for the same voice (stage 2 plan 4.2).
 */
export function emotionPitchWindow(emo: string, sigma: number, text: string): [number, number] {
  const spread = 2 * sigma;
  const high = (HIGH_PITCH as readonly string[]).includes(emo)
    ? EMOTION_PITCH.highPitch
    : EMOTION_PITCH.high;
  const rising = /[?!？！]["'」』）)\s]*$/.test(text.trim()) ? EMOTION_PITCH.rising : 0;
  return [-Math.max(EMOTION_PITCH.low, spread), Math.max(high, spread) + rising];
}

/**
 * Mix gain of a line (dB): `volume`, plus `power` for voices that cannot act it (the script's
 * voice, so a draft mixes like the final). Recordings take `volume` only.
 */
export function gainFor(meta: Frontmatter, paragraph: Paragraph, sentence: Sentence): number {
  const a = sentence.acting;
  if (!a) return 0;
  let db = a.volume ? VOLUME_DB[a.volume] : 0;
  const member = meta.cast[paragraph.cast];
  // engines that act choose a take by power instead (stage 3)
  if (!paragraph.audio && a.power && member && !actsEmotion(engineOf(member)))
    db += POWER_DB[a.power];
  return db;
}

/** Faces the character can draw in a framing (null: no character information — use none). */
function drawable(member: CastMember | undefined, framing: Framing): string[] | null {
  const sets = member?.faceSets;
  if (!sets) return null;
  if ('any' in sets) return sets.any;
  return sets[framing] ?? [];
}

/** The emotion face a line asks for: the user emotion's face, else the emotion's name. */
export function emotionFace(meta: Frontmatter, emo: string | undefined): string | undefined {
  if (emo === undefined) return undefined;
  return userEmotion(meta, emo)?.face ?? emo;
}

/**
 * Face of a sentence (stage 2 plan 6.1): `wanted` = paragraph `face=` → emotion face → cast face;
 * `drawn` = the emotion face only when the character can draw it in this framing, else the cast
 * face. Casts without character information never take emotion faces.
 */
export function sentenceFace(
  meta: Frontmatter,
  paragraph: Paragraph,
  sentence: Sentence,
  framing: Framing,
): { wanted: string; drawn: string } {
  const member = meta.cast[paragraph.cast];
  const castFace = member?.face ?? 'neutral';
  if (paragraph.face) return { wanted: paragraph.face, drawn: paragraph.face };
  const emoFace = emotionFace(meta, sentence.acting?.emo);
  if (!emoFace) return { wanted: castFace, drawn: castFace };
  const can = drawable(member, framing);
  if (!can) return { wanted: castFace, drawn: castFace };
  return { wanted: emoFace, drawn: can.includes(emoFace) ? emoFace : castFace };
}

/**
 * The face a look shows (acting stage 5b plan 3): `viewer` → `front-<face>`, `glance` →
 * `glance-<face>` when the character draws it in this framing; otherwise the face itself
 * (`missing` names the variant it lacks). `partner` and casts without character information keep
 * the face. The head close-up takes looks too (closeup-look plan).
 */
export function lookFace(
  meta: Frontmatter,
  cast: string,
  face: string,
  look: LookValue,
  framing: Framing,
): { face: string; missing?: string } {
  if (look === 'partner') return { face };
  const name = `${look === 'viewer' ? 'front' : 'glance'}-${face}`;
  const can = drawable(meta.cast[cast], framing);
  if (!can) return { face };
  return can.includes(name) ? { face: name } : { face, missing: name };
}

/** The variant name a look asks for (`character missing`): what `lookFace` would like to draw. */
export function lookWanted(face: string, look: LookValue): string {
  if (look === 'partner') return face;
  return `${look === 'viewer' ? 'front' : 'glance'}-${face}`;
}

/**
 * Faces listeners may show through `:look` in a paragraph (stage 5b plan 5): each look applied to
 * the listener's default face and to its reaction faces in the paragraph — what to compose, lint
 * and list (`face`: drawn, `wanted`: the variant asked for).
 */
export function listenerLookFaces(
  meta: Frontmatter,
  paragraph: Paragraph,
  framingOf: (cast: string) => Framing,
): { cast: string; face: string; wanted: string }[] {
  const looked = new Map<string, Set<LookValue>>();
  for (const s of paragraph.sentences)
    for (const l of s.looks ?? [])
      for (const [c, v] of Object.entries(l.looks))
        if (c !== paragraph.cast) (looked.get(c) ?? looked.set(c, new Set()).get(c)!).add(v);
  const out: { cast: string; face: string; wanted: string }[] = [];
  for (const [c, values] of looked) {
    const framing = framingOf(c);
    const faces = new Set([
      meta.cast[c]?.face ?? 'neutral',
      ...paragraph.sentences.flatMap((s) =>
        (s.reacts ?? []).flatMap((r) => (r.faces[c] ? [r.faces[c]] : [])),
      ),
    ]);
    for (const v of values)
      for (const f of faces)
        out.push({
          cast: c,
          face: lookFace(meta, c, f, v, framing).face,
          wanted: lookWanted(f, v),
        });
  }
  return out;
}

/**
 * Where the speaker of a paragraph looks in each sentence (stage 5b plan 2): a `:look` on the
 * speaker at a sentence's start applies to that sentence, one inside a sentence from the next
 * sentence on; every paragraph starts at `partner`. `mid` are the lines of looks inside a
 * sentence, `dropped` those inside the last sentence (nothing to apply to).
 */
export function speakerLooks(paragraph: Paragraph): {
  looks: LookValue[];
  mid: (number | undefined)[];
  dropped: (number | undefined)[];
} {
  const looks: LookValue[] = [];
  const mid: (number | undefined)[] = [];
  const dropped: (number | undefined)[] = [];
  let state: LookValue = 'partner';
  let pending: LookValue | undefined;
  paragraph.sentences.forEach((s, si) => {
    if (pending) state = pending;
    pending = undefined;
    for (const l of s.looks ?? []) {
      const v = l.looks[paragraph.cast];
      if (!v) continue;
      if (l.at === 0) state = v;
      else {
        pending = v;
        (si === paragraph.sentences.length - 1 ? dropped : mid).push(l.line);
      }
    }
    looks.push(state);
  });
  return { looks, mid, dropped };
}

/**
 * Automatic motion of a face (stage 2 plan 6.2), after the explicit `motion=` and `motion: off`
 * have been handled by the caller: the user emotion's motion → the character's face motions (parts)
 * or the standard emotion's motion → FACE_MOTION. `undefined` = no motion.
 */
export function autoMotion(
  meta: Frontmatter,
  member: CastMember | undefined,
  face: string,
  emo: string | undefined,
): string | undefined {
  const pick = (m: string | undefined) => (m === undefined || m === 'none' ? undefined : m);
  const user = userEmotion(meta, emo);
  if (user?.motion !== undefined) return pick(user.motion);
  if (member?.faceMotions) {
    if (Object.hasOwn(member.faceMotions, face)) return pick(member.faceMotions[face]);
    return emo !== undefined && isStandardEmotion(emo) ? pick(EMOTION_MOTION[emo]) : undefined;
  }
  if (emo !== undefined && isStandardEmotion(emo)) return pick(EMOTION_MOTION[emo]);
  return FACE_MOTION[face];
}

/**
 * Faces and motion runs of a paragraph (stage 2 plan 6.2), by sentence index: a run starts at the
 * first sentence and where an inline `:emo` changes the face or the emotion (not when the
 * paragraph fixes `face=` or `motion=`). `motion` undefined = none.
 */
export function paragraphActing(
  meta: Frontmatter,
  paragraph: Paragraph,
  framing: Framing,
): {
  /** `shown`: `drawn` with the speaker's look applied (stage 5b); `wantedShown`: the look's wanted name. */
  faces: {
    wanted: string;
    drawn: string;
    shown: string;
    wantedShown: string;
    look: LookValue;
    missing?: string;
  }[];
  runs: { sentence: number; motion?: string }[];
} {
  const member = meta.cast[paragraph.cast];
  const { looks } = speakerLooks(paragraph);
  const faces = paragraph.sentences.map((s, i) => {
    const f = sentenceFace(meta, paragraph, s, framing);
    const look = looks[i]!;
    const l = lookFace(meta, paragraph.cast, f.drawn, look, framing);
    return {
      ...f,
      shown: l.face,
      wantedShown: lookWanted(f.wanted, look),
      look,
      ...(l.missing ? { missing: l.missing } : {}),
    };
  });
  const starts: { sentence: number; face: string; emo?: string }[] = [];
  paragraph.sentences.forEach((s, i) => {
    const emo = s.acting?.emo;
    const last = starts[starts.length - 1];
    const face = faces[i]!.wanted;
    if (
      !last ||
      (s.actingChange &&
        !paragraph.face &&
        !paragraph.motion &&
        (last.face !== face || last.emo !== emo))
    )
      starts.push({ sentence: i, face, ...(emo !== undefined ? { emo } : {}) });
  });
  const runs = starts.map((run, k) => {
    let motion: string | undefined;
    if (k === 0 && paragraph.motion)
      motion = paragraph.motion === 'none' ? undefined : paragraph.motion;
    else if (member?.motion === 'off') motion = undefined;
    // automatic motions only for a face the script asked for (paragraph face= or an emotion);
    // a paragraph face= fixes the face, so its motion follows that face, not the emotion
    else if (k > 0 || paragraph.face || run.emo !== undefined)
      motion = autoMotion(meta, member, run.face, paragraph.face ? undefined : run.emo);
    return { sentence: run.sentence, ...(motion ? { motion } : {}) };
  });
  return { faces, runs };
}

/** What the emotion gates read from one take (stage 2 plan 4.1; seconds, raw scale). */
export interface EmotionTakeMeasure {
  /** Normalized characters of the line (`normalizeForCer` of the TTS text). */
  chars: number;
  /** Raw take, trimmed, inside the aligned words (± margins): length and longest quiet gap. */
  rawDuration: number;
  rawPause: number;
  /** Non-speech before / after the voice and inside the take (lock wav × tempo). */
  lead: number;
  tail: number;
  noise: number;
}

/**
 * Failed emotion gates of a take (stage 2 plan 4.2). `rate`: the voice reference's speaking rate
 * (characters per second, null: no reference — the length gate is skipped); `synthSpeed`: the
 * speed the model was asked for (supertonic), 1 otherwise.
 */
export function emotionGateFailures(
  m: EmotionTakeMeasure,
  job: { multiplier: number; maxPause: number; synthSpeed: number },
  rate: number | null,
): string[] {
  const out: string[] = [];
  if (m.lead > GATES.edgeS)
    out.push(`${m.lead.toFixed(2)}s of sound before the voice (emotion line)`);
  if (m.tail > GATES.edgeS)
    out.push(`${m.tail.toFixed(2)}s of sound after the voice (emotion line)`);
  const noiseLimit = Math.max(GATES.noiseS, GATES.noisePerS * m.rawDuration);
  if (m.noise > noiseLimit)
    out.push(
      `${m.noise.toFixed(2)}s of non-speech sound in the take (breath or sigh; limit ${noiseLimit.toFixed(2)}s)`,
    );
  if (rate !== null && rate > 0 && m.chars >= GATES.lengthMinChars) {
    const expected = ((m.chars / rate) * job.multiplier) / job.synthSpeed;
    const ratio = m.rawDuration / expected;
    const [lo, hi] = GATES.length;
    if ((ratio < lo || ratio > hi) && Math.abs(m.rawDuration - expected) > GATES.lengthSlackS)
      out.push(
        `length ${m.rawDuration.toFixed(2)}s is ×${ratio.toFixed(2)} of the expected ${expected.toFixed(2)}s`,
      );
  }
  if (m.rawPause > job.maxPause)
    out.push(`a ${m.rawPause.toFixed(2)}s pause inside the line (limit ${job.maxPause}s)`);
  return out;
}
