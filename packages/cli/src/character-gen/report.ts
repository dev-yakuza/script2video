/**
 * What tools read about a generated character (S9b plan 3.3, 3.4): `character build --dry-run
 * --json` (what is left to make) and `character review --json` (every item, view and face). Both
 * only read the folder.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { FaceError, type Framing } from '@script2video/renderer-remotion';
import {
  loadGraph,
  MIN_PER_IMAGE,
  MIN_PER_ROUND,
  nextRound,
  remaining,
  type LoadedGraph,
} from './graph.js';
import { FRONT_REF, ROUND_NAMES, twinWrites } from './items.js';
import {
  deriveCode,
  deriveFindings,
  faceNeeds,
  faceTodo,
  layerFiles,
  viewLayers,
  type FailedCheck,
  type ViewLayers,
} from './layers.js';
import { currentDef, diskSha, fileSha, status, WORK, workPath, type Check } from './state.js';
import { writeDerived } from './yaml-write.js';
import { actorRunning } from '../actor-lock.js';

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Checks with their names in order (null when none). */
function sortedChecks(checks: Record<string, Check> | undefined): Record<string, Check> | null {
  if (!checks) return null;
  return Object.fromEntries(
    Object.keys(checks)
      .sort(byName)
      .map((k) => [k, checks[k]!]),
  );
}

/** Out-of-date layer parts of every view derive builds (`set|view#part`, sorted). */
function staleParts(layers: Map<string, ViewLayers>): string[] {
  const out: string[] = [];
  for (const [key, v] of layers) {
    if (!v.job) continue;
    if (v.common === false) out.push(`${key}#common`);
    for (const [b, ok] of Object.entries(v.bodies)) if (!ok) out.push(`${key}#body:${b}`);
    for (const [gk, ok] of Object.entries(v.groups)) if (!ok) out.push(`${key}#group:${gk}`);
  }
  return out.sort(byName);
}

// ---------- build --dry-run ----------

export interface BuildPlan {
  /** A command working on the character now (its work lock, S8), or null. */
  running: { pid: number; pid_start: string; cmd: string } | null;
  state: 'pick' | 'generate' | 'review' | 'blocked' | 'derive' | 'complete';
  front: 'never-picked' | 'deleted' | null;
  candidates: number;
  candidatesAvailable: number;
  rounds: { round: number; name: string; toMake: number; toReview: number }[];
  next: {
    round: number;
    name: string;
    images: number;
    minutes: number;
    items: { id: string; status: string; kept: boolean }[];
  } | null;
  blocking: string[];
  staleParts: string[];
  remainingImages: number;
  remainingMinutes: number;
  toReview: number;
  twinsToWrite: string[][];
  twinsKept: string[][];
  warnings: string[];
}

