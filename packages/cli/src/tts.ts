/**
 * `s2v tts`: synthesize every sentence of a script into the audio lock (PLAN 5.2).
 *
 *   synthesize (tts-server) → atempo if speed≠1 (Qwen) → 48 kHz mono + trim silence (ffmpeg)
 *   → word timing (aligner /align) → ASR round-trip CER (aligner /transcribe)
 *   → pitch and similarity against the voice's committed reference (voice-refs.ts)
 *
 * Audio lock: <script dir>/audio/<lang>/{<key>.wav, manifest.json}. Entries are keyed by the
 * content key, so unchanged sentences are reused and edits only re-synthesize what changed.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ACTING_VERSION,
  analyzeLevels,
  endsWithQuestion,
  ESTIMATE_RATE,
  FIRST_TAKES,
  isStandardEmotion,
  MAX_TAKES,
  selectTake,
  takeBudgetDone,
  type Neighbor,
  type TakeContext,
  type TakeFacts,
  assessSentence,
  emotionGateFailures,
  normalizeForCer,
  bestAttempt,
  emotionSentence,
  instructFor,
  lengthMultiplier,
  maxPauseFor,
  speedProduct,
  SUPERTONIC_SPEED,
  type Acting,
  type EmotionTakeMeasure,
  consistencyReasons,
  cosine,
  roundTripCer,
  sentenceId,
  toAlignText,
  toTtsText,
  type AlignedWord,
  type AudioManifest,
  type CastMember,
  type Lang,
  type Script,
  type SentenceAssessment,
} from '@script2video/core';
import { compressPausesInFile, cropFile, loudnessReader, readPcm16 } from './pauses.js';
import { MOCK_REF_F0, mockEnabled, mockFails, mockMeasure, mockSynthesize } from './mock-tts.js';
import { splitRecording } from './recording.js';
import {
  cropFor,
  EDGE_PAD_LEAD_S,
  EDGE_PAD_TAIL_S,
  judgeTake,
  shiftWords,
  type TakeJob,
  type WavFacts,
} from './take-judge.js';
import { resolvePersona, type PersonaRef } from './persona.js';
import { ALIGNER, Service, TTS_SERVER } from './services.js';
import {
  ClipVectors,
  createReference,
  describeVoice,
  embed,
  loadReference,
  type LoadedReference,
  type RefServices,
  type RefVoice,
} from './voice-refs.js';

const run = promisify(execFile);
export const POSTPROCESS_VERSION = 'pp3-48k-mono-trim50db-pausecap-edgecut';
/** Bump when the aligner input or mapping changes: word timings are re-measured (raw audio reused). */
export const ALIGN_VERSION = 'al2-ko-numbers-spelled';
/** How recordings are cut into sentences (recording.ts). */
export const RECORDING_VERSION = 'rec1-midgap';
/** Synthesis wrapper version and decoding: part of every synthesis key. */
export const TTS_WRAPPER = '0.1.0';
export const TTS_DECODING = 'sampling-default';

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function hashKey(fields: unknown): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 24);
}
/**
 * Take measurement cache (stage 3 plan 2): the constants the measuring code uses, and a version
 * to bump when that code changes in another way.
 */
const TAKE_MEASURE_VERSION = 1;
const MEASURE_CONSTANTS = { EDGE_PAD_LEAD_S, EDGE_PAD_TAIL_S, levels: 'analyzeLevels-v1' };
/** Seconds per take, synthesis and measuring (2a runs: 2.7–6.7 s), for the time estimate. */
const TAKE_SECONDS: Record<'qwen' | 'persona' | 'supertonic', number> = {
  qwen: 5,
  persona: 5,
  supertonic: 2,
};
/** Takes a line needs on average (stage 3 plan 9), takes of a new voice reference, server start. */
const EXPECTED_TAKES = { emotion: 3.4, plain: 1.2 };
const REFERENCE_TAKES = 20;
const SERVER_START_S = 30;

const sha16 = (path: string) => sha256File(path).slice(0, 16);

/** Write a cache file whole: other s2v processes share the cache (stage 3 plan 2). */
function atomicWrite(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** A cached JSON file, or null when it is missing or unreadable. */
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export interface LockEntry {
  src: string;
  duration: number;
  words: AlignedWord[];
  heard: string;
  cer: number;
  engine: string;
  model: string;
  seed: string;
  attempt: number;
  /** Seconds removed by internal pause compression. */
  pauseRemoved?: number;
  /** Failed checks of the kept attempt (empty when it passed). */
  checks?: string[];
  /** Median pitch (Hz) of the voiced frames, for voice consistency (null: too few voiced frames). */
  f0?: number | null;
  /**
   * Ending: last fifth of the voiced frames against the median, semitones (null: unmeasurable).
   * Measured on the lock wav, as heard: pause compression and tempo keep the voiced frames' pitch,
   * but voiced sound cut away after the last word is not counted.
   */
  ending?: number | null;
  /** Similarity with the voice reference clip, and the reference it was measured against. */
  sim?: number;
  voiceRef?: string;
  /**
   * Emotion lines (ko): what the emotion gates read (stage 2 plan 4.1), so `--recheck` judges
   * without the raw take. `raw`: the raw take inside the aligned words; the rest: lock wav × tempo.
   */
  raw?: { duration: number; pause: number; ending: number | null };
  lead?: number;
  tail?: number;
  noise?: number;
  /** Stage 3: the raw takes it came from, and the human-choice key (3b). */
  synthKey?: string;
  pickKey?: string;
  /** Highest take number made so far for this sentence (a retry starts after it). */
  tried?: number;
  /** Takes made for the choice: number → passed, and what selection read (rounded). */
  takes?: Record<string, TakeRecord>;
  /** How the take was chosen (emotion lines and retries). */
  select?: { n: number; rank: number; neighbor: boolean; retry: boolean };
  /** Non-speech cut at the edges (seconds of the take wav). */
  crop?: { from: number; to: number };
}

/** One take in a lock entry (stage 3): enough to see why it was or was not chosen. */
export interface TakeRecord {
  ok: boolean;
  f0: number | null;
  /** Raw length and ending (emotion lines), heard rate (chars/s). */
  raw: number | null;
  ending: number | null;
  rate: number | null;
}

export interface LockManifest {
  version: 1;
  lang: string;
  /** content key → synthesized sentence */
  entries: Record<string, LockEntry>;
  /** sentence id (scene:block:sentence) → content key, for the current script */
  sentences: Record<string, string>;
  env: Record<string, unknown>;
}

interface VoiceTarget {
  engine: 'qwen' | 'persona' | 'supertonic';
  voice: string;
  modelName: string;
  /** persona only: the reference clip the Base model clones. */
  ref?: PersonaRef;
}

export function voiceTarget(member: CastMember, lang: Lang, scriptDir: string): VoiceTarget {
  const [kind, name] = member.voice.split(':') as [string, string];
  if (kind === 'qwen')
    return { engine: 'qwen', voice: name, modelName: 'qwen3-tts-1.7b-customvoice' };
  if (kind === 'supertonic')
    return { engine: 'supertonic', voice: name, modelName: 'supertonic-3' };
  const ref = resolvePersona(name, lang, scriptDir);
  if (typeof ref === 'string') throw new Error(ref);
  return { engine: 'persona', voice: name, modelName: 'qwen3-tts-1.7b-base', ref };
}

export function wavDuration(path: string): number {
  const buf = readFileSync(path);
  const sampleRate = buf.readUInt32LE(24);
  const blockAlign = buf.readUInt16LE(32);
  // find the "data" chunk (ffmpeg may add LIST chunks before it)
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return size / blockAlign / sampleRate;
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

export async function postprocess(
  input: string,
  output: string,
  tempo: number | null,
): Promise<void> {
  const trim =
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse,' +
    'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.05,areverse';
  const filters = [...(tempo ? [`atempo=${tempo}`] : []), 'aresample=48000', trim].join(',');
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    input,
    '-af',
    filters,
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    output,
  ]);
}

