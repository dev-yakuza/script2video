/**
 * S9b: what tools read about generated characters — `character missing --json`, `character build
 * --dry-run --json`, `--layers-only`, `character review --json [--no-check]` — on small folders
 * made here (no image model, no real derive: a stand-in python answers derive).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCharacter, buildExitCode, reviewCharacter } from '../src/character-gen/commands.js';
import { loadGraph } from '../src/character-gen/graph.js';
import { FRONT_REF } from '../src/character-gen/items.js';
import {
  deriveCode,
  deriveJobs,
  deriveVersion,
  partHashes,
  viewLayers,
} from '../src/character-gen/layers.js';
import { buildPlan, reviewReport } from '../src/character-gen/report.js';
import {
  currentDef,
  fileSha,
  readProvenance,
  workPath,
  writeProvenance,
  type ItemRecord,
} from '../src/character-gen/state.js';
import { writeDerived } from '../src/character-gen/yaml-write.js';
import { twinWrites } from '../src/character-gen/items.js';
import { loadCharacterSpec, type LayeredSpec } from '@script2video/renderer-remotion';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = join(REPO, 'packages/cli/dist/main.js');

const SPEC = `source: generated
license: test
kind: a girl
views:
  turn: { preset: turn-slight, facing: right }
expressions:
  neutral: {}
  happy: { prompt: smiling }
faces:
  neutral: { view: turn, expression: neutral }
  happy: { view: front, expression: happy }
sets:
  head:
    views: { front: {} }
    faces: [neutral]
`;

const tmp = (name: string) => mkdtempSync(join(tmpdir(), `s2v-${name}-`));

function character(dir: string, yaml = SPEC): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'character.yaml'), yaml);
  return dir;
}

/** Approve the front reference as `pick` does. */
function pickFront(dir: string): void {
  const to = join(dir, 'views', 'front', '_src', 'ref.png');
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, 'front');
  const prov = readProvenance(dir);
  const sha = fileSha(to);
  prov.items[FRONT_REF] = {
    def: 'picked',
    state: 'approved',
    seed: 11,
    prompt: '',
    sha,
    approvedSha: sha,
  };
  writeProvenance(dir, prov);
}

/** Record one item as generated (waiting for review) or approved, with its image on disk. */
function record(dir: string, id: string, state: 'generated' | 'approved'): void {
  const g = loadGraph(dir);
  const it = g.items.get(id)!;
  const work = workPath(dir, id);
  mkdirSync(dirname(work), { recursive: true });
  writeFileSync(work, `img:${id}`);
  const sha = fileSha(work);
  if (state === 'approved') {
    mkdirSync(dirname(join(dir, it.src)), { recursive: true });
    writeFileSync(join(dir, it.src), `img:${id}`);
  }
  const rec: ItemRecord = {
    def: currentDef(g, it)!,
    state,
    seed: 7,
    prompt: '',
    sha,
    ...(state === 'approved' ? { approvedSha: sha } : {}),
  };
  g.prov.items[id] = rec;
  writeProvenance(dir, g.prov);
}

/** Approve every item, inputs first (as rounds do). */
function approveAll(dir: string, except: string[] = []): void {
  for (;;) {
    const g = loadGraph(dir);
    const next = [...g.items.values()].find(
      (it) =>
        !except.includes(it.id) &&
        g.prov.items[it.id]?.state !== 'approved' &&
        it.needs.every((n) => g.prov.items[n]?.state === 'approved') &&
        currentDef(g, it) !== null,
    );
    if (!next) return;
    record(dir, next.id, 'approved');
  }
}

/** Record the layers as derive would after building them now. */
function markDerived(dir: string, repoRoot = REPO): void {
  const g = loadGraph(dir);
  const code = deriveCode(repoRoot)!;
  g.prov.deriveInputs = Object.fromEntries(
    deriveJobs(g).jobs.map((j) => [j.key, partHashes(g, j, code)]),
  );
  writeProvenance(dir, g.prov);
}

