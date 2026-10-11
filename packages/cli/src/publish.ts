/** Writes the publishing files next to a rendered video (PLAN 5.11). */

import { execFile } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { renderStills, type RenderOptions } from '@script2video/renderer-remotion';
import {
  chapters,
  chaptersText,
  descriptionDraft,
  formatDiagnostic,
  subtitleCues,
  toSrt,
  toVtt,
  type Script,
  type Timeline,
} from '@script2video/core';

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
  const cues = subtitleCues(script, timeline);
  const written = [`${base}.srt`, `${base}.vtt`];
  writeFileSync(`${base}.srt`, toSrt(cues));
  writeFileSync(`${base}.vtt`, toVtt(cues));
  const ch = withChapters ? chapters(timeline) : { chapters: [], diagnostics: [] };
  for (const d of ch.diagnostics) log(formatDiagnostic(d, base));
  if (ch.chapters.length > 0) {
    writeFileSync(`${base}.chapters.txt`, chaptersText(ch.chapters));
    written.push(`${base}.chapters.txt`);
  }
  writeFileSync(`${base}.description.md`, descriptionDraft(script, ch.chapters, { draft }));
  written.push(`${base}.description.md`);
  return written;
}

const run = promisify(execFile);

/**
 * YouTube thumbnail (1280×720) for 16:9 outputs: the script's `::thumbnail{src=...}` image
 * (scaled and letterboxed), otherwise a still of the first scene's middle (usually the title
 * card), rendered by the same components.
 */
export async function writeThumbnail(
  script: Script,
  scriptDir: string,
  opts: RenderOptions,
  out: string,
): Promise<string> {
  const thumb = script.scenes
    .flatMap((s) => s.blocks)
    .find((b) => b.kind === 'visual' && b.type === 'thumbnail');
  const fit =
    'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=0x111827';
  if (thumb && thumb.kind === 'visual' && thumb.attrs.src) {
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      resolve(scriptDir, thumb.attrs.src),
      '-vf',
      fit,
      out,
    ]);
    return out;
  }
  const first = opts.timeline.scenes[0]!;
  const dir = join(opts.workDir, 'thumbnail');
  mkdirSync(dir, { recursive: true });
  const still = join(dir, 'still.png');
  // No subtitles on a thumbnail.
  const timeline = {
    ...opts.timeline,
    scenes: opts.timeline.scenes.map((sc) => (sc === first ? { ...sc, subtitles: [] } : sc)),
  };
  await renderStills({ ...opts, timeline, scale: 1 }, [
    { sceneId: first.id, frame: Math.floor(first.durationFrames / 2), output: still },
  ]);
  await run('ffmpeg', ['-v', 'error', '-y', '-i', still, '-vf', fit, `${out}.tmp.png`]);
  renameSync(`${out}.tmp.png`, out);
  return out;
}