export interface TtsOptions {
  asr: boolean;
  /**
   * Draft mode (PLAN 5.2): every cast member speaks with its `draftVoice` (or an auto-assigned
   * Supertonic voice), audio goes to a cache instead of the audio lock, and the ASR / pitch passes
   * are skipped. Word alignment still runs so cues line up.
   */
  draft?: boolean;
  /** Audio lock directory override (draft audio lives in the cache). */
  lockDir?: string;
  /** Re-assess sentences already in the audio lock and re-synthesize the ones that now fail. */
  recheck?: boolean;
  /**
   * Sentence ids to synthesize again with new takes even though they pass (they sound off):
   * `scene:paragraph:sentence`, or a prefix (`scene`, `scene:paragraph`) for all inside.
   */
  retry?: string[];
  /** Never synthesize: fail if any sentence has no audio in the lock (reproducible renders). */
  frozen?: boolean;
  log: (msg: string) => void;
}

export interface SentenceJob {
  id: string;
  text: string;
  member: CastMember;
  target: VoiceTarget;
  ttsText: string;
  alignText: string;
  synthKey: string;
  synthFields: { speed: number; instruct: string };
  key: string;
  /** Key of a human take choice (stage 3b): the raw takes and, for emotion lines, power. */
  pickKey: string;
  tempo: number | null;
  /** `power` of an emotion line: it picks a take (stage 3 plan 5). */
  power?: 'weak' | 'strong';
  /** Voice attributes of the line (acting stage 2). */
  acting?: Acting;
  /** An emotion line: the emotion gates apply (ko) and the emotion pitch window. */
  emotional: boolean;
  /** cast × line × user emotion speed: tempo (qwen, persona) or synthesis speed (supertonic). */
  speedProduct: number;
  /** The instruction holds an acting template (its version is in the synthesis key). */
  template: boolean;
  /** Expected-length factor of the emotion (1 for plain lines). */
  multiplier: number;
  /** Longest pause allowed inside the raw take. */
  maxPause: number;
}

/**
 * The previous sentence for neighbor matching (stage 3 plan 5.6): the sentence right before in the
 * same paragraph, an emotion line of the same emotion, instruction, power and speed whose locked
 * take passed.
 * Its pitch and heard rate come from its lock entry, so a sentence synthesized now and one reused
 * from the lock give the same neighbor.
 */
export function neighborFor(
  job: SentenceJob,
  prev: SentenceJob | undefined,
  entry: Pick<LockEntry, 'f0' | 'words' | 'checks'> | undefined,
  rate: (job: SentenceJob, words: AlignedWord[]) => number | null,
): Neighbor | undefined {
  if (!prev || !entry || !job.emotional || !prev.emotional) return undefined;
  const [scene, block, sentence] = job.id.split(':');
  if (prev.id !== `${scene}:${block}:${Number(sentence) - 1}`) return undefined;
  if (
    prev.acting?.emo !== job.acting?.emo ||
    // the instruction holds the emotion template, `say` and the cast style
    prev.synthFields.instruct !== job.synthFields.instruct ||
    prev.power !== job.power ||
    prev.speedProduct !== job.speedProduct
  )
    return undefined;
  // a fallback take (kept despite failures) is not matched
  if ((entry.checks?.length ?? 0) > 0) return undefined;
  return { f0: entry.f0 ?? null, rate: rate(prev, entry.words) };
}

interface Attempt {
  attempt: number;
  wavPath: string;
  words: AlignedWord[];
  heard: string;
  removed: number;
  info: { model: string; seed: number };
  assessment: SentenceAssessment;
  f0: number | null;
  ending: number | null;
  sim: number | null;
  /** The reference the take was checked against (null: not checked). */
  voiceRef: string | null;
  /** Emotion gate measurements (emotion lines in ko only). */
  emotion?: EmotionTakeMeasure & { ending: number | null };
  /** Raw take inside the words (every emotion line). */
  raw?: { duration: number; pause: number; ending: number | null };
  /** What take selection reads. */
  facts: TakeFacts;
  crop: { from: number; to: number } | null;
  /** Judge the take again with another reference (null: none, stage 3 plan 3). */
  rejudge: (ref: LoadedReference | null) => void;
}

interface PitchResult {
  median_hz: number | null;
  ending_st: number | null;
  lead_s: number;
  tail_s: number;
  noise_s: number;
}

/** Margins kept around the aligned words when the raw take is measured (as the edge cut). */
const rawWindow = (words: AlignedWord[], length: number): [number, number] =>
  words.length === 0
    ? [0, length]
    : [
        Math.max(0, words[0]!.start - EDGE_PAD_LEAD_S),
        Math.min(length, words[words.length - 1]!.end + EDGE_PAD_TAIL_S),
      ];

export interface RecordedParagraph {
  src: string;
  sha: string;
  items: { id: string; key: string; text: string; alignText: string }[];
}

export interface SentencePlan {
  jobs: SentenceJob[];
  recorded: RecordedParagraph[];
  /** sentence id (scene:block:sentence) → lock key, for every sentence that could be planned */
  sentences: Record<string, string>;
  /** Paragraphs that cannot be planned (missing recording, unresolvable persona), in script order. */
  errors: { id: string; message: string }[];
  /** Things changed to make a plan (a draft speed clamped to Supertonic's range). */
  notes: string[];
}

const DRAFT_VOICES = ['F1', 'M1', 'F2', 'M2', 'F3', 'M3', 'F4', 'M4', 'F5', 'M5'];

/**
 * The lock key of every sentence, without synthesizing: what `tts` would make, and what `inspect`
 * hashes (they must agree, so both use this).
 */