/** Every file under a folder with its hash: what a read-only command must leave as it is. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        out[relative(dir, p)] =
          `${statSync(p).mtimeMs}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

function cli(args: string[], env: Record<string, string | undefined> = {}) {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  delete e.S2V_NO_OPEN;
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete e[k];
  const r = spawnSync('node', [CLI, ...args], { cwd: REPO, env: e as NodeJS.ProcessEnv });
  return { status: r.status, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/**
 * A repository root whose imagegen python is a stand-in: derive answers every view (no pivot,
 * no groups — as character.py does for a view without a headless body), or an error for the
 * view named in S2V_FAKE_DERIVE_ERROR.
 */
function fakeRepo(version: string | null = 'DERIVE_VERSION = 1'): string {
  const root = tmp('repo');
  mkdirSync(join(root, 'imagegen', '.venv', 'bin'), { recursive: true });
  writeFileSync(join(root, 'imagegen', 'character.py'), `${version ?? ''}\n`);
  const py = join(root, 'imagegen', '.venv', 'bin', 'python');
  writeFileSync(
    py,
    `#!/usr/bin/env node
const fs = require('fs');
const [, , , step, file] = process.argv;
if (step !== 'derive') process.exit(3);
const job = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = {};
for (const v of job.views)
  out[v.key] = process.env.S2V_FAKE_DERIVE_ERROR === v.key
    ? { error: 'boom' }
    : { pivot: null, groups: {}, bodies: {}, checks: {} };
process.stdout.write(JSON.stringify(out));
`,
  );
  chmodSync(py, 0o755);
  return root;
}

const quiet = { log: () => {} };

describe('derive version', () => {
  it('reads DERIVE_VERSION from imagegen/character.py', () => {
    expect(deriveVersion(REPO)).toBeGreaterThanOrEqual(1);
    expect(deriveCode(REPO)).toMatch(/^py:\d+;ts:\d+$/);
    // no constant: nothing counts as up to date, and it says so
    const logs: string[] = [];
    expect(deriveCode(fakeRepo(null), (m) => logs.push(m))).toBeNull();
    expect(logs.join('\n')).toMatch(/cannot read DERIVE_VERSION/);
  });
});

