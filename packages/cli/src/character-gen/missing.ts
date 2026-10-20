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
  type Framing,
  type LayeredSpec,
} from '@script2video/renderer-remotion';
import { parseDocument } from 'yaml';
import { usedFaces } from '../lint-assets.js';
import { loadGraph } from './graph.js';
import { deriveCode, faceNeeds, faceTodo, viewLayers } from './layers.js';
import { PROVENANCE } from './state.js';
import { actorRunning } from '../actor-lock.js';

export interface MissingReport {
  cast: string;
  /** The character folder (absolute). */
  dir: string;
  /** The folder as the script writes it. */
  written: string;
  /** False: not judged (see `reason`); its lists are empty. */
  checked: boolean;
  reason: 'no-folder' | 'invalid' | 'not-parts' | 'not-generated' | null;
  /** Why an invalid character could not be judged (paths made relative). */
  message: string | null;
  /** Made by `s2v character build` (it has a provenance.json): only then is (c) known. */
  managed: boolean;
  undefined: string[];
  notInSet: { framing: Framing; face: string }[];
  notReady: { framing: Framing; face: string; items: string[]; staleParts: string[] }[];
  impossible: { framing: Framing; face: string; why: string }[];
  /**
   * Faces lines ask for through an emotion that the character cannot draw yet (they show the
   * default face). Optional: not counted, not added by --apply (acting stage 2 plan 6.1).
   */
  emotional: { framing: Framing; face: string }[];
}

/** What `--apply` added to a character's sets (S9b plan 3.2). */
export interface Added {
  framing: 'upper' | 'head';
  kind: 'face' | 'head' | 'body';
  key: string;
  note: string | null;
}

/** An added entry as the text output has always said it. */
export const addedText = (a: Added) =>
  a.kind === 'face'
    ? `${a.framing}:${a.key}`
    : `${a.framing}:${a.kind === 'head' ? 'heads' : 'bodies'}.${a.key}${a.note ? ` (${a.note})` : ''}`;

/** Breaks a cast's judgment: a missing folder or a character that cannot be read. */
export const blocksMissing = (r: MissingReport) =>
  r.reason === 'no-folder' || r.reason === 'invalid';

/** The (a)–(d) count of a report (faces and items, not text lines). */
export const missingCount = (r: MissingReport) =>
  r.undefined.length + r.notInSet.length + r.notReady.length + r.impossible.length;

export function findMissing(
  script: Script,
  scriptDir: string,
  opts: { repoRoot: string; log?: (m: string) => void },
): MissingReport[] {
  const reports: MissingReport[] = [];
  // derive's version decides whether layers are up to date
  const code = deriveCode(opts.repoRoot, opts.log);
  for (const [key, m] of Object.entries(script.meta.cast)) {
    if (!m.character) continue;
    const written = typeof m.character === 'string' ? m.character : m.character.dir;
    const dir = resolve(scriptDir, written);
    const r: MissingReport = {
      cast: key,
      dir,
      written,
      checked: false,
      reason: null,
      message: null,
      managed: false,
      undefined: [],
      notInSet: [],
      notReady: [],
      impossible: [],
      emotional: [],
    };
    reports.push(r);
    if (!existsSync(dir)) {
      r.reason = 'no-folder';
      continue;
    }
    try {
      judge(r, script, key, dir, code);
    } catch (e) {
      Object.assign(r, {
        checked: false,
        reason: 'invalid',
        message: relativePaths((e as Error).message, [
          [dir, written],
          [opts.repoRoot, '<repo>'],
          [scriptDir, '.'],
        ]),
        managed: false,
        undefined: [],
        notInSet: [],
        notReady: [],
        impossible: [],
        emotional: [],
      });
    }
  }
  return reports;
}

/** A message without the machine's absolute paths. */
function relativePaths(message: string, pairs: [string, string][]): string {
  let out = message;
  for (const [abs, rel] of pairs) out = out.split(abs).join(rel);
  return out;
}

function judge(
  r: MissingReport,
  script: Script,
  key: string,
  dir: string,
  code: string | null,
): void {
  if (characterSource(dir) !== 'parts') {
    r.reason = 'not-parts';
    return;
  }
  const spec = loadCharacterSpec(dir);
  if (spec.source !== 'generated') {
    r.reason = 'not-generated';
    return;
  }
  r.checked = true;
  // Only characters the generator manages have a build state; others (hand-made folders with
  // source: generated) are checked for definitions and sets only, and their (c) is unknown.
  r.managed = existsSync(join(dir, PROVENANCE));
  const g = r.managed ? loadGraph(dir) : null;
  const layers = g ? viewLayers(g, code) : new Map();
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
      let needs: ReturnType<typeof faceNeeds>;
      try {
        needs = faceNeeds(dir, spec, framing, face);
      } catch (e) {
        if (!(e instanceof FaceError)) throw e;
        r.impossible.push({ framing, face, why: e.message });
        continue;
      }
      if (!g) continue;
      const todo = faceTodo(g, layers, needs);
      if (todo.items.length || todo.staleParts.length)
        r.notReady.push({ framing, face, items: todo.items, staleParts: todo.staleParts });
    }
}

