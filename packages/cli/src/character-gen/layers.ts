/**
 * Whether a character's layers are up to date (S9b plan 3.1). derive builds the layers of each
 * view from its approved sources; approving records the approval first and derives after, so a
 * failed derive leaves approved images whose layers are old or missing. derive records what it
 * built each part from (`provenance.deriveInputs`), and these functions compare that with what
 * the approved sources are now:
 *
 *   common      the view's reference (and headless body): pivot, body, head region
 *   body:<b>    one approved pose body
 *   group:<g>   one expression group (head/expr): its still, its approved frames and every approved
 *               blink of the view (a group's eye parts may come from another group's blink)
 *
 * A blink's own definition holds its still's hash, so a changed still unapproves the blink and
 * the group hashes change through the blink set; the still is not hashed again here.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveFace, type Framing, type LayeredSpec } from '@script2video/renderer-remotion';
import { IMAGEGEN_DIR } from '../imagegen.js';
import { withTwins, type Item } from './items.js';
import { diskSha, sha256, status, type Check, type DeriveInputs, type Graph } from './state.js';

/** The TS side of a derive job; raise it when the job derive gets changes what it builds. */
export const DERIVE_JOB_VERSION = 1;
const DERIVE_VERSION_RE = /^DERIVE_VERSION(?::\s*int)?\s*=\s*(\d+)\b/m;

/** `DERIVE_VERSION` of imagegen/character.py (null when the file or the constant is missing). */
export function deriveVersion(repoRoot: string): number | null {
  const file = join(repoRoot, IMAGEGEN_DIR, 'character.py');
  if (!existsSync(file)) return null;
  const m = DERIVE_VERSION_RE.exec(readFileSync(file, 'utf8'));
  return m ? Number(m[1]) : null;
}

/** The version part of every layer hash, or null (then no layer counts as up to date). */
export function deriveCode(repoRoot: string, log?: (m: string) => void): string | null {
  const v = deriveVersion(repoRoot);
  if (v === null) {
    log?.(
      `warning: cannot read DERIVE_VERSION from ${join(IMAGEGEN_DIR, 'character.py')}: layers count as out of date`,
    );
    return null;
  }
  return `py:${v};ts:${DERIVE_JOB_VERSION}`;
}

export interface DeriveGroup {
  /** `head/expr`. */
  key: string;
  head: string;
  expr: string;
  /** The still's item id (a view's base/neutral group is its reference). */
  still: string;
  /** Approved frames. */
  frames: { name: string; id: string }[];
}

export interface DeriveJob {
  /** `set|view`. */
  key: string;
  set: Framing;
  view: string;
  split: boolean;
  ref: string;
  headless: string | null;
  /** Approved bodies. */
  bodies: string[];
  groups: DeriveGroup[];
}

const DERIVED_KINDS = ['ref', 'closeup', 'still', 'frame', 'body', 'headless'];

/**
 * Every view of the character (`set|view`, in item order) and the derive job of those whose
 * reference (and headless body) is approved — what `deriveLayers` hands to character.py.
 */
export function deriveJobs(g: Graph): { views: string[]; jobs: DeriveJob[] } {
  const approved = (id: string) => status(g, id) === 'approved';
  type ViewItems = { set: Framing; view: string; bodies: string[]; groups: Map<string, string[]> };
  const views = new Map<string, ViewItems>();
  const keyOf = (it: Item) => `${it.set}|${it.view}`;
  for (const it of g.items.values()) {
    if (!DERIVED_KINDS.includes(it.kind)) continue;
    const v: ViewItems = views.get(keyOf(it)) ?? {
      set: it.set,
      view: it.view,
      bodies: [],
      groups: new Map(),
    };
    views.set(keyOf(it), v);
    if (it.kind === 'body' && approved(it.id)) v.bodies.push(it.body!);
    if (it.kind === 'frame' || it.kind === 'still') {
      const gk = `${it.head}/${it.expr}`;
      if (!v.groups.has(gk)) v.groups.set(gk, []);
      if (it.kind === 'frame' && approved(it.id)) v.groups.get(gk)!.push(it.frame!);
    }
  }
  const jobs: DeriveJob[] = [];
  for (const [key, v] of views) {
    const p = v.set === 'full' ? '' : `${v.set}:`;
    const ref = `${p}${v.view}/ref`;
    if (!approved(ref)) continue;
    const split = g.items.has(`${p}${v.view}/headless`);
    if (split && !approved(`${p}${v.view}/headless`)) continue;
    const groups: DeriveGroup[] = [];
    for (const [gk, frames] of v.groups) {
      const [head, expr] = gk.split('/') as [string, string];
      const baseNeutral = head === 'base' && expr === 'neutral';
      if (!baseNeutral && !approved(`${p}${v.view}/${gk}`)) continue;
      groups.push({
        key: gk,
        head,
        expr,
        still: baseNeutral ? ref : `${p}${v.view}/${gk}`,
        frames: frames.map((name) => ({ name, id: `${p}${v.view}/${gk}/${name}` })),
      });
    }
    jobs.push({
      key,
      set: v.set,
      view: v.view,
      split,
      ref,
      headless: split ? `${p}${v.view}/headless` : null,
      bodies: v.bodies,
      groups,
    });
  }
  return { views: [...views.keys()], jobs };
}