export function planSentences(
  scriptPath: string,
  script: Script,
  repoRoot: string,
  opts: { draft: boolean; mock: boolean },
): SentencePlan {
  const { meta } = script;
  const { mock } = opts;
  const castOrder = Object.keys(meta.cast);
  const memberFor = (castKey: string): CastMember => {
    const member = meta.cast[castKey]!;
    if (!opts.draft) return member;
    const voice =
      member.draftVoice ??
      `supertonic:${DRAFT_VOICES[castOrder.indexOf(castKey) % DRAFT_VOICES.length]}`;
    return { ...member, voice, style: undefined };
  };
  const models = (
    JSON.parse(readFileSync(join(repoRoot, 'models.lock.json'), 'utf8')) as {
      models: Record<string, { revision: string }>;
    }
  ).models;
  const plan: SentencePlan = { jobs: [], recorded: [], sentences: {}, errors: [], notes: [] };
  for (const scene of script.scenes) {
    for (const [bi, block] of scene.blocks.entries()) {
      if (block.kind !== 'paragraph') continue;
      if (block.audio) {
        // Your own recording instead of TTS (see recording.ts).
        const src = resolve(dirname(scriptPath), block.audio);
        if (!existsSync(src)) {
          plan.errors.push({
            id: sentenceId(scene.id, bi, 0),
            message: `recording not found: ${block.audio}`,
          });
          continue;
        }
        const sha = sha256File(src);
        const items = block.sentences.map((sentence, si) => {
          const alignText = toAlignText(sentence.text, meta.pronounce, meta.lang).tts;
          const id = sentenceId(scene.id, bi, si);
          const key = hashKey({
            recording: sha,
            index: si,
            alignText,
            version: RECORDING_VERSION,
            align: ALIGN_VERSION,
          });
          plan.sentences[id] = key;
          return { id, key, text: sentence.text, alignText };
        });
        plan.recorded.push({ src, sha, items });
        continue;
      }
      const member = memberFor(block.cast);
      // Mock runs need no persona reference clips (CI has none).
      let target: VoiceTarget;
      try {
        target =
          mock && member.voice.startsWith('persona:')
            ? { engine: 'persona', voice: member.voice.slice(8), modelName: 'qwen3-tts-1.7b-base' }
            : voiceTarget(member, meta.lang, dirname(scriptPath));
      } catch (e) {
        plan.errors.push({ id: sentenceId(scene.id, bi, 0), message: (e as Error).message });
        continue;
      }
      for (const [si, sentence] of block.sentences.entries()) {
        const ttsText = toTtsText(sentence.text, meta.pronounce).tts;
        const acting = sentence.acting;
        // a draft speaks plainly (plan 3: no template or say, whatever the draft voice is)
        const { instruct, template } =
          target.engine === 'qwen' && !opts.draft
            ? instructFor(meta, member.style, acting)
            : { instruct: '', template: false };
        const speed = speedProduct(meta, member, acting);
        const id = sentenceId(scene.id, bi, si);
        if (speed < 0.5 || speed > 2) {
          plan.errors.push({
            id,
            message: `${id}: speed ${speed.toFixed(3)} (cast × line × emotion) is outside 0.5–2`,
          });
          continue;
        }
        let synthSpeed = target.engine === 'supertonic' ? speed : 1;
        if (target.engine === 'supertonic') {
          const [lo, hi] = SUPERTONIC_SPEED;
          if (synthSpeed < lo || synthSpeed > hi) {
            if (!opts.draft) {
              plan.errors.push({
                id,
                message: `${id}: Supertonic speed ${speed.toFixed(3)} is outside ${lo.toFixed(3)}–${hi.toFixed(3)}`,
              });
              continue;
            }
            synthSpeed = Math.min(hi, Math.max(lo, synthSpeed));
            plan.notes.push(
              `${id}: draft speed ${speed.toFixed(3)} clamped to ${synthSpeed.toFixed(3)} (Supertonic range)`,
            );
          }
        }
        // Two-level key: the raw TTS output depends only on synthesis inputs; post-processing
        // (tempo, trim, pause compression, alignment) can change without re-running the model.
        const synthFields = {
          ...(mock ? { mock: 1 } : {}),
          engine: target.engine,
          model: models[target.modelName]!.revision,
          wrapper: TTS_WRAPPER,
          voice: target.voice,
          // persona: the exact reference clip and its sentence define the voice
          ...(target.ref ? { ref: target.ref.sha256, refText: target.ref.text } : {}),
          instruct,
          lang: meta.lang,
          speed: synthSpeed,
          seed: meta.seed,
          decoding: TTS_DECODING,
          text: ttsText,
          // only lines that use an acting template: other keys stay as they were (A3)
          ...(template ? { templates: ACTING_VERSION } : {}),
        };
        const synthKey = hashKey(synthFields);
        const tempo = target.engine !== 'supertonic' && speed !== 1 ? speed : null;
        const emotional = emotionSentence(target.engine, acting, opts.draft);
        // power picks a take of an emotion line (stage 3 plan 1): in the lock key, not the
        // synthesis key, so lines that differ only in power share their raw takes
        const power = emotional ? acting?.power : undefined;
        const key = hashKey({
          synthKey,
          postprocess: POSTPROCESS_VERSION,
          align: ALIGN_VERSION,
          tempo,
          maxPause: meta.pacing.maxPause,
          ...(power ? { power } : {}),
        });
        plan.sentences[id] = key;
        plan.jobs.push({
          id,
          text: sentence.text,
          member,
          target,
          ttsText,
          alignText: toAlignText(sentence.text, meta.pronounce, meta.lang).tts,
          synthKey,
          synthFields,
          key,
          pickKey: hashKey({ synthKey, ...(power ? { power } : {}) }),
          tempo,
          ...(acting ? { acting } : {}),
          ...(power ? { power } : {}),
          emotional,
          speedProduct: speed,
          template,
          multiplier: lengthMultiplier(meta, emotional, acting),
          maxPause: maxPauseFor(meta, acting),
        });
      }
    }
  }
  return plan;
}

