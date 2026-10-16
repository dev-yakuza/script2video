/**
 * Persona voices on disk (PLAN 5.8) and `s2v voice create | pick`.
 *
 * A persona is looked up as `voices/<id>.yaml` next to the script, then in each folder above it up
 * to the repository root (the folder holding `.git`), so one persona can be shared by every video
 * in a repository. Outside a repository only the script's folder and its parent are searched.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  analyzeLevels,
  describedGender,
  normalizeForCer,
  parsePersona,
  PERSONA_ID,
  referenceGateFailures,
  roundTripCer,
  referenceText,
  type Lang,
  type LevelAnalysis,
  type Persona,
  type PersonaClip,
} from '@script2video/core';
import { normalizeLoudness } from './media.js';
import { compressPausesInFile, readPcm16 } from './pauses.js';
import { ALIGNER, Service, TTS_SERVER } from './services.js';
import { postprocess, wavDuration } from './tts.js';

const DESIGN_MODEL = 'qwen3-tts-1.7b-voicedesign';
const run = promisify(execFile);

export interface PersonaRef {
  id: string;
  lang: Lang;
  wavPath: string;
  text: string;
  sha256: string;
}

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

export function personaSearchDirs(scriptDir: string): string[] {
  const dirs: string[] = [];
  for (let dir = resolve(scriptDir); ; dir = dirname(dir)) {
    dirs.push(join(dir, 'voices'));
    if (existsSync(join(dir, '.git'))) return dirs;
    if (dirname(dir) === dir) break;
  }
  return dirs.slice(0, 2);
}

export function findPersonaYaml(id: string, scriptDir: string): string | null {
  for (const dir of personaSearchDirs(scriptDir)) {
    const p = join(dir, `${id}.yaml`);
    if (existsSync(p)) return p;
  }
  return null;
}

/** The chosen reference clip of a persona, or an error message saying what to run. */
export function resolvePersona(id: string, lang: Lang, scriptDir: string): PersonaRef | string {
  const yaml = findPersonaYaml(id, scriptDir);
  if (!yaml)
    return `persona "${id}" not found (looked for ${personaSearchDirs(scriptDir)
      .map((d) => join(d, `${id}.yaml`))
      .join(', ')})`;
  const dir = join(dirname(yaml), id);
  const wavPath = join(dir, `${lang}.wav`);
  const metaPath = join(dir, `${lang}.json`);
  if (!existsSync(wavPath) || !existsSync(metaPath))
    return `persona "${id}" has no ${lang} reference clip: run \`s2v voice create ${yaml} --lang ${lang}\``;
  const clip = JSON.parse(readFileSync(metaPath, 'utf8')) as PersonaClip;
  const sha256 = sha256File(wavPath);
  if (sha256 !== clip.sha256)
    return `persona "${id}": ${wavPath} changed since it was picked; pick it again with \`s2v voice pick\``;
  let persona: Persona;
  try {
    persona = parsePersona(readFileSync(yaml, 'utf8'));
  } catch (e) {
    return `persona "${id}": ${yaml} is invalid (${(e as Error).message.replace(/\s+/g, ' ').slice(0, 160)}); it needs a description`;
  }
  if (persona.description !== clip.description || referenceText(persona, lang) !== clip.text)
    return `persona "${id}": ${basename(yaml)} changed since the ${lang} clip was made; run \`s2v voice create ${yaml} --lang ${lang}\``;
  return { id, lang, wavPath, text: clip.text, sha256 };
}

// ---------- trained speakers (acting stage 4) ----------

/** Dimension of a CustomVoice speaker row (Qwen3-TTS 1.7B). */
export const SPEAKER_DIM = 2048;

/** `voices/<id>/<lang>.speaker.json`: the speaker row trained by `s2v voice train`. */
export interface SpeakerFile {
  version: 1;
  vector: number[];
  model: string;
  revision: string;
  referenceSha: string;
  vectorSha: string;
  [k: string]: unknown;
}

/** Largest float32: a larger value would become Infinity when the vector is hashed or used. */
const FLOAT32_MAX = 3.4028234663852886e38;

/** sha256 of the vector as float32 little-endian bytes (the same in tts-server/helpers.py). */
export function vectorShaOf(vector: readonly number[]): string {
  const buf = Buffer.alloc(vector.length * 4);
  vector.forEach((x, i) => buf.writeFloatLE(x, i * 4));
  return createHash('sha256').update(buf).digest('hex');
}

