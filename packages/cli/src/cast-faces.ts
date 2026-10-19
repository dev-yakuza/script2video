/**
 * What a cast member's character can draw, put into the parsed script's meta (internal fields):
 *
 *   faceMotions  face → motion of a parts character (plan C6)
 *   faceSets     emotion faces the character can really draw, per framing (acting stage 2 plan 6.1)
 *
 * Every path that reads faces (lint, tts, check, timeline, render, inspect, character missing)
 * calls `enrichCast`, so they all agree on which face a line shows. It never throws: a broken
 * character simply gets no field and the lint reports what is wrong.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EMOTIONS, type CastMember, type Framing, type Script } from '@script2video/core';
import {
  characterFaces,
  characterSource,
  faceMotions,
  FaceError,
  IMPORTED_PARTS,
  loadCharacterSpec,
  resolveFace,
  type CharacterSpec,
  type LayeredSpec,
} from '@script2video/renderer-remotion';

const FRAMINGS: Framing[] = ['full', 'upper', 'head'];

export function characterDir(scriptDir: string, member: CastMember): string | null {
  if (!member.character) return null;
  return resolve(
    scriptDir,
    typeof member.character === 'string' ? member.character : member.character.dir,
  );
}

/**
 * Problems of one parts face in one framing, on both sides (lint-assets reports them; an emotion
 * face is drawable only when there are none). `files`: the images whose sizes lint compares.
 */
export function partsFaceProblems(
  dir: string,
  spec: LayeredSpec,
  framing: Framing,
  face: string,
  speaking: boolean,
): { problems: Map<string, string[]>; files: string[]; optional: string[] } {
  const problems = new Map<string, string[]>();
  const files: string[] = [];
  const optional: string[] = [];
  for (const side of ['left', 'right'] as const) {
    try {
      const r = resolveFace(dir, spec, framing, face, side, [1, 1]);
      const required = [...r.head.states.closed, ...(r.body ? [r.body.file] : [])];
      optional.push(
        ...[
          r.head.states.talk.at(-1)!,
          r.head.states.half.at(-1)!,
          r.head.states.blink.at(-1)!,
          ...(r.front ? [r.front.file] : []),
        ].filter((f) => existsSync(f)),
      );
      const fm = spec.faces[face]?.motion ?? spec.expressions[spec.faces[face]!.expression]?.motion;
      if (r.pivot === null && (fm === 'head-nod' || fm === 'head-tilt'))
        problems.set(
          `face "${face}" has ${fm}, but no head layer in ${framing}: it plays as ${fm === 'head-nod' ? 'nod' : 'lean'} (whole body)`,
          ['warn'],
        );
      if (r.body && r.body.flip !== r.head.flip && spec.mirror)
        problems.set(
          `face "${face}" flips only the ${r.head.flip ? 'head' : 'body'} on the ${side} side: asymmetric details (a hair clip) switch sides there`,
          ['warn'],
        );
      if (speaking && !existsSync(r.head.states.talk.at(-1)!))
        problems.set(`face "${face}" is used for speaking but has no mouth frames (${framing})`, [
          'warn',
          'no-talk',
        ]);
      for (const file of required) {
        if (!existsSync(file))
          problems.set(`${file.slice(dir.length + 1)} is missing (face "${face}", ${framing})`, []);
        else files.push(file);
      }
    } catch (e) {
      if (!(e instanceof FaceError)) throw e;
      const msg = `${e.message} (${framing})`;
      problems.set(msg, [...(problems.get(msg) ?? []), side]);
    }
  }
  return { problems, files, optional };
}

/** Selection keys of imported YMM4 faces (folders; 後 / 他 take slots 1–3). */
export const YMM4_SLOTS = [
  '後',
  '後1',
  '後2',
  '後3',
  '体',
  '顔色',
  '髪',
  '口',
  '目',
  '眉',
  '他',
  '他1',
  '他2',
  '他3',
];

