/**
 * Rhythm (acting stage 5d plan): paragraph gaps that follow the content. A quick answer after a
 * question, a breath where the emotion changes, a pause after a sad, moved or serious paragraph,
 * and a little jitter. On by default (the user's choice after E5d; `acting.rhythm: false` keeps the
 * old even gaps). Judged on the script alone (no audio), so the length lint and a render agree.
 */

import { isQuestion, textKey, unitHash } from './keys.js';
import type { Paragraph, Script } from './schema.js';
import { includesParagraph, selectScenes } from './stage.js';

/** Default gap factors (acting plan 4.3); a script may set its own (`acting.rhythm: {…}`). */
export const RHYTHM: RhythmValues = { answer: 0.6, emotion: 1.3, linger: 1.4, jitter: 0.12 };

export interface RhythmValues {
  answer: number;
  emotion: number;
  linger: number;
  jitter: number;
}
const LINGER: ReadonlySet<string> = new Set(['sad', 'moved', 'serious']);

export type RhythmRule = 'question' | 'emotion' | 'linger' | 'jitter' | 'explicit';

export interface RhythmGap {
  sceneId: string;
  /** The paragraph after the gap. */
  paragraph: Paragraph;
  line: number;
  rules: RhythmRule[];
  /** Multiplies the paragraph gap (1 for an explicit `gap=`, which stays as written). */
  factor: number;
}

/**
 * An output's rhythm: on unless turned off (the override, else the output's `rhythm`, else
 * `acting.rhythm`; an object means on), and its factors (defaults ← acting object ← output object).
 */
export function resolveRhythm(
  script: Script,
  output: string,
  override?: boolean,
): { on: boolean; values: RhythmValues } {
  const top = script.meta.acting?.rhythm;
  const own = script.meta.outputs[output]?.rhythm;
  const flag = (r: typeof top) => (r === undefined ? undefined : r !== false);
  const on = override ?? flag(own) ?? flag(top) ?? true;
  const values = {
    ...RHYTHM,
    ...(typeof top === 'object' ? top : {}),
    ...(typeof own === 'object' ? own : {}),
  };
  return { on, values };
}

/** Whether an output uses rhythm (see `resolveRhythm`). */
export function rhythmOn(script: Script, output: string, override?: boolean): boolean {
  return resolveRhythm(script, output, override).on;
}

/** A paragraph's emotion: its first sentence's (the prefix, or a leading inline `:emo`). */
const emotionOf = (p: Paragraph) => p.sentences[0]?.acting?.emo ?? 'neutral';

/**
 * The gap before every included paragraph of the output but each scene's first, in order. The
 * jitter seed is the next paragraph's first sentence and how many times the output has said it
 * before (every included paragraph counts), so adding or removing `gap=` moves no other gap.
 */
export function rhythmGaps(script: Script, output: string): RhythmGap[] {
  const profile = script.meta.outputs[output];
  const f = resolveRhythm(script, output).values;
  if (!profile) throw new Error(`unknown output "${output}"`);
  const seen = new Map<string, number>();
  const out: RhythmGap[] = [];
  for (const scene of selectScenes(script, profile)) {
    let prev: Paragraph | null = null;
    for (const b of scene.blocks) {
      if (b.kind !== 'paragraph' || !includesParagraph(b, output)) continue;
      const first = b.sentences[0];
      const key = textKey(b.cast, first?.text ?? '');
      const ordinal = seen.get(key) ?? 0;
      seen.set(key, ordinal + 1);
      if (prev) {
        const rules: RhythmRule[] = [];
        let factor = 1;
        if (b.gap !== undefined) rules.push('explicit');
        else {
          const last = prev.sentences[prev.sentences.length - 1];
          if (last && isQuestion(last.text) && b.cast !== prev.cast) {
            rules.push('question');
            factor *= f.answer;
          }
          if (emotionOf(b) !== emotionOf(prev)) {
            rules.push('emotion');
            factor *= f.emotion;
          }
          if (LINGER.has(emotionOf(prev))) {
            rules.push('linger');
            factor *= f.linger;
          }
          if (f.jitter > 0) rules.push('jitter');
          factor *= 1 + f.jitter * (2 * unitHash('rhythm', key, ordinal, output) - 1);
        }
        out.push({ sceneId: scene.id, paragraph: b, line: b.line, rules, factor });
      }
      prev = b;
    }
  }
  return out;
}