/** A speaker file read and checked, or what is wrong with it. */
export function readSpeaker(path: string): SpeakerFile | string {
  let f: SpeakerFile;
  try {
    f = JSON.parse(readFileSync(path, 'utf8')) as SpeakerFile;
  } catch (e) {
    return `${path}: cannot read (${(e as Error).message})`;
  }
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return `${path}: not a speaker file`;
  if (f.version !== 1) return `${path}: version ${String(f.version)} is not supported`;
  if (
    !Array.isArray(f.vector) ||
    f.vector.length !== SPEAKER_DIM ||
    !f.vector.every((x) => typeof x === 'number' && Math.abs(x) <= FLOAT32_MAX)
  )
    return `${path}: vector must be ${SPEAKER_DIM} finite numbers`;
  // the file's own sha is not trusted: a damaged or hand-edited vector is an error
  if (vectorShaOf(f.vector) !== f.vectorSha)
    return `${path}: vectorSha does not match the vector (damaged or edited) — train again`;
  return f;
}

/** Why there is no usable trained speaker: not made yet (or no persona), or a damaged file. */
export interface TrainedProblem {
  kind: 'missing' | 'damaged';
  message: string;
}
export const isTrainedProblem = (t: TrainedSpeaker | TrainedProblem): t is TrainedProblem =>
  'kind' in t;

export interface TrainedSpeaker {
  id: string;
  lang: Lang;
  path: string;
  vectorSha: string;
  referenceSha: string;
  revision: string;
}

/**
 * The trained speaker of a persona, from the folder next to its yaml only (not another voices/
 * folder), or an error saying what to run. It does not need the reference clip to be current: a
 * changed clip is a lint warning (train again), not an error.
 */
export function resolveTrained(
  id: string,
  lang: Lang,
  scriptDir: string,
): TrainedSpeaker | TrainedProblem {
  const yaml = findPersonaYaml(id, scriptDir);
  if (!yaml)
    return {
      kind: 'missing',
      message: `persona "${id}" not found (looked for ${personaSearchDirs(scriptDir)
        .map((d) => join(d, `${id}.yaml`))
        .join(', ')})`,
    };
  const path = join(dirname(yaml), id, `${lang}.speaker.json`);
  if (!existsSync(path))
    return {
      kind: 'missing',
      message: `persona "${id}" has no trained ${lang} speaker: run \`s2v voice train ${yaml} --lang ${lang}\` (or use personaModel: clone)`,
    };
  const f = readSpeaker(path);
  if (typeof f === 'string') return { kind: 'damaged', message: f };
  return {
    id,
    lang,
    path,
    vectorSha: f.vectorSha,
    referenceSha: f.referenceSha,
    revision: f.revision,
  };
}

function loadPersona(yamlPath: string): { id: string; persona: Persona; dir: string } {
  const id = basename(yamlPath).replace(/\.ya?ml$/, '');
  if (!PERSONA_ID.test(id))
    throw new Error(
      `persona file name must be <id>.yaml with id matching ${PERSONA_ID}: ${yamlPath}`,
    );
  const persona = parsePersona(readFileSync(yamlPath, 'utf8'));
  return { id, persona, dir: join(dirname(resolve(yamlPath)), id) };
}

async function play(path: string): Promise<void> {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['afplay', [path]]
      : ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'error', path]];
  await new Promise<void>((res) =>
    spawn(cmd as string, args as string[], { stdio: 'ignore' }).on('exit', () => res()),
  );
}

/** Longest pause kept inside a reference clip (the clone copies the clip's rhythm). */
const REF_MAX_PAUSE = 0.7;
/** Silence after the last word: the clip ends cleanly instead of on the last sample. */
const REF_END_PAD_S = 0.3;
/**
 * How a VoiceDesign output becomes a reference clip; candidates finished another way are finished
 * again from their raw output. Breaths are kept (removing them made the pauses sound cut).
 */
const REF_FINISH = 'ref2-level-pause0.7-fade-pad0.3';
/**
 * Reference clips are leveled: the Base model clones the clip's loudness too, and VoiceDesign
 * clips vary by 20 dB (a quiet clip gives a quiet persona and a noisy boost later).
 */
const REF_LUFS = -20;

interface CandidateCheck {
  duration: number;
  cer: number;
  heard: string;
  /** Median pitch (Hz): tells the candidates apart (lower / higher voice). */
  f0: number | null;
  /** Normalized characters per second. */
  rate: number;
  levels: LevelAnalysis;
  /** Failed reference gates (empty: usable). */
  fails: string[];
}

