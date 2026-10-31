/**
 * Scenes with nothing on screen (pilot-1 P1): a scene that speaks over the bare background is
 * valid, so this is a warning. The same predicate picks the thumbnail scene (cli publish.ts).
 */

import type { Diagnostic } from './diagnostics.js';
import type { Script, Visual } from './schema.js';
import { castsIn, outputScenes } from './stage.js';

/**
 * Whether an output draws characters: every cast member who speaks or reacts in it has character
 * art (the renderer's `dialogueShape`). The presenter is then the picture of every scene.
 */
export function characterModeFor(script: Script, output: string): boolean {
  const cast = [...castsIn(outputScenes(script, output))];
  return cast.length > 0 && cast.every((k) => !!script.meta.cast[k]?.character);
}

/**
 * Whether a scene shows something besides the background from its start. The first visual is drawn
 * from frame 0 and each lasts until the next one, so the first is what decides. `::thumbnail` is
 * not drawn; a `::title` without a label is an empty card (the narration under it shows nothing).
 */
export function sceneHasVisual(visuals: Visual[], characterMode: boolean): boolean {
  if (characterMode) return true;
  const first = visuals.find((v) => v.type !== 'thumbnail');
  return !!first && !(first.type === 'title' && !first.label?.trim());
}

/** `no-visual`: per output, each scene with narration that shows only the background. */
export function lintVisuals(script: Script): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const name of Object.keys(script.meta.outputs)) {
    const characterMode = characterModeFor(script, name);
    for (const scene of outputScenes(script, name)) {
      if (!scene.blocks.some((b) => b.kind === 'paragraph')) continue;
      const visuals = scene.blocks.filter((b): b is Visual => b.kind === 'visual');
      if (sceneHasVisual(visuals, characterMode)) continue;
      out.push({
        severity: 'warning',
        code: 'no-visual',
        message: `output "${name}" scene ${scene.id}: no visual — the frame shows only the background; add ::title[…], a text card (:::bullets/:::quote/…) or an image`,
        line: scene.line,
      });
    }
  }
  return out;
}
