/**
 * `s2v import-recording <script> <recording> [--write]` (PLAN 5.3): one take of the whole script
 * → one file per paragraph (`rec/<scene>-<n>.wav`, as `export-script` names them).
 *
 * Paragraphs are found in order: each is aligned inside a window a little longer than its
 * expected length, starting where the previous one ended; the speaking rate measured so far
 * sizes the next window. Files are cut halfway through the gaps. With `--write`, `:audio{...}`
 * is added to each paragraph of the script (the only change made to the script).
 */

import { copyFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  ESTIMATE_RATE,
  normalizeForCer,
  toAlignText,
  type AlignedWord,
  type Script,
} from '@script2video/core';
import { cropFile } from './pauses.js';
import { paragraphCuts, type ParagraphSpan } from './recording.js';
import { ALIGNER, Service } from './services.js';
import { postprocess, wavDuration } from './tts.js';

const MAX_WINDOW_S = 175; // the aligner takes at most 180 s

export async function importRecording(
  scriptPath: string,
  script: Script,
  recording: string,
  repoRoot: string,
  opts: { write: boolean; log: (m: string) => void },
): Promise<string[]> {
  const { meta } = script;
  const paras = script.scenes.flatMap((scene) =>
    scene.blocks.flatMap((b, bi) =>
      b.kind === 'paragraph'
        ? [
            {
              scene: scene.id,
              bi,
              line: b.line,
              text: b.sentences
                .map((s) => toAlignText(s.text, meta.pronounce, meta.lang).tts)
                .join(' '),
            },
          ]
        : [],
    ),
  );
  const dir = join(dirname(scriptPath), 'rec');
  mkdirSync(dir, { recursive: true });
  const whole = join(dir, '.whole.wav');
  await postprocess(recording, whole, null);
  const duration = wavDuration(whole);

  const aligner = new Service(ALIGNER, repoRoot);
  await aligner.ensure();
  const spans: ParagraphSpan[] = [];
  try {
    let t = 0;
    let rate = ESTIMATE_RATE[meta.lang];
    for (const [k, p] of paras.entries()) {
      const chars = [...normalizeForCer(p.text, meta.lang)].length;
      const end = Math.min(duration, t + Math.min(MAX_WINDOW_S, (chars / rate) * 1.5 + 4));
      const win = join(dir, '.window.wav');
      copyFileSync(whole, win);
      cropFile(win, t, end);
      const { data } = await aligner.post<{ words: AlignedWord[] }>('/align', {
        wav_path: win,
        text: p.text,
        lang: meta.lang,
      });
      unlinkSync(win);
      if (data.words.length === 0)
        throw new Error(`paragraph ${k + 1} (${p.scene}) not found after ${t.toFixed(1)} s`);
      const first = t + data.words[0]!.start;
      const last = t + data.words[data.words.length - 1]!.end;
      spans.push({ first, last });
      opts.log(`  ${p.scene}-${p.bi}: ${first.toFixed(2)}–${last.toFixed(2)} s`);
      // Running speaking rate (chars per second of speech) sizes the next window.
      const measured = chars / Math.max(0.5, last - first);
      rate = k === 0 ? measured : rate * 0.6 + measured * 0.4;
      t = last;
    }
  } finally {
    aligner.stop();
  }

  const files: string[] = [];
  for (const [k, cut] of paragraphCuts(spans, duration).entries()) {
    const p = paras[k]!;
    const rel = `rec/${p.scene}-${p.bi}.wav`;
    copyFileSync(whole, join(dirname(scriptPath), rel));
    cropFile(join(dirname(scriptPath), rel), cut.from, cut.to);
    files.push(rel);
  }
  unlinkSync(whole);

  if (opts.write) {
    // Add :audio{src=...} at the start of each paragraph's first line (skip ones that have it).
    const lines = readFileSync(scriptPath, 'utf8').split('\n');
    for (const [k, p] of paras.entries()) {
      const i = p.line - 1;
      const l = lines[i] ?? '';
      if (l.includes(':audio{')) continue;
      const m = /^([A-Za-z_][\w-]*(\{[^}]*\})?:\s*)?/.exec(l)!;
      lines[i] = `${m[0]}:audio{src=${files[k]}}${l.slice(m[0].length)}`;
    }
    writeFileSync(scriptPath, lines.join('\n'));
  }
  return files;
}