function levelsOf(wav: string): LevelAnalysis {
  const { rate, samples } = readPcm16(wav);
  return analyzeLevels(
    Float32Array.from(samples, (x) => x / 32768),
    rate,
  );
}

/**
 * Gates of a reference clip (acting plan 3.6): read right, the described gender's pitch, a quiet
 * noise floor, pauses between the sentences, an ending that is not cut. Each candidate is judged
 * on its raw VoiceDesign output when there is one (the finished clip has faded, padded edges).
 */
async function checkCandidates(
  clips: { judge: string; finished: string }[],
  text: string,
  description: string,
  lang: Lang,
  repoRoot: string,
  log: (m: string) => void,
): Promise<CandidateCheck[]> {
  const aligner = new Service(ALIGNER, repoRoot);
  const wasRunning = (await aligner.health()) !== null;
  if (!wasRunning) log('starting aligner (transcribe + pitch) ...');
  await aligner.ensure();
  try {
    const out: CandidateCheck[] = [];
    const chars = [...normalizeForCer(text, lang)].length;
    const gender = describedGender(description);
    for (const { judge, finished } of clips) {
      const { data: t } = await aligner.post<{ text: string }>('/transcribe', {
        wav_path: judge,
        lang,
      });
      const { data: p } = await aligner.post<{ median_hz: number | null }>('/pitch', {
        wav_path: judge,
      });
      const duration = wavDuration(finished);
      const cer = roundTripCer(text, t.text, lang);
      const levels = levelsOf(judge);
      out.push({
        duration,
        cer,
        heard: t.text,
        f0: p.median_hz,
        rate: chars / duration,
        levels,
        fails: referenceGateFailures({ text, cer, chars, f0: p.median_hz, gender, levels }),
      });
    }
    return out;
  } finally {
    if (!wasRunning) aligner.stop();
  }
}

const describe = (c: CandidateCheck) =>
  `${c.duration.toFixed(1)}s, ${c.rate.toFixed(1)} chars/s, pitch ${c.f0 ? `${Math.round(c.f0)} Hz` : '?'}, ` +
  `CER ${(c.cer * 100).toFixed(0)}%, noise ${c.levels.floorDb.toFixed(0)} dB, ` +
  `pauses ${c.levels.gaps.map((g) => `${g}s`).join(' ') || 'none'}` +
  (c.fails.length ? ` — fails: ${c.fails.join('; ')}` : ' — passes');

/** Raw VoiceDesign output → reference clip: level, shorten long pauses, fade, pad, level. */
async function finishReference(raw: string, wav: string): Promise<void> {
  await postprocess(raw, wav, null);
  // Level first: pauses are found at a fixed -40 dBFS, which must sit under a leveled voice.
  await normalizeLoudness(wav, REF_LUFS);
  compressPausesInFile(wav, REF_MAX_PAUSE);
  const tmp = `${wav}.fade.wav`;
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    wav,
    '-af',
    `afade=t=in:d=0.01,areverse,afade=t=in:d=0.03,areverse,apad=pad_dur=${REF_END_PAD_S}`,
    '-c:a',
    'pcm_s16le',
    tmp,
  ]);
  renameSync(tmp, wav);
  await normalizeLoudness(wav, REF_LUFS);
}

export interface CreateOptions {
  lang: Lang;
  candidates: number;
  play: boolean;
  log: (m: string) => void;
}

/**
 * Generate reference-clip candidates with VoiceDesign (each one a different voice that fits the
 * description) and write a listening page. With one candidate it is picked right away.
 */