export async function synthesizeScript(
  scriptPath: string,
  script: Script,
  repoRoot: string,
  opts: TtsOptions,
) {
  const { meta } = script;
  const lockDir = opts.lockDir ?? join(dirname(scriptPath), 'audio', meta.lang);
  if (opts.draft) opts = { ...opts, asr: false };
  mkdirSync(lockDir, { recursive: true });
  const manifestPath = join(lockDir, 'manifest.json');
  const previous: LockManifest | null = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as LockManifest)
    : null;
  const models = (
    JSON.parse(readFileSync(join(repoRoot, 'models.lock.json'), 'utf8')) as {
      models: Record<string, { revision: string }>;
    }
  ).models;
  const revisions = Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v.revision]));

  const mock = mockEnabled();
  if (mock) opts.log('S2V_TTS=mock: synthetic audio, no models');
  const rawDir = join(repoRoot, '.s2v-cache', 'tts-raw');
  mkdirSync(rawDir, { recursive: true });
  const tts = new Service(TTS_SERVER, repoRoot);
  const aligner = new Service(ALIGNER, repoRoot);
  const manifest: LockManifest = {
    version: 1,
    lang: meta.lang,
    entries: previous?.entries ?? {},
    sentences: {},
    // Server identity / versions of the last run that synthesized; kept when everything is reused.
    env: previous?.env ?? {},
  };
  const warnings: string[] = [];
  const pushOnce = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  let synthesized = 0;
  let reused = 0;
  let started = false;
  const ensureServices = async () => {
    if (started) return;
    opts.log('starting tts-server and aligner ...');
    const [th, ah] = await Promise.all([tts.ensure(), aligner.ensure()]);
    manifest.env = { tts: th, aligner: ah };
    started = true;
  };
  const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  // E7 (stage 3 plan 6): make all six takes of emotion lines; the choice stays the budget's
  const takesAll = process.env.S2V_TAKES_ALL === '6';
  /** Tell how long synthesis will take (stage 3 plan 9). */
  const estimateTime = (todo: SentenceJob[], retry: (j: SentenceJob) => boolean) => {
    if (mock || todo.length === 0) return;
    // highest raw take per synthesis key, read once
    const rawMax = new Map<string, number>();
    for (const f of readdirSync(rawDir)) {
      const m = /^([0-9a-f]+)(?:\.a(\d+))?\.wav$/.exec(f);
      if (m) rawMax.set(m[1]!, Math.max(rawMax.get(m[1]!) ?? -1, Number(m[2] ?? 0)));
    }
    let seconds = 0;
    const seenRefs = new Set<string>();
    for (const j of todo) {
      const takes = j.emotional ? EXPECTED_TAKES.emotion : EXPECTED_TAKES.plain;
      // a retry makes new takes; otherwise cached raw takes are only measured
      const cached = retry(j) ? 0 : (rawMax.get(j.synthKey) ?? -1) + 1;
      seconds += Math.max(0.3, takes - cached) * TAKE_SECONDS[j.target.engine];
      if (checkVoices) {
        const v = refVoice(j);
        const key = voiceKey(v);
        if (!seenRefs.has(key)) {
          seenRefs.add(key);
          let missing = true;
          try {
            const { loaded, stale } = loadReference(v, dirname(scriptPath), revisions);
            missing = !loaded || !!stale;
          } catch {
            // counted as missing
          }
          if (missing) seconds += REFERENCE_TAKES * TAKE_SECONDS[j.target.engine];
        }
      }
    }
    if (seconds > todo.length * 0.3 * TAKE_SECONDS.qwen) seconds += SERVER_START_S;
    opts.log(`about ${Math.max(1, Math.round(seconds / 60))} min for ${todo.length} sentence(s)`);
  };

  // ---------- voice references (acting plan 3.6) ----------
  // Draft and mock audio is not checked. A missing reference is made on first use (20 takes).
  const checkVoices = !mock && !opts.draft;
  const services: RefServices = { tts, aligner, ensure: () => ensureServices() };
  const vectors = new ClipVectors(tts);
  const references = new Map<string, Promise<LoadedReference | null>>();
  const refVoice = (job: SentenceJob): RefVoice => ({
    engine: job.target.engine,
    voice: job.target.voice,
    lang: meta.lang,
    modelName: job.target.modelName,
    ...(job.target.engine === 'qwen' && job.member.style ? { style: job.member.style } : {}),
    ...(job.target.ref ? { ref: job.target.ref } : {}),
  });
  // A voice whose reference cannot be read, made or embedded is left unchecked with a warning, like
  // a failing take (Q3): the consistency check never stops a run.
  const voiceKey = (v: RefVoice) =>
    JSON.stringify([v.engine, v.voice, v.style ?? '', v.ref?.sha256 ?? '']);
  const unchecked = (v: RefVoice, e: unknown) => {
    warnings.push(
      `${describeVoice(v)}: not checked for pitch and similarity (${(e as Error).message.slice(0, 200)})`,
    );
    references.set(voiceKey(v), Promise.resolve(null));
    return null;
  };
  const referenceFor = (job: SentenceJob): Promise<LoadedReference | null> => {
    const v = refVoice(job);
    const key = voiceKey(v);
    if (!references.has(key))
      references.set(
        key,
        (async () => {
          try {
            const scriptDir = dirname(scriptPath);
            const { loaded, stale, warning } = loadReference(v, scriptDir, revisions);
            if (warning) warnings.push(warning);
            let r = loaded;
            if (!loaded || stale) {
              opts.log(
                stale
                  ? `voice reference of ${describeVoice(v)} is out of date (${stale})`
                  : `no voice reference for ${describeVoice(v)} yet`,
              );
              r = await createReference(v, scriptDir, repoRoot, revisions, services, opts.log);
            }
            return r;
          } catch (e) {
            return unchecked(v, e);
          }
        })(),
      );
    return references.get(key)!;
  };
  /** Similarity of a wav with its voice reference clip (null: the voice is unchecked). */
  const similarity = async (job: SentenceJob, wavPath: string) => {
    const r = await referenceFor(job);
    if (!r) return null;
    try {
      await ensureServices();
      return { r, sim: cosine(await embed(tts, wavPath), await vectors.get(r)) };
    } catch (e) {
      return unchecked(refVoice(job), e);
    }
  };
  /** Pitch and similarity of a take against its voice reference. */
  const emoOf = (job: SentenceJob) =>
    job.emotional && job.acting?.emo ? { emo: job.acting.emo } : {};
  /** The emotion gates apply to new takes of emotion lines in Korean (stage 2 plan 4). */
  const gated = (job: SentenceJob) => checkVoices && job.emotional && meta.lang === 'ko';
  const charsOf = (job: SentenceJob) => [...normalizeForCer(job.ttsText, meta.lang)].length;
  /**
   * The raw take as the model made it (trimmed, no tempo, no pause compression), measured inside
   * the aligned words: its length and longest quiet gap, and its ending.
   */
  const measureRaw = async (job: SentenceJob, raw: string, attempt: number) => {
    const dir = join(repoRoot, '.s2v-cache', 'tts-raw-trim');
    mkdirSync(dir, { recursive: true });
    const trimmed = join(dir, `${job.synthKey}.a${attempt}.${process.pid}.wav`);
    try {
      await postprocess(raw, trimmed, null);
      const { data } = await aligner.post<{ words: AlignedWord[] }>('/align', {
        wav_path: trimmed,
        text: job.alignText,
        lang: meta.lang,
      });
      const pcm = readPcm16(trimmed);
      const length = pcm.samples.length / pcm.rate;
      const [from, to] = rawWindow(data.words, length);
      const slice = pcm.samples.subarray(Math.round(from * pcm.rate), Math.round(to * pcm.rate));
      const samples = Float32Array.from(slice, (x) => x / 32768);
      const gaps = samples.length > 0 ? analyzeLevels(samples, pcm.rate).gaps : [];
      const p = (await aligner.post<PitchResult>('/pitch', { wav_path: trimmed })).data;
      return { duration: to - from, pause: Math.max(0, ...gaps), ending: p.ending_st };
    } finally {
      if (existsSync(trimmed)) unlinkSync(trimmed);
    }
  };

  // ---------- jobs ----------
  const plan = planSentences(scriptPath, script, repoRoot, { draft: opts.draft === true, mock });
  if (plan.errors.length > 0) throw new Error(plan.errors[0]!.message);
  for (const n of plan.notes) opts.log(`  ${n}`);
  const { jobs, recorded } = plan;
  Object.assign(manifest.sentences, plan.sentences);

  // ---------- takes (stage 3 plan 2–3): raw take → take wav → measurements → judgement ----------
  const takesDir = join(repoRoot, '.s2v-cache', 'tts-takes');
  if (!mock) mkdirSync(takesDir, { recursive: true });
  const takeKey = (job: SentenceJob, n: number) =>
    hashKey({
      synthKey: job.synthKey,
      tempo: job.tempo,
      maxPause: meta.pacing.maxPause,
      postprocess: POSTPROCESS_VERSION,
      n,
    });
  const measureKey = (job: SentenceJob) =>
    hashKey({
      alignText: job.alignText,
      align: ALIGN_VERSION,
      aligner: ALIGNER.wrapper,
      models: [revisions['qwen3-forcedaligner-0.6b'], revisions['qwen3-asr-0.6b']],
      asr: opts.asr,
      constants: MEASURE_CONSTANTS,
      version: TAKE_MEASURE_VERSION,
    });
  const rawPath = (job: SentenceJob, n: number) =>
    join(rawDir, n === 0 ? `${job.synthKey}.wav` : `${job.synthKey}.a${n}.wav`);
  /** The highest take number in the raw cache for a synthesis key (-1: none). */
  const lastRawTake = (synthKey: string) => {
    let last = -1;
    for (const f of readdirSync(rawDir)) {
      if (f === `${synthKey}.wav`) last = Math.max(last, 0);
      const m = new RegExp(`^${synthKey}\\.a(\\d+)\\.wav$`).exec(f);
      if (m) last = Math.max(last, Number(m[1]));
    }
    return last;
  };

  /** The raw take (cached) and its synthesis info. */
  const rawTake = async (job: SentenceJob, n: number) => {
    const raw = rawPath(job, n);
    const info = readJson<{ model: string; seed: number }>(`${raw}.json`);
    if (info && existsSync(raw)) return { raw, info };
    await ensureServices();
    const { data: wav, headers } = await tts.post<Buffer>('/synthesize', {
      engine: job.target.engine,
      voice: job.target.voice,
      lang: meta.lang,
      text: job.ttsText,
      ...(job.synthFields.instruct ? { instruct: job.synthFields.instruct } : {}),
      speed: job.synthFields.speed,
      ...(job.target.ref
        ? { ref_wav_path: job.target.ref.wavPath, ref_text: job.target.ref.text }
        : {}),
      seed_material: `${job.synthKey}:${n}`,
    });
    const meta2 = JSON.parse(headers.get('x-s2v-meta') ?? '{}') as { model: string; seed: number };
    atomicWrite(raw, wav);
    atomicWrite(`${raw}.json`, JSON.stringify(meta2));
    return { raw, info: meta2 };
  };

  /** Measurements of one take before any crop (cached by take and measurement key). */
  interface TakeMeasure {
    wavSha: string;
    words: AlignedWord[];
    heard: string;
    removed: number;
    info: { model: string; seed: number };
    pitch: PitchResult;
    /** Raw take inside the words (every emotion line). */
    raw?: { duration: number; pause: number; ending: number | null };
  }
  const measureTake = async (job: SentenceJob, n: number) => {
    const tk = takeKey(job, n);
    const wav = join(takesDir, `${tk}.wav`);
    const meta3 = join(takesDir, `${tk}.json`);
    type Made = {
      wavSha: string;
      rawSha: string;
      removed: number;
      info: { model: string; seed: number };
    };
    let made = readJson<Made>(meta3);
    const wavSha0 = existsSync(wav) ? sha16(wav) : null;
    // the take wav and what made it belong together (a crash between the two writes)
    const raw0 = rawPath(job, n);
    // an emotion line also measures the raw take: it must be the one the take wav was made from
    const madeOk =
      !!made &&
      made.wavSha === wavSha0 &&
      typeof made.removed === 'number' &&
      typeof made.info?.model === 'string' &&
      (!job.emotional || (existsSync(raw0) && made.rawSha === sha16(raw0)));
    const path = join(takesDir, `${tk}.${measureKey(job)}.json`);
    const valid = (c: TakeMeasure | null, sha: string | null) =>
      !!c && c.wavSha === sha && (!job.emotional || !!c.raw);
    let cached = readJson<TakeMeasure>(path);
    if (madeOk && valid(cached, wavSha0)) return { tk, wav, m: cached! };
    // the raw measurement of an emotion line needs the raw take: without it, the take is made
    // again from a new raw take (plain lines measure the take wav only)
    if (!madeOk) {
      const { raw, info } = await rawTake(job, n);
      const tmp = `${wav}.${process.pid}.tmp.wav`;
      try {
        await postprocess(raw, tmp, job.tempo);
        const removed = compressPausesInFile(tmp, meta.pacing.maxPause);
        renameSync(tmp, wav);
        made = { wavSha: sha16(wav), rawSha: sha16(raw), removed, info };
      } finally {
        if (existsSync(tmp)) unlinkSync(tmp);
      }
      atomicWrite(meta3, JSON.stringify(made));
    }
    const wavSha = made!.wavSha;
    cached = readJson<TakeMeasure>(path);
    if (valid(cached, wavSha)) return { tk, wav, m: cached! };
    await ensureServices();
    const { data: aligned } = await aligner.post<{ words: AlignedWord[] }>('/align', {
      wav_path: wav,
      text: job.alignText,
      lang: meta.lang,
    });
    const heard = opts.asr
      ? (await aligner.post<{ text: string }>('/transcribe', { wav_path: wav, lang: meta.lang }))
          .data.text
      : '';
    const pitch = (await aligner.post<PitchResult>('/pitch', { wav_path: wav })).data;
    const m: TakeMeasure = {
      wavSha,
      words: aligned.words,
      heard,
      removed: made!.removed,
      info: made!.info,
      pitch,
      ...(job.emotional ? { raw: await measureRaw(job, rawPath(job, n), n) } : {}),
    };
    atomicWrite(path, JSON.stringify(m));
    return { tk, wav, m };
  };

  /** What the take checks need of a job (stage 3 plan 3). */
  const takeJob = (job: SentenceJob): TakeJob => ({
    text: job.text,
    lang: meta.lang,
    speed: job.speedProduct,
    tempo: job.tempo,
    gated: gated(job),
    chars: charsOf(job),
    multiplier: job.multiplier,
    maxPause: job.maxPause,
    synthSpeed: job.synthFields.speed,
    ...(job.emotional && job.acting?.emo ? { emo: job.acting.emo } : {}),
  });
  const wavFacts = (path: string): WavFacts => ({
    duration: wavDuration(path),
    loudness: loudnessReader(path),
  });

  /** The final wav of a take (cropped when the crop rule says so), its words and pitch. */
  const finalTake = async (job: SentenceJob, n: number) => {
    const { tk, wav, m } = await measureTake(job, n);
    const crop = cropFor(takeJob(job), m.words, m.pitch, wavFacts(wav));
    if (!crop) return { tk, m, wav, words: m.words, pitch: m.pitch, crop: null, tag: 'full' };
    const tag = `crop-${crop.from.toFixed(3)}-${crop.to.toFixed(3)}`;
    const cut = join(takesDir, `${tk}.${tag}.${m.wavSha}.wav`);
    if (!existsSync(cut)) {
      const tmp = `${cut}.${process.pid}.tmp.wav`;
      copyFileSync(wav, tmp);
      cropFile(tmp, crop.from, crop.to);
      renameSync(tmp, cut);
      opts.log(
        `  ${job.id} take ${n}: cut non-speech outside the words (kept ${crop.from.toFixed(2)}–${crop.to.toFixed(2)}s)`,
      );
    }
    const words = shiftWords(m.words, crop.from);
    const pitchPath = join(takesDir, `${tk}.${measureKey(job)}.${tag}.pitch.json`);
    let p = readJson<{ wavSha: string; pitch: PitchResult }>(pitchPath);
    if (!p || p.wavSha !== m.wavSha) {
      await ensureServices();
      p = {
        wavSha: m.wavSha,
        pitch: (await aligner.post<PitchResult>('/pitch', { wav_path: cut })).data,
      };
      atomicWrite(pitchPath, JSON.stringify(p));
    }
    return { tk, m, wav: cut, words, pitch: p.pitch, crop, tag };
  };

  /** Similarity of a final take with the voice reference (cached per reference), or null. */
  const takeSimilarity = async (
    job: SentenceJob,
    f: Awaited<ReturnType<typeof finalTake>>,
    r: LoadedReference,
  ) => {
    const enc = r.ref.embedder.revision;
    const path = join(takesDir, `${f.tk}.${f.tag}.sim.${r.sha}.${enc}.${TTS_SERVER.wrapper}.json`);
    const cached = readJson<{ wavSha: string; sim: number }>(path);
    if (cached && cached.wavSha === f.m.wavSha) return cached.sim;
    const s = await similarity(job, f.wav);
    if (!s) return null;
    atomicWrite(path, JSON.stringify({ wavSha: f.m.wavSha, sim: s.sim }));
    return s.sim;
  };

  /** Judge a measured take (stage 3 plan 3). */
  const judge = (
    job: SentenceJob,
    f: Awaited<ReturnType<typeof finalTake>>,
    r: LoadedReference | null,
    sim: number | null,
  ) =>
    judgeTake(
      takeJob(job),
      {
        words: f.words,
        wav: wavFacts(f.wav),
        pitch: f.pitch,
        cer: opts.asr ? roundTripCer(job.text, f.m.heard, meta.lang, meta.pronounce) : null,
        ...(f.m.raw ? { raw: f.m.raw } : {}),
      },
      r ? r.ref : null,
      sim,
    );

  /** Heard speaking rate of a take: characters over the words of the final wav. */
  const heardRate = (job: SentenceJob, words: AlignedWord[]) => {
    if (words.length === 0) return null;
    const spoken = words[words.length - 1]!.end - words[0]!.start;
    return spoken > 0 ? charsOf(job) / spoken : null;
  };

  // ---------- one attempt: synthesize → post-process → align → ASR → assess ----------
  const runAttempt = async (job: SentenceJob, attempt: number): Promise<Attempt> => {
    if (mock) {
      const wavPath = join(lockDir, `${job.key}.try${attempt}.wav`);
      const words = mockSynthesize(job.alignText, meta.lang, job.speedProduct, wavPath);
      let assessment = assessSentence({
        text: job.text,
        lang: meta.lang,
        duration: wavDuration(wavPath),
        words,
        cer: null,
        speed: job.speedProduct,
        loudness: loudnessReader(wavPath),
      });
      if (mockFails(job.synthKey, attempt))
        assessment = {
          ...assessment,
          ok: false,
          reasons: [...assessment.reasons, 'mock failure (S2V_TTS_MOCK_FAIL)'],
        };
      const fake = mockMeasure(
        job.synthKey,
        attempt,
        charsOf(job) * job.multiplier,
        ESTIMATE_RATE[meta.lang],
      );
      return {
        attempt,
        wavPath,
        words,
        heard: job.text,
        removed: 0,
        info: { model: 'mock', seed: 0 },
        assessment,
        // emotion lines keep the mock pitch, so neighbor matching runs on mock locks too
        f0: job.emotional ? fake.f0 : null,
        ending: null,
        sim: null,
        voiceRef: null,
        facts: {
          n: attempt,
          ok: assessment.ok,
          f0: fake.f0,
          rawDuration: fake.rawDuration,
          rawEnding: fake.rawEnding,
          rate: heardRate(job, words),
        },
        crop: null,
        rejudge: () => {},
      };
    }
    const f = await finalTake(job, attempt);
    const r = checkVoices ? await referenceFor(job) : null;
    const sim = r ? await takeSimilarity(job, f, r) : null;
    const ref = r && sim !== null ? r : null;
    const a: Attempt = {
      attempt,
      wavPath: f.wav,
      words: f.words,
      heard: f.m.heard,
      removed: f.m.removed,
      info: f.m.info,
      assessment: null as unknown as SentenceAssessment,
      f0: f.pitch.median_hz,
      ending: f.pitch.ending_st,
      sim,
      voiceRef: ref ? ref.sha : null,
      ...(f.m.raw ? { raw: f.m.raw } : {}),
      facts: {
        n: attempt,
        ok: false,
        f0: f.pitch.median_hz,
        rawDuration: f.m.raw?.duration ?? null,
        rawEnding: f.m.raw?.ending ?? null,
        rate: heardRate(job, f.words),
      },
      crop: f.crop,
      rejudge: (r2) => {
        const j = judge(job, f, r2, r2 ? sim : null);
        a.assessment = j.assessment;
        a.facts.ok = j.assessment.ok;
        if (j.emotion) a.emotion = j.emotion;
        else delete a.emotion;
        if (!r2) {
          a.sim = null;
          a.voiceRef = null;
        }
      },
    };
    a.rejudge(ref);
    return a;
  };

  /** Selection inputs of a job (stage 3 plan 5). */
  const takeContext = async (job: SentenceJob): Promise<TakeContext> => {
    const emo = job.acting?.emo;
    const standard =
      emo !== undefined && isStandardEmotion(emo) && !meta.acting?.emotions?.[emo]
        ? emo
        : undefined;
    const base = {
      ...(standard ? { emotion: standard } : {}),
      ...(job.power ? { power: job.power } : {}),
      question: endsWithQuestion(job.text),
    };
    if (mock) {
      const rate = ESTIMATE_RATE[meta.lang];
      return { ...base, refF0: MOCK_REF_F0, expected: (charsOf(job) / rate) * job.multiplier };
    }
    const r = checkVoices ? await referenceFor(job) : null;
    if (!r) return { ...base, refF0: null, expected: null };
    return {
      ...base,
      refF0: r.ref.f0,
      expected:
        r.ref.rate > 0
          ? ((charsOf(job) / r.ref.rate) * job.multiplier) / job.synthFields.speed
          : null,
    };
  };

  /** How many of the takes the budget looks at: where it is done (a retry: its 3 takes). */
  const budgetStop = (tried: Attempt[], ctx: TakeContext, retry: boolean) => {
    if (retry) return Math.min(tried.length, FIRST_TAKES);
    for (let k = FIRST_TAKES; k <= tried.length; k++)
      if (
        takeBudgetDone(
          tried.slice(0, k).map((t) => t.facts),
          ctx,
        )
      )
        return k;
    return tried.length;
  };

  /**
   * Make takes of an emotion line from `first` until the budget is done (3 first, at most 6), or 3
   * new takes for a retry; select among the takes the budget looked at.
   */
  const emotionTakes = async (job: SentenceJob, first: number, retry: boolean) => {
    let ctx = await takeContext(job);
    const tried: Attempt[] = [];
    const last = retry ? first + FIRST_TAKES - 1 : first + MAX_TAKES - 1;
    for (let n = first; n <= last; n++) {
      const a = await runAttempt(job, n);
      tried.push(a);
      if (!a.assessment.ok) opts.log(`  ${job.id} take ${n}: ${a.assessment.reasons.join('; ')}`);
      const enough = retry
        ? tried.length === FIRST_TAKES
        : tried.length >= FIRST_TAKES &&
          takeBudgetDone(
            tried.map((t) => t.facts),
            ctx,
          );
      if (enough && !takesAll) break;
    }
    // a reference that failed mid-sentence: judge every take without it (stage 3 plan 3)
    if (await settle(job, tried, ctx.refF0 !== null)) ctx = { ...ctx, refF0: null, expected: null };
    if (checkVoices && !mock && ctx.refF0 === null)
      pushOnce(
        `${job.id}: chose a take without the voice reference — run tts --retry ${job.id} later`,
      );
    return { ctx, tried, candidates: tried.slice(0, budgetStop(tried, ctx, retry)) };
  };

  /**
   * The reference became unusable during the sentence (stage 3 plan 3): judge every take without
   * it. True when the sentence is now without a reference although selection started with one.
   */
  const settle = async (job: SentenceJob, tried: Attempt[], hadRef: boolean) => {
    if (mock || !checkVoices) return false;
    if (await referenceFor(job)) return false;
    if (tried.some((t) => t.voiceRef !== null)) for (const t of tried) t.rejudge(null);
    return hadRef;
  };

  /** Takes of a plain line from `first`: the first that passes, at most 6. */
  const plainTakes = async (job: SentenceJob, first: number) => {
    const tried: Attempt[] = [];
    const last = first + MAX_TAKES - 1;
    for (let attempt = first; attempt <= last; attempt++) {
      const a = await runAttempt(job, attempt);
      tried.push(a);
      if (a.assessment.ok) break;
      opts.log(
        `  ${job.id} attempt ${attempt}: ${a.assessment.reasons.join('; ')}${attempt < last ? ' → retrying' : ''}`,
      );
    }
    await settle(job, tried, false);
    return tried;
  };
  const firstPassing = (tried: Attempt[]) =>
    tried.find((t) => t.assessment.ok) ?? bestAttempt(tried, meta.lang);

  const neighborOf = (job: SentenceJob): Neighbor | undefined => {
    const prev = jobs[jobs.indexOf(job) - 1];
    return neighborFor(job, prev, prev && manifest.entries[prev.key], heardRate);
  };

  /** Choose among candidates: selection, else the fewest failures. */
  const choose = (
    job: SentenceJob,
    candidates: Attempt[],
    ctx: TakeContext,
    prev: Neighbor | undefined,
  ) => {
    const sel = selectTake(
      candidates.map((t) => t.facts),
      ctx,
      prev,
    );
    if (!sel) return { chosen: bestAttempt(candidates, meta.lang), select: null };
    if (sel.n === 1) opts.log(`  ${job.id}: one take passed — no choice by power or strength`);
    const chosen = candidates.find((t) => t.attempt === sel.take.n)!;
    return {
      chosen,
      select: { n: sel.n, rank: sel.rank, neighbor: sel.neighbor },
    };
  };

  const commit = (
    job: SentenceJob,
    chosen: Attempt,
    tried: Attempt[],
    extra: { tried: number; select?: LockEntry['select'] },
  ) => {
    const src = `${job.key}.wav`;
    // mock takes live in the lock folder; real takes stay in the take cache
    if (dirname(chosen.wavPath) === lockDir) renameSync(chosen.wavPath, join(lockDir, src));
    else copyFileSync(chosen.wavPath, join(lockDir, src));
    for (const t of tried)
      if (t !== chosen && dirname(t.wavPath) === lockDir && existsSync(t.wavPath))
        unlinkSync(t.wavPath);
    const cer = chosen.assessment.cer ?? 0;
    manifest.entries[job.key] = {
      src,
      duration: Number(wavDuration(join(lockDir, src)).toFixed(4)),
      words: chosen.words,
      heard: chosen.heard,
      cer: Number(cer.toFixed(3)),
      engine: job.target.engine,
      model: chosen.info.model,
      seed: String(chosen.info.seed),
      attempt: chosen.attempt,
      pauseRemoved: Number(chosen.removed.toFixed(3)),
      checks: chosen.assessment.reasons,
      f0: chosen.f0 ? Number(chosen.f0.toFixed(1)) : null,
      ending: chosen.ending !== null ? Number(chosen.ending.toFixed(2)) : null,
      ...(chosen.sim !== null && chosen.voiceRef
        ? { sim: Number(chosen.sim.toFixed(4)), voiceRef: chosen.voiceRef }
        : {}),
      ...(chosen.raw
        ? {
            raw: {
              duration: Number(chosen.raw.duration.toFixed(3)),
              pause: Number(chosen.raw.pause.toFixed(2)),
              ending: chosen.raw.ending !== null ? Number(chosen.raw.ending.toFixed(2)) : null,
            },
          }
        : {}),
      ...(chosen.emotion
        ? {
            lead: Number(chosen.emotion.lead.toFixed(3)),
            tail: Number(chosen.emotion.tail.toFixed(3)),
            noise: Number(chosen.emotion.noise.toFixed(3)),
          }
        : {}),
      synthKey: job.synthKey,
      pickKey: job.pickKey,
      tried: extra.tried,
      takes: Object.fromEntries(
        tried.map((t) => {
          const r = (x: number | null, d: number) => (x === null ? null : Number(x.toFixed(d)));
          const rec: TakeRecord = {
            ok: t.assessment.ok,
            f0: r(t.facts.f0, 1),
            raw: r(t.facts.rawDuration, 3),
            ending: r(t.facts.rawEnding, 2),
            rate: r(t.facts.rate, 2),
          };
          return [String(t.attempt), rec];
        }),
      ),
      ...(extra.select ? { select: extra.select } : {}),
      ...(chosen.crop ? { crop: chosen.crop } : {}),
    };
    save();
  };

  /** `--recheck` of a locked sentence: the per-sentence checks and its voice reference. */
  const recheckReasons = async (job: SentenceJob, e: LockEntry): Promise<string[]> => {
    const wav = join(lockDir, e.src);
    const { reasons } = assessSentence({
      text: job.text,
      lang: meta.lang,
      duration: e.duration,
      words: e.words,
      cer: opts.asr ? e.cer : null,
      speed: job.speedProduct,
      loudness: loudnessReader(wav),
    });
    if (!checkVoices) return reasons;
    const r = await referenceFor(job);
    // emotion gates from the recorded measurements only (the raw take may be gone, A4)
    if (gated(job)) {
      if (e.raw && e.lead !== undefined && e.tail !== undefined && e.noise !== undefined)
        reasons.push(
          ...emotionGateFailures(
            {
              chars: charsOf(job),
              rawDuration: e.raw.duration,
              rawPause: e.raw.pause,
              lead: e.lead,
              tail: e.tail,
              noise: e.noise,
            },
            {
              multiplier: job.multiplier,
              maxPause: job.maxPause,
              synthSpeed: job.synthFields.speed,
            },
            r?.ref.rate ?? null,
          ),
        );
      else
        opts.log(
          `  ${job.id}: no emotion measurements in the lock (made before them); emotion gates skipped`,
        );
    }
    if (!r) return reasons;
    if (e.f0 === undefined || e.ending === undefined) {
      await ensureServices();
      const p = (await aligner.post<PitchResult>('/pitch', { wav_path: wav })).data;
      e.f0 = p.median_hz ? Number(p.median_hz.toFixed(1)) : null;
      e.ending = p.ending_st !== null ? Number(p.ending_st.toFixed(2)) : null;
    }
    if (e.voiceRef !== r.sha || e.sim === undefined) {
      await ensureServices();
      const m = await similarity(job, wav);
      if (!m) {
        save();
        return reasons;
      }
      e.sim = Number(m.sim.toFixed(4));
      e.voiceRef = r.sha;
    }
    save();
    return [
      ...reasons,
      ...consistencyReasons({ text: job.text, f0: e.f0 ?? null, sim: e.sim, ...emoOf(job) }, r.ref),
    ];
  };

  try {
    // ---------- every sentence passes the per-sentence checks ----------
    if (opts.frozen) {
      const missing = [...jobs, ...recorded.flatMap((r) => r.items)].filter((j) => {
        const e = manifest.entries[j.key];
        return !e || !existsSync(join(lockDir, e.src));
      });
      if (missing.length > 0)
        throw new Error(
          `--frozen-audio: ${missing.length} sentence(s) have no locked audio (text, voice or dictionary changed?): ${missing
            .slice(0, 5)
            .map((j) => `${j.id} "${j.text}"`)
            .join(', ')}${missing.length > 5 ? ', …' : ''}`,
        );
      save();
      return { manifestPath, synthesized: 0, reused: jobs.length, warnings };
    }
    // ---------- recordings: align each paragraph once, cut it into sentences ----------
    for (const rec of recorded) {
      const have = rec.items.every((it) => {
        const e = manifest.entries[it.key];
        return e && existsSync(join(lockDir, e.src));
      });
      if (have) {
        reused += rec.items.length;
        continue;
      }
      await ensureServices();
      const whole = join(lockDir, `rec-${rec.sha.slice(0, 16)}.wav`);
      await postprocess(rec.src, whole, null);
      const duration = wavDuration(whole);
      if (duration > 180)
        throw new Error(
          `${rec.src}: ${duration.toFixed(0)} s; split recordings into paragraphs of at most 180 s`,
        );
      const { data } = await aligner.post<{ words: AlignedWord[] }>('/align', {
        wav_path: whole,
        text: rec.items.map((it) => it.alignText).join(' '),
        lang: meta.lang,
      });
      const cuts = splitRecording(
        data.words,
        rec.items.map((it) => it.alignText),
        meta.lang,
        duration,
      );
      for (const [n, it] of rec.items.entries()) {
        const cut = cuts[n]!;
        const src = `${it.key}.wav`;
        copyFileSync(whole, join(lockDir, src));
        cropFile(join(lockDir, src), cut.from, cut.to);
        manifest.entries[it.key] = {
          src,
          duration: Number(wavDuration(join(lockDir, src)).toFixed(4)),
          words: cut.words,
          heard: '',
          cer: 0,
          engine: 'recording',
          model: basename(rec.src),
          seed: rec.sha.slice(0, 16),
          attempt: 0,
          checks: [],
        };
        opts.log(`  ${it.id} recording ${cut.from.toFixed(2)}–${cut.to.toFixed(2)}s`);
        synthesized++;
      }
      unlinkSync(whole);
      save();
    }
    const retried = (id: string) =>
      (opts.retry ?? []).some((r) => id === r || id.startsWith(`${r}:`));
    estimateTime(
      jobs.filter((j) => {
        const e = manifest.entries[j.key];
        return retried(j.id) || !e || !existsSync(join(lockDir, e.src));
      }),
      (j) => retried(j.id),
    );
    for (const job of jobs) {
      const existing = manifest.entries[job.key];
      const hasLock = !!existing && existsSync(join(lockDir, existing.src));
      // the entry this sentence had before its key changed (power added, text edited, …)
      const oldKey = previous?.sentences[job.id];
      const old = oldKey && oldKey !== job.key ? previous?.entries[oldKey] : undefined;
      if (!existing && old?.select?.retry)
        warnings.push(
          `${job.id}: the take chosen with --retry before is not used (the sentence's key changed) — "${job.text}"`,
        );
      const wantRetry = retried(job.id);
      const base = existing ?? old;
      // takes already made from the same raw takes (the old entry when only power changed)
      const madeBefore = Math.max(
        // a 2a entry has no synthKey: count it (new seeds either way)
        ...[existing, !old?.synthKey || old.synthKey === job.synthKey ? old : undefined].map((e) =>
          e ? Math.max(e.tried ?? e.attempt, e.attempt) : -1,
        ),
      );
      let first = 0;
      if (wantRetry) {
        if (base) {
          // new seeds: after every take made so far for this synthesis key (A4)
          first = Math.max(madeBefore, lastRawTake(job.synthKey)) + 1;
          opts.log(`  ${job.id} retry requested → new takes from ${first}`);
        } else opts.log(`  ${job.id} retry: no lock entry — synthesizing it`);
      }
      if (!wantRetry && hasLock) {
        // Sentences already in the lock are not checked again unless asked (Q9).
        const reasons = opts.recheck ? await recheckReasons(job, existing!) : [];
        if (reasons.length === 0) {
          reused++;
          continue;
        }
        opts.log(`  ${job.id} recheck failed: ${reasons.join('; ')} → re-synthesizing`);
        if (existing!.select?.retry)
          warnings.push(`${job.id}: the take chosen with --retry is replaced by a budget take`);
      }
      const retrying = wantRetry && first > 0;
      let tried: Attempt[] = [];
      let chosen: Attempt;
      let select: LockEntry['select'] | undefined;
      if (job.emotional) {
        const r = await emotionTakes(job, first, retrying);
        tried = r.tried;
        const c = choose(job, r.candidates, r.ctx, neighborOf(job));
        chosen = c.chosen;
        select = c.select ? { ...c.select, retry: retrying } : undefined;
        if (retrying && !c.select) {
          if (hasLock) {
            warnings.push(
              `${job.id}: no new take passed (${chosen.assessment.reasons.join('; ')}) — kept the locked take`,
            );
            for (const t of tried)
              if (dirname(t.wavPath) === lockDir && existsSync(t.wavPath)) unlinkSync(t.wavPath);
            existing!.tried = Math.max(
              existing!.tried ?? existing!.attempt,
              first + tried.length - 1,
            );
            save();
            reused++;
            continue;
          }
          // no entry under the current key: the budget takes instead, so the line has audio
          const b = await emotionTakes(job, 0, false);
          const c2 = choose(job, b.candidates, b.ctx, neighborOf(job));
          tried = [
            ...tried.filter((t) => !b.tried.some((x) => x.attempt === t.attempt)),
            ...b.tried,
          ];
          chosen = c2.chosen;
          select = c2.select ? { ...c2.select, retry: false } : undefined;
        }
      } else {
        tried = await plainTakes(job, first);
        const retryTakes = new Set(tried);
        chosen = firstPassing(tried);
        if (retrying && !chosen.assessment.ok && !hasLock) {
          // no entry under the current key: the budget takes instead, so the line has audio
          const b = await plainTakes(job, 0);
          tried = [...tried.filter((t) => !b.some((x) => x.attempt === t.attempt)), ...b];
          chosen = firstPassing(b);
        } else if (retrying && !chosen.assessment.ok) {
          warnings.push(
            `${job.id}: no new take passed (${chosen.assessment.reasons.join('; ')}) — kept the locked take`,
          );
          for (const t of tried)
            if (dirname(t.wavPath) === lockDir && existsSync(t.wavPath)) unlinkSync(t.wavPath);
          existing!.tried = Math.max(
            existing!.tried ?? existing!.attempt,
            first + tried.length - 1,
          );
          save();
          reused++;
          continue;
        }
        if (retrying && retryTakes.has(chosen))
          select = { n: 1, rank: 0, neighbor: false, retry: true };
      }
      if (!chosen.assessment.ok) {
        warnings.push(
          `${job.id}: kept attempt ${chosen.attempt} despite ${chosen.assessment.reasons.join('; ')} — "${job.text}" → heard "${chosen.heard}"`,
        );
      }
      const madeUpTo = Math.max(...tried.map((t) => t.attempt), madeBefore);
      commit(job, chosen, tried, { tried: madeUpTo, ...(select ? { select } : {}) });
      synthesized++;
      const e = manifest.entries[job.key]!;
      opts.log(
        `  ${job.id} ${job.target.engine}:${job.target.voice} ${e.duration.toFixed(2)}s` +
          (chosen.removed > 0 ? ` (-${chosen.removed.toFixed(2)}s pauses)` : '') +
          ` cer=${(chosen.assessment.cer ?? 0).toFixed(2)}` +
          (job.emotional ? ` take ${chosen.attempt} of ${tried.length}` : ''),
      );
    }
  } finally {
    tts.stop();
    aligner.stop();
  }
  save();
  return { manifestPath, synthesized, reused, warnings };
}

