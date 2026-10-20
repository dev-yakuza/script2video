/**
 * S8 on the generation side, in process (a stand-in python, no image model): the gen lock and its
 * preflight (C5), and a character's work lock held by every command that writes it (C6).
 */
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { actorLockPath, ActorBusyError } from '../src/actor-lock.js';
import {
  approveItems,
  buildCharacter,
  createCharacter,
  pickCandidate,
  redoItems,
  reviewCharacter,
} from '../src/character-gen/commands.js';
import { FRONT_REF } from '../src/character-gen/items.js';
import { buildPlan } from '../src/character-gen/report.js';
import { fileSha, readProvenance, writeProvenance } from '../src/character-gen/state.js';
import { BusyError, heavyLockPath } from '../src/heavy-lock.js';
import { imagegenSupported, ramGb, setupImagegen } from '../src/imagegen.js';
import { TTS_SERVER } from '../src/services.js';
import { deadPid, healthStub, killChildren, livePid, tmp, writeOwner } from './lock-helpers.js';

afterAll(killChildren);
// what a test put there as another program would have
afterEach(() => {
  rmSync(heavyLockPath(), { recursive: true, force: true });
  rmSync(join(process.env.S2V_STATE_DIR!, 'resident.json'), { force: true });
});

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
`;

function character(): string {
  const dir = join(tmp('gen-char'), 'c');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'character.yaml'), SPEC);
  return dir;
}

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

/** A repo whose imagegen python answers derive (and fails anything else). */
function fakeRepo(): string {
  const root = tmp('gen-repo');
  mkdirSync(join(root, 'imagegen', '.venv', 'bin'), { recursive: true });
  writeFileSync(join(root, 'imagegen', 'character.py'), 'DERIVE_VERSION = 1\n');
  const py = join(root, 'imagegen', '.venv', 'bin', 'python');
  writeFileSync(
    py,
    `#!/usr/bin/env node
const fs = require('fs');
const [, , , step, file] = process.argv;
if (step !== 'derive') process.exit(3);
const job = JSON.parse(fs.readFileSync(file, 'utf8'));
const out = {};
for (const v of job.views) out[v.key] = { pivot: null, groups: {}, bodies: {}, checks: {} };
process.stdout.write(JSON.stringify(out));
`,
  );
  chmodSync(py, 0o755);
  return root;
}

/** Every file below a folder (but the work lock itself) with its hash. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (p.startsWith(actorLockPath(dir))) continue;
      if (e.isDirectory()) walk(p);
      else
        out[relative(dir, p)] =
          `${statSync(p).mtimeMs}:${createHash('sha256').update(readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir);
  return out;
}

const quiet = { log: () => {} };

function foreignHeavy(kind: string): void {
  const p = livePid();
  writeOwner(heavyLockPath(), {
    kind,
    pid: p.pid,
    pid_start: p.start,
    holder: `other ${kind}`,
    token: '9a'.repeat(16),
  });
}

async function busyOf(p: Promise<unknown>): Promise<BusyError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(BusyError);
  return e as BusyError;
}