describe('character build --dry-run --json', { timeout: 60_000 }, () => {
  it('says what is next in every state, and the text says the same', () => {
    const dir = character(join(tmp('build'), 'c'));
    // no front reference yet: pick, with the candidates that can still be picked
    const prov = readProvenance(dir);
    mkdirSync(join(dir, '.work', 'candidates'), { recursive: true });
    for (const n of ['1', '2', '3']) {
      writeFileSync(join(dir, '.work', 'candidates', `${n}.png`), `cand${n}`);
      prov.candidates[n] = {
        seed: 10 + Number(n),
        prompt: '',
        sha: fileSha(join(dir, '.work', 'candidates', `${n}.png`)),
      };
    }
    writeProvenance(dir, prov);
    writeFileSync(join(dir, '.work', 'candidates', '2.png'), 'changed');
    let p = buildPlan(dir, REPO);
    expect([p.state, p.front, p.candidates, p.candidatesAvailable]).toEqual([
      'pick',
      'never-picked',
      3,
      2,
    ]);
    expect(p.next).toBeNull();

    pickFront(dir);
    p = buildPlan(dir, REPO);
    expect(p.state).toBe('generate');
    expect(p.next!.round).toBe(2);
    expect(p.rounds[0]!.round).toBe(2);
    expect(p.remainingImages).toBe(p.rounds.reduce((a, r) => a + r.toMake, 0));
    // the text dry run says the same next round
    const text = cli(['character', 'build', dir, '--dry-run']);
    expect(text.status).toBe(0);
    expect(text.stderr).toContain(
      `next: round 2 (view references and close-ups): ${p.next!.images} images`,
    );
    const json = cli(['character', 'build', dir, '--dry-run', '--json']);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(p);

    // a stopped run's finished output for the same definition is kept
    const id = p.next!.items[0]!.id;
    const g = loadGraph(dir);
    g.prov.inflight = { [id]: currentDef(g, g.items.get(id)!)! };
    writeProvenance(dir, g.prov);
    mkdirSync(join(dir, '.work'), { recursive: true });
    writeFileSync(workPath(dir, id), 'half done');
    expect(buildPlan(dir, REPO).next!.items.find((x) => x.id === id)!.kept).toBe(true);
    const g2 = loadGraph(dir);
    delete g2.prov.inflight;
    writeProvenance(dir, g2.prov);

    // the round's images wait for review
    for (const x of p.next!.items) record(dir, x.id, 'generated');
    const made = p.next!.items.length;
    p = buildPlan(dir, REPO);
    expect([p.state, p.toReview, p.next]).toEqual(['review', made, null]);

    // everything approved: layers never built → derive; built → complete
    approveAll(dir);
    p = buildPlan(dir, REPO);
    expect(p.state).toBe('derive');
    expect(p.rounds).toEqual([]);
    expect(p.staleParts).toContain('full|turn#common');
    expect(cli(['character', 'build', dir, '--dry-run']).stderr).toMatch(/--layers-only/);
    markDerived(dir);
    p = buildPlan(dir, REPO);
    expect([p.state, p.staleParts]).toEqual(['complete', []]);
    // another DERIVE_VERSION: out of date again
    const v2 = fakeRepo('DERIVE_VERSION = 2');
    expect(buildPlan(dir, v2).state).toBe('derive');

    // the front reference deleted from disk
    rmSync(join(dir, 'views', 'front', '_src', 'ref.png'));
    p = buildPlan(dir, REPO);
    expect([p.state, p.front]).toEqual(['pick', 'deleted']);
    expect(cli(['character', 'build', dir, '--dry-run']).status).toBe(1);
  });

  it('writes nothing and starts nothing; @flip twins are what build would write', () => {
    const dir = character(join(tmp('build-ro'), 'c'), `${SPEC}mirror: false\n`);
    pickFront(dir);
    const before = tree(dir);
    // a TTS or aligner port that answers would be asked by the memory check: none is asked
    const r = cli(['character', 'build', dir, '--dry-run', '--json'], {
      S2V_TTS_PORT: '1',
      S2V_ALIGNER_PORT: '1',
    });
    expect(r.status).toBe(0);
    expect(tree(dir)).toEqual(before);
    expect(existsSync(join(dir, '.work'))).toBe(false);
    const p = JSON.parse(r.stdout) as ReturnType<typeof buildPlan>;
    expect(p.twinsToWrite.length).toBeGreaterThan(0);
    // the same as a real write on a copy
    const copy = join(tmp('build-copy'), 'c');
    cpSync(dir, copy, { recursive: true });
    const spec = loadCharacterSpec(copy) as LayeredSpec;
    const w = writeDerived(copy, twinWrites(spec), readProvenance(copy).derived);
    expect(p.twinsToWrite).toEqual(w.writtenPaths);
    expect(readFileSync(join(dir, 'character.yaml'), 'utf8')).toBe(`${SPEC}mirror: false\n`);
    // no folder: nothing on stdout, exit 1
    const none = cli(['character', 'build', join(tmp('none'), 'x'), '--dry-run', '--json']);
    expect([none.status, none.stdout]).toEqual([1, '']);
  });
});