const H = (v: unknown) => sha256(JSON.stringify(v));

/** What the parts of one view job are built from now (S9b plan 3.1). */
export function partHashes(g: Graph, job: DeriveJob, code: string): DeriveInputs {
  const sha = (id: string) => diskSha(g, id);
  const p = job.set === 'full' ? '' : `${job.set}:`;
  const common = H({ code, ref: sha(job.ref), headless: job.headless ? sha(job.headless) : null });
  const bodies: Record<string, string> = {};
  for (const b of job.bodies) bodies[b] = H({ common, body: sha(`${p}${job.view}/body/${b}`) });
  const blinks = job.groups
    .flatMap((gr) => gr.frames.filter((f) => f.name === 'blink').map((f) => [gr.key, sha(f.id)]))
    .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  const groups: Record<string, string> = {};
  for (const gr of job.groups)
    groups[gr.key] = H({
      common,
      still: sha(gr.still),
      frames: gr.frames
        .map((f) => [f.name, sha(f.id)])
        .sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
      blinks,
    });
  return { common, bodies, groups };
}

export interface ViewLayers {
  set: Framing;
  view: string;
  /** derive builds this view (its reference is approved). */
  job: boolean;
  /** Per part: built from the current approved sources (null: no job). */
  common: boolean | null;
  bodies: Record<string, boolean>;
  groups: Record<string, boolean>;
  current: boolean | null;
}

/** Up-to-date state of every view's layers, by `set|view` (in item order). */
export function viewLayers(g: Graph, code: string | null): Map<string, ViewLayers> {
  const { views, jobs } = deriveJobs(g);
  const byKey = new Map(jobs.map((j) => [j.key, j]));
  const out = new Map<string, ViewLayers>();
  for (const key of views) {
    const [set, view] = key.split('|') as [Framing, string];
    const job = byKey.get(key);
    if (!job) {
      out.set(key, { set, view, job: false, common: null, bodies: {}, groups: {}, current: null });
      continue;
    }
    const rec = g.prov.deriveInputs?.[key];
    const now = code === null ? null : partHashes(g, job, code);
    const same = (a: string | undefined, b: string | undefined) =>
      now !== null && a !== undefined && a === b;
    const bodies: Record<string, boolean> = {};
    for (const b of job.bodies) bodies[b] = same(rec?.bodies[b], now?.bodies[b]);
    const groups: Record<string, boolean> = {};
    for (const gr of job.groups) groups[gr.key] = same(rec?.groups[gr.key], now?.groups[gr.key]);
    const common = same(rec?.common, now?.common);
    out.set(key, {
      set,
      view,
      job: true,
      common,
      bodies,
      groups,
      current:
        common && Object.values(bodies).every(Boolean) && Object.values(groups).every(Boolean),
    });
  }
  return out;
}

/**
 * What a face needs in one framing, on both sides (a `mirror: false` character draws the other
 * side from its `@flip` views): the item ids (as `missing` counts them) and the layer parts
 * (`set|view#part`). Throws FaceError when the face cannot be drawn.
 */
