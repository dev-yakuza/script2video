/**
 * Static budget checks (PLAN 5.4, 5.5): subtitle groups that cannot fit the per-language budget,
 * and the video length against `targetDuration` / an output's `maxDuration`.
 *
 * Length uses synthesized audio where it exists and a per-language speaking rate elsewhere, run
 * through the real timeline so pacing, pauses and `only` filters count exactly as in a render.
 */

import { emotionSentence, engineOf, lengthMultiplier, speedProduct } from './acting.js';
import { normalizeForCer } from './cer.js';
import type { Diagnostic } from './diagnostics.js';
import type { Lang, Script } from './schema.js';
import {
  buildTimeline,
  groupSubtitles,
  sentenceId,
  SUBTITLE_MAX_CHARS,
  type AudioManifest,
} from './timeline.js';
import { toTtsText } from './tts-text.js';

/**
 * Speaking rate in normalized characters per second at speed 1.0, measured on Qwen3-TTS output
 * (sentence audio including its trimmed edges; M2, 144 sentences).
 */
export const ESTIMATE_RATE: Record<Lang, number> = { ko: 5.5, ja: 6.4, en: 12.6 };
/** Allowed relative difference between the estimated length and `targetDuration`. */
export const TARGET_TOLERANCE = 0.15;

export interface TextSubtitle {
  sceneId: string;
  cast: string;
  line: number;
  text: string;
  /** The group contains (part of) a cue phrase, which is never split. */
  inCue: boolean;
}

/**
 * Subtitle groups from the text alone (no audio): spaces (ko/en) or characters (ja) stand in
 * for aligned words. Matches the timeline's grouping except where the aligner splits differently.
 * With `outputName`, only the scenes and paragraphs that output includes.
 */
export function textSubtitles(script: Script, outputName?: string): TextSubtitle[] {
  const { lang, outputs } = script.meta;
  const profile = outputName ? outputs[outputName] : undefined;
  if (outputName && !profile) throw new Error(`unknown output "${outputName}"`);
  const max = SUBTITLE_MAX_CHARS[lang];
  const out: TextSubtitle[] = [];
  for (const scene of script.scenes) {
    if (profile?.scenes && !profile.scenes.includes(scene.id)) continue;
    for (const block of scene.blocks) {
      if (block.kind !== 'paragraph') continue;
      if (outputName && block.only && !block.only.includes(outputName)) continue;
      for (const s of block.sentences) {
        const spans = [...s.text.matchAll(lang === 'ja' ? /\S/gu : /\S+/gu)].map((m) => ({
          start: m.index,
          end: m.index + m[0].length,
          t0: 0,
          t1: 0,
        }));
        for (const g of groupSubtitles(s.text, spans, lang, max, s.cues))
          out.push({
            sceneId: scene.id,
            cast: block.cast,
            line: block.line,
            text: s.text.slice(g.start, g.end).trim(),
            inCue: s.cues.some((c) => c.start < g.end && c.end > g.start),
          });
      }
    }
  }
  return out;
}

/** Lines a subtitle box shows (PLAN 5.4 budget); `s2v check` measures the real layout. */
export const SUBTITLE_MAX_LINES = 2;

/**
 * Subtitle groups that cannot fit the budget (lines × chars per line): an unbreakable word or a
 * cue phrase is too long. Slightly long groups are left to `s2v check`, which measures them.
 */
export function lintSubtitleBudget(script: Script): Diagnostic[] {
  const { lang } = script.meta;
  const max = SUBTITLE_MAX_CHARS[lang] * SUBTITLE_MAX_LINES;
  return textSubtitles(script)
    .filter((g) => [...g.text].length > max)
    .map((g) => ({
      severity: 'warning',
      code: 'subtitle-budget',
      message: `subtitle "${g.text}" is ${[...g.text].length} chars, over the ${lang} budget of ${SUBTITLE_MAX_LINES} × ${SUBTITLE_MAX_CHARS[lang]}${g.inCue ? '; shorten the cue phrase' : '; it has no place to break'}`,
      line: g.line,
    }));
}

export interface LengthEstimate {
  output: string;
  seconds: number;
  /** Sentences whose length came from synthesized audio (the rest are estimated). */
  measured: number;
  total: number;
}

/**
 * `manifest` with every missing sentence filled by an estimate from its text (no words), and how
 * many sentences had real audio. The estimate uses the cast × line × emotion speed and the emotion
 * length multiplier.
 */