/** The part files an imported face draws: (YMM4 folder, path), its own over neutral's. */
export function importedFaceFiles(
  dir: string,
  spec: CharacterSpec,
  face: string,
): [string, string][] {
  if (!spec.faces[face]) return [];
  const pick = { ...spec.faces.neutral, ...spec.faces[face] } as Record<string, string>;
  const parts = join(dir, IMPORTED_PARTS);
  return Object.entries(pick).map(([folder, stem]) => [
    folder,
    join(parts, folder.replace(/[123]$/, ''), `${stem}.png`),
  ]);
}

/**
 * Problems of an imported (YMM4) face: part folders that are not YMM4 slots and missing part
 * files (as lint reports them), or null when the face is not defined.
 */
export function importedFaceProblems(
  dir: string,
  spec: CharacterSpec,
  face: string,
): string[] | null {
  if (!spec.faces[face]) return null;
  const pick = { ...spec.faces.neutral, ...spec.faces[face] } as Record<string, string>;
  const out: string[] = [];
  for (const slot of Object.keys(pick))
    if (!YMM4_SLOTS.includes(slot.normalize('NFC')))
      out.push(`face "${face}": "${slot}" is not a YMM4 part folder (${YMM4_SLOTS.join(' ')})`);
  for (const [folder, file] of importedFaceFiles(dir, spec, face)) {
    if (!existsSync(file))
      out.push(`${file.slice(dir.length + 1)} is missing (face "${face}", folder ${folder})`);
  }
  return out;
}

/**
 * Faces a line may ask for: the standard emotions, the user emotions' faces, every cast face,
 * paragraph `face=` and reaction face — and each one's look variants `front-` / `glance-`
 * (acting stage 5b plan 5).
 */
function faceCandidates(script: Script): string[] {
  const user = Object.entries(script.meta.acting?.emotions ?? {}).map(([n, e]) => e.face ?? n);
  const written = script.scenes.flatMap((s) =>
    s.blocks.flatMap((b) =>
      b.kind === 'paragraph'
        ? [
            ...(b.face ? [b.face] : []),
            ...b.sentences.flatMap((x) => (x.reacts ?? []).flatMap((r) => Object.values(r.faces))),
          ]
        : [],
    ),
  );
  const base = [
    ...new Set([
      ...EMOTIONS,
      ...user,
      ...Object.values(script.meta.cast).map((m) => m.face),
      ...written,
    ]),
  ];
  return [...base, ...base.flatMap((f) => [`front-${f}`, `glance-${f}`])];
}

/** Drawable emotion faces of one cast member (null: unknown — the line keeps its default face). */
function faceSetsOf(script: Script, dir: string): CastMember['faceSets'] | null {
  const candidates = faceCandidates(script);
  if (characterSource(dir) !== 'parts') {
    const faces = characterFaces(dir);
    return { any: candidates.filter((f) => faces[f]?.base) };
  }
  const spec = loadCharacterSpec(dir);
  if (spec.source === 'imported')
    return { full: candidates.filter((f) => importedFaceProblems(dir, spec, f)?.length === 0) };
  const out: Record<string, string[]> = {};
  for (const framing of FRAMINGS)
    out[framing] = candidates.filter((face) => {
      if (!spec.faces[face]) return false;
      try {
        const { problems } = partsFaceProblems(dir, spec, framing, face, true);
        // only warnings that do not stop drawing it as a speaking face
        return [...problems.values()].every((v) => v[0] === 'warn' && v[1] !== 'no-talk');
      } catch {
        return false;
      }
    });
  return out;
}

/** Fill the internal cast fields from the character files (see the file comment). */
export function enrichCast(script: Script, scriptDir: string): void {
  for (const m of Object.values(script.meta.cast)) {
    const dir = characterDir(scriptDir, m);
    if (!dir || !existsSync(dir)) continue;
    try {
      if (characterSource(dir) === 'parts') {
        const motions = faceMotions(loadCharacterSpec(dir));
        if (motions) m.faceMotions = motions;
      }
    } catch {
      // The lint reports the broken character.yaml.
    }
    try {
      const sets = faceSetsOf(script, dir);
      if (sets) m.faceSets = sets;
    } catch {
      // Same: no emotion faces for a character that cannot be read.
    }
  }
}