export function faceNeeds(
  dir: string,
  spec: LayeredSpec,
  framing: Framing,
  face: string,
): { ids: string[]; parts: string[] } {
  const s = withTwins(spec);
  const ids = new Set<string>();
  const parts = new Set<string>();
  const p = framing === 'full' ? '' : `${framing}:`;
  for (const side of ['left', 'right'] as const) {
    const k = resolveFace(dir, s, framing, face, side, spec.size ?? [640, 800]).key as Record<
      string,
      string
    >;
    ids.add(framing === 'full' && k.view === 'front' ? 'front/ref' : `${p}${k.view}/ref`);
    ids.add(`${p}${k.view}/headless`); // only counted when the view has one (split)
    if (k.body !== 'stand') ids.add(`${p}${k.view}/body/${k.body}`);
    ids.add(`${p}${k.view}/${k.head}/${k.expr}`);
    const v = `${framing}|${k.view}`;
    parts.add(`${v}#common`);
    if (k.body !== 'stand') parts.add(`${v}#body:${k.body}`);
    parts.add(`${v}#group:${k.head}/${k.expr}`);
  }
  return { ids: [...ids], parts: [...parts] };
}

/** A part's state: true / false, or null when its view has no job or the part is not built. */
export function partState(layers: Map<string, ViewLayers>, part: string): boolean | null {
  const [key, name] = part.split('#') as [string, string];
  const vl = layers.get(key);
  if (!vl || !vl.job) return null;
  if (name === 'common') return vl.common;
  if (name.startsWith('body:')) return vl.bodies[name.slice(5)] ?? null;
  if (name.startsWith('group:')) return vl.groups[name.slice(6)] ?? null;
  return null;
}

/**
 * What a face still waits for (S9b plan 3.2): graph items not approved, the number of items its
 * ids match, and the layer parts it uses that are out of date.
 */
export function faceTodo(
  g: Graph,
  layers: Map<string, ViewLayers>,
  needs: { ids: string[]; parts: string[] },
): { items: string[]; matched: number; staleParts: string[] } {
  const matching = [...g.items.keys()].filter((id) =>
    needs.ids.some((x) => id === x || id.startsWith(`${x}/`)),
  );
  return {
    items: matching.filter((id) => status(g, id) !== 'approved'),
    matched: matching.length,
    staleParts: needs.parts.filter((p) => partState(layers, p) === false).sort(),
  };
}

export interface FailedCheck {
  part: string;
  check: string;
  value: number;
  ok: boolean;
  limit: string;
}

interface DeriveResult {
  checks?: Record<string, Record<string, Check>>;
  bodies?: Record<string, Record<string, Check>>;
  eyes?: Record<string, { own_open: boolean; from: string | null }>;
}

/** The join checks the last derive of a view failed, and its groups whose blink leaves eyes open. */
export function deriveFindings(
  g: Graph,
  key: string,
): { failedChecks: FailedCheck[]; eyesOpen: { group: string; from: string | null }[] } {
  const r = g.prov.derive?.[key] as DeriveResult | undefined;
  const failedChecks: FailedCheck[] = [];
  if (r && !('error' in r)) {
    const add = (part: string, checks: Record<string, Check>) => {
      for (const [check, c] of Object.entries(checks))
        if (!c.ok) failedChecks.push({ part, check, value: c.value, ok: c.ok, limit: c.limit });
    };
    for (const [gk, c] of Object.entries(r.checks ?? {})) add(`group:${gk}`, c);
    for (const [b, c] of Object.entries(r.bodies ?? {})) add(`body:${b}`, c);
  }
  failedChecks.sort((a, b) =>
    a.part !== b.part
      ? a.part < b.part
        ? -1
        : 1
      : a.check < b.check
        ? -1
        : a.check > b.check
          ? 1
          : 0,
  );
  const eyesOpen = Object.entries(r?.eyes ?? {})
    .filter(([, e]) => e.own_open)
    .map(([group, e]) => ({ group, from: e.from ?? null }))
    .sort((a, b) => (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  return { failedChecks, eyesOpen };
}

/** Layer PNGs under views/ and sets/<f>/views/ (not the _src sources), relative to the folder. */
export function layerFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = join(rel, e.name);
      if (e.isDirectory()) {
        if (e.name !== '_src') walk(r);
      } else if (e.name.endsWith('.png')) out.push(r);
    }
  };
  walk('views');
  for (const f of ['upper', 'head']) walk(join('sets', f, 'views'));
  return out.sort();
}