describe('the gen lock (C5)', { timeout: 60_000 }, () => {
  it('(a) build and create are refused while TTS work holds the machine, before generating', async () => {
    const repo = fakeRepo();
    const dir = character();
    pickFront(dir);
    foreignHeavy('tts');
    const e = await busyOf(buildCharacter(dir, { repoRoot: repo, maxGb: 24, ...quiet }));
    expect(e.reason).toBe('lock');
    expect(readProvenance(dir).inflight ?? {}).toEqual({}); // no round was started
    const fresh = character();
    expect(
      (await busyOf(createCharacter(fresh, { repoRoot: repo, maxGb: 24, ...quiet, candidates: 1 })))
        .exitCode,
    ).toBe(73);
  });

  it('(d) --layers-only and --dry-run do not need the machine', async () => {
    const repo = fakeRepo();
    const dir = character();
    pickFront(dir);
    foreignHeavy('tts');
    await buildCharacter(dir, { repoRoot: repo, maxGb: 24, ...quiet, layersOnly: true });
    await buildCharacter(dir, { repoRoot: repo, maxGb: 24, ...quiet, dryRun: true });
  });

  it('(b) a live resident server refuses generation and stays recorded; a dead one is removed', async () => {
    const repo = fakeRepo();
    const dir = character();
    pickFront(dir);
    const p = livePid();
    const resident = join(process.env.S2V_STATE_DIR!, 'resident.json');
    const rec = {
      pid: p.pid,
      pid_start: p.start,
      port: 1,
      server_pgid: null,
      id: 'script2video-tts',
      wrapper_version: '0',
      started: '',
    };
    writeFileSync(resident, JSON.stringify(rec));
    const e = await busyOf(buildCharacter(dir, { repoRoot: repo, maxGb: 24, ...quiet }));
    expect(e.reason).toBe('resident');
    expect(e.message).toMatch(/Ctrl-C the tts-server start terminal/);
    expect(JSON.parse(readFileSync(resident, 'utf8'))).toEqual(rec);
  });

  it('(b) a dead resident.json is removed and generation goes on', async () => {
    const repo = fakeRepo();
    const dir = character();
    pickFront(dir);
    const resident = join(process.env.S2V_STATE_DIR!, 'resident.json');
    writeFileSync(
      resident,
      JSON.stringify({
        pid: deadPid(),
        pid_start: 'x',
        port: 1,
        server_pgid: null,
        id: 'script2video-tts',
        wrapper_version: '0',
        started: '',
      }),
    );
    const e = await buildCharacter(dir, { repoRoot: repo, maxGb: 24, ...quiet }).catch(
      (x: unknown) => x,
    );
    // it goes on to the round (which the stand-in cannot run): not refused as busy
    expect(e).not.toBeInstanceOf(BusyError);
    expect(() => statSync(resident)).toThrow();
  });

  it('(c) a server answering the TTS port: 73 (orphan)', async () => {
    const repo = fakeRepo();
    const dir = character();
    pickFront(dir);
    const stub = await healthStub(() => ({
      id: TTS_SERVER.id,
      lock_hash: 'x',
      wrapper_version: '0',
    }));
    const was = process.env.S2V_TTS_PORT;
    process.env.S2V_TTS_PORT = String(stub.port);
    try {
      const e = await busyOf(buildCharacter(dir, { repoRoot: repo, maxGb: 24, ...quiet }));
      expect(e.reason).toBe('orphan');
    } finally {
      if (was === undefined) delete process.env.S2V_TTS_PORT;
      else process.env.S2V_TTS_PORT = was;
      stub.server.close();
    }
  });

  it.skipIf(!imagegenSupported() || ramGb() < 31.5)(
    '(e) setup takes the gen lock before anything',
    async () => {
      foreignHeavy('tts');
      const e = await busyOf(setupImagegen(fakeRepo(), { maxGb: 24, ...quiet }));
      expect(e.exitCode).toBe(73);
    },
  );
});

describe('the work lock of a character (C6)', { timeout: 60_000 }, () => {
  function busy(dir: string): number {
    const p = livePid();
    writeOwner(actorLockPath(dir), {
      pid: p.pid,
      pid_start: p.start,
      cmd: 's2v character build c',
      token: '7b'.repeat(16),
    });
    return p.pid;
  }

  it('every command that writes the character is refused (74), nothing written; readers report who works', async () => {
    const repo = fakeRepo();
    const dir = character();
    pickFront(dir);
    const pid = busy(dir);
    const before = tree(dir);
    const gen = { repoRoot: repo, maxGb: 24, ...quiet };
    const refused = async (f: () => unknown) => {
      const e = await Promise.resolve()
        .then(f)
        .then(
          () => null,
          (x: unknown) => x,
        );
      expect(e).toBeInstanceOf(ActorBusyError);
      expect((e as ActorBusyError).exitCode).toBe(74);
    };
    await refused(() => buildCharacter(dir, { ...gen, layersOnly: true }));
    await refused(() => buildCharacter(dir, gen));
    await refused(() => createCharacter(dir, { ...gen, candidates: 1 }));
    await refused(() => approveItems(dir, ['turn/ref'], gen));
    await refused(() => redoItems(dir, ['turn/ref'], undefined, () => {}));
    await refused(() => pickCandidate(dir, '1', () => {}));
    await refused(() => reviewCharacter(dir, { ...gen, open: false }));
    expect(tree(dir)).toEqual(before);
    // readers go on and say who works on it
    await reviewCharacter(dir, { ...gen, check: false });
    expect(buildPlan(dir, repo).running).toMatchObject({ pid, cmd: 's2v character build c' });
    await buildCharacter(dir, { ...gen, dryRun: true });
  });

  it('a dead holder is no obstacle, and the lock is gone from the report', async () => {
    const repo = fakeRepo();
    const dir = character();
    pickFront(dir);
    writeOwner(actorLockPath(dir), {
      pid: deadPid(),
      pid_start: 'x',
      cmd: 'old',
      token: '7c'.repeat(16),
    });
    expect(buildPlan(dir, repo).running).toBeNull();
    await buildCharacter(dir, { repoRoot: repo, maxGb: 24, ...quiet, layersOnly: true });
  });
});