export async function createVoice(
  yamlPath: string,
  repoRoot: string,
  opts: CreateOptions,
): Promise<string[]> {
  const { id, persona, dir } = loadPersona(yamlPath);
  const text = referenceText(persona, opts.lang);
  const candDir = join(dir, 'candidates');
  mkdirSync(candDir, { recursive: true });
  const revision = (
    JSON.parse(readFileSync(join(repoRoot, 'models.lock.json'), 'utf8')) as {
      models: Record<string, { revision: string }>;
    }
  ).models[DESIGN_MODEL]!.revision;

  // Candidates are deterministic per (description, sentence, n): keep the ones already made, so
  // asking for more only generates the new numbers.
  const existing = (n: number): string | null => {
    const base = join(candDir, `${opts.lang}-${n}`);
    if (!existsSync(`${base}.wav`) || !existsSync(`${base}.json`)) return null;
    const c = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as PersonaClip;
    return c.description === persona.description && c.text === text && c.revision === revision
      ? `${base}.wav`
      : null;
  };
  // Candidates finished another way are finished again from their raw output (the voice itself
  // is unchanged); without a raw output they are only leveled.
  const refinish = async (n: number) => {
    const base = join(candDir, `${opts.lang}-${n}`);
    const c = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as PersonaClip;
    if (c.finish === REF_FINISH) return;
    if (existsSync(`${base}.raw.wav`)) await finishReference(`${base}.raw.wav`, `${base}.wav`);
    else if (c.lufs !== REF_LUFS) await normalizeLoudness(`${base}.wav`, REF_LUFS);
    else return;
    const finish = existsSync(`${base}.raw.wav`) ? { finish: REF_FINISH } : {};
    writeFileSync(
      `${base}.json`,
      JSON.stringify(
        { ...c, lufs: REF_LUFS, ...finish, sha256: sha256File(`${base}.wav`) },
        null,
        2,
      ),
    );
  };
  const made: string[] = [];
  const todo: number[] = [];
  for (let n = 1; n <= opts.candidates; n++) {
    const wav = existing(n);
    if (wav) {
      await refinish(n);
      made[n - 1] = wav;
    } else todo.push(n);
  }
  if (todo.length > 0) opts.log(`designing ${todo.length} candidate(s) ...`);

  const service = new Service(TTS_SERVER, repoRoot);
  const wasRunning = todo.length === 0 || (await service.health()) !== null;
  if (!wasRunning) opts.log('starting tts-server ...');
  if (todo.length > 0) await service.ensure();
  try {
    for (const n of todo) {
      const { data, headers } = await service.post<Buffer>('/design', {
        lang: opts.lang,
        text,
        instruct: persona.description,
        seed_material: JSON.stringify(['persona', id, opts.lang, persona.description, text, n]),
      });
      const info = JSON.parse(headers.get('x-s2v-meta') ?? '{}') as { seed: number };
      const raw = join(candDir, `${opts.lang}-${n}.raw.wav`);
      const wav = join(candDir, `${opts.lang}-${n}.wav`);
      writeFileSync(raw, data);
      await finishReference(raw, wav);
      const clip: PersonaClip = {
        id,
        lang: opts.lang,
        description: persona.description,
        text,
        seed: info.seed,
        model: DESIGN_MODEL,
        revision,
        sha256: sha256File(wav),
        candidate: n,
        lufs: REF_LUFS,
        finish: REF_FINISH,
        created: new Date().toISOString(),
      };
      writeFileSync(join(candDir, `${opts.lang}-${n}.json`), JSON.stringify(clip, null, 2));
      made[n - 1] = wav;
    }
  } finally {
    if (!wasRunning) service.stop();
  }
  const rawOf = (wav: string) => wav.replace(/\.wav$/, '.raw.wav');
  const checks = await checkCandidates(
    made.map((wav) => ({ judge: existsSync(rawOf(wav)) ? rawOf(wav) : wav, finished: wav })),
    text,
    persona.description,
    opts.lang,
    repoRoot,
    opts.log,
  );
  for (const [i, c] of checks.entries()) {
    const base = join(candDir, `${opts.lang}-${i + 1}.json`);
    const clip = JSON.parse(readFileSync(base, 'utf8')) as PersonaClip;
    writeFileSync(base, JSON.stringify({ ...clip, gates: c.fails }, null, 2));
  }
  // Passing candidates first (acting plan 3.6); among the rest, fewest failed gates first.
  const order = checks
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.fails.length - b.c.fails.length || a.i - b.i);
  const passing = order.filter(({ c }) => c.fails.length === 0).length;
  for (const { c, i } of order) {
    opts.log(`  candidate ${i + 1}: ${describe(c)}  ${made[i]}`);
    if (opts.play) await play(made[i]!);
  }
  if (passing === 0)
    opts.log(
      `warning: no candidate passes the reference checks; a clone copies the clip's noise, rhythm and ` +
        `cut ending. Try more candidates (--candidates ${opts.candidates + 3}) or pick the least bad one.`,
    );

  const page = join(candDir, `${opts.lang}.html`);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  writeFileSync(
    page,
    [
      `<!doctype html><meta charset=utf-8><title>${esc(id)} (${opts.lang})</title>`,
      '<style>body{font-family:system-ui;max-width:760px;margin:24px auto;padding:0 16px}' +
        'li{margin:12px 0}.fail{opacity:.6}.bad{color:#b91c1c}</style>',
      `<h1>${esc(id)} · ${opts.lang}</h1><p>${esc(persona.description)}</p><p>“${esc(text)}”</p>`,
      `<p>${passing} of ${checks.length} candidate(s) pass the reference checks; they come first.</p><ol>`,
      ...order.map(
        ({ c, i }) =>
          `<li${c.fails.length ? ' class=fail' : ''}><b>${i + 1}</b> <audio controls preload=none src="${opts.lang}-${i + 1}.wav"></audio>` +
          `<br><small>${esc(describe(c))}<br>heard: ${esc(c.heard)}</small>` +
          `<br><code>s2v voice pick ${esc(yamlPath)} ${i + 1} --lang ${opts.lang}</code></li>`,
      ),
      '</ol>',
    ].join('\n'),
  );
  if (opts.candidates === 1 && passing === 1) pickVoice(yamlPath, 1, opts.lang, opts.log);
  else
    opts.log(
      `listen: open ${page}\nthen: s2v voice pick ${yamlPath} <n> --lang ${opts.lang}` +
        (opts.candidates === 1 ? ' (not picked automatically: it fails the checks)' : ''),
    );
  return made;
}

