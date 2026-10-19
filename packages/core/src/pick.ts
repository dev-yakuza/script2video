/**
 * `render --scenes` (S11): some scenes of one output, as if its frontmatter `scenes` named them.
 * The picked copy differs from the script in that one output's `scenes` only, so the timeline,
 * the stage, rhythm and lint all follow it. `pickDrift` names what the cut changes on screen.
 */

import { SCENE_ID_CHARS, type Framing, type OutputProfile, type Script } from './schema.js';
import { castsIn, outputScenes, stageEvents, type Side } from './stage.js';
import { sceneFramings } from './timeline.js';

/** One scene id as given on the command line. */
export const SCENE_ID = new RegExp(`^${SCENE_ID_CHARS}$`);

export type PickResult =
  | { ok: true; script: Script; ids: string[] }
  | { ok: false; code: 'unknown-scene' | 'not-in-output'; message: string };

/**
 * The script with `outputs.<output>.scenes` set to `ids` (in script order). Scenes and blocks are
 * shared, not copied. Every id must be a scene of the script and of the output.
 */
export function pickScenes(script: Script, output: string, ids: readonly string[]): PickResult {
  const profile = script.meta.outputs[output];
  if (!profile) throw new Error(`unknown output "${output}"`);
  const all = script.scenes.map((s) => s.id);
  for (const id of ids)
    if (!all.includes(id))
      return {
        ok: false,
        code: 'unknown-scene',
        message: `--scenes: no scene "${id}" in this script (scenes: ${all.join(', ')})`,
      };
  if (profile.scenes)
    for (const id of ids)
      if (!profile.scenes.includes(id))
        return {
          ok: false,
          code: 'not-in-output',
          message: `--scenes: scene "${id}" is not in output "${output}" (outputs.${output}.scenes: ${profile.scenes.join(', ')})`,
        };
  const wanted = new Set(ids);
  const ordered = all.filter((id) => wanted.has(id));
  return {
    ok: true,
    ids: ordered,
    script: {
      ...script,
      meta: {
        ...script.meta,
        outputs: { ...script.meta.outputs, [output]: { ...profile, scenes: ordered } },
      },
    },
  };
}

export type Drift =
  | { kind: 'framing'; scene: string; cast: string; here: Framing; full: Framing }
  | { kind: 'side'; cast: string; here: Side; full: Side }
  | { kind: 'full-not-character' };

/**
 * Where the picked scenes draw a character otherwise than the full output does: framings
 * inherited from scenes left out, and sides set by who speaks. Characters only (avatars stand
 * nowhere a viewer would audition); when the full output draws no characters, one entry says so.
 */
export function pickDrift(full: Script, picked: Script, output: string): Drift[] {
  const here = stageEvents(picked, output);
  if (!here.characterMode) return [];
  const whole = stageEvents(full, output);
  if (!whole.characterMode) return [{ kind: 'full-not-character' }];
  const profile = picked.meta.outputs[output] as OutputProfile;
  const fullScenes = outputScenes(full, output);
  const fullFramings = new Map(
    sceneFramings(full.meta, fullScenes, profile).map((f, i) => [fullScenes[i]!.id, f]),
  );
  const pickedScenes = outputScenes(picked, output);
  const pickedFramings = sceneFramings(picked.meta, pickedScenes, profile);
  const out: Drift[] = [];
  const seen = new Set<string>();
  pickedScenes.forEach((scene, i) => {
    const cast = castsIn([scene]);
    for (const key of Object.keys(picked.meta.cast)) {
      if (!cast.has(key)) continue;
      const a = pickedFramings[i]![key] ?? 'full';
      const b = fullFramings.get(scene.id)?.[key] ?? 'full';
      if (a !== b) out.push({ kind: 'framing', scene: scene.id, cast: key, here: a, full: b });
      seen.add(key);
    }
  });
  for (const key of Object.keys(picked.meta.cast)) {
    if (!seen.has(key)) continue;
    const a = here.side[key];
    const b = whole.side[key];
    if (a && b && a !== b) out.push({ kind: 'side', cast: key, here: a, full: b });
  }
  return out;
}

/** One warning line per drift. */
export function driftMessage(d: Drift, output: string): string {
  if (d.kind === 'full-not-character')
    return `--scenes: the full video draws no characters for "${output}"`;
  if (d.kind === 'framing')
    return `--scenes: in "${d.scene}" ${d.cast} is ${d.here} here but ${d.full} in the full video`;
  return `--scenes: ${d.cast} stands ${d.here} here but ${d.full} in the full video`;
}
