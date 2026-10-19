/**
 * `render --scenes` (S11 plan 3.4): the per-output lint again on the picked copy, before any
 * synthesis, so a framing the cut changes fails here and not in the renderer.
 */
import { lintActing, type Diagnostic, type Script } from '@script2video/core';
import { lintAssets, lintCast, lintImageFormats } from './lint-assets.js';

/** The lint whose results depend on an output's scenes. */
function outputLint(script: Script, scriptDir: string): Diagnostic[] {
  return [
    ...lintAssets(script, scriptDir),
    ...lintImageFormats(script, scriptDir),
    ...lintCast(script, scriptDir),
    ...lintActing(script),
  ];
}

const keyOf = (d: Diagnostic) => JSON.stringify([d.severity, d.code, d.message, d.line ?? null]);

/** Diagnostics of the picked copy that the full script's run (`fullDiags`) did not have. */
export function scenesLint(
  picked: Script,
  scriptDir: string,
  fullDiags: Diagnostic[],
): Diagnostic[] {
  const known = new Set(fullDiags.map(keyOf));
  const out: Diagnostic[] = [];
  for (const d of outputLint(picked, scriptDir)) {
    const k = keyOf(d);
    if (known.has(k)) continue;
    known.add(k);
    out.push(d);
  }
  return out;
}

/** Sentences of the output's paragraphs in the picked copy (none: a silent clip). */
export function spokenIn(picked: Script, output: string): number {
  const wanted = picked.meta.outputs[output]?.scenes;
  let n = 0;
  for (const s of picked.scenes) {
    if (wanted && !wanted.includes(s.id)) continue;
    for (const b of s.blocks)
      if (b.kind === 'paragraph' && (!b.only || b.only.includes(output))) n += b.sentences.length;
  }
  return n;
}