/** Make candidate `n` the persona's reference clip for `lang`. */
export function pickVoice(yamlPath: string, n: number, lang: Lang, log: (m: string) => void): void {
  const { id, dir } = loadPersona(yamlPath);
  const src = join(dir, 'candidates', `${lang}-${n}`);
  if (!existsSync(`${src}.wav`) || !existsSync(`${src}.json`))
    throw new Error(
      `no candidate ${n} for ${lang}: run \`s2v voice create ${yamlPath} --lang ${lang}\``,
    );
  copyFileSync(`${src}.wav`, join(dir, `${lang}.wav`));
  const clip = JSON.parse(readFileSync(`${src}.json`, 'utf8')) as PersonaClip;
  writeFileSync(
    join(dir, `${lang}.json`),
    JSON.stringify({ ...clip, sha256: sha256File(join(dir, `${lang}.wav`)) }, null, 2),
  );
  log(`persona "${id}" (${lang}) now uses candidate ${n} → ${join(dir, `${lang}.wav`)}`);
  if (clip.gates?.length)
    log(`warning: candidate ${n} fails the reference checks: ${clip.gates.join('; ')}`);
  log('its voice reference (pitch, similarity) is made again on the next `s2v tts`');
}

/**
 * `s2v voice check`: judge a persona's committed reference clip with the same gates as new
 * candidates (it is measured as finished, so pauses are already shortened). Nothing is changed;
 * whether to make a new clip is the user's call. Returns the failed gates.
 */
export async function checkVoice(
  yamlPath: string,
  lang: Lang,
  repoRoot: string,
  log: (m: string) => void,
): Promise<string[]> {
  const { id, persona, dir } = loadPersona(yamlPath);
  const wav = join(dir, `${lang}.wav`);
  const meta = join(dir, `${lang}.json`);
  if (!existsSync(wav) || !existsSync(meta))
    throw new Error(`persona "${id}" has no ${lang} reference clip: run \`s2v voice create\``);
  const clip = JSON.parse(readFileSync(meta, 'utf8')) as PersonaClip;
  // The gates are set for raw VoiceDesign output: judge the picked candidate's raw output when it
  // is still there. A clip finished by us is leveled (its noise floor moves) and padded with
  // silence (its ending always looks clean), so those two gates do not apply to it.
  const cand = join(dir, 'candidates', `${lang}-${clip.candidate}`);
  const raw =
    existsSync(`${cand}.raw.wav`) &&
    existsSync(`${cand}.json`) &&
    (JSON.parse(readFileSync(`${cand}.json`, 'utf8')) as PersonaClip).sha256 === clip.sha256
      ? `${cand}.raw.wav`
      : null;
  const [c] = await checkCandidates(
    [{ judge: raw ?? wav, finished: wav }],
    clip.text,
    persona.description,
    lang,
    repoRoot,
    log,
  );
  if (!raw && clip.finish === REF_FINISH) {
    c!.fails = c!.fails.filter((f) => !/^noisy|^ending is cut/.test(f));
    log('(judged on the finished clip: noise and ending are not judged)');
  }
  log(`${id} (${lang}): ${describe(c!)}`);
  log(`  heard: ${c!.heard}`);
  if (c!.fails.length)
    log(
      `  the clone copies these flaws; to replace the clip: s2v voice create ${yamlPath} --lang ${lang} ` +
        '(then pick, and re-run tts)',
    );
  return c!.fails;
}