/** What `character build` would do next, without doing anything (S9b plan 3.3). */
export function buildPlan(dir: string, repoRoot: string, log?: (m: string) => void): BuildPlan {
  const g = loadGraph(dir);
  const candidates = Object.entries(g.prov.candidates);
  const available = candidates.filter(([n, c]) => {
    const f = join(dir, WORK, 'candidates', `${n}.png`);
    return existsSync(f) && fileSha(f) === c.sha;
  }).length;
  const front: BuildPlan['front'] =
    g.prov.items[FRONT_REF]?.state !== 'approved'
      ? 'never-picked'
      : status(g, FRONT_REF) !== 'approved'
        ? 'deleted'
        : null;
  const base = {
    running: actorRunning(dir),
    front,
    candidates: candidates.length,
    candidatesAvailable: available,
    warnings: g.errors,
  };
  if (front)
    return {
      state: 'pick',
      ...base,
      rounds: [],
      next: null,
      blocking: [],
      staleParts: [],
      remainingImages: 0,
      remainingMinutes: 0,
      toReview: 0,
      twinsToWrite: [],
      twinsKept: [],
    };
  const twins = writeDerived(dir, twinWrites(g.spec), structuredClone(g.prov.derived), {
    write: false,
  });
  const rest = remaining(g);
  const plan = nextRound(g);
  const stale = staleParts(viewLayers(g, deriveCode(repoRoot, log)));
  const toReview = rest.reduce((a, r) => a + r.waiting, 0);
  const images = rest.reduce((a, r) => a + r.todo, 0);
  // Outputs a stopped run finished for the same definition are kept (buildCharacter).
  const kept = (id: string) => {
    const it = g.items.get(id)!;
    return existsSync(workPath(dir, id)) && g.prov.inflight?.[id] === currentDef(g, it);
  };
  const blocking =
    !plan && toReview === 0 && rest.length > 0
      ? [
          ...new Set(
            [...g.items.values()]
              .filter((it) => status(g, it.id) !== 'approved')
              .flatMap((it) => it.needs)
              .filter((id) => status(g, id) !== 'approved'),
          ),
        ].sort(byName)
      : [];
  const state: BuildPlan['state'] = plan
    ? 'generate'
    : toReview > 0
      ? 'review'
      : rest.length > 0
        ? 'blocked'
        : stale.length > 0
          ? 'derive'
          : 'complete';
  return {
    state,
    ...base,
    rounds: rest.map((r) => ({
      round: r.round,
      name: ROUND_NAMES[r.round] ?? '',
      toMake: r.todo,
      toReview: r.waiting,
    })),
    next: plan
      ? {
          round: plan.round,
          name: ROUND_NAMES[plan.round] ?? '',
          images: plan.items.length,
          minutes: plan.minutes,
          items: plan.items.map((it) => ({
            id: it.id,
            status: status(g, it.id),
            kept: kept(it.id),
          })),
        }
      : null,
    blocking,
    staleParts: stale,
    remainingImages: images,
    remainingMinutes: Math.ceil(
      images * MIN_PER_IMAGE + rest.filter((r) => r.todo > 0).length * MIN_PER_ROUND,
    ),
    toReview,
    twinsToWrite: twins.writtenPaths,
    twinsKept: twins.keptPaths,
    warnings: g.errors,
  };
}

/** The text of `character build --dry-run` (the same plan as `--json`). */
export function printBuildPlan(p: BuildPlan, dir: string, log: (m: string) => void): void {
  for (const e of p.warnings) log(`warning: ${e}`);
  if (p.running) log(`running now: ${p.running.cmd} (pid ${p.running.pid})`);
  if (p.front === 'never-picked')
    throw new Error(`no front reference yet: s2v character create ${dir}, then pick one`);
  if (p.front === 'deleted')
    throw new Error(
      `views/front/_src/ref.png is gone: s2v character pick ${dir} <n> (or restore the file)`,
    );
  log(
    'rounds left: ' +
      (p.rounds
        .map(
          (r) => `${r.round} (${r.toMake} to make${r.toReview ? `, ${r.toReview} to review` : ''})`,
        )
        .join(', ') || 'none'),
  );
  if (!p.next) {
    log(
      p.toReview
        ? `nothing to generate: ${p.toReview} images wait for review (s2v character review ${dir})`
        : p.rounds.length
          ? 'nothing to generate until the earlier rounds are approved'
          : p.staleParts.length
            ? `every image is approved; ${p.staleParts.length} layer parts are out of date: s2v character build ${dir} --layers-only`
            : 'every image is approved: the character is complete',
    );
    return;
  }
  log(
    `next: round ${p.next.round} (${p.next.name}): ${p.next.images} images, about ${p.next.minutes} min`,
  );
  for (const it of p.next.items)
    log(`  ${it.id}  [${it.status}]${it.kept ? ' (done in a stopped run, kept)' : ''}`);
}

// ---------- review --json ----------

export interface ReviewRun {
  recheck: 'done' | 'none' | 'failed';
  rechecked: Set<string>;
  onPage: Set<string>;
  /** The page written, relative to the character folder (null: none). */
  page: string | null;
}

export interface FaceReport {
  key: string;
  framing: Framing;
  face: string;
  ready: boolean | null;
  pending: string[];
  staleParts: string[];
  warnings: string[];
  why: string | null;
}