describe('character build --layers-only', { timeout: 60_000 }, () => {
  const prev = process.env.S2V_FAKE_DERIVE_ERROR;
  afterEach(() => {
    if (prev === undefined) delete process.env.S2V_FAKE_DERIVE_ERROR;
    else process.env.S2V_FAKE_DERIVE_ERROR = prev;
  });

  it('builds layers only (no generation) and records them; a failed view is not recorded', async () => {
    const repo = fakeRepo();
    const dir = character(join(tmp('layers'), 'c'));
    pickFront(dir);
    // only the front and the turn references: later rounds are left to make
    record(dir, 'turn/ref', 'approved');
    expect(existsSync(join(dir, '.work'))).toBe(true); // record() made it; start without
    rmSync(join(dir, '.work'), { recursive: true });
    const r = await buildCharacter(dir, { repoRoot: repo, maxGb: 24, ...quiet, layersOnly: true });
    expect(r.failed).toEqual([]);
    // imageStep made .work and its .gitignore on the way (a fresh clone has neither)
    expect(existsSync(join(dir, '.work', 'derive.json'))).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.work/\n');
    expect(readdirSync(join(dir, '.work')).filter((f) => f.startsWith('round-'))).toEqual([]);
    const p = buildPlan(dir, repo);
    expect(p.state).toBe('generate'); // rounds are left, none was made
    expect(p.staleParts).toEqual([]);
    // the front view waits for its headless body (split); the turn view is one image
    expect(Object.keys(readProvenance(dir).deriveInputs!)).toEqual(['full|turn']);

    process.env.S2V_FAKE_DERIVE_ERROR = 'full|turn';
    const bad = await buildCharacter(dir, {
      repoRoot: repo,
      maxGb: 24,
      ...quiet,
      layersOnly: true,
    });
    expect(bad.failed).toEqual(['full|turn']);
    expect(readProvenance(dir).deriveInputs).toEqual({});
    expect(buildPlan(dir, repo).staleParts).toContain('full|turn#common');
  });

  it('a view without a headless body reports no groups and still counts as built', async () => {
    const repo = fakeRepo();
    const dir = character(join(tmp('layers-head'), 'c'));
    pickFront(dir);
    approveAll(dir);
    await buildCharacter(dir, { repoRoot: repo, maxGb: 24, ...quiet, layersOnly: true });
    const g = loadGraph(dir);
    const head = deriveJobs(g).jobs.find((j) => j.key === 'head|front')!;
    expect(head.split).toBe(false);
    expect(Object.keys(readProvenance(dir).deriveInputs!['head|front']!.groups)).toEqual(
      head.groups.map((x) => x.key),
    );
    const { graph, run } = await reviewCharacter(dir, {
      repoRoot: repo,
      maxGb: 24,
      ...quiet,
      check: false,
    });
    const faces = reviewReport(dir, graph, run, repo).faces;
    expect(faces.find((f) => f.key === 'head:neutral')!.ready).toBe(true);
    expect(buildPlan(dir, repo).state).toBe('complete');
  });

  it('without a readable DERIVE_VERSION no layer counts as built, and --layers-only fails', async () => {
    const dir = character(join(tmp('no-version'), 'c'));
    pickFront(dir);
    approveAll(dir);
    markDerived(dir);
    expect(buildPlan(dir, REPO).state).toBe('complete');
    const none = fakeRepo(null);
    expect(buildPlan(dir, none).state).toBe('derive');
    const { graph, run } = await reviewCharacter(dir, {
      repoRoot: none,
      maxGb: 24,
      ...quiet,
      check: false,
    });
    const faces = reviewReport(dir, graph, run, none).faces;
    expect(faces.length).toBeGreaterThan(0);
    expect(faces.filter((f) => f.ready === true)).toEqual([]);
    const r = await buildCharacter(dir, { repoRoot: none, maxGb: 24, ...quiet, layersOnly: true });
    expect(r.failed.length).toBeGreaterThan(0);
  });

  it('a new blink makes the other groups of its view out of date (their eyes may come from it)', () => {
    const spec = SPEC.replace(
      '  happy: { view: front, expression: happy }\n',
      '  happy: { view: front, expression: happy }\n  smile: { view: turn, expression: happy }\n',
    );
    const dir = character(join(tmp('blink'), 'c'), spec);
    pickFront(dir);
    approveAll(dir, ['turn/base/happy/blink']);
    markDerived(dir);
    const face = (k: string) =>
      reviewReport(
        dir,
        loadGraph(dir),
        { recheck: 'none', rechecked: new Set(), onPage: new Set(), page: null },
        REPO,
      ).faces.find((f) => f.key === k)!;
    expect(face('full:neutral').ready).toBe(true);
    // the smile group's blink is approved now: the neutral group of the same view is out of date
    record(dir, 'turn/base/happy/blink', 'approved');
    expect(face('full:neutral').ready).toBe(false);
    expect(face('full:neutral').staleParts).toEqual(['full|turn#group:base/neutral']);
    expect(face('full:happy').ready).toBe(true); // another view
    expect(buildPlan(dir, REPO).staleParts).toContain('full|turn#group:base/neutral');
  });

  it('build and review refuse flags that would do nothing (S3)', () => {
    for (const args of [
      ['character', 'build', 'x', '--json'],
      ['character', 'build', 'x', '--dry-run', '--json', '--reset-derived'],
      ['character', 'build', 'x', '--dry-run', '--no-open'],
      ['character', 'review', 'x', '--apply'],
      ['character', 'missing', 'x.md', '--dry-run'],
    ]) {
      const r = cli(args);
      expect([r.status, r.stdout], args.join(' ')).toEqual([2, '']);
    }
    // the text dry run still takes --reset-derived (as before)
    expect(
      cli(['character', 'build', join(tmp('none'), 'x'), '--dry-run', '--reset-derived']).status,
    ).toBe(1);
  });

  it('exits 1 only when --layers-only could not build or record a view', () => {
    expect(buildExitCode({ layersOnly: true }, { failed: ['full|turn'] })).toBe(1);
    expect(buildExitCode({ layersOnly: true }, { failed: [] })).toBe(0);
    expect(buildExitCode({ layersOnly: false }, { failed: ['full|turn'] })).toBe(0);
  });

  it('refuses the dry run, --json, --no-open and --max-memory-gb', () => {
    for (const extra of [['--dry-run'], ['--json'], ['--no-open'], ['--max-memory-gb', '24']]) {
      const r = cli(['character', 'build', 'x', '--layers-only', ...extra]);
      expect(r.status, extra.join(' ')).toBe(2);
    }
  });
});

