/**
 * Human take choices (stage 3b plan 1): `audio/<lang>/picks.json`, committed next to the lock.
 * A pick is keyed by the pick key (synthesis key + power of an emotion line), so it survives
 * post-processing changes and stops applying when the line's text, voice or acting changes.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Pick {
  take: number;
  /** Sentence id and the first characters of its text, for people (refreshed by `tts`). */
  id: string;
  text: string;
  /** Highest take number made for this pick key (a retry starts after it). */
  tried: number;
  by: 'human' | 'retry';
  /** sha of the raw take it was chosen from (absent: not compared). */
  rawSha?: string;
}

export interface PicksFile {
  version: 1;
  picks: Record<string, Pick>;
}

export const PICKS_VERSION = 1;

export const picksPath = (lockDir: string) => join(lockDir, 'picks.json');

/** First characters of a line, as picks.json shows it. */
export const pickText = (text: string) => [...text].slice(0, 20).join('');

/**
 * Read picks.json (missing: empty). A broken file or an unknown version is an error: treating it as
 * empty and writing it back would erase the choices.
 */
export function readPicks(lockDir: string): PicksFile {
  return readPicksAt(lockDir).file;
}

/**
 * picks.json and the text it was read from (null: no file), for writing it back only when nobody
 * else wrote it meanwhile (writePicks `expected`, final review 17).
 */
export function readPicksAt(lockDir: string): { file: PicksFile; text: string | null } {
  const path = picksPath(lockDir);
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  return { file: parsePicks(path, text), text };
}

function parsePicks(path: string, text: string | null): PicksFile {
  if (text === null) return { version: PICKS_VERSION, picks: {} };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`${path}: cannot read (${(e as Error).message}) — fix or remove it`, {
      cause: e,
    });
  }
  const f = data as Partial<PicksFile>;
  if (f.version !== PICKS_VERSION)
    throw new Error(`${path}: version ${String(f.version)} is not supported (supported: 1)`);
  if (typeof f.picks !== 'object' || f.picks === null)
    throw new Error(`${path}: no "picks" object — fix or remove it`);
  return { version: PICKS_VERSION, picks: f.picks };
}

/**
 * picks.json written whole (temp file + rename), keys sorted so diffs stay small. With `expected`
 * (the text read, null for no file), nothing is written when the file is no longer that text —
 * another command wrote it (final review 17) — and null is returned; otherwise the text written.
 * A write between this check and the rename is still possible (milliseconds, as for the audio
 * lock's manifest).
 */
export function writePicks(
  lockDir: string,
  file: PicksFile,
  expected?: string | null,
): string | null {
  const picks = Object.fromEntries(
    Object.keys(file.picks)
      .sort()
      .map((k) => [k, file.picks[k]!]),
  );
  const path = picksPath(lockDir);
  if (expected !== undefined) {
    const now = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (now !== expected) return null;
  }
  const text = `${JSON.stringify({ version: PICKS_VERSION, picks }, null, 2)}\n`;
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return text;
}

/** A sentence as the pick rules see it. */
export interface PickLine {
  id: string;
  pickKey: string;
  text: string;
}

export interface StalePick {
  pickKey: string;
  pick: Pick;
  /** The warning for `tts`. */
  message: string;
}

/**
 * Picks that no longer apply (stage 3b plan 3): their pick key is no current sentence's. Ids are
 * positional, so a pick whose key is still used never counts, whatever its `id` says.
 */
export function stalePicks(file: PicksFile, lines: PickLine[], scriptArg: string): StalePick[] {
  const live = new Set(lines.map((l) => l.pickKey));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const out: StalePick[] = [];
  for (const [pickKey, pick] of Object.entries(file.picks)) {
    if (live.has(pickKey)) continue;
    const now = byId.get(pick.id);
    const unpick = `use the automatic choice: s2v takes unpick ${scriptArg} ${pick.id}`;
    let message: string;
    if (!now)
      message = `a pick (take ${pick.take}) for "${pick.text}…" no longer matches any line — remove it: s2v audio prune ${scriptArg}`;
    else if (pickText(now.text) === pick.text)
      message = `${pick.id}: your pick (take ${pick.take}) no longer applies — the voice or acting of this line changed; choose again: s2v takes ${scriptArg} --list --id ${pick.id}, or ${unpick}`;
    else
      message = `${pick.id}: your pick (take ${pick.take}) was for "${pick.text}…", that line is now "${pickText(now.text)}…" — choose again: s2v takes ${scriptArg} --list --id ${pick.id}, or ${unpick}`;
    out.push({ pickKey, pick, message });
  }
  return out;
}

/** Remove the stale picks carrying `id` (a new choice for that line replaces them). */
export function dropStaleWithId(file: PicksFile, lines: PickLine[], id: string): number {
  let n = 0;
  for (const s of stalePicks(file, lines, ''))
    if (s.pick.id === id) {
      delete file.picks[s.pickKey];
      n++;
    }
  return n;
}

/** Shell quoting for paths in suggested commands. */
export function shellQuote(s: string): string {
  return /^[\w./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** sha used for a raw take (same as the take cache records). */
export const rawShaOf = (path: string) =>
  createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