/** Audio manifest for the timeline (sentence id → audio), resolved from the lock. */
export function loadAudioManifest(
  scriptPath: string,
  lang: string,
  lockDirOverride?: string,
): AudioManifest {
  const lockDir = lockDirOverride ?? join(dirname(scriptPath), 'audio', lang);
  const m = JSON.parse(readFileSync(join(lockDir, 'manifest.json'), 'utf8')) as LockManifest;
  const out: AudioManifest = {};
  for (const [id, key] of Object.entries(m.sentences)) {
    const e = m.entries[key];
    if (e) out[id] = { src: join(lockDir, e.src), duration: e.duration, words: e.words };
  }
  return out;
}

/**
 * Remove audio the script no longer uses from its lock: entries not referenced by the current
 * sentence map (run `tts` first so the map is current) and leftover takes. Returns what was removed.
 */
export function pruneAudio(
  scriptPath: string,
  lang: string,
): { entries: number; files: number; bytes: number } {
  const lockDir = join(dirname(scriptPath), 'audio', lang);
  const manifestPath = join(lockDir, 'manifest.json');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as LockManifest;
  const used = new Set(Object.values(m.sentences));
  let entries = 0;
  for (const key of Object.keys(m.entries))
    if (!used.has(key)) {
      delete m.entries[key];
      entries++;
    }
  const keep = new Set(Object.values(m.entries).map((e) => e.src));
  let files = 0;
  let bytes = 0;
  for (const f of readdirSync(lockDir)) {
    if (!f.endsWith('.wav') || keep.has(f)) continue;
    bytes += statSync(join(lockDir, f)).size;
    unlinkSync(join(lockDir, f));
    files++;
  }
  writeFileSync(manifestPath, JSON.stringify(m, null, 2));
  return { entries, files, bytes };
}
