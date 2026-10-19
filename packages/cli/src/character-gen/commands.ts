/**
 * `s2v character create | pick | build | review | approve | redo` (plan 4.1).
 *
 * Every round runs one Python process under the memory watchdog (imagegen.ts); the image steps
 * after it (cutouts, checks, layers) are light and run without the model. Only approved images
 * become inputs (P2); approving also rebuilds the layers and the derived yaml fields.
 */

import { execFile, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { CHARACTER_YAML, loadCharacterSpec } from '@script2video/renderer-remotion';
import {
  EXIT_MEMORY,
  ExitError,
  IMAGEGEN_DIR,
  imagegenPython,
  readImagegenLock,
  runRound,
  type RoundJob,
} from '../imagegen.js';
import { ALIGNER, Service, TTS_SERVER } from '../services.js';
import {
  loadGraph,
  MIN_PER_IMAGE,
  MIN_PER_ROUND,
  nextRound,
  remaining,
  type LoadedGraph,
} from './graph.js';
import { candidatePrompt, FRONT_REF, ROUND_NAMES, twinWrites, type Item } from './items.js';
import { deriveCode, deriveJobs, layerFiles, partHashes } from './layers.js';
import { buildPlan, printBuildPlan, type ReviewRun } from './report.js';
import { candidateEntries, previewName, sectionsOf, writeReview } from './review.js';
import {
  currentDef,
  DEFAULT_SEED,
  ensureGitignore,
  fileSha,
  invalidate,
  seedOf,
  sha256,
  status,
  WORK,
  workPath,
  writeProvenance,
  type Check,
  type Graph,
  type ItemRecord,
} from './state.js';
import { writeDerived, type DerivedWrite } from './yaml-write.js';

export { loadGraph, nextRound, remaining, type RoundPlan } from './graph.js';

const run = promisify(execFile);
const CANDIDATE_SEED = 11;

export interface GenOptions {
  repoRoot: string;
  maxGb: number;
  log: (m: string) => void;
}

const TEMPLATE = `# A generated character (s2v character create / build). Describe the design in \`kind\`.
source: generated
license: "generated with Qwen-Image-Edit-2511 (Apache-2.0)"
kind: "TODO: an original ... (hair, clothes, colors, one or two props)"
style: chibi
preset: standard@1
mirror: true
`;

/** Refuse to start while another big model is loaded, and warn about swap / huge processes (C15). */
export async function memoryPreflight(repoRoot: string, log: (m: string) => void): Promise<void> {
  for (const spec of [TTS_SERVER, ALIGNER])
    if (await new Service(spec, repoRoot).health())
      throw new Error(
        `${spec.id} is running on port ${spec.port}: stop it before generating (both need tens of GB)`,
      );
  if (process.platform !== 'darwin') return;
  try {
    const { stdout } = await run('sysctl', ['-n', 'vm.swapusage']);
    const used = /used = ([\d.]+)M/.exec(stdout);
    if (used && Number(used[1]) > 2048)
      log(`warning: ${(Number(used[1]) / 1024).toFixed(1)} GB of swap in use: close apps first`);
  } catch {
    // No swap information: nothing to say.
  }
  try {
    const { stdout } = await run('ps', ['-axo', 'rss=,pid=,comm='], { maxBuffer: 8 << 20 });
    for (const line of stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      if (m && Number(m[1]) > 8 * 1024 * 1024 && Number(m[2]) !== process.pid)
        log(
          `warning: ${m[3]!.split('/').pop()} (pid ${m[2]}) uses ${(Number(m[1]) / 1024 / 1024).toFixed(0)} GB: generation needs ~17 GB`,
        );
    }
  } catch {
    // ps unavailable: skip.
  }
}

function roundFailed(code: number, what: string): Error {
  return code === EXIT_MEMORY
    ? new ExitError(
        `${what} stopped at the memory limit; finished images are kept: run the same command again`,
        EXIT_MEMORY,
      )
    : code === 130
      ? new ExitError(`${what} interrupted; finished images are kept`, 130)
      : new ExitError(`${what} failed (exit ${code})`, 1);
}

async function generate(
  dir: string,
  jobs: RoundJob[],
  name: string,
  opts: GenOptions,
): Promise<Map<string, { s: number; peak: number }>> {
  const lock = readImagegenLock(opts.repoRoot);
  const [w, h] = loadCharacterSpec(dir).size ?? [640, 800];
  const file = join(dir, WORK, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({ width: w, height: h, steps: lock.lora.steps, jobs }, null, 2),
  );
  const stats = new Map<string, { s: number; peak: number }>();
  const t0 = Date.now();
  const r = await runRound(opts.repoRoot, [file], {
    maxGb: opts.maxGb,
    log: opts.log,
    onEvent: (e) => {
      if (e.event === 'loaded') opts.log(`model loaded (${e.s}s); encoding ${jobs.length} prompts`);
      if (e.event === 'done') {
        stats.set(e.out, { s: e.s, peak: e.peak_gb });
        const left = ((Date.now() - t0) / e.index) * (e.total - e.index);
        opts.log(
          `[${e.index}/${e.total}] ${e.out.split('/').pop()} ${e.s}s, peak ${e.peak_gb} GB` +
            (e.index < e.total ? `, ~${Math.ceil(left / 60000)} min left` : ''),
        );
      }
      if (e.event === 'error') opts.log(`error: ${e.message}`);
    },
  });
  if (r.code !== 0) throw roundFailed(r.code, `round ${name}`);
  opts.log(`round done: peak memory ${r.peakGb.toFixed(1)} GB (watchdog)`);
  return stats;
}

/** Run imagegen/character.py (light: no model) and parse its JSON. */
async function imageStep<T>(
  repoRoot: string,
  step: 'post' | 'derive',
  job: unknown,
  dir: string,
): Promise<T> {
  // a fresh clone has no .work yet (S9b plan 3.3a)
  mkdirSync(join(dir, WORK), { recursive: true });
  ensureGitignore(dir);
  const file = join(dir, WORK, `${step}.json`);
  writeFileSync(file, JSON.stringify(job, null, 2));
  const { stdout } = await run(
    imagegenPython(repoRoot),
    [join(repoRoot, IMAGEGEN_DIR, 'character.py'), step, file],
    { maxBuffer: 64 << 20 },
  );
  return JSON.parse(stdout) as T;
}

interface PostResult {
  id: string;
  checks: Record<string, Check>;
  ok: boolean;
}

function toolInfo(repoRoot: string): Record<string, string> {
  const lock = readImagegenLock(repoRoot);
  const m = lock.models[lock.quantized.from]!;
  const l = lock.models[lock.lora.model]!;
  return {
    model: `${m.repo}@${m.revision.slice(0, 12)} (${m.license}, ${lock.quantized.bits}-bit)`,
    lora: `${l.repo}@${l.revision.slice(0, 12)} (${l.license})`,
  };
}

// ---------- create / pick ----------

export async function createCharacter(
  dir: string,
  opts: GenOptions & { candidates: number },
): Promise<void> {
  const yaml = join(dir, CHARACTER_YAML);
  if (!existsSync(yaml)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(yaml, TEMPLATE);
    throw new ExitError(
      `wrote ${yaml}: describe the character in "kind" (and adjust preset / mirror), then run this again`,
      2,
    );
  }
  const spec = loadCharacterSpec(dir);
  if (spec.source !== 'generated') throw new Error(`${yaml}: source must be "generated"`);
  if (!spec.kind || spec.kind.startsWith('TODO'))
    throw new Error(`${yaml}: describe the character in "kind" first`);
  const g = loadGraph(dir);
  const prompt = candidatePrompt(spec.kind, spec.style);
  const cdir = join(dir, WORK, 'candidates');
  mkdirSync(cdir, { recursive: true });
  ensureGitignore(dir);
  const have = Object.keys(g.prov.candidates).map(Number);
  const start = have.length ? Math.max(...have) + 1 : 1;
  const jobs: RoundJob[] = [];
  for (let n = start; n < start + opts.candidates; n++)
    jobs.push({ out: join(cdir, `${n}.png`), prompt, image: null, seed: CANDIDATE_SEED + n - 1 });
  opts.log(
    `round 1 (candidates): ${jobs.length} images, about ${Math.ceil(jobs.length * MIN_PER_IMAGE + MIN_PER_ROUND)} min`,
  );
  await memoryPreflight(opts.repoRoot, opts.log);
  await generate(dir, jobs, 'round-1', opts);
  const post = await imageStep<PostResult[]>(
    opts.repoRoot,
    'post',
    {
      items: jobs.map((j) => ({
        id: j.out,
        kind: 'candidate',
        image: j.out,
        cutout: j.out.replace(/\.png$/, '.cut.png'),
      })),
    },
    dir,
  );
  for (const [i, j] of jobs.entries())
    g.prov.candidates[String(start + i)] = {
      seed: j.seed,
      prompt,
      sha: fileSha(j.out),
      checks: post[i]!.checks,
    };
  writeProvenance(dir, g.prov);
  const page = writeReview(dir, [{ title: 'Round 1: candidates', entries: candidateEntries(g) }], {
    candidates: true,
  });
  openPage(page);
  opts.log(`review: ${page}\nnext: s2v character pick ${dir} <n>`);
}

export function pickCandidate(dir: string, n: string, log: (m: string) => void): void {
  const g = loadGraph(dir);
  const c = g.prov.candidates[n];
  const from = join(dir, WORK, 'candidates', `${n}.png`);
  if (!c || !existsSync(from))
    throw new Error(
      `no candidate ${n} (have: ${Object.keys(g.prov.candidates).join(', ') || 'none'})`,
    );
  const to = join(dir, 'views', 'front', '_src', 'ref.png');
  const old = g.prov.items[FRONT_REF];
  if (old && existsSync(to) && fileSha(to) !== old.approvedSha)
    throw new Error(`${to} was edited by hand; move it away to pick again`);
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  const sha = fileSha(to);
  g.prov.items[FRONT_REF] = {
    def: sha256(JSON.stringify({ v: 1, kind: 'candidate', prompt: c.prompt, seed: c.seed })),
    state: 'approved',
    seed: c.seed,
    prompt: c.prompt,
    sha,
    approvedSha: sha,
    ...(c.checks ? { checks: c.checks } : {}),
    at: new Date().toISOString(),
  };
  writeProvenance(dir, g.prov);
  if (old && old.approvedSha !== sha)
    log('the front reference changed: everything made from it will be generated again');
  log(`picked candidate ${n} as the front reference\nnext: s2v character build ${dir}`);
}

function openPage(page: string): void {
  if (process.env.S2V_NO_OPEN) return;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    spawn(opener, [page], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // No opener: the path is printed.
  }
}

// ---------- build ----------

const srcPath = (dir: string, item: Item) => join(dir, item.src);

/** The approved image an item edits. */
function inputPath(dir: string, g: Graph, item: Item): string {
  if (item.input === FRONT_REF) return join(dir, 'views', 'front', '_src', 'ref.png');
  return srcPath(dir, g.items.get(item.input)!);
}

const FRONT_SRC = (dir: string) => join(dir, 'views', 'front', '_src', 'ref.png');

/**
 * What an image is compared with for the change checks: a frame with its group's still, a still
 * with its view's neutral reference (an expression or head turn must change the face).
 */
function stillPath(dir: string, g: Graph, item: Item): string {
  const id =
    item.kind === 'frame'
      ? item.group
      : item.set === 'full' && item.view === 'front'
        ? FRONT_REF
        : `${item.set === 'full' ? '' : `${item.set}:`}${item.view}/ref`;
  const s = g.items.get(id);
  return s ? srcPath(dir, s) : FRONT_SRC(dir);
}

const compPath = (dir: string, id: string) => workPath(dir, id).replace(/\.png$/, '.comp.png');

/** Cutouts and checks (no model): after a round, and again on review (the checks may change). */
function postItems(dir: string, g: Graph, items: Item[], repoRoot: string): Promise<PostResult[]> {
  return imageStep<PostResult[]>(
    repoRoot,
    'post',
    {
      items: items.map((it) => ({
        id: it.id,
        kind: it.kind === 'closeup' ? 'ref' : it.kind,
        ...(it.frame ? { frame: it.frame } : {}),
        framing: it.set,
        image: workPath(dir, it.id),
        cutout: workPath(dir, it.id).replace(/\.png$/, '.cut.png'),
        bottom_open: it.bottomOpen,
        // An edit's background noise is compared with its input (frames are judged on their
        // part instead). A set's items edit the set's close-up (cut by the bottom).
        input: inputPath(dir, g, it),
        input_bottom_open: it.input !== FRONT_REF && (g.items.get(it.input)?.bottomOpen ?? false),
        ...(it.kind === 'headless' ? { ref: inputPath(dir, g, it) } : {}),
        ...(it.kind === 'body' ? bodyCheckInputs(dir, g, it) : {}),
        ...(it.kind === 'still' || it.kind === 'frame' ? { still: stillPath(dir, g, it) } : {}),
        // What the renderer shows (the still with the frame's part): the lip-sync preview.
        ...(it.kind === 'frame'
          ? { composite: compPath(dir, it.id), ...frameContext(dir, g, it, items) }
          : {}),
      })),
    },
    dir,
  );
}

/**
 * The group's other frames (derive makes the mouth and eye parts from all of them) and another
 * group's blink placing the mouth when this group's blink finds no eyes (a closed-eye smile).
 */
export function frameContext(dir: string, g: Graph, it: Item, round: Item[]) {
  const image = (x: Item) =>
    round.includes(x)
      ? existsSync(workPath(dir, x.id))
        ? workPath(dir, x.id)
        : undefined
      : status(g, x.id) === 'approved' && existsSync(srcPath(dir, x))
        ? srcPath(dir, x)
        : undefined;
  const frames: Record<string, string> = {};
  for (const x of g.items.values()) {
    const p = x.kind === 'frame' && x.group === it.group && x.id !== it.id ? image(x) : undefined;
    if (p) frames[x.frame!] = p;
  }
  // Borrowed blinks: approved ones, as derive has them, and this round's (a round that makes
  // every frame again has no approved blink to borrow; a bad one is skipped as leaving the eyes
  // open).
  const blinks = [...g.items.values()].filter(
    (x) =>
      x.frame === 'blink' &&
      x.set === it.set &&
      x.view === it.view &&
      x.group !== it.group &&
      image(x) !== undefined,
  );
  // Python takes the first that shows two eyes, in derive's order (character.py eye_order):
  // the same head's blinks, then the others, each sorted as Python sorts (head, expr) tuples.
  const byName = (a: Item, b: Item) =>
    a.head! < b.head! ? -1 : a.head! > b.head! ? 1 : a.expr! < b.expr! ? -1 : 1;
  const eyes = [
    ...blinks.filter((x) => x.head === it.head).sort(byName),
    ...blinks.filter((x) => x.head !== it.head).sort(byName),
  ].map((x) => ({
    still: stillPath(dir, g, x),
    blink: image(x)!,
    key: `${x.head}/${x.expr}`,
    same_head: x.head === it.head,
  }));
  // Split views: derive finds parts in the head region cut below pivot y + 4, so post does too.
  const p = it.set === 'full' ? '' : `${it.set}:`;
  const region = headRegionPath(dir, it.set, it.view);
  const split = g.items.has(`${p}${it.view}/headless`);
  // The pivot derive cut the head layer at (the yaml's may be hand-edited).
  const pivot = (g.prov.derive?.[`${it.set}|${it.view}`] as { pivot?: number[] } | undefined)
    ?.pivot;
  return {
    frames,
    eyes,
    ...(split && existsSync(region) ? { head_region: region } : {}),
    ...(split && pivot ? { pivot_y: pivot[1] } : {}),
  };
}

/**
 * The exit code of `character build`: `--layers-only` fails when a view's layers were not built
 * or could not be recorded (S9b plan 3.3a); a generating build fails by throwing.
 */
export function buildExitCode(opts: { layersOnly?: boolean }, r: { failed: string[] }): number {
  return opts.layersOnly && r.failed.length > 0 ? 1 : 0;
}

export async function buildCharacter(
  dir: string,
  opts: GenOptions & {
    dryRun?: boolean;
    resetDerived?: boolean;
    /** Twin entries and layers only, no generation (S9b plan 3.3a). */
    layersOnly?: boolean;
    /** Open the review page after a round (default true). */
    open?: boolean;
  },
): Promise<{ failed: string[] }> {
  const { log } = opts;
  if (opts.dryRun) {
    printBuildPlan(buildPlan(dir, opts.repoRoot, log), dir, log);
    return { failed: [] };
  }
  let g = loadGraph(dir);
  for (const e of g.errors) log(`warning: ${e}`);
  if (g.prov.items[FRONT_REF]?.state !== 'approved')
    throw new Error(`no front reference yet: s2v character create ${dir}, then pick one`);
  if (status(g, FRONT_REF) !== 'approved')
    throw new Error(
      `views/front/_src/ref.png is gone: s2v character pick ${dir} <n> (or restore the file)`,
    );
  if (opts.layersOnly && Object.keys(g.prov.inflight ?? {}).length)
    log(
      'warning: a generation round is in flight or was stopped; if it is running, its end may freeze these layers as hand edits (stop it first)',
    );
  // Twin entries first (C10): they are derived fields, written once and then like the user's.
  const twins = twinWrites(g.spec);
  if (twins.length) {
    const r = writeDerived(dir, twins, g.prov.derived);
    if (r.written.length) log(`added @flip twins to ${CHARACTER_YAML}: ${r.written.join(', ')}`);
    writeProvenance(dir, g.prov);
    g = loadGraph(dir);
  }
  // Layers of everything approved so far (also retries a derive that failed during approve).
  let failed: string[] = [];
  if (Object.values(g.prov.items).some((r) => r.state === 'approved')) {
    const d = await deriveLayers(dir, opts);
    // --layers-only fails when a view failed or nothing could be recorded (no DERIVE_VERSION)
    failed = d.recorded ? d.failed : [...new Set([...d.failed, ...d.jobs])];
    // derive recorded the layer hashes it wrote: saving the old graph later would put the old
    // hashes back, and the next approve would keep the new layers as hand-edited.
    g = loadGraph(dir);
  }
  if (opts.layersOnly) {
    const p = buildPlan(dir, opts.repoRoot);
    log(
      `state: ${p.state}${p.staleParts.length ? ` (${p.staleParts.length} layer parts out of date)` : ''}`,
    );
    return { failed };
  }
  const rest = remaining(g);
  const plan = nextRound(g);
  log(
    'rounds left: ' +
      (rest
        .map((r) => `${r.round} (${r.todo} to make${r.waiting ? `, ${r.waiting} to review` : ''})`)
        .join(', ') || 'none'),
  );
  if (!plan) {
    const waiting = rest.reduce((a, r) => a + r.waiting, 0);
    log(
      waiting
        ? `nothing to generate: ${waiting} images wait for review (s2v character review ${dir})`
        : rest.length
          ? 'nothing to generate until the earlier rounds are approved'
          : 'every image is approved: the character is complete',
    );
    return { failed };
  }
  log(
    `next: round ${plan.round} (${ROUND_NAMES[plan.round]}): ${plan.items.length} images, about ${plan.minutes} min`,
  );
  await memoryPreflight(opts.repoRoot, log);
  mkdirSync(join(dir, WORK), { recursive: true });
  ensureGitignore(dir);
  // C16: a new model or LoRA revision never makes items stale, but say so once.
  const tool = toolInfo(opts.repoRoot);
  const older = Object.entries(g.prov.items).filter(
    ([, r]) => r.state === 'approved' && r.tool && JSON.stringify(r.tool) !== JSON.stringify(tool),
  );
  if (older.length)
    log(
      `note: ${older.length} approved images were made with another model or LoRA revision; they stay valid (redo them to remake)`,
    );
  // run.py skips finished outputs, which resumes a stopped round. Keep an output only when it was
  // made for this exact definition (recorded before the round started); drop everything else.
  const inflight = g.prov.inflight ?? {};
  const jobs: RoundJob[] = plan.items.map((it) => {
    const out = workPath(dir, it.id);
    const def = currentDefOrThrow(g, it);
    if (existsSync(out) && inflight[it.id] !== def)
      // With its cutout and composite: a failed check step must not show the old ones.
      for (const f of [out, out.replace(/\.png$/, '.cut.png'), compPath(dir, it.id)])
        rmSync(f, { force: true });
    inflight[it.id] = def;
    return { out, prompt: it.prompt, image: inputPath(dir, g, it), seed: seedOf(g, it) };
  });
  g.prov.inflight = inflight;
  writeProvenance(dir, g.prov);
  const stats = await generate(dir, jobs, `round-${plan.round}`, opts);
  // Light image steps: cutouts and checks for the review page.
  const post = await postItems(dir, g, plan.items, opts.repoRoot);
  for (const [i, it] of plan.items.entries()) {
    const out = workPath(dir, it.id);
    const p = post[i]!;
    const st = stats.get(out);
    const old = g.prov.items[it.id];
    const rec: ItemRecord = {
      def: '',
      state: p.ok ? 'generated' : 'failed',
      seed: seedOf(g, it),
      ...(old?.seedFixed ? { seedFixed: true } : {}),
      ...(old?.frameSeed !== undefined ? { frameSeed: old.frameSeed } : {}),
      // The last approved copy's hash: approve must not overwrite a hand-edited source.
      ...(old?.approvedSha ? { approvedSha: old.approvedSha } : {}),
      prompt: it.prompt,
      sha: fileSha(out),
      checks: p.checks,
      ...(st ? { peakGb: st.peak, seconds: st.s } : {}),
      at: new Date().toISOString(),
      tool,
    };
    g.prov.items[it.id] = rec;
  }
  // Definitions after the records exist (a group's seed lives on its still).
  invalidate(g);
  // The definition the images were made for (an input edited meanwhile leaves them stale).
  for (const it of plan.items) {
    g.prov.items[it.id]!.def = inflight[it.id]!;
    delete inflight[it.id];
  }
  writeProvenance(dir, g.prov);
  if (plan.round === 6) await previews(dir, g, plan.items, log);
  invalidate(g);
  const page = writeReviewPage(dir, g, plan.round);
  if (opts.open !== false) openPage(page);
  const failedChecks = plan.items.filter((it) => g.prov.items[it.id]!.state === 'failed');
  log(
    `${plan.items.length} images ready for review${failedChecks.length ? ` (${failedChecks.length} failed checks)` : ''}: ${page}\n` +
      `next: s2v character approve ${dir} --all   (or pick items on the page; redo with s2v character redo)`,
  );
  return { failed };
}

function currentDefOrThrow(g: Graph, it: Item): string {
  const def = currentDef(g, it);
  if (!def) throw new Error(`${it.id}: input ${it.input} is not approved`);
  return def;
}

const headRegionPath = (dir: string, set: string, view: string) =>
  join(dir, WORK, `head-region-${set}-${view}.png`);

function bodyCheckInputs(dir: string, g: Graph, it: Item): Record<string, string> {
  const region = headRegionPath(dir, it.set, it.view);
  // The head region comes from this view's reference: compare with it, not the front one.
  const p = it.set === 'full' ? '' : `${it.set}:`;
  const ref =
    it.set === 'full' && it.view === 'front'
      ? FRONT_SRC(dir)
      : srcPath(dir, g.items.get(`${p}${it.view}/ref`)!);
  return existsSync(region) ? { ref, head_region: region } : {};
}

/** Lip-sync previews of round-6 groups: closed → half → open → half … with a blink (plan 4.4). */
async function previews(
  dir: string,
  g: Graph,
  items: Item[],
  log: (m: string) => void,
): Promise<void> {
  const groups = new Map<string, Item[]>();
  for (const it of items)
    (groups.get(it.group) ?? groups.set(it.group, []).get(it.group)!).push(it);
  for (const [group, frames] of groups) {
    const f = (name: string) => frames.find((x) => x.frame === name);
    const half = f('half');
    const open = f('open');
    const blink = f('blink');
    if (!half || !open || !blink) continue;
    const still = stillPath(dir, g, half);
    const shown = (it: Item) =>
      existsSync(compPath(dir, it.id)) ? compPath(dir, it.id) : workPath(dir, it.id);
    const seq = [still, shown(half), shown(open), shown(half)];
    const order = [...seq, ...seq, still, shown(blink), still, ...seq];
    const list = join(dir, WORK, 'preview.txt');
    const q = (p: string) => `file '${p.replace(/'/g, "'\\''")}'\n`;
    writeFileSync(list, order.map((p) => `${q(p)}duration 0.12\n`).join('') + q(still));
    try {
      await run('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        list,
        '-vf',
        'scale=320:-2,format=yuv420p',
        '-r',
        '25',
        join(dir, WORK, previewName(group)),
      ]);
    } catch (e) {
      log(`warning: no preview for ${group}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
}

function writeReviewPage(dir: string, g: Graph, round?: number): string {
  const items = [...g.items.values()].filter((it) => {
    const s = status(g, it.id);
    return (
      (round === undefined || it.round === round) &&
      (s === 'generated' || s === 'failed' || (round !== undefined && s === 'approved'))
    );
  });
  return writeReview(
    dir,
    sectionsOf(dir, g, items, (id) => status(g, id)),
    {},
  );
}

/**
 * `character review`: check what waits again, write the page and open it. `check: false` (S9b
 * `--no-check`) only reads: no Python, no ffmpeg, no page, nothing written. Returns the graph and
 * what this run did, for `--json`.
 */
export async function reviewCharacter(
  dir: string,
  opts: GenOptions & { open?: boolean; check?: boolean },
): Promise<{ graph: LoadedGraph; run: ReviewRun }> {
  const { log } = opts;
  let g: LoadedGraph = loadGraph(dir);
  if (opts.check === false)
    return {
      graph: g,
      run: { recheck: 'none', rechecked: new Set(), onPage: new Set(), page: null },
    };
  const waiting = [...g.items.values()].filter((it) =>
    ['generated', 'failed'].includes(status(g, it.id)),
  );
  // Check again what waits (the checks may have changed since the round); an image changed on
  // disk is left as it is (approve refuses it).
  const fresh = waiting.filter((it) => {
    const f = workPath(dir, it.id);
    return existsSync(f) && fileSha(f) === g.prov.items[it.id]?.sha;
  });
  let post: PostResult[] | undefined;
  let recheck: ReviewRun['recheck'] = 'none';
  try {
    post = fresh.length ? await postItems(dir, g, fresh, opts.repoRoot) : undefined;
    if (post) recheck = 'done';
  } catch (e) {
    recheck = 'failed';
    log(
      `warning: could not check the images again (${(e as Error).message}); showing the checks of the round`,
    );
  }
  if (post) {
    let changed = 0;
    for (const [i, it] of fresh.entries()) {
      const rec = g.prov.items[it.id]!;
      const state = post[i]!.ok ? 'generated' : 'failed';
      if (state !== rec.state) changed++;
      rec.checks = post[i]!.checks;
      rec.state = state;
    }
    writeProvenance(dir, g.prov);
    invalidate(g);
    if (changed) log(`checked again: ${changed} images changed between passed and failed`);
    // Previews need every frame of a group, approved ones included.
    const groups = new Set(fresh.map((it) => it.group));
    await previews(
      dir,
      g,
      [...g.items.values()].filter(
        (it) =>
          it.kind === 'frame' &&
          groups.has(it.group) &&
          ['generated', 'failed', 'approved'].includes(status(g, it.id)),
      ),
      log,
    );
  }
  const page = waiting.length
    ? writeReview(
        dir,
        sectionsOf(dir, g, waiting, (id) => status(g, id)),
        {},
      )
    : writeReview(dir, [{ title: 'Round 1: candidates', entries: candidateEntries(g) }], {
        candidates: true,
      });
  if (opts.open !== false) openPage(page);
  log(`${waiting.length} images wait for review: ${page}`);
  // what the page shows, as it is now (the checks may have changed the states)
  g = loadGraph(dir);
  return {
    graph: g,
    run: {
      recheck,
      rechecked: new Set(recheck === 'done' ? fresh.map((it) => it.id) : []),
      onPage: new Set(waiting.map((it) => it.id)),
      page: relative(dir, page).split(sep).join('/'),
    },
  };
}

// ---------- approve / redo ----------

export async function approveItems(
  dir: string,
  ids: string[],
  opts: GenOptions & { all?: boolean; except?: string[]; resetDerived?: boolean },
): Promise<void> {
  const g = loadGraph(dir);
  const waiting = [...g.items.values()].filter((it) =>
    ['generated', 'failed'].includes(status(g, it.id)),
  );
  let chosen: Item[];
  if (opts.all) {
    const except = new Set(opts.except ?? []);
    chosen = waiting.filter((it) => !except.has(it.id) && status(g, it.id) === 'generated');
    const failed = waiting.filter((it) => status(g, it.id) === 'failed' && !except.has(it.id));
    if (failed.length)
      opts.log(
        `not approved (failed checks; name them to approve anyway): ${failed.map((i) => i.id).join(' ')}`,
      );
  } else {
    chosen = ids
      .map((id) => {
        const it = g.items.get(id);
        if (!it) throw new Error(`unknown item ${id}`);
        return it;
      })
      .filter((it) => {
        const s = status(g, it.id);
        if (s === 'approved') {
          opts.log(`${it.id} is already approved`);
          return false;
        }
        if (s !== 'generated' && s !== 'failed')
          throw new Error(`${it.id} is ${s}, not waiting for review`);
        return true;
      });
  }
  // Check every item first: a refusal must not leave some copied and unrecorded.
  for (const it of chosen) {
    const from = workPath(dir, it.id);
    const to = srcPath(dir, it);
    const rec = g.prov.items[it.id]!;
    if (!existsSync(from) || fileSha(from) !== rec.sha)
      throw new Error(`${from} is missing or changed since it was generated; run build again`);
    // Never overwrite a source someone edited: only our last approved copy may be replaced.
    if (existsSync(to)) {
      const cur = fileSha(to);
      if (cur !== rec.approvedSha && cur !== rec.sha)
        throw new Error(`${to} was edited by hand; move it away to approve ${it.id}`);
    }
  }
  for (const it of chosen) {
    const from = workPath(dir, it.id);
    const to = srcPath(dir, it);
    const rec = g.prov.items[it.id]!;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    rec.state = 'approved';
    rec.approvedSha = rec.sha!;
  }
  writeProvenance(dir, g.prov);
  opts.log(`approved ${chosen.length}: ${chosen.map((i) => i.id).join(' ') || '(none)'}`);
  await deriveLayers(dir, opts);
  const g2 = loadGraph(dir);
  const plan = nextRound(g2);
  opts.log(
    plan
      ? `next: s2v character build ${dir}   (round ${plan.round}: ${plan.items.length} images, about ${plan.minutes} min)`
      : remaining(g2).length
        ? 'some images still wait for review'
        : 'every image is approved: the character is complete',
  );
}

export function redoItems(
  dir: string,
  ids: string[],
  seed: number | undefined,
  log: (m: string) => void,
): void {
  const g = loadGraph(dir);
  // Per group: whether the still itself is redone, or only its frames (they edit the still).
  const groups = new Map<string, boolean>();
  for (const id of ids) {
    const it = g.items.get(id);
    if (!it && id !== FRONT_REF) throw new Error(`unknown item ${id}`);
    const group = it ? it.group : FRONT_REF;
    // The picked front reference stays: pick another candidate to replace it.
    const still = group !== FRONT_REF && it?.kind !== 'frame';
    groups.set(group, (groups.get(group) ?? false) || still);
  }
  for (const [group, still] of groups) {
    const rec = g.prov.items[group];
    if (!rec) throw new Error(`${group} was never generated: run build`);
    if (still) {
      rec.seed = seed ?? rec.seed + 1;
      rec.seedFixed = true;
      delete rec.frameSeed;
      rec.def = 'redo';
      log(`${group}: seed ${rec.seed}; it will be generated again, with its frames`);
    } else {
      rec.frameSeed = seed ?? (rec.frameSeed ?? (rec.seedFixed ? rec.seed : DEFAULT_SEED)) + 1;
      log(
        `${group} frames: seed ${rec.frameSeed}; the still stays, all its frames are made again` +
          (group === FRONT_REF ? ' (pick another candidate to change the front reference)' : ''),
      );
    }
  }
  writeProvenance(dir, g.prov);
  invalidate(g);
  const g2 = loadGraph(dir);
  // Everything redone: the groups (or their frames) and what waits below them.
  const stale = [...g2.items.values()].filter(
    (it) =>
      (groups.has(it.group) && (groups.get(it.group) || it.kind === 'frame')) ||
      ['stale', 'missing'].includes(status(g2, it.id)),
  );
  log(
    `${stale.length} images to generate (s2v character build ${dir} --dry-run shows the next round)`,
  );
}

// ---------- derive: layers and derived yaml fields ----------

interface DeriveView {
  pivot: [number, number] | null;
  groups: Record<string, { offset: [number, number]; band_error: number }>;
  bodies: Record<string, Record<string, Check>>;
  checks: Record<string, Record<string, Check>>;
  /** Groups whose approved blink leaves the eyes open, and the blink that placed their parts. */
  eyes?: Record<string, { own_open: boolean; from: string | null }>;
}

/** Rebuild layers from approved sources and write pivots / offsets to the yaml (4.3, C16). */
export async function deriveLayers(
  dir: string,
  opts: GenOptions & { resetDerived?: boolean },
): Promise<{ views: number; failed: string[]; jobs: string[]; recorded: boolean }> {
  const g = loadGraph(dir);
  const { jobs } = deriveJobs(g);
  const jobViews = jobs.map((j) => {
    const root = j.set === 'full' ? dir : join(dir, 'sets', j.set);
    return {
      key: j.key,
      src: join(root, 'views', j.view, '_src'),
      out: join(root, 'views', j.view),
      split: j.split,
      bottom_open: j.set !== 'full',
      framing: j.set,
      bodies: j.bodies,
      groups: j.groups.map((gr) => ({
        head: gr.head,
        expr: gr.expr,
        frames: gr.frames.map((f) => f.name),
      })),
      region_out: headRegionPath(dir, j.set, j.view),
    };
  });
  if (jobViews.length === 0) return { views: 0, failed: [], jobs: [], recorded: true };
  // Layer files someone edited since derive wrote them are kept as they are (C16).
  const layers = g.prov.layers ?? {};
  const protect = layerFiles(dir).filter(
    (rel) => layers[rel] !== undefined && fileSha(join(dir, rel)) !== layers[rel],
  );
  for (const rel of protect) opts.log(`kept hand-edited layer ${rel} (delete it to rebuild it)`);
  const res = await imageStep<Record<string, DeriveView>>(
    opts.repoRoot,
    'derive',
    { views: jobViews, protect: protect.map((rel) => join(dir, rel)) },
    dir,
  );
  const fresh: Record<string, string> = {};
  for (const rel of layerFiles(dir))
    fresh[rel] = protect.includes(rel) ? layers[rel]! : fileSha(join(dir, rel));
  g.prov.layers = fresh;
  // What each view's parts were built from (S9b plan 3.1): a view derive built, all of its
  // job's groups and bodies (a view without a headless body reports no groups but builds them);
  // a view that failed has no record. Views no longer derived keep theirs (not judged).
  const code = deriveCode(opts.repoRoot, opts.log);
  const inputs = { ...(g.prov.deriveInputs ?? {}) };
  const failed: string[] = [];
  for (const j of jobs) {
    const r = res[j.key];
    if (!r || 'error' in r || code === null) {
      delete inputs[j.key];
      if (!r || 'error' in r) failed.push(j.key);
    } else inputs[j.key] = partHashes(g, j, code);
  }
  g.prov.deriveInputs = inputs;
  const writes: DerivedWrite[] = [];
  for (const [k, r] of Object.entries(res)) {
    const [set, view] = k.split('|') as [string, string];
    if ('error' in r) {
      opts.log(`warning: layers of ${k} not built: ${String((r as { error: unknown }).error)}`);
      continue;
    }
    const base = set === 'full' ? [] : ['sets', set];
    if (r.pivot) writes.push({ path: [...base, 'views', view, 'pivot'], value: r.pivot });
    for (const [gk, gr] of Object.entries(r.groups))
      if (r.pivot)
        writes.push({ path: [...base, 'groups', `${view}/${gk}`, 'offset'], value: gr.offset });
    for (const [b, c] of Object.entries(r.bodies ?? {})) {
      const bad = Object.entries(c).filter(([, x]) => !x.ok);
      if (bad.length)
        opts.log(
          `warning: ${k} body ${b}: ${bad.map(([n, x]) => `${n} ${x.value} (${x.limit})`).join(', ')}`,
        );
    }
    for (const [gk, e] of Object.entries(r.eyes ?? {}))
      if (e.own_open)
        opts.log(
          `warning: ${k} ${gk}: its approved blink leaves the eyes open; ${e.from ? `the eyes of ${e.from} place its parts` : 'no blink places its parts'} (s2v character redo ${dir} ${set === 'full' ? '' : `${set}:`}${view}/${gk}/blink)`,
        );
    for (const [gk, c] of Object.entries(r.checks)) {
      const bad = Object.entries(c).filter(([, x]) => !x.ok);
      if (bad.length)
        opts.log(
          `warning: ${k} ${gk} join check: ${bad.map(([n, x]) => `${n} ${x.value} (${x.limit})`).join(', ')}`,
        );
    }
  }
  const w = writeDerived(dir, writes, g.prov.derived, { reset: opts.resetDerived ?? false });
  for (const kept of w.kept)
    opts.log(
      `kept hand-edited ${kept.path} = ${JSON.stringify(kept.yaml)} (estimate ${JSON.stringify(kept.estimate)}; --reset-derived to use it)`,
    );
  g.prov.derive = res;
  writeProvenance(dir, g.prov);
  opts.log(
    `layers updated for ${jobViews.length} view(s)${w.written.length ? `; wrote ${w.written.length} derived fields` : ''}`,
  );
  return { views: jobViews.length, failed, jobs: jobs.map((j) => j.key), recorded: code !== null };
}
