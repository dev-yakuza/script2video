/**
 * Files for publishing next to the video (PLAN 5.11): SRT / VTT subtitles, YouTube chapters and a
 * description draft. All are derived from the same timeline as the rendered frames.
 */

import type { Diagnostic } from './diagnostics.js';
import { bgmOf, type Lang, type Script } from './schema.js';
import type { Timeline } from './timeline.js';

export interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

/**
 * Subtitle cues in seconds. With two or more speakers each cue starts with the speaker's name
 * (`Mina: 오!`); overlapping lines stay overlapping, as on screen.
 */
export function subtitleCues(script: Script, timeline: Timeline): SubtitleCue[] {
  const speakers = new Set(timeline.scenes.flatMap((s) => s.subtitles.map((x) => x.cast)));
  const named = speakers.size >= 2;
  const cues: SubtitleCue[] = [];
  for (const scene of timeline.scenes)
    for (const s of scene.subtitles) {
      const name = script.meta.cast[s.cast]?.name ?? s.cast;
      cues.push({
        start: (scene.startFrame + s.startFrame) / timeline.fps,
        end: (scene.startFrame + s.endFrame) / timeline.fps,
        text: named ? `${name}: ${s.text}` : s.text,
      });
    }
  return cues.sort((a, b) => a.start - b.start);
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function clock(seconds: number, sep: ',' | '.'): string {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${clock(c.start, ',')} --> ${clock(c.end, ',')}\n${c.text}\n`)
    .join('\n');
}

export function toVtt(cues: SubtitleCue[]): string {
  return `WEBVTT\n\n${cues
    .map((c) => `${clock(c.start, '.')} --> ${clock(c.end, '.')}\n${c.text}\n`)
    .join('\n')}`;
}

/** YouTube's chapter rules: first at 0:00, at least 3, each at least 10 s long. */
export const CHAPTER_MIN_S = 10;
export const CHAPTER_MIN_COUNT = 3;

export interface Chapter {
  start: number;
  title: string;
}

/** `m:ss`, or `h:mm:ss` from one hour on (YouTube's timestamp format). */
export function timestamp(seconds: number): string {
  const t = Math.floor(seconds);
  const h = Math.floor(t / 3600);
  const m = Math.floor(t / 60) % 60;
  const s = t % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * One chapter per scene. A scene shorter than 10 s joins the chapter before it (the first one
 * joins the next, which then starts at 0:00). Fewer than 3 chapters after that: none, with a
 * warning.
 */
export function chapters(timeline: Timeline): { chapters: Chapter[]; diagnostics: Diagnostic[] } {
  const fps = timeline.fps;
  const items = timeline.scenes.map((s) => ({
    start: s.startFrame / fps,
    end: (s.startFrame + s.durationFrames) / fps,
    title: s.title,
  }));
  const merged: typeof items = [];
  for (const it of items) {
    const prev = merged[merged.length - 1];
    if (prev && it.end - it.start < CHAPTER_MIN_S) prev.end = it.end;
    else merged.push({ ...it });
  }
  // A short first chapter joins the next one, which then starts at 0:00.
  if (merged.length > 1 && merged[0]!.end - merged[0]!.start < CHAPTER_MIN_S) merged.shift();
  if (merged.length > 0) merged[0]!.start = 0;
  if (merged.length < CHAPTER_MIN_COUNT)
    return {
      chapters: [],
      diagnostics: [
        {
          severity: 'warning',
          code: 'chapters',
          message: `only ${merged.length} chapter(s) of ${CHAPTER_MIN_S}+ s; YouTube needs ${CHAPTER_MIN_COUNT}, so no chapters were written`,
        },
      ],
    };
  return { chapters: merged.map(({ start, title }) => ({ start, title })), diagnostics: [] };
}

export function chaptersText(list: Chapter[]): string {
  return list.map((c) => `${timestamp(c.start)} ${c.title}`).join('\n') + (list.length ? '\n' : '');
}

const SUPERTONIC_NOTICE: Record<Lang, string> = {
  ko: '이 영상의 음성 일부는 기계(Supertonic-3 음성 합성)로 생성되었습니다.',
  ja: 'この動画の音声の一部は機械（Supertonic-3 音声合成）で生成されています。',
  en: 'Some of the voices in this video are machine-generated (Supertonic-3 speech synthesis).',
};

const AI_NARRATION: Record<Lang, string> = {
  ko: '내레이션은 AI 음성 합성으로 만들었습니다.',
  ja: 'ナレーションは AI 音声合成で作成しています。',
  en: 'Narration is generated with AI speech synthesis.',
};

const BGM_LABEL: Record<Lang, string> = { ko: '배경음악', ja: 'BGM', en: 'Music' };

const CHAPTER_HEADING: Record<Lang, string> = { ko: '목차', ja: '目次', en: 'Chapters' };

/** Cast members whose final voice is Supertonic (its weights' license requires a notice). */
export function supertonicCast(script: Script): string[] {
  return Object.entries(script.meta.cast)
    .filter(([, m]) => m.voice.startsWith('supertonic:'))
    .map(([k]) => k);
}

/** Description draft: title, chapters, and the notices the voices require. */
export function descriptionDraft(
  script: Script,
  list: Chapter[],
  opts: { draft?: boolean } = {},
): string {
  const { meta } = script;
  const lang = meta.lang;
  const usesSupertonic = opts.draft || supertonicCast(script).length > 0;
  const lines = [`# ${meta.title ?? script.scenes[0]?.title ?? ''}`, ''];
  if (list.length > 0) lines.push(`${CHAPTER_HEADING[lang]}`, chaptersText(list).trimEnd(), '');
  lines.push('---', AI_NARRATION[lang]);
  const bgm = bgmOf(meta);
  if (bgm?.credit) lines.push(`${BGM_LABEL[lang]}: ${bgm.credit}`);
  if (usesSupertonic) lines.push(SUPERTONIC_NOTICE[lang]);
  return `${lines.join('\n')}\n`;
}
