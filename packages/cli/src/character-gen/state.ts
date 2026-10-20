/**
 * Generation state (plan C16, C18): `provenance.json` next to character.yaml.
 *
 * Definition hash = the item's instruction + kind + size + the approved output hash of its input
 * + an explicit `redo --seed`. Seeds, model revisions and tool versions are recorded but never
 * make an item stale. An item is stale when its recorded definition differs from the current one;
 * a stale approved item and everything below it must be generated and approved again.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FRONT_REF, type Item } from './items.js';

export const PROVENANCE = 'provenance.json';
export const WORK = '.work';
/** Default seed of every group: the one all spikes used (out-a … out-g). */
export const DEFAULT_SEED = 7;

export type ItemState = 'generated' | 'failed' | 'approved';
export type Status = 'missing' | 'stale' | 'blocked' | ItemState;

export interface Check {
  value: number;
  ok: boolean;
  limit: string;
}

export interface ItemRecord {
  def: string;
  state: ItemState;
  seed: number;
  /** Set by `redo --seed N`: part of the definition hash and kept for later regenerations. */
  seedFixed?: boolean;
  /** On a group's still: the frames' own redo seed (they edit the still, which stays). */
  frameSeed?: number;
  prompt: string;
  /** sha256 of the generated image in .work/ and of the approved copy in _src/. */
  sha?: string;
  approvedSha?: string;
  checks?: Record<string, Check>;
  peakGb?: number;
  seconds?: number;
  at?: string;
  tool?: Record<string, string>;
}

export interface Provenance {
  version: 1;
  items: Record<string, ItemRecord>;
  /** Candidates of round 1: index → seed, prompt, checks. */
  candidates: Record<
    string,
    { seed: number; prompt: string; sha: string; checks?: Record<string, Check> }
  >;
  /** Derived yaml values as the generator last wrote them (manual edits are detected, C16). */
  derived: Record<string, unknown>;
  /** Join checks and band errors from the last derive. */
  derive?: Record<string, unknown>;
  /** Definitions of a round being generated: a resumed round keeps only matching outputs. */
  inflight?: Record<string, string>;
  /** Hashes of the layer files derive wrote: files that differ were edited by hand (C16). */
  layers?: Record<string, string>;
  /**
   * What the layers of each view (`set|view`) were last built from, per part (S9b plan 3.1):
   * the approved sources and the derive version. A part whose hash differs now is out of date.
   */
  deriveInputs?: Record<string, DeriveInputs>;
}

export interface DeriveInputs {
  common: string;
  bodies: Record<string, string>;
  groups: Record<string, string>;
}

export function readProvenance(dir: string): Provenance {
  const p = join(dir, PROVENANCE);
  if (!existsSync(p)) return { version: 1, items: {}, candidates: {}, derived: {} };
  const data = JSON.parse(readFileSync(p, 'utf8')) as Provenance;
  return {
    ...data,
    items: data.items ?? {},
    candidates: data.candidates ?? {},
    derived: data.derived ?? {},
  };
}

export function writeProvenance(dir: string, prov: Provenance): void {
  const p = join(dir, PROVENANCE);
  writeFileSync(`${p}.tmp`, `${JSON.stringify(prov, null, 2)}\n`);
  renameSync(`${p}.tmp`, p);
}

export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const fileSha = (path: string) => sha256(readFileSync(path));

/** File name of an item's generated image in .work/ (ids contain `/` and `:`). */
export const workName = (id: string) => `${id.replace(/[/:]/g, '__')}.png`;

export interface Graph {
  items: Map<string, Item>;
  prov: Provenance;
  size: [number, number];
  /** The character folder: inputs are hashed as they are on disk (a hand edit makes items stale). */
  dir?: string;
}

