/**
 * `s2v takes` (stage 3b plan 5a–6): list the takes of each line, and pick or unpick one. Nothing
 * here starts a server or synthesizes; `tts` applies the picks.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { Script } from '@script2video/core';
import { BusyError } from './heavy-lock.js';
import { mockEnabled } from './mock-tts.js';
import {
  dropStaleWithId,
  pickText,
  rawShaOf,
  readPicks,
  readPicksAt,
  shellQuote,
  writePicks,
  type PickLine,
} from './picks.js';
import {
  lastRawTakeIn,
  planSentences,
  rawDirOf,
  rawPathOf,
  takeKeyOf,
  takeMadeOf,
  takesDirOf,
  type LockEntry,
  type LockManifest,
  type SentenceJob,
  type TakeRecord,
} from './tts.js';

export interface Context {
  scriptPath: string;
  scriptArg: string;
  lockDir: string;
  rawDir: string;
  takesDir: string;
  maxPause: number;
  jobs: SentenceJob[];
  plan: ReturnType<typeof planSentences>;
  lock: LockManifest | null;
  mock: boolean;
}

export function context(scriptPath: string, script: Script, repoRoot: string): Context {
  const mock = mockEnabled();
  // pick keys follow S2V_TTS like tts (3b plan 6)
  const plan = planSentences(scriptPath, script, repoRoot, { draft: false, mock });
  const lockDir = join(dirname(scriptPath), 'audio', script.meta.lang);
  const manifestPath = join(lockDir, 'manifest.json');
  return {
    scriptPath,
    scriptArg: shellQuote(relative(process.cwd(), scriptPath) || scriptPath),
    lockDir,
    rawDir: rawDirOf(repoRoot),
    takesDir: takesDirOf(repoRoot),
    maxPause: script.meta.pacing.maxPause,
    jobs: plan.jobs,
    plan,
    lock: readLock(manifestPath),
    mock,
  };
}

/** The audio lock (null: none yet). A half-written one (tts writing it) is an error. */
function readLock(path: string): LockManifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as LockManifest;
  } catch (e) {
    throw new Error(`${path}: cannot read — is tts running? Try again when it is done`, {
      cause: e,
    });
  }
}

/** Lock entries made from the same raw takes (any lock key of the synthesis key). */
const relatedEntries = (c: Context, job: SentenceJob): LockEntry[] =>
  Object.values(c.lock?.entries ?? {}).filter((e) => e.synthKey === job.synthKey);

const madeOf = (e: LockEntry) => Math.max(e.tried ?? e.attempt, e.attempt);

/** What the cache and the lock know about take n of a line. */
function takeInfo(c: Context, job: SentenceJob, n: number) {
  const entry = c.lock?.entries[job.key];
  const record: TakeRecord | undefined =
    entry?.takes?.[n] ?? relatedEntries(c, job).find((e) => e.takes?.[n])?.takes?.[n];
  const tk = takeKeyOf(job, c.maxPause, n);
  const made = existsSync(c.takesDir) ? takeMadeOf(c.takesDir, tk) : null;
  const raw = rawPathOf(c.rawDir, job.synthKey, n);
  return {
    record,
    wav: made ? join(c.takesDir, `${tk}.wav`) : null,
    rawSha: made?.rawSha ?? (existsSync(raw) ? rawShaOf(raw) : undefined),
    rawOnly: !made && existsSync(raw),
  };
}

/** The highest take number made for a line (3b plan 5a). */
export function lastTake(c: Context, job: SentenceJob, pickTried: number): number {
  return Math.max(
    pickTried,
    ...relatedEntries(c, job).map(madeOf),
    c.lock?.entries[job.key] ? madeOf(c.lock.entries[job.key]!) : -1,
    lastRawTakeIn(c.rawDir, job.synthKey),
  );
}

export const matches = (id: string, filters: string[]) =>
  filters.length === 0 || filters.some((f) => id === f || id.startsWith(`${f}:`));

/** `s2v takes <script> --list [--id …]`: the takes of each line as text. */
export function listTakes(
  scriptPath: string,
  script: Script,
  repoRoot: string,
  ids: string[],
): string[] {
  const c = context(scriptPath, script, repoRoot);
  const picks = readPicks(c.lockDir);
  const out: string[] = [];
  for (const e of c.plan.errors) out.push(`${e.id}: ${e.message}`);
  for (const job of c.jobs) {
    if (!matches(job.id, ids)) continue;
    const entry = c.lock?.entries[job.key];
    const pick = picks.picks[job.pickKey];
    const head = [
      `${job.id} "${pickText(job.text)}${[...job.text].length > 20 ? '…' : ''}"`,
      job.acting?.emo ? `emo=${job.acting.emo}${job.power ? ` power=${job.power}` : ''}` : null,
      entry ? `lock: take ${entry.attempt}` : 'lock: none',
      pick ? `pick: take ${pick.take} (${pick.by})` : null,
    ].filter(Boolean);
    out.push(head.join(' · '));
    const last = lastTake(c, job, pick?.tried ?? -1);
    for (let n = 0; n <= last; n++) {
      const t = takeInfo(c, job, n);
      if (!t.record && !t.wav && !t.rawOnly) continue;
      const r = t.record;
      const facts = r
        ? [
            r.ok ? 'pass' : 'fail',
            r.f0 !== null ? `f0 ${r.f0}` : null,
            r.rate !== null ? `rate ${r.rate}` : null,
          ]
            .filter(Boolean)
            .join(' ')
        : 'not judged';
      const where = t.wav ?? (t.rawOnly ? 'raw only (tts makes the take wav)' : 'not cached');
      const marks = [entry?.attempt === n ? 'lock' : null, pick?.take === n ? 'pick' : null]
        .filter(Boolean)
        .join(',');
      out.push(`  take ${n}${marks ? ` [${marks}]` : ''}  ${facts}  ${where}`);
    }
  }
  if (out.length === 0) out.push('no lines match');
  return out;
}

