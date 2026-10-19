/**
 * `s2v character missing <script> [--apply]` (plan C23): what a script needs from its generated
 * characters, over every output and both sides, that the library does not have yet.
 *
 *   (a) not defined          → a yaml draft to add by hand
 *   (b) not in the framing set → --apply adds it to sets.<framing>.faces
 *   (c) defined, not generated or approved → s2v character build
 *   (d) not expressible in that framing (a removed set) → use another face
 *
 * A pose in the head close-up is drawn with its expression (no body shows; closeup-look plan).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Script } from '@script2video/core';
import {
  CHARACTER_YAML,
  characterSource,
  FaceError,
  loadCharacterSpec,
  resolveFace,
  type Framing,
  type LayeredSpec,
} from '@script2video/renderer-remotion';
import { parseDocument } from 'yaml';
import { usedFaces } from '../lint-assets.js';
import { withTwins } from './items.js';
import { PROVENANCE, status } from './state.js';
import { loadGraph } from './commands.js';

export interface MissingReport {
  cast: string;
  dir: string;
  undefined: string[];
  notInSet: { framing: Framing; face: string }[];
  notReady: { framing: Framing; face: string; items: string[] }[];
  impossible: { framing: Framing; face: string; why: string }[];
  /**
   * Faces lines ask for through an emotion that the character cannot draw yet (they show the
   * default face). Optional: not counted, not added by --apply (acting stage 2 plan 6.1).
   */
  emotional: { framing: Framing; face: string }[];
}

/** The items a (framing, face) needs on both sides (ids as in items.ts). */
function itemsFor(dir: string, spec: LayeredSpec, framing: Framing, face: string): string[] {
  const s = withTwins(spec);
  const out = new Set<string>();
  const p = framing === 'full' ? '' : `${framing}:`;
  for (const side of ['left', 'right'] as const) {
    const k = resolveFace(dir, s, framing, face, side, spec.size ?? [640, 800]).key as Record<
      string,
      string
    >;
    out.add(framing === 'full' && k.view === 'front' ? 'front/ref' : `${p}${k.view}/ref`);
    out.add(`${p}${k.view}/headless`); // only counted when the view has one (split)
    if (k.body !== 'stand') out.add(`${p}${k.view}/body/${k.body}`);
    out.add(`${p}${k.view}/${k.head}/${k.expr}`);
  }
  return [...out];
}

export function findMissing(script: Script, scriptDir: string): MissingReport[] {
  const reports: MissingReport[] = [];
  for (const [key, m] of Object.entries(script.meta.cast)) {
    if (!m.character) continue;
    const dir = resolve(scriptDir, typeof m.character === 'string' ? m.character : m.character.dir);
    if (!existsSync(dir) || characterSource(dir) !== 'parts') continue;
    const spec = loadCharacterSpec(dir);
    if (spec.source !== 'generated') continue;
    // Only characters the generator manages have a build state; others (hand-made folders with
    // source: generated) are checked for definitions and sets only.
    const managed = existsSync(join(dir, PROVENANCE));
    const g = managed ? loadGraph(dir) : null;
    const r: MissingReport = {
      cast: key,
      dir,
      undefined: [],
      notInSet: [],
      notReady: [],
      impossible: [],
      emotional: [],
    };
    const drawn = usedFaces(script, key);
    for (const [framing, faces] of usedFaces(script, key, 'wanted'))
      for (const face of faces)
        if (!drawn.get(framing)?.has(face)) r.emotional.push({ framing, face });
    for (const [framing, faces] of usedFaces(script, key))
      for (const face of faces) {
        const fd = spec.faces[face];
        if (!fd) {
          if (!r.undefined.includes(face)) r.undefined.push(face);
          continue;
        }
        if (framing !== 'full' && !spec.sets[framing]) {
          r.impossible.push({
            framing,
            face,
            why: `the ${framing} set is removed (sets.${framing}: null or exclude) — restore it or use another framing`,
          });
          continue;
        }
        if (framing !== 'full' && !spec.sets[framing]?.faces.includes(face)) {
          r.notInSet.push({ framing, face });
          continue;
        }
        let ids: string[];
        try {
          ids = itemsFor(dir, spec, framing, face);
        } catch (e) {
          if (!(e instanceof FaceError)) throw e;
          r.impossible.push({ framing, face, why: e.message });
          continue;
        }
        if (!g) continue;
        const todo = [...g.items.keys()].filter(
          (id) =>
            ids.some((x) => id === x || id.startsWith(`${x}/`)) && status(g, id) !== 'approved',
        );
        if (todo.length) r.notReady.push({ framing, face, items: todo });
      }
    reports.push(r);
  }
  return reports;
}