export function filledManifest(
  script: Script,
  manifest: AudioManifest = {},
): { filled: AudioManifest; measured: number; total: number } {
  const { meta } = script;
  const filled: AudioManifest = {};
  let measured = 0;
  let total = 0;
  for (const scene of script.scenes)
    scene.blocks.forEach((block, bi) => {
      if (block.kind !== 'paragraph') return;
      const member = meta.cast[block.cast];
      block.sentences.forEach((s, si) => {
        const id = sentenceId(scene.id, bi, si);
        total++;
        const real = manifest[id];
        if (real) {
          measured++;
          filled[id] = real;
          return;
        }
        const chars = [...normalizeForCer(toTtsText(s.text, meta.pronounce).tts, meta.lang)].length;
        // cast × line × emotion speed; an emotion line runs longer or shorter by its multiplier
        const speed = member ? speedProduct(meta, member, s.acting) : 1;
        const emotional = !!member && !block.audio && emotionSentence(engineOf(member), s.acting);
        const factor = lengthMultiplier(meta, emotional, s.acting);
        filled[id] = {
          src: '',
          words: [],
          duration: (chars / (ESTIMATE_RATE[meta.lang] * speed)) * factor,
        };
      });
    });
  return { filled, measured, total };
}

/** Estimated length of each output. `manifest` (optional) supplies real sentence durations. */
export function estimateLengths(script: Script, manifest: AudioManifest = {}, fps = 30) {
  const { filled, measured, total } = filledManifest(script, manifest);
  return Object.keys(script.meta.outputs).map((output): LengthEstimate => {
    const { timeline } = buildTimeline(script, output, filled, fps);
    return { output, seconds: timeline.totalFrames / fps, measured, total };
  });
}

const fmt = (seconds: number) => {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function lintLength(script: Script, manifest?: AudioManifest): Diagnostic[] {
  const { meta } = script;
  const estimates = estimateLengths(script, manifest);
  const basis = (e: LengthEstimate) =>
    e.measured === e.total
      ? 'from synthesized audio'
      : e.measured === 0
        ? 'estimated'
        : `${e.measured}/${e.total} sentences synthesized, rest estimated`;
  const out: Diagnostic[] = [];
  for (const e of estimates) {
    const max = meta.outputs[e.output]!.maxDuration;
    if (max !== undefined && e.seconds > max)
      out.push({
        severity: 'warning',
        code: 'max-duration',
        message: `"${e.output}" is ${fmt(e.seconds)} (${basis(e)}), over its maxDuration ${fmt(max)}`,
      });
  }
  // targetDuration describes the full video: the first output that keeps every scene.
  const full = estimates.find((e) => !meta.outputs[e.output]!.scenes) ?? estimates[0];
  if (meta.targetDuration !== undefined && full) {
    const diff = (full.seconds - meta.targetDuration) / meta.targetDuration;
    if (Math.abs(diff) > TARGET_TOLERANCE)
      out.push({
        severity: 'warning',
        code: 'target-duration',
        message: `"${full.output}" is ${fmt(full.seconds)} (${basis(full)}), ${diff > 0 ? '+' : ''}${Math.round(diff * 100)}% from targetDuration ${fmt(meta.targetDuration)} (tolerance ±${TARGET_TOLERANCE * 100}%)`,
      });
  }
  return out;
}

/**
 * Latin-script words left in Korean / Japanese narration after the pronunciation dictionary
 * (PLAN 4.4): Qwen3-TTS reads them as English and often stumbles mid-sentence (pauses, misreads
 * that the ASR check then retries). One warning per word, with its first line.
 */
export function lintUnreadWords(script: Script): Diagnostic[] {
  const { lang, pronounce } = script.meta;
  if (lang === 'en') return [];
  const seen = new Map<string, number>();
  for (const scene of script.scenes)
    for (const b of scene.blocks)
      if (b.kind === 'paragraph')
        for (const s of b.sentences)
          for (const m of toTtsText(s.text, pronounce).tts.matchAll(/[A-Za-z][A-Za-z0-9.+#-]*/g))
            if (!seen.has(m[0])) seen.set(m[0], b.line);
  return [...seen].map(([word, line]) => ({
    severity: 'warning' as const,
    code: 'unread-word',
    message: `"${word}" is not in pronounce: the ${lang} voice reads it as English; add how it should be read (check with: s2v say "<sentence>" --script <script>)`,
    line,
  }));
}