const diskShas = new WeakMap<Graph, Map<string, string | null>>();
/** Hash of an approved source as it is on disk now (null when missing). */
export function diskSha(g: Graph, id: string): string | null {
  if (!g.dir) return g.prov.items[id]?.approvedSha ?? null;
  let cache = diskShas.get(g);
  if (!cache) diskShas.set(g, (cache = new Map()));
  if (cache.has(id)) return cache.get(id)!;
  const rel = id === FRONT_REF ? join('views', 'front', '_src', 'ref.png') : g.items.get(id)?.src;
  const p = rel ? join(g.dir, rel) : null;
  const sha = p && existsSync(p) ? fileSha(p) : null;
  cache.set(id, sha);
  return sha;
}

/** The definition hash of an item now, or null while its input is not approved. */
export function currentDef(g: Graph, item: Item): string | null {
  const input = g.prov.items[item.input];
  if (!input || input.state !== 'approved' || !input.approvedSha) return null;
  if (item.input !== FRONT_REF && status(g, item.input) !== 'approved') return null;
  const inputSha = diskSha(g, item.input);
  if (!inputSha) return null;
  // A redo seed is fixed per group (C16): it changes the still and every frame of the group;
  // a frames-only redo changes the frames alone.
  const group = g.prov.items[item.group];
  return sha256(
    JSON.stringify({
      v: 1,
      kind: item.kind,
      prompt: item.prompt,
      size: g.size,
      input: inputSha,
      seed: frameSeedOf(group, item) ?? (group?.seedFixed ? group.seed : null),
    }),
  );
}

const memo = new WeakMap<Graph, Map<string, Status>>();

/** Where an item stands (C16): stale when its definition changed since it was generated. */
export function status(g: Graph, id: string): Status {
  let cache = memo.get(g);
  if (!cache) memo.set(g, (cache = new Map()));
  const hit = cache.get(id);
  if (hit) return hit;
  const s = computeStatus(g, id);
  cache.set(id, s);
  return s;
}

/** Forget cached statuses after the provenance changed. */
export const invalidate = (g: Graph) => {
  memo.delete(g);
  diskShas.delete(g);
};

function computeStatus(g: Graph, id: string): Status {
  const rec = g.prov.items[id];
  // An approved source deleted from disk is gone: make it (or pick it) again.
  const deleted = rec?.state === 'approved' && g.dir !== undefined && !diskSha(g, id);
  if (id === FRONT_REF) return rec?.state === 'approved' && !deleted ? 'approved' : 'missing';
  const item = g.items.get(id);
  if (!item) return rec ? (rec.state as Status) : 'missing';
  // Inputs first: everything under a missing input waits for it.
  if (item.needs.some((n) => status(g, n) !== 'approved')) return 'blocked';
  if (deleted) return 'missing';
  const def = currentDef(g, item);
  if (!rec) return 'missing';
  if (def !== rec.def) return 'stale';
  return rec.state;
}

/** Items to generate now: inputs approved, and missing or stale. */
export function pending(g: Graph): Item[] {
  return [...g.items.values()].filter((it) => ['missing', 'stale'].includes(status(g, it.id)));
}

/** A frame's seed after a frames-only redo (on the group's still record). */
const frameSeedOf = (group: ItemRecord | undefined, item: Item) =>
  item.kind === 'frame' ? group?.frameSeed : undefined;

/** Seed of an item: its group's fixed redo seed, else the default (P5: one seed per group). */
export function seedOf(g: Graph, item: Item): number {
  const group = g.prov.items[item.group];
  return frameSeedOf(group, item) ?? (group?.seedFixed ? group.seed : DEFAULT_SEED);
}

export const workPath = (dir: string, id: string) => join(dir, WORK, workName(id));

/**
 * Keep the work folder out of git (the character folder is committed): a .gitignore without a
 * `.work/` line gets one added (S8: the work lock lives there too); its other lines stay.
 */
export function ensureGitignore(dir: string): void {
  const f = join(dir, '.gitignore');
  if (!existsSync(f)) {
    writeFileSync(f, `${WORK}/\n`);
    return;
  }
  const text = readFileSync(f, 'utf8');
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.some((l) => l === WORK || l === `${WORK}/` || l === `/${WORK}` || l === `/${WORK}/`))
    return;
  writeFileSync(f, `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${WORK}/\n`);
}