describe('character review --json', { timeout: 60_000 }, () => {
  let stub: string;
  let marker: string;
  beforeEach(() => {
    stub = tmp('open');
    marker = join(stub, 'opened');
    for (const name of ['open', 'xdg-open']) {
      writeFileSync(join(stub, name), `#!/bin/sh\necho "$@" >> "${marker}"\n`);
      chmodSync(join(stub, name), 0o755);
    }
  });
  const opened = async (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      if (existsSync(marker)) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return existsSync(marker);
  };

  it('--no-check only reads; items, views, faces and layer files', () => {
    const dir = character(join(tmp('review'), 'c'));
    pickFront(dir);
    approveAll(dir, ['turn/base/neutral/blink']);
    markDerived(dir);
    // layer files: one as derive wrote it, one edited, one never recorded, one recorded and gone
    mkdirSync(join(dir, 'views', 'turn', 'body'), { recursive: true });
    for (const f of ['same', 'edited', 'untracked'])
      writeFileSync(join(dir, 'views', 'turn', 'body', `${f}.png`), f);
    const prov = readProvenance(dir);
    prov.layers = {
      'views/turn/body/same.png': fileSha(join(dir, 'views', 'turn', 'body', 'same.png')),
      'views/turn/body/edited.png': 'old',
      'views/turn/body/gone.png': 'x',
    };
    prov.derive = {
      'full|turn': {
        pivot: [1, 2],
        groups: {},
        bodies: {},
        checks: { 'base/neutral': { silhouette: { value: 0.9312, ok: false, limit: '≥ 0.95' } } },
        eyes: { 'base/neutral': { own_open: true, from: null } },
      },
    };
    writeProvenance(dir, prov);
    const before = tree(dir);
    const r = cli(['character', 'review', dir, '--json', '--no-check']);
    expect(r.status).toBe(0);
    expect(tree(dir)).toEqual(before);
    const rep = JSON.parse(r.stdout);
    expect([rep.recheck, rep.page]).toEqual(['none', null]);
    expect(rep.items.every((i: { onPage: boolean }) => !i.onPage)).toBe(true);
    const blink = rep.items.find((i: { id: string }) => i.id === 'turn/base/neutral/blink');
    expect(blink.status).toBe('missing');
    const half = rep.items.find((i: { id: string }) => i.id === 'turn/base/neutral/half');
    expect([half.status, half.workMatches, half.srcSha === half.approvedSha]).toEqual([
      'approved',
      true,
      true,
    ]);
    // faces: neutral waits for its blink; happy (front) is ready; the head close-up too
    const face = (k: string) => rep.faces.find((f: { key: string }) => f.key === k);
    expect(face('full:neutral').ready).toBe(false);
    expect(face('full:neutral').pending).toEqual(['turn/base/neutral/blink']);
    expect(face('full:neutral').warnings.join('\n')).toMatch(/silhouette 0.9312/);
    expect(face('full:happy').ready).toBe(true);
    expect(face('head:neutral').ready).toBe(true);
    const turn = rep.views.find(
      (v: { set: string; view: string }) => v.set === 'full' && v.view === 'turn',
    );
    expect(turn.failedChecks).toEqual([
      {
        part: 'group:base/neutral',
        check: 'silhouette',
        value: 0.9312,
        ok: false,
        limit: '≥ 0.95',
      },
    ]);
    expect(turn.eyesOpen).toEqual([{ group: 'base/neutral', from: null }]);
    expect(rep.layers.map((l: { path: string; state: string }) => [l.path, l.state])).toEqual([
      ['views/turn/body/edited.png', 'edited'],
      ['views/turn/body/gone.png', 'gone'],
      ['views/turn/body/same.png', 'same'],
      ['views/turn/body/untracked.png', 'untracked'],
    ]);
    // the same bytes again
    expect(cli(['character', 'review', dir, '--json', '--no-check']).stdout).toBe(r.stdout);

    // a group's layers out of date: only the faces that use it
    const p2 = readProvenance(dir);
    p2.deriveInputs!['full|front']!.groups['base/happy'] = 'old';
    writeProvenance(dir, p2);
    const rep2 = JSON.parse(cli(['character', 'review', dir, '--json', '--no-check']).stdout);
    const f2 = (k: string) => rep2.faces.find((f: { key: string }) => f.key === k);
    expect(f2('full:happy').ready).toBe(false);
    expect(f2('full:happy').staleParts).toEqual(['full|front#group:base/happy']);
    expect(f2('head:neutral').ready).toBe(true);
  });

  it('both sides: a mirror: false character draws the other side from its @flip view', async () => {
    const dir = character(join(tmp('review-flip'), 'c'), `${SPEC}mirror: false\n`);
    pickFront(dir);
    const repo = fakeRepo();
    // twins first (build writes them), then approve everything and build the layers
    const spec = loadCharacterSpec(dir) as LayeredSpec;
    const prov = readProvenance(dir);
    writeDerived(dir, twinWrites(spec), prov.derived);
    writeProvenance(dir, prov);
    approveAll(dir);
    markDerived(dir, repo);
    const g = loadGraph(dir);
    expect(
      reviewReport(
        dir,
        g,
        { recheck: 'none', rechecked: new Set(), onPage: new Set(), page: null },
        repo,
      ).faces.find((f) => f.key === 'full:neutral')!.ready,
    ).toBe(true);
    const flip = [...viewLayers(g, deriveCode(repo)).keys()].find((k) => k.includes('@flip'))!;
    const p = readProvenance(dir);
    p.deriveInputs![flip]!.groups['base/neutral'] = 'old';
    writeProvenance(dir, p);
    const f = reviewReport(
      dir,
      loadGraph(dir),
      { recheck: 'none', rechecked: new Set(), onPage: new Set(), page: null },
      repo,
    ).faces.find((x) => x.key === 'full:neutral')!;
    expect(f.ready).toBe(false);
    expect(f.staleParts).toEqual([`${flip}#group:base/neutral`]);
  });

  it('the page mode writes the page (a fresh folder has no .work) and opens it unless --no-open', async () => {
    const dir = character(join(tmp('review-page'), 'c'));
    pickFront(dir);
    expect(existsSync(join(dir, '.work'))).toBe(false);
    const env = { PATH: `${stub}:${process.env.PATH}` };
    const quietRun = cli(['character', 'review', dir, '--json', '--no-open'], env);
    expect(quietRun.status).toBe(0);
    const rep = JSON.parse(quietRun.stdout);
    expect(rep.page).toBe('.work/review.html');
    expect(existsSync(join(dir, '.work', 'review.html'))).toBe(true);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('.work/\n');
    expect(await opened(1500)).toBe(false);
    expect(cli(['character', 'review', dir, '--json'], env).status).toBe(0);
    expect(await opened(3000)).toBe(true);
    // --no-check is a --json mode, and it has no page to open
    expect(cli(['character', 'review', dir, '--no-check']).status).toBe(2);
    expect(cli(['character', 'review', dir, '--json', '--no-check', '--no-open']).status).toBe(2);
  });

  it('a recheck without the image environment keeps the round checks and says so', async () => {
    const dir = character(join(tmp('review-fail'), 'c'));
    pickFront(dir);
    record(dir, 'turn/ref', 'generated');
    const prov = readProvenance(dir);
    prov.items['turn/ref']!.checks = {
      noise: { value: 0.8123, ok: true, limit: '≤ 2' },
      change: { value: 0.0042, ok: false, limit: '≥ 0.005' },
    };
    writeProvenance(dir, prov);
    const logs: string[] = [];
    const { graph, run } = await reviewCharacter(dir, {
      repoRoot: tmp('no-imagegen'),
      maxGb: 24,
      log: (m) => logs.push(m),
      open: false,
    });
    expect(run.recheck).toBe('failed');
    expect(logs.join('\n')).toMatch(/could not check the images again/);
    const rep = reviewReport(dir, graph, run, REPO);
    const it = rep.items.find((i) => i.id === 'turn/ref')!;
    expect([it.rechecked, it.onPage, it.workMatches]).toEqual([false, true, true]);
    // the checks as recorded (names in order, values as Python wrote them)
    expect(Object.keys(it.checks!)).toEqual(['change', 'noise']);
    expect(it.checks!.noise!.value).toBe(0.8123);
    expect(rep.page).toBe('.work/review.html');
    // the .work image changed: approve would refuse it
    writeFileSync(workPath(dir, 'turn/ref'), 'other');
    const after = reviewReport(dir, loadGraph(dir), run, REPO);
    expect(after.items.find((i) => i.id === 'turn/ref')!.workMatches).toBe(false);
  });
});

