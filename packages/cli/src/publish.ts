/** Writes the publishing files next to a rendered video (PLAN 5.11). */

import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { FADE_FRAMES, renderStills, type RenderOptions } from '@script2video/renderer-remotion';
import {
  chapters,
  chaptersText,
  characterModeFor,
  descriptionDraft,
  formatDiagnostic,
  sceneHasVisual,
  subtitleCues,
  toSrt,
  toVtt,
  type Script,
  type Timeline,
} from '@script2video/core';

/** `<base>.srt` and `.vtt` (a `--scenes` clip writes these only, S11). */
export function writeSubtitleFiles(script: Script, timeline: Timeline, base: string): string[] {
  const cues = subtitleCues(script, timeline);
  writeFileSync(`${base}.srt`, toSrt(cues));
  writeFileSync(`${base}.vtt`, toVtt(cues));
  return [`${base}.srt`, `${base}.vtt`];
}

/** `<base>.srt`, `.vtt`, `.chapters.txt` (when YouTube's rules allow), `.description.md`. */
export function writePublishFiles(
  script: Script,
  timeline: Timeline,
  base: string,
  draft: boolean,
  log: (m: string) => void,
  /** Chapters only for 16:9 outputs (Shorts have none). */
  withChapters = true,
): string[] {
  const written = writeSubtitleFiles(script, timeline, base);
  const ch = withChapters ? chapters(timeline) : { chapters: [], diagnostics: [] };
  for (const d of ch.diagnostics) log(formatDiagnostic(d, base));
  if (ch.chapters.length > 0) {
    writeFileSync(`${base}.chapters.txt`, chaptersText(ch.chapters));
    written.push(`${base}.chapters.txt`);
  } else rmSync(`${base}.chapters.txt`, { force: true }); // not last run's (S2: the exact set)
  writeFileSync(`${base}.description.md`, descriptionDraft(script, ch.chapters, { draft }));
  written.push(`${base}.description.md`);
  return written;
}

/**
 * A render that makes no thumbnail (vertical output, draft) leaves none from an earlier run under
 * its name (S2: a render's results are exactly this run's).
 */
export function dropThumbnail(path: string): void {
  rmSync(path, { force: true });
}

const run = promisify(execFile);

/**
 * The still a thumbnail without `::thumbnail` is taken from (pilot-1 P1): the first scene that
 * shows a visual, in the middle of that visual's span (the scene's middle with characters, who
 * are on screen throughout). Kept out of fades like `snapshot`'s stills; scene 0's middle when no
 * scene shows anything. Each visual's span is judged on its own, so a scene the `no-visual` lint
 * flags for an empty first `::title` can still give its later image.
 */
export function thumbnailTarget(
  timeline: Timeline,
  characterMode: boolean,
  transition: 'none' | 'fade' = 'none',
): { sceneId: string; frame: number } {
  for (const scene of timeline.scenes) {
    const dur = scene.durationFrames;
    // Visual i shows from its start (the first from frame 0) until the next one starts.
    const spans = scene.visuals.map((v, i) => ({
      v: v.visual,
      from: i === 0 ? 0 : v.startFrame,
      to: scene.visuals[i + 1]?.startFrame ?? dur,
    }));
    const span = characterMode
      ? { from: 0, to: dur }
      : spans.find((s) => sceneHasVisual([s.v], false));
    if (!span) continue;
    const mid = Math.floor((span.from + span.to) / 2);
    const fade = transition === 'fade' ? FADE_FRAMES : 0;
    const lo = Math.max(span.from, fade);
    const hi = Math.min(span.to - 1, dur - 1 - fade);
    // a span too short to clear the fades keeps its middle
    return { sceneId: scene.id, frame: lo <= hi ? Math.min(hi, Math.max(lo, mid)) : mid };
  }
  const first = timeline.scenes[0]!;
  return { sceneId: first.id, frame: Math.floor(first.durationFrames / 2) };
}

/**
 * YouTube thumbnail (1280×720) for 16:9 outputs: the script's `::thumbnail{src=...}` image
 * (scaled and letterboxed), otherwise a still at `thumbnailTarget` (usually the title card),
 * rendered by the same components.
 */
export async function writeThumbnail(
  script: Script,
  scriptDir: string,
  opts: RenderOptions,
  out: string,
  /** The PROXY band (S13): a png and where it goes on the 1280×720 thumbnail. */
  mark?: { png: string; x: number; y: number },
): Promise<string> {
  rmSync(out, { force: true }); // a failed thumbnail does not leave last run's (S2)
  const thumb = script.scenes
    .flatMap((s) => s.blocks)
    .find((b) => b.kind === 'visual' && b.type === 'thumbnail');
  const fit =
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x111827';
  if (thumb && thumb.kind === 'visual' && thumb.attrs.src) {
    await fitThumbnail(resolve(scriptDir, thumb.attrs.src), out, fit, mark);
    return out;
  }
  // The still renders with opts.transition (render passes none: no fades are drawn), so the fade
  // clamp only matters for a caller that passes `transition: 'fade'`.
  const target = thumbnailTarget(
    opts.timeline,
    characterModeFor(script, opts.timeline.output),
    opts.transition,
  );
  const dir = join(opts.workDir, 'thumbnail');
  mkdirSync(dir, { recursive: true });
  const still = join(dir, 'still.png');
  // No subtitles on a thumbnail.
  const timeline = {
    ...opts.timeline,
    scenes: opts.timeline.scenes.map((sc) =>
      sc.id === target.sceneId ? { ...sc, subtitles: [] } : sc,
    ),
  };
  await renderStills({ ...opts, timeline, scale: 1 }, [{ ...target, output: still }]);
  await fitThumbnail(still, out, fit, mark);
  return out;
}

/** One image fitted to 1280×720 (and marked, S13), written beside and moved in place. */
async function fitThumbnail(
  input: string,
  out: string,
  fit: string,
  mark?: { png: string; x: number; y: number },
): Promise<void> {
  const tmp = `${out}.tmp.png`;
  const args = mark
    ? [
        '-i',
        input,
        '-i',
        mark.png,
        '-filter_complex',
        `[0:v]${fit}[b];[b][1:v]overlay=x=${mark.x}:y=${mark.y}:format=auto,format=rgb24`,
        '-frames:v',
        '1',
      ]
    : ['-i', input, '-vf', fit];
  try {
    await run('ffmpeg', ['-v', 'error', '-y', ...args, tmp]);
    renameSync(tmp, out);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}