/** Every item, view, face and layer file of a character (S9b plan 3.4). */
export function reviewReport(
  dir: string,
  g: LoadedGraph,
  run: ReviewRun,
  repoRoot: string,
  log?: (m: string) => void,
) {
  const items = [...g.items.values()];
  const waiting = items.filter((it) => ['generated', 'failed'].includes(status(g, it.id)));
  const frontRec = g.prov.items[FRONT_REF];
  const candidates = Object.entries(g.prov.candidates).sort((a, b) => Number(a[0]) - Number(b[0]));
  const layers = viewLayers(g, deriveCode(repoRoot, log));
  const findings = new Map([...layers.keys()].map((k) => [k, deriveFindings(g, k)]));
  const views = [...layers.entries()]
    .sort((a, b) => byName(a[1].set, b[1].set) || byName(a[1].view, b[1].view))
    .map(([k, v]) => ({ ...v, ...findings.get(k)! }));
  // the faces of the spec in each framing it has
  const faces: FaceReport[] = [];
  const framings: [Framing, string[]][] = [
    ['full', Object.keys(g.spec.faces)],
    ['upper', g.spec.sets.upper?.faces ?? []],
    ['head', g.spec.sets.head?.faces ?? []],
  ];
  for (const [framing, names] of framings)
    for (const face of names) {
      const r: FaceReport = {
        key: `${framing}:${face}`,
        framing,
        face,
        ready: null,
        pending: [],
        staleParts: [],
        warnings: [],
        why: null,
      };
      faces.push(r);
      let needs: ReturnType<typeof faceNeeds>;
      try {
        needs = faceNeeds(dir, g.spec, framing, face);
      } catch (e) {
        if (!(e instanceof FaceError)) throw e;
        r.why = e.message;
        continue;
      }
      const todo = faceTodo(g, layers, needs);
      r.pending = todo.items;
      r.staleParts = todo.staleParts;
      for (const part of needs.parts) {
        const [vk, name] = part.split('#') as [string, string];
        const f = findings.get(vk);
        if (!f) continue;
        for (const c of f.failedChecks as FailedCheck[])
          if (c.part === name) r.warnings.push(`${part} ${c.check} ${c.value} (${c.limit})`);
        for (const e of f.eyesOpen)
          if (name === `group:${e.group}`)
            r.warnings.push(
              `${part} blink leaves the eyes open (${e.from ? `the eyes of ${e.from} place its parts` : 'no blink places its parts'})`,
            );
      }
      if (todo.matched === 0) r.why = 'no items';
      else r.ready = todo.items.length === 0 && todo.staleParts.length === 0;
    }
  const recorded = g.prov.layers ?? {};
  const paths = [...new Set([...layerFiles(dir), ...Object.keys(recorded)])].sort(byName);
  return {
    running: actorRunning(dir),
    recheck: run.recheck,
    page: run.page,
    waiting: waiting.length,
    failed: waiting.filter((it) => status(g, it.id) === 'failed').length,
    front: {
      status: status(g, FRONT_REF),
      approvedSha: frontRec?.approvedSha ?? null,
      candidate:
        candidates.find(
          ([, c]) => frontRec?.approvedSha !== undefined && c.sha === frontRec.approvedSha,
        )?.[0] ?? null,
    },
    items: items.map((it) => {
      const rec = g.prov.items[it.id];
      const work = workPath(dir, it.id);
      return {
        id: it.id,
        round: it.round,
        set: it.set,
        view: it.view,
        kind: it.kind,
        status: status(g, it.id),
        sha: rec?.sha ?? null,
        workMatches: rec?.sha ? existsSync(work) && fileSha(work) === rec.sha : null,
        approvedSha: rec?.approvedSha ?? null,
        srcSha: diskSha(g, it.id),
        seed: rec?.seed ?? null,
        checks: sortedChecks(rec?.checks),
        rechecked: run.rechecked.has(it.id),
        onPage: run.onPage.has(it.id),
      };
    }),
    candidates: candidates.map(([n, c]) => ({
      n,
      seed: c.seed,
      sha: c.sha,
      checks: sortedChecks(c.checks),
    })),
    views,
    faces,
    layers: paths.map((path) => {
      const abs = join(dir, path);
      const recordedSha = recorded[path] ?? null;
      const diskShaNow = existsSync(abs) ? fileSha(abs) : null;
      return {
        path: path.split('\\').join('/'),
        state:
          recordedSha === null
            ? 'untracked'
            : diskShaNow === null
              ? 'gone'
              : diskShaNow === recordedSha
                ? 'same'
                : 'edited',
        recordedSha,
        diskSha: diskShaNow,
      };
    }),
  };
}