describe('character missing --json', { timeout: 60_000 }, () => {
  it('reports every cast with a character: judged, unknown, missing folder, unreadable, not generated', () => {
    const root = tmp('missing');
    const chars = join(root, 'chars');
    // a: made by build, everything approved and built
    const a = character(join(chars, 'a'));
    pickFront(a);
    approveAll(a);
    markDerived(a);
    // b: generated yaml but no provenance.json (hand-made): (c) unknown
    character(join(chars, 'b'));
    // d: unreadable yaml
    character(join(chars, 'd'), 'source: generated\nviews: [\n');
    // e: a folder of images (not parts)
    mkdirSync(join(chars, 'e'), { recursive: true });
    const script = join(root, 'v', 'script.ko.md');
    mkdirSync(dirname(script), { recursive: true });
    const cast = (k: string) => `  ${k}: { voice: "qwen:Sohee", character: ../chars/${k} }\n`;
    writeFileSync(
      script,
      `---\nlang: ko\ncast:\n${['a', 'b', 'c', 'd', 'e'].map(cast).join('')}---\n\n# s {#s}\n\na: 안녕.\n\nb: 네.\n`,
    );
    const r = cli(['character', 'missing', script, '--json']);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/\(a\) not defined/);
    const rep = JSON.parse(r.stdout);
    const by = (k: string) => rep.find((x: { cast: string }) => x.cast === k);
    expect(rep.map((x: { cast: string }) => x.cast)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(by('a')).toMatchObject({
      checked: true,
      managed: true,
      unknown: false,
      notReady: [],
      count: 0,
      dir: '../chars/a',
    });
    expect(by('b')).toMatchObject({
      checked: true,
      managed: false,
      unknown: true,
      notReady: null,
      count: 0,
    });
    expect(by('c')).toMatchObject({ checked: false, reason: 'no-folder', notInSet: null });
    expect(by('d')).toMatchObject({ checked: false, reason: 'invalid' });
    expect(by('d').message).not.toContain(root);
    expect(by('e')).toMatchObject({ checked: false, reason: 'not-parts', message: null });
    // the same bytes again
    expect(cli(['character', 'missing', script, '--json']).stdout).toBe(r.stdout);
    // the text: unknown and the folder that is not there
    const text = cli(['character', 'missing', script]);
    expect(text.status).toBe(1);
    expect(text.stderr).toMatch(/\(c\) unknown: no provenance\.json/);
    expect(text.stderr).toMatch(/c: no character folder \.\.\/chars\/c/);
    // --apply skips what was not judged (no throw on the unreadable one)
    const applied = cli(['character', 'missing', script, '--apply', '--json']);
    expect(applied.status).toBe(1);
    expect(JSON.parse(applied.stdout).map((x: { added: unknown[] }) => x.added)).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
  });

  it('a generated character without provenance.json alone fails (its (c) is unknown)', () => {
    const root = tmp('missing-unknown');
    character(join(root, 'chars', 'b'));
    const script = join(root, 'v', 'script.ko.md');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(
      script,
      '---\nlang: ko\ncast:\n  b: { voice: "qwen:Sohee", character: ../chars/b }\n---\n\n# s {#s}\n\nb: 안녕.\n',
    );
    const json = cli(['character', 'missing', script, '--json']);
    expect(json.status).toBe(1);
    expect(JSON.parse(json.stdout)[0]).toMatchObject({ unknown: true, count: 0 });
    const text = cli(['character', 'missing', script]);
    expect(text.status).toBe(1);
    expect(text.stderr).toMatch(/\(c\) unknown/);
  });

  it('counts faces, not lines; out-of-date layers are (c) with the command to rebuild them', () => {
    const root = tmp('missing-count');
    const a = character(join(root, 'chars', 'a'));
    pickFront(a);
    approveAll(a);
    const script = join(root, 'v', 'script.ko.md');
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(
      script,
      '---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: ../chars/a }\n---\n\n# s {#s}\n\na{face=shy}: 안녕.\n\na{face=sly}: 네.\n',
    );
    // layers never built: the faces used are (c), two undefined faces are (a) — 2 faces, not 3 lines
    const rep = JSON.parse(cli(['character', 'missing', script, '--json']).stdout)[0];
    expect(rep.notDefined).toEqual(['shy', 'sly']);
    expect(rep.notReady.length).toBeGreaterThan(0);
    expect(rep.notReady[0].items).toEqual([]);
    expect(rep.notReady[0].staleParts.length).toBeGreaterThan(0);
    expect(rep.count).toBe(2 + rep.notReady.length);
    expect(cli(['character', 'missing', script]).stderr).toMatch(
      /layers not rebuilt .*--layers-only/,
    );
    markDerived(a);
    const after = JSON.parse(cli(['character', 'missing', script, '--json']).stdout)[0];
    expect([after.notReady, after.count]).toEqual([[], 2]);
  });
});