/** Add faces to sets.<framing>.faces, keeping the preset's list (a user list replaces it). */
export function applyMissing(r: MissingReport): string[] {
  if (r.notInSet.length === 0) return [];
  const spec = loadCharacterSpec(r.dir) as LayeredSpec;
  const file = join(r.dir, CHARACTER_YAML);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const added: string[] = [];
  for (const f of ['upper', 'head'] as const) {
    const add = r.notInSet.filter((x) => x.framing === f).map((x) => x.face);
    if (add.length === 0) continue;
    const faces = [...new Set([...(spec.sets[f]?.faces ?? []), ...add])];
    // The set must name its view in the user's yaml even when a preset supplies the set.
    if (!doc.hasIn(['sets', f, 'views']))
      doc.setIn(['sets', f, 'views'], doc.createNode({ front: {} }));
    // C23 (b): a close-up set keeps head variants (and the upper set poses) only when it has
    // them locally. In the head set a turned head also turns every turned face (resolve.ts).
    for (const face of add) {
      const fd = spec.faces[face]!;
      const hk = `front/${fd.head}`;
      const h = spec.heads[hk];
      if (fd.head && h && !spec.sets[f]?.heads[hk] && !doc.hasIn(['sets', f, 'heads', hk])) {
        doc.setIn(['sets', f, 'heads', hk], doc.createNode(h));
        // As resolve.ts turnedHead picks it: no glance head there yet, its twin when not mirrored.
        const turns =
          f === 'head' &&
          (h.facing ?? 'front') !== 'front' &&
          (spec.mirror || doc.hasIn(['sets', f, 'heads', `${hk}@flip`])) &&
          !Object.values(spec.sets.head?.heads ?? {}).some((x) => x.preset === 'glance');
        added.push(
          `${f}:heads.${hk}${turns ? ' (turned faces in the head close-up now use this head)' : ''}`,
        );
      }
      const bk = `front/${fd.body}`;
      if (f === 'upper' && fd.body && !spec.sets.upper?.bodies[bk] && spec.bodies[bk]) {
        doc.setIn(['sets', f, 'bodies', bk], doc.createNode(spec.bodies[bk]));
        added.push(`${f}:bodies.${bk}`);
      }
    }
    const node = doc.createNode(faces);
    node.flow = true;
    doc.setIn(['sets', f, 'faces'], node);
    added.push(...add.map((x) => `${f}:${x}`));
  }
  writeFileSync(`${file}.tmp`, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  renameSync(`${file}.tmp`, file);
  return added;
}

export function printMissing(reports: MissingReport[], log: (m: string) => void): number {
  let n = 0;
  for (const r of reports) {
    const lines: string[] = [];
    if (r.undefined.length) {
      lines.push(`  (a) not defined — add to ${CHARACTER_YAML} faces, e.g.:`);
      for (const f of r.undefined)
        lines.push(`        ${f}: { view: turn, expression: neutral }   # TODO`);
    }
    for (const x of r.notInSet)
      lines.push(`  (b) ${x.face}: not in sets.${x.framing}.faces (--apply adds it)`);
    for (const x of r.notReady)
      lines.push(`  (c) ${x.framing} ${x.face}: not approved yet: ${x.items.join(' ')}`);
    for (const x of r.impossible)
      lines.push(`  (d) ${x.framing} ${x.face}: ${x.why}; use another face`);
    n += lines.length;
    // optional: emotion faces fall back to the default face, so they do not count
    const optional = r.emotional.map(
      (x) =>
        `  (optional) ${x.framing} ${x.face}: asked for by an emotion, drawn with the default face for now (write face=${x.face} on a line to have it listed above)`,
    );
    log(
      lines.length || optional.length
        ? `${r.cast} (${r.dir}):\n${[...lines, ...optional].join('\n')}`
        : `${r.cast}: nothing missing`,
    );
  }
  return n;
}