/** Add faces to sets.<framing>.faces, keeping the preset's list (a user list replaces it). */
export function applyMissing(r: MissingReport): Added[] {
  if (!r.checked || r.notInSet.length === 0) return [];
  const spec = loadCharacterSpec(r.dir) as LayeredSpec;
  const file = join(r.dir, CHARACTER_YAML);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const added: Added[] = [];
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
        added.push({
          framing: f,
          kind: 'head',
          key: hk,
          note: turns ? 'turned faces in the head close-up now use this head' : null,
        });
      }
      const bk = `front/${fd.body}`;
      if (f === 'upper' && fd.body && !spec.sets.upper?.bodies[bk] && spec.bodies[bk]) {
        doc.setIn(['sets', f, 'bodies', bk], doc.createNode(spec.bodies[bk]));
        added.push({ framing: f, kind: 'body', key: bk, note: null });
      }
    }
    const node = doc.createNode(faces);
    node.flow = true;
    doc.setIn(['sets', f, 'faces'], node);
    added.push(...add.map((x) => ({ framing: f, kind: 'face' as const, key: x, note: null })));
  }
  writeFileSync(`${file}.tmp`, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
  renameSync(`${file}.tmp`, file);
  return added;
}

export function printMissing(reports: MissingReport[], log: (m: string) => void): number {
  let n = 0;
  for (const r of reports) {
    if (!r.checked) {
      if (blocksMissing(r)) {
        n++;
        log(
          r.reason === 'no-folder'
            ? `${r.cast}: no character folder ${r.written}`
            : `${r.cast} (${r.dir}): cannot be read: ${r.message}`,
        );
      }
      continue;
    }
    const lines: string[] = [];
    if (r.undefined.length) {
      lines.push(`  (a) not defined — add to ${CHARACTER_YAML} faces, e.g.:`);
      for (const f of r.undefined)
        lines.push(`        ${f}: { view: turn, expression: neutral }   # TODO`);
    }
    for (const x of r.notInSet)
      lines.push(`  (b) ${x.face}: not in sets.${x.framing}.faces (--apply adds it)`);
    if (!r.managed) lines.push(`  (c) unknown: no ${PROVENANCE} (not made by s2v character build)`);
    for (const x of r.notReady) {
      if (x.items.length)
        lines.push(`  (c) ${x.framing} ${x.face}: not approved yet: ${x.items.join(' ')}`);
      if (x.staleParts.length)
        lines.push(
          `  (c) ${x.framing} ${x.face}: layers not rebuilt (${x.staleParts.join(' ')}): s2v character build ${r.dir} --layers-only`,
        );
    }
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

/** `character missing --json` (S9b plan 3.2): one entry per cast with a character. */
export function missingJson(reports: MissingReport[], added: Map<string, Added[]>) {
  return reports.map((r) => {
    const list = <T>(v: T) => (r.checked ? v : null);
    return {
      cast: r.cast,
      dir: r.written,
      checked: r.checked,
      reason: r.reason,
      message: r.message,
      managed: r.checked ? r.managed : null,
      unknown: r.checked ? !r.managed : null,
      notDefined: list(r.undefined),
      notInSet: list(r.notInSet),
      notReady: r.checked && r.managed ? r.notReady : null,
      impossible: list(r.impossible),
      optional: list(r.emotional),
      added: added.get(r.cast) ?? [],
      count: r.checked ? missingCount(r) : 0,
      // a command working on the character now (S8 work lock), or null
      running: r.checked ? actorRunning(r.dir) : null,
    };
  });
}

/** Whether `character missing` fails: something to fix, unknown, or not judged. */
export const missingFails = (reports: MissingReport[]) =>
  reports.some((r) => blocksMissing(r) || (r.checked && (missingCount(r) > 0 || !r.managed)));

/**
 * `character missing --apply` (final review 16): judge, take the work lock of every character
 * that needs additions, judge again under the locks, and repeat while that finds more characters to
 * lock; then apply the last judgment to the locked characters only. A busy character (74) stops it
 * before anything is written. Characters that need nothing are not locked (nothing is written in
 * them, not even a .gitignore).
 */
export function applyMissingFlow(
  find: () => MissingReport[],
  acquire: (dirs: string[]) => void,
  apply: (r: MissingReport) => Added[],
): { reports: MissingReport[]; added: Map<string, Added[]> } {
  const needs = (rs: MissingReport[]) =>
    rs.filter((x) => x.checked && x.notInSet.length > 0).map((x) => x.dir);
  const locked = new Set<string>();
  let reports = find();
  for (;;) {
    const more = [...new Set(needs(reports))].filter((d) => !locked.has(d));
    if (more.length === 0) break;
    acquire(more);
    for (const d of more) locked.add(d);
    reports = find();
  }
  const added = new Map<string, Added[]>();
  // only characters that were judged (S9b: a skipped or unreadable one has nothing to add)
  for (const r of reports.filter((x) => x.checked && locked.has(x.dir)))
    added.set(r.cast, apply(r));
  return { reports, added };
}
