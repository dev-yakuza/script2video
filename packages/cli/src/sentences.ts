/**
 * `s2v sentences --json` (S9a plan 2.3): every sentence of the script in order, with what a tool
 * needs to judge it without listening — its lock key, voice attributes, the take a person (or a
 * retry) picked, and what the audio lock holds for it. No server runs.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sentenceId, type Acting, type Script } from '@script2video/core';
import { mockEnabled } from './mock-tts.js';
import { readPicks } from './picks.js';
import { lockAsr, planSentences, type LockManifest } from './tts.js';

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export interface SentenceReport {
  id: string;
  cast: string;
  text: string;
  recorded: boolean;
  lockKey: string | null;
  pickKey: string | null;
  acting: Acting | null;
  pick: { take: number; by: 'human' | 'retry'; applied: boolean } | null;
  lock: {
    attempt: number;
    wavSha256: string;
    asr: boolean;
    cer: number | null;
    heard: string;
    checks: string[];
  } | null;
  error: string | null;
}

export function sentencesReport(
  scriptPath: string,
  script: Script,
  repoRoot: string,
): SentenceReport[] {
  const plan = planSentences(scriptPath, script, repoRoot, { draft: false, mock: mockEnabled() });
  const lockDir = join(dirname(scriptPath), 'audio', script.meta.lang);
  const manifestPath = join(lockDir, 'manifest.json');
  let lock: LockManifest | null = null;
  if (existsSync(manifestPath))
    try {
      lock = JSON.parse(readFileSync(manifestPath, 'utf8')) as LockManifest;
    } catch {
      throw new Error(`cannot read ${manifestPath} (is tts running?)`);
    }
  const picks = readPicks(lockDir);
  const jobs = new Map(plan.jobs.map((j) => [j.id, j]));
  const recorded = new Set(plan.recorded.flatMap((r) => r.items.map((i) => i.id)));
  const errors = new Map(plan.errors.map((e) => [e.id, e.message]));
  const out: SentenceReport[] = [];
  for (const scene of script.scenes)
    scene.blocks.forEach((b, bi) => {
      if (b.kind !== 'paragraph') return;
      b.sentences.forEach((s, si) => {
        const id = sentenceId(scene.id, bi, si);
        const key = plan.sentences[id] ?? null;
        const job = jobs.get(id);
        const entry = key ? lock?.entries[key] : undefined;
        const wav = entry ? join(lockDir, entry.src) : null;
        const held = entry && wav && existsSync(wav) ? entry : undefined;
        const p = job ? picks.picks[job.pickKey] : undefined;
        const acting = s.acting && Object.keys(s.acting).length > 0 ? s.acting : null;
        out.push({
          id,
          cast: b.cast,
          text: s.text,
          recorded: recorded.has(id),
          lockKey: key,
          pickKey: job ? job.pickKey : null,
          acting,
          pick: p ? { take: p.take, by: p.by, applied: !!held && held.attempt === p.take } : null,
          lock: held
            ? {
                attempt: held.attempt,
                wavSha256: sha256File(wav!),
                asr: lockAsr(held),
                // what no ASR heard has no CER (as tts writes it)
                cer: lockAsr(held) ? (held.cer ?? null) : null,
                heard: lockAsr(held) ? held.heard : '',
                checks: held.checks ?? [],
              }
            : null,
          // a sentence's own error first (its speed), else its paragraph's (missing recording)
          error: key ? null : (errors.get(id) ?? errors.get(sentenceId(scene.id, bi, 0)) ?? null),
        });
      });
    });
  return out;
}
