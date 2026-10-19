/**
 * The generation graph of a character folder (plan 4.1): its items, their state and what is
 * left per round. Read only: shared by the commands and the reports (`--json`).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHARACTER_YAML,
  loadCharacterSpec,
  type LayeredSpec,
} from '@script2video/renderer-remotion';
import { planItems, type Item } from './items.js';
import { pending, readProvenance, status, type Graph } from './state.js';

/** Minutes per 640×800 image (8 steps, measured 4–6) and per round (model load, encoding). */
export const MIN_PER_IMAGE = 5.5;
export const MIN_PER_ROUND = 1;

/** A generated character: its spec, items and provenance. */
export function loadGraph(dir: string): Graph & { spec: LayeredSpec; errors: string[] } {
  if (!existsSync(join(dir, CHARACTER_YAML)))
    throw new Error(`${dir} has no ${CHARACTER_YAML}: run s2v character create ${dir} first`);
  const spec = loadCharacterSpec(dir);
  if (spec.source !== 'generated')
    throw new Error(`${dir}: source is "${spec.source}"; only generated characters are built`);
  const { items, errors } = planItems(dir, spec);
  return {
    spec,
    errors,
    items: new Map(items.map((i) => [i.id, i])),
    prov: readProvenance(dir),
    size: spec.size ?? [640, 800],
    dir,
  };
}

export interface RoundPlan {
  round: number;
  items: Item[];
  minutes: number;
}

/** Remaining work per round (for --dry-run and the start message). */
export function remaining(g: Graph): { round: number; todo: number; waiting: number }[] {
  const out = new Map<number, { todo: number; waiting: number }>();
  for (const it of g.items.values()) {
    const s = status(g, it.id);
    if (s === 'approved') continue;
    const r = out.get(it.round) ?? { todo: 0, waiting: 0 };
    if (s === 'generated' || s === 'failed') r.waiting++;
    else r.todo++;
    out.set(it.round, r);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(([round, v]) => ({ round, ...v }));
}

/**
 * The next round to generate (C21): the lowest round with work, and only once every earlier
 * round is reviewed (approval rounds stay in order even where inputs would allow more).
 */
export function nextRound(g: Graph): RoundPlan | null {
  const todo = pending(g);
  if (todo.length === 0) return null;
  const round = Math.min(...todo.map((i) => i.round));
  if (waitingRound(g) < round) return null;
  const items = todo.filter((i) => i.round === round);
  return { round, items, minutes: Math.ceil(items.length * MIN_PER_IMAGE + MIN_PER_ROUND) };
}

/** The lowest round with images waiting for review (Infinity when none). */
function waitingRound(g: Graph): number {
  const w = [...g.items.values()].filter((it) =>
    ['generated', 'failed'].includes(status(g, it.id)),
  );
  return w.length ? Math.min(...w.map((i) => i.round)) : Infinity;
}

export type LoadedGraph = ReturnType<typeof loadGraph>;
