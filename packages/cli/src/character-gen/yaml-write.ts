/**
 * Derived fields in character.yaml (plan C16): pivots, group offsets and `@flip` twin entries are
 * written by the generator, keeping the user's comments and key order (yaml Document API).
 *
 * The value the generator last wrote is kept in provenance. A yaml value that differs from it was
 * edited by hand: it stays (with a warning and the new estimate) unless `--reset-derived`.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHARACTER_YAML } from '@script2video/renderer-remotion';
import { isMap, isSeq, parseDocument, type Document } from 'yaml';

export interface DerivedWrite {
  path: string[];
  value: unknown;
}

const keyOf = (path: string[]) => path.join(' › ');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Plain JS value at a path (undefined when absent). */
function getIn(doc: Document, path: string[]): unknown {
  const node = doc.getIn(path, true) as { toJSON?: () => unknown } | undefined;
  if (node === undefined || node === null) return undefined;
  return typeof node === 'object' && node && 'toJSON' in node && node.toJSON ? node.toJSON() : node;
}

export interface WriteResult {
  written: string[];
  kept: { path: string; yaml: unknown; estimate: unknown }[];
  /** The same as yaml paths (keys may hold dots). */
  writtenPaths: string[][];
  keptPaths: string[][];
}

/**
 * Apply derived values. `last` is provenance.derived (updated in place with what was written).
 * `write: false` only says what would be written (the yaml file is left as it is).
 */
export function writeDerived(
  dir: string,
  writes: DerivedWrite[],
  last: Record<string, unknown>,
  opts: { reset?: boolean; write?: boolean } = {},
): WriteResult {
  const file = join(dir, CHARACTER_YAML);
  const doc = parseDocument(readFileSync(file, 'utf8'));
  const res: WriteResult = { written: [], kept: [], writtenPaths: [], keptPaths: [] };
  for (const w of writes) {
    const k = keyOf(w.path);
    const now = getIn(doc, w.path);
    if (same(now, w.value)) {
      last[k] = w.value;
      continue;
    }
    // Present but not what we wrote last (or written by a person): a manual value.
    const manual = now !== undefined && !(k in last && same(now, last[k]));
    if (manual && !opts.reset) {
      res.kept.push({ path: k, yaml: now, estimate: w.value });
      res.keptPaths.push(w.path);
      continue;
    }
    const node = doc.createNode(w.value);
    if (isSeq(node) || isMap(node)) node.flow = true;
    // Create missing parent maps in block style (readable diffs).
    for (let i = 1; i < w.path.length; i++) {
      const parent = w.path.slice(0, i);
      if (!doc.hasIn(parent)) doc.setIn(parent, doc.createNode({}));
    }
    doc.setIn(w.path, node);
    last[k] = w.value;
    res.written.push(k);
    res.writtenPaths.push(w.path);
  }
  if (res.written.length > 0 && opts.write !== false) {
    writeFileSync(`${file}.tmp`, doc.toString({ lineWidth: 0, flowCollectionPadding: false }));
    renameSync(`${file}.tmp`, file);
  }
  return res;
}