/** The job of a sentence id, or why there is none. */
function jobFor(c: Context, id: string): SentenceJob {
  if (!/^[^:]+:\d+:\d+$/.test(id))
    throw new Error(
      `${id}: give one sentence as scene:paragraph:sentence (s2v sentences lists them)`,
    );
  const job = c.jobs.find((j) => j.id === id);
  if (job) return job;
  if (c.plan.recorded.some((r) => r.items.some((it) => it.id === id)))
    throw new Error(`${id}: a recorded paragraph has no takes`);
  const [scene, block] = id.split(':');
  const err = c.plan.errors.find((e) => e.id === id || e.id === `${scene}:${block}:0`);
  if (err) throw new Error(`${id}: ${err.message}`);
  throw new Error(`${id}: no such sentence (s2v sentences lists them)`);
}

const linesOf = (c: Context): PickLine[] =>
  c.jobs.map((j) => ({ id: j.id, pickKey: j.pickKey, text: j.text }));

/** Stale picks are only judged with real keys and every paragraph planned (3b plan 6). */
const canDropStale = (c: Context) => !c.mock && c.plan.errors.length === 0;

/** `s2v takes pick <script> <id>=<n> …`: write the picks (one write); `tts` applies them. */
export function pickTakes(
  scriptPath: string,
  script: Script,
  repoRoot: string,
  args: string[],
): string[] {
  if (args.length === 0) throw new Error('give at least one <id>=<take>');
  const c = context(scriptPath, script, repoRoot);
  const { file: picks, text: read } = readPicksAt(c.lockDir);
  const out: string[] = [];
  const chosen = new Map<string, { job: SentenceJob; n: number }>();
  for (const arg of args) {
    const m = /^(.+)=(\d+)$/.exec(arg);
    if (!m) throw new Error(`${arg}: write <id>=<take>, e.g. 1:0:2=3`);
    const job = jobFor(c, m[1]!);
    const n = Number(m[2]);
    const same = chosen.get(job.pickKey);
    if (same && same.n !== n)
      throw new Error(
        `${same.job.id} and ${job.id} are the same line and voice (one pick): take ${same.n} or ${n}?`,
      );
    const t = takeInfo(c, job, n);
    const pick = picks.picks[job.pickKey];
    const made = Math.max(
      pick?.tried ?? -1,
      ...relatedEntries(c, job).map(madeOf),
      c.lock?.entries[job.key] ? madeOf(c.lock.entries[job.key]!) : -1,
    );
    if (!t.record && !t.wav && !t.rawOnly && n > made)
      throw new Error(
        `${job.id}: take ${n} was never made — run s2v tts ${c.scriptArg} --retry ${job.id}`,
      );
    if (t.record && !t.record.ok)
      out.push(`${job.id}: take ${n} failed its checks — picked anyway`);
    chosen.set(job.pickKey, { job, n });
    // the first line with this pick key names it
    const first = c.jobs.find((j) => j.pickKey === job.pickKey)!;
    const tried = Math.max(
      n,
      pick?.tried ?? -1,
      ...Object.values(c.lock?.entries ?? {})
        .filter((e) => e.pickKey === job.pickKey)
        .map(madeOf),
    );
    picks.picks[job.pickKey] = {
      take: n,
      id: first.id,
      text: pickText(first.text),
      tried,
      by: 'human',
      ...(t.rawSha ? { rawSha: t.rawSha } : {}),
    };
    if (canDropStale(c))
      for (const l of linesOf(c))
        if (l.pickKey === job.pickKey) dropStaleWithId(picks, linesOf(c), l.id);
    out.push(`${job.id}: take ${n}${pick && pick.take !== n ? ` (was ${pick.take})` : ''}`);
  }
  mkdirSync(c.lockDir, { recursive: true });
  if (writePicks(c.lockDir, picks, read) === null) throw picksChanged();
  out.push(`run s2v tts ${c.scriptArg} to apply`);
  return out;
}

/** picks.json changed while this command worked on it (a tts run wrote it): run again (73). */
const picksChanged = () =>
  new BusyError(
    'changed',
    'the takes picks changed while picking (another command wrote picks.json, a tts run?); run again',
  );

/** `s2v takes unpick <script> <id> …`: back to the automatic choice on the next `tts`. */
export function unpickTakes(
  scriptPath: string,
  script: Script,
  repoRoot: string,
  ids: string[],
): string[] {
  if (ids.length === 0) throw new Error('give at least one sentence id');
  const c = context(scriptPath, script, repoRoot);
  const { file: picks, text: read } = readPicksAt(c.lockDir);
  const out: string[] = [];
  let removed = 0;
  for (const id of ids) {
    const job = jobFor(c, id);
    let n = 0;
    if (picks.picks[job.pickKey]) {
      delete picks.picks[job.pickKey];
      n++;
    }
    // stale picks of this line too: the way to silence their warning
    if (canDropStale(c)) n += dropStaleWithId(picks, linesOf(c), id);
    out.push(n > 0 ? `${id}: unpicked` : `${id}: no pick`);
    removed += n;
  }
  if (removed > 0) {
    if (writePicks(c.lockDir, picks, read) === null) throw picksChanged();
    out.push(`run s2v tts ${c.scriptArg} to choose again`);
  }
  return out;
}
