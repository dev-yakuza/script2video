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
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  ACTING_VERSION,
  actsEmotion,
  analyzeLevels,
  endsWithQuestion,
  ESTIMATE_RATE,
  FIRST_TAKES,
  isStandardEmotion,
  MAX_TAKES,
  selectTake,
  takeBudgetDone,
  type Engine,
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
  cerReason,
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
import {
  dropStaleWithId,
  pickText,
  PICKS_VERSION,
  picksPath,
  readPicks,
  shellQuote,
  stalePicks,
  writePicks,
  type Pick as PickEntry,
  type PickLine,
  type PicksFile,
} from './picks.js';
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
import { isTrainedProblem, resolvePersona, resolveTrained, type PersonaRef } from './persona.js';
import { ALIGNER, Service, TTS_SERVER } from './services.js';
import {
  ClipVectors,
  createReference,
  describeVoice,
  embed,
  loadReference,
  synthesisBody,
  type LoadedReference,
  type RefServices,
  type RefVoice,
} from './voice-refs.js';
import { atomicWrite } from './atomic.js';

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
const TAKE_SECONDS: Record<Engine, number> = {
  qwen: 5,
  persona: 5,
  trained: 5,
  supertonic: 2,
};
/** Takes a line needs on average (stage 3 plan 9), takes of a new voice reference, server start. */
const EXPECTED_TAKES = { emotion: 3.4, plain: 1.2 };
const REFERENCE_TAKES = 20;
const SERVER_START_S = 30;

const sha16 = (path: string) => sha256File(path).slice(0, 16);

/** Cache folders of the takes (stage 3 plan 2): raw model output and post-processed takes. */
export const rawDirOf = (repoRoot: string) => join(repoRoot, '.s2v-cache', 'tts-raw');
export const takesDirOf = (repoRoot: string) => join(repoRoot, '.s2v-cache', 'tts-takes');
/** Take cache key: the raw take and how it was post-processed (no power, no alignment). */
export const takeKeyOf = (
  job: Pick<SentenceJob, 'synthKey' | 'tempo'>,
  maxPause: number,
  n: number,
) =>
  hashKey({
    synthKey: job.synthKey,
    tempo: job.tempo,
    maxPause,
    postprocess: POSTPROCESS_VERSION,
    n,
  });
/** Raw take n of a synthesis key (take 0 has no suffix). */
export const rawPathOf = (rawDir: string, synthKey: string, n: number) =>
  join(rawDir, n === 0 ? `${synthKey}.wav` : `${synthKey}.a${n}.wav`);
/** The highest take number in the raw cache for a synthesis key (-1: none). */
export function lastRawTakeIn(rawDir: string, synthKey: string): number {
  let last = -1;
  if (!existsSync(rawDir)) return last;
  for (const f of readdirSync(rawDir)) {
    if (f === `${synthKey}.wav`) last = Math.max(last, 0);
    const m = new RegExp(`^${synthKey}\\.a(\\d+)\\.wav$`).exec(f);
    if (m) last = Math.max(last, Number(m[1]));
  }
  return last;
}
/**
 * A take wav from its raw take: post-processing (trim, 48 kHz, tempo) and pause compression,
 * written whole. Returns the seconds of pauses removed. `s2v takes` makes the same wav to listen.
 */
export async function makeTakeWav(
  raw: string,
  out: string,
  tempo: number | null,
  maxPause: number,
): Promise<number> {
  const tmp = `${out}.${process.pid}.tmp.wav`;
  try {
    await postprocess(raw, tmp, tempo);
    const removed = compressPausesInFile(tmp, maxPause);
    renameSync(tmp, out);
    return removed;
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/** What made a take wav (`<take key>.json` in the take cache). */
export interface TakeMade {
  wavSha: string;
  rawSha: string;
  removed: number;
  info: { model: string; seed: number };
}
/** The take record when it still describes the take wav next to it. */
export function takeMadeOf(takesDir: string, tk: string): TakeMade | null {
  const wav = join(takesDir, `${tk}.wav`);
  const made = readJson<TakeMade>(join(takesDir, `${tk}.json`));
  if (!made || !existsSync(wav) || made.wavSha !== sha16(wav)) return null;
  if (typeof made.removed !== 'number' || typeof made.info?.model !== 'string') return null;
  return made;
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
  /** null: not heard by ASR (`asr: false`). */
  cer: number | null;
  /**
   * `heard` and `cer` come from ASR (S9a). Absent in locks made before it: see `lockAsr`.
   */
  asr?: boolean;
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
  /** How the take was chosen: by selection (emotion lines), or a pick (stage 3b). */
  select?: AutoSelect | PickSelect;
  /** Non-speech cut at the edges (seconds of the take wav). */
  crop?: { from: number; to: number };
}

/**
 * Whether a lock entry was heard by ASR (S9a). Locks made before the field: non-empty `heard`
 * of a synthesized, non-mock line means ASR ran (nothing else fills it).
 */
export function lockAsr(e: Pick<LockEntry, 'asr' | 'engine' | 'model' | 'heard'>): boolean {
  return e.asr ?? (e.engine !== 'recording' && e.model !== 'mock' && e.heard !== '');
}

/** Selection among the takes (stage 3a; `retry` only in locks made before 3b). */
export interface AutoSelect {
  n: number;
  rank: number;
  neighbor: boolean;
  retry: boolean;
}
/** The take of a pick in picks.json (stage 3b). */
export interface PickSelect {
  pick: number;
  by: 'human' | 'retry';
}
export const isPickSelect = (s: LockEntry['select']): s is PickSelect =>
  !!s && typeof (s as PickSelect).pick === 'number';

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
  engine: Engine;
  voice: string;
  modelName: string;
  /** persona only: the reference clip the Base model clones. */
  ref?: PersonaRef;
  /** trained only: the speaker file and its vector sha (stage 4). */
  speaker?: { path: string; vectorSha: string };
}

export function voiceTarget(member: CastMember, lang: Lang, scriptDir: string): VoiceTarget {
  const [kind, name] = member.voice.split(':') as [string, string];
  if (kind === 'qwen')
    return { engine: 'qwen', voice: name, modelName: 'qwen3-tts-1.7b-customvoice' };
  if (kind === 'supertonic')
    return { engine: 'supertonic', voice: name, modelName: 'supertonic-3' };
  if (member.personaModel === 'trained') {
    // the CustomVoice model with the trained speaker row; the clip is not part of the voice
    const t = resolveTrained(name, lang, scriptDir);
    if (isTrainedProblem(t)) throw new Error(t.message);
    return {
      engine: 'trained',
      voice: name,
      modelName: 'qwen3-tts-1.7b-customvoice',
      speaker: { path: t.path, vectorSha: t.vectorSha },
    };
  }
  const ref = resolvePersona(name, lang, scriptDir);
  if (typeof ref === 'string') throw new Error(ref);
  return { engine: 'persona', voice: name, modelName: 'qwen3-tts-1.7b-base', ref };
}

/**
 * A persona target for mock runs: no clip needed; a trained one keys on its speaker file when it
 * exists (so a new vector re-synthesizes), else on a placeholder.
 */
function mockPersonaTarget(member: CastMember, lang: Lang, scriptDir: string): VoiceTarget {
  const voice = member.voice.slice(8);
  if (member.personaModel !== 'trained')
    return { engine: 'persona', voice, modelName: 'qwen3-tts-1.7b-base' };
  const t = resolveTrained(voice, lang, scriptDir);
  return {
    engine: 'trained',
    voice,
    modelName: 'qwen3-tts-1.7b-customvoice',
    speaker: isTrainedProblem(t)
      ? { path: '', vectorSha: 'mock' }
      : { path: t.path, vectorSha: t.vectorSha },
  };
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
  /** The raw take it was made from (absent in mock), and whether this run synthesized it. */
  rawSha?: string;
  synthesized?: boolean;
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
    // a draft speaks plainly: no style, and its voice is no trained speaker
    return { ...member, voice, style: undefined, personaModel: undefined };
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
      // Mock runs need no persona reference clips or trained speakers (CI has none).
      let target: VoiceTarget;
      try {
        target =
          mock && member.voice.startsWith('persona:')
            ? mockPersonaTarget(member, meta.lang, dirname(scriptPath))
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
          actsEmotion(target.engine) && !opts.draft
            ? instructFor(meta, member.style, acting, target.engine)
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
          // trained: the speaker row (stage 4) — a new vector is a new voice
          ...(target.speaker ? { speaker: target.speaker.vectorSha } : {}),
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

/**
 * Whether a frozen run writes the lock manifest (S11 plan 3.7): only when its text would change
 * and the file is still what this run read (another run may have written it meanwhile).
 */
export function frozenSaveDecision(
  readAtStart: string | null,
  current: string | null,
  next: string,
): 'write' | 'same' | 'changed' {
  if (current === next) return 'same';
  if (current !== readAtStart) return 'changed';
  return 'write';
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
  // the text read now: a frozen run rewrites the lock only when nobody else did meanwhile (S11)
  const previousText = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
  const previous: LockManifest | null = previousText
    ? (JSON.parse(previousText) as LockManifest)
    : null;
  const models = (
    JSON.parse(readFileSync(join(repoRoot, 'models.lock.json'), 'utf8')) as {
      models: Record<string, { revision: string }>;
    }
  ).models;
  const revisions = Object.fromEntries(Object.entries(models).map(([k, v]) => [k, v.revision]));

  const mock = mockEnabled();
  if (mock) opts.log('S2V_TTS=mock: synthetic audio, no models');
  const rawDir = rawDirOf(repoRoot);
  mkdirSync(rawDir, { recursive: true });
  const tts = new Service(TTS_SERVER, repoRoot);
  const aligner = new Service(ALIGNER, repoRoot);
  const manifest: LockManifest = {
    version: 1,
    lang: meta.lang,
    entries: previous?.entries ?? {},
    sentences: {},
    // Server identity / versions of the last run that used each service; kept when nothing ran.
    env: previous?.env ?? {},
  };
  // locks made before S9a learn whether ASR heard them (fields only: wav and words stay)
  for (const e of Object.values(manifest.entries))
    if (e.asr === undefined) {
      e.asr = lockAsr(e);
      // what no ASR heard has no CER (an old mock line kept its script text as `heard`)
      if (!e.asr) Object.assign(e, { cer: null, heard: '' });
    }
  const warnings: string[] = [];
  const pushOnce = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  let synthesized = 0;
  let reused = 0;
  let started = false;
  let alignerStarted = false;
  /** Synthesis needs both servers. */
  const ensureServices = async () => {
    if (started) return;
    opts.log(alignerStarted ? 'starting tts-server ...' : 'starting tts-server and aligner ...');
    const [th, ah] = await Promise.all([tts.ensure(), aligner.ensure()]);
    manifest.env = { ...manifest.env, tts: th, aligner: ah };
    started = alignerStarted = true;
  };
  /** Measuring and re-judging need the aligner only: no TTS model is loaded for them (S9a). */
  const ensureAligner = async () => {
    if (alignerStarted) return;
    opts.log('starting aligner ...');
    manifest.env = { ...manifest.env, aligner: await aligner.ensure() };
    alignerStarted = true;
  };
  const save = () => atomicWrite(manifestPath, JSON.stringify(manifest, null, 2));
  // E7 (stage 3 plan 6): make all six takes of emotion lines; the choice stays the budget's
  const takesAll = process.env.S2V_TAKES_ALL === '6';
  /** Tell how long synthesis will take (stage 3 plan 9). */
  const estimateTime = (
    todo: SentenceJob[],
    retry: (j: SentenceJob) => boolean,
    takesOf = new Map<SentenceJob, number>(),
    /** Locked lines only ASR has to hear (S9a): the aligner, no synthesis. */
    rejudges = 0,
  ) => {
    if (mock || (todo.length === 0 && rejudges === 0)) return;
    if (todo.length === 0) {
      const s = SERVER_START_S + rejudges * 1.5;
      opts.log(`about ${Math.max(1, Math.round(s / 60))} min to hear ${rejudges} locked line(s)`);
      return;
    }
    // highest raw take per synthesis key, read once
    const rawMax = new Map<string, number>();
    for (const f of readdirSync(rawDir)) {
      const m = /^([0-9a-f]+)(?:\.a(\d+))?\.wav$/.exec(f);
      if (m) rawMax.set(m[1]!, Math.max(rawMax.get(m[1]!) ?? -1, Number(m[2] ?? 0)));
    }
    let seconds = 0;
    const seenRefs = new Set<string>();
    for (const j of todo) {
      const fixed = takesOf.get(j);
      const takes = fixed ?? (j.emotional ? EXPECTED_TAKES.emotion : EXPECTED_TAKES.plain);
      // a retry makes new takes; otherwise cached raw takes are only measured
      const cached = fixed !== undefined || retry(j) ? 0 : (rawMax.get(j.synthKey) ?? -1) + 1;
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
    seconds += rejudges * 1.5;
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
    ...(actsEmotion(job.target.engine) && job.member.style ? { style: job.member.style } : {}),
    ...(job.target.ref ? { ref: job.target.ref } : {}),
    ...(job.target.speaker ? { speaker: job.target.speaker } : {}),
  });
  // A voice whose reference cannot be read, made or embedded is left unchecked with a warning, like
  // a failing take (Q3): the consistency check never stops a run.
  const voiceKey = (v: RefVoice) =>
    JSON.stringify([
      v.engine,
      v.voice,
      v.style ?? '',
      v.ref?.sha256 ?? '',
      v.speaker?.vectorSha ?? '',
    ]);
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
  // picks (stage 3b plan 1): a draft or another lock folder neither reads nor writes them
  const usePicks = !opts.draft && !opts.lockDir;
  const picks: PicksFile = usePicks ? readPicks(lockDir) : { version: PICKS_VERSION, picks: {} };
  const savePicks = () => {
    if (usePicks) writePicks(lockDir, picks);
  };
  const pickLines: PickLine[] = jobs.map((j) => ({ id: j.id, pickKey: j.pickKey, text: j.text }));
  const scriptArg = shellQuote(relative(process.cwd(), scriptPath) || scriptPath);

  // ---------- takes (stage 3 plan 2–3): raw take → take wav → measurements → judgement ----------
  const takesDir = takesDirOf(repoRoot);
  if (!mock) mkdirSync(takesDir, { recursive: true });
  const takeKey = (job: SentenceJob, n: number) => takeKeyOf(job, meta.pacing.maxPause, n);
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
  const rawPath = (job: SentenceJob, n: number) => rawPathOf(rawDir, job.synthKey, n);
  const lastRawTake = (synthKey: string) => lastRawTakeIn(rawDir, synthKey);

  /** The raw take (cached) and its synthesis info. */
  const rawTake = async (job: SentenceJob, n: number) => {
    const raw = rawPath(job, n);
    const info = readJson<{ model: string; seed: number }>(`${raw}.json`);
    if (info && existsSync(raw)) return { raw, info, synthesized: false };
    await ensureServices();
    const { data: wav, headers } = await tts.post<Buffer>('/synthesize', {
      ...synthesisBody(job.target),
      lang: meta.lang,
      text: job.ttsText,
      ...(job.synthFields.instruct ? { instruct: job.synthFields.instruct } : {}),
      speed: job.synthFields.speed,
      seed_material: `${job.synthKey}:${n}`,
    });
    const meta2 = JSON.parse(headers.get('x-s2v-meta') ?? '{}') as { model: string; seed: number };
    atomicWrite(raw, wav);
    atomicWrite(`${raw}.json`, JSON.stringify(meta2));
    return { raw, info: meta2, synthesized: true };
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
  /**
   * A picked take (stage 3b plan 2): the take wav the person heard is trusted even without its raw
   * take, unless the raw take the pick was made from is still there to rebuild it from.
   */
  interface PickMode {
    rawSha?: string;
  }
  /** `raw` of an emotion take measured before (another measurement key, same take wav). */
  const borrowRaw = (tk: string, wavSha: string) => {
    const re = new RegExp(`^${tk}\\.[0-9a-f]{24}\\.json$`);
    for (const f of readdirSync(takesDir)) {
      if (!re.test(f)) continue;
      const c = readJson<TakeMeasure>(join(takesDir, f));
      if (c && c.wavSha === wavSha && c.raw) return c.raw;
    }
    return undefined;
  };
  const measureTake = async (job: SentenceJob, n: number, pick?: PickMode) => {
    const tk = takeKey(job, n);
    const wav = join(takesDir, `${tk}.wav`);
    const meta3 = join(takesDir, `${tk}.json`);
    let made = readJson<TakeMade>(meta3);
    const wavSha0 = existsSync(wav) ? sha16(wav) : null;
    // the take wav and what made it belong together (a crash between the two writes)
    const raw0 = rawPath(job, n);
    const rawSha0 = existsSync(raw0) ? sha16(raw0) : null;
    const madeBase =
      !!made &&
      made.wavSha === wavSha0 &&
      typeof made.removed === 'number' &&
      typeof made.info?.model === 'string';
    // an emotion line also measures the raw take: it must be the one the take wav was made from
    const madeOk = pick
      ? madeBase && !(pick.rawSha && made!.rawSha !== pick.rawSha && rawSha0 === pick.rawSha)
      : madeBase && (!job.emotional || made!.rawSha === rawSha0);
    const path = join(takesDir, `${tk}.${measureKey(job)}.json`);
    // a pick may go without the raw measurement, unless its raw take is there to measure
    const rawHere = () => (existsSync(raw0) ? sha16(raw0) : null);
    const valid = (c: TakeMeasure | null, sha: string | null) =>
      !!c &&
      c.wavSha === sha &&
      (!job.emotional || !!c.raw || (!!pick && rawHere() !== (made?.rawSha ?? null)));
    let cached = readJson<TakeMeasure>(path);
    if (madeOk && valid(cached, wavSha0))
      return { tk, wav, m: cached!, rawSha: made!.rawSha, synthesized: false };
    // the raw measurement of an emotion line needs the raw take: without it, the take is made
    // again from a new raw take (plain lines measure the take wav only)
    let synthesized = false;
    if (!madeOk) {
      const { raw, info, synthesized: s } = await rawTake(job, n);
      synthesized = s;
      const removed = await makeTakeWav(raw, wav, job.tempo, meta.pacing.maxPause);
      made = { wavSha: sha16(wav), rawSha: sha16(raw), removed, info };
      atomicWrite(meta3, JSON.stringify(made));
    }
    const wavSha = made!.wavSha;
    const rawSha = made!.rawSha;
    cached = readJson<TakeMeasure>(path);
    if (valid(cached, wavSha)) return { tk, wav, m: cached!, rawSha, synthesized };
    await ensureAligner();
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
    // a picked take whose raw take is gone keeps the raw measurement made before, if any
    const raw = !job.emotional
      ? undefined
      : existsSync(raw0) && sha16(raw0) === rawSha
        ? await measureRaw(job, raw0, n)
        : borrowRaw(tk, wavSha);
    const m: TakeMeasure = {
      wavSha,
      words: aligned.words,
      heard,
      removed: made!.removed,
      info: made!.info,
      pitch,
      ...(raw ? { raw } : {}),
    };
    atomicWrite(path, JSON.stringify(m));
    return { tk, wav, m, rawSha, synthesized };
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
  const finalTake = async (job: SentenceJob, n: number, pick?: PickMode) => {
    const { tk, wav, m, rawSha, synthesized } = await measureTake(job, n, pick);
    const made = { rawSha, synthesized };
    const crop = cropFor(takeJob(job), m.words, m.pitch, wavFacts(wav));
    if (!crop)
      return { tk, m, wav, words: m.words, pitch: m.pitch, crop: null, tag: 'full', ...made };
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
      await ensureAligner();
      p = {
        wavSha: m.wavSha,
        pitch: (await aligner.post<PitchResult>('/pitch', { wav_path: cut })).data,
      };
      atomicWrite(pitchPath, JSON.stringify(p));
    }
    return { tk, m, wav: cut, words, pitch: p.pitch, crop, tag, ...made };
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
  const runAttempt = async (
    job: SentenceJob,
    attempt: number,
    pick?: PickMode,
  ): Promise<Attempt> => {
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
    const f = await finalTake(job, attempt, pick);
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
      rawSha: f.rawSha,
      synthesized: f.synthesized,
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
    extra: { tried: number; select?: LockEntry['select']; takes?: Record<string, TakeRecord> },
  ) => {
    const src = `${job.key}.wav`;
    // mock takes live in the lock folder; real takes stay in the take cache
    if (dirname(chosen.wavPath) === lockDir) renameSync(chosen.wavPath, join(lockDir, src));
    else copyFileSync(chosen.wavPath, join(lockDir, src));
    for (const t of tried)
      if (t !== chosen && dirname(t.wavPath) === lockDir && existsSync(t.wavPath))
        unlinkSync(t.wavPath);
    // heard by ASR when it measured a CER (mock and --no-asr do not: S9a)
    const cer = chosen.assessment.cer;
    manifest.entries[job.key] = {
      src,
      duration: Number(wavDuration(join(lockDir, src)).toFixed(4)),
      words: chosen.words,
      heard: cer === null ? '' : chosen.heard,
      cer: cer === null ? null : Number(cer.toFixed(3)),
      asr: cer !== null,
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
      takes: {
        ...extra.takes,
        ...Object.fromEntries(
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
      },
      ...(extra.select ? { select: extra.select } : {}),
      ...(chosen.crop ? { crop: chosen.crop } : {}),
    };
    save();
  };

  /** A locked line no ASR has heard, in a run that hears (S9a plan 2.2). */
  const needsAsr = (e: LockEntry) =>
    opts.asr && !mock && e.engine !== 'recording' && e.model !== 'mock' && !lockAsr(e);
  /**
   * Hear a locked line no ASR heard, in place: the lock wav (what plays) is transcribed and its
   * heard / cer / asr written; wav, words and the take stay. Returns the CER reason when it fails
   * (null: it passes, or there was nothing to hear).
   */
  const rejudge = async (job: SentenceJob, e: LockEntry): Promise<string | null> => {
    if (!needsAsr(e)) return null;
    await ensureAligner();
    const heard = (
      await aligner.post<{ text: string }>('/transcribe', {
        wav_path: join(lockDir, e.src),
        lang: meta.lang,
      })
    ).data.text;
    const cer = roundTripCer(job.text, heard, meta.lang, meta.pronounce);
    const reason = cerReason(cer, meta.lang as Lang);
    e.heard = heard;
    e.cer = Number(cer.toFixed(3));
    e.asr = true;
    e.checks = [
      ...(e.checks ?? []).filter((r) => !r.startsWith('ASR round-trip CER')),
      ...(reason ? [reason] : []),
    ];
    // saved by the caller once the line is settled: a run cut short while choosing again leaves
    // it unheard, to be heard (and chosen again) next time
    opts.log(`  ${job.id} heard by ASR: cer=${cer.toFixed(2)}${reason ? ' — fails' : ''}`);
    return reason;
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
      await ensureAligner();
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
      // the lock must hold the picked takes (3b plan 7); nothing is written for picks
      const unapplied = usePicks ? unappliedPicks(jobs, manifest, picks) : [];
      if (unapplied.length > 0)
        throw new Error(
          `--frozen-audio: ${unapplied
            .slice(0, 5)
            .map((u) => u.message)
            .join('; ')}${unapplied.length > 5 ? '; …' : ''}`,
        );
      const next = JSON.stringify(manifest, null, 2);
      const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null;
      const decision = frozenSaveDecision(previousText, current, next);
      if (decision === 'write') atomicWrite(manifestPath, next);
      else if (decision === 'changed')
        pushOnce('the audio lock changed during this run; not rewritten');
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
      await ensureAligner();
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
          cer: null,
          asr: false,
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
    // ---------- picks (stage 3b plan 1–4) ----------
    if (usePicks) {
      // old 3a retry choices become picks; picks.json is written first, so a crash keeps them
      const migrated: [LockEntry, number][] = [];
      let cleared = false;
      const seen = new Set<string>();
      const live = new Set(Object.values(manifest.sentences));
      for (const j of jobs) {
        if (seen.has(j.pickKey)) continue;
        seen.add(j.pickKey);
        const cands = Object.entries(manifest.entries).filter(
          ([, e]) => e.pickKey === j.pickKey && !isPickSelect(e.select) && e.select?.retry,
        );
        if (cands.length === 0) continue;
        const made = (e: LockEntry) => e.tried ?? e.attempt;
        // one becomes the pick, unless a pick exists; none is moved again later (unpick)
        // only a choice a line still uses becomes a pick (an orphaned entry did not apply in 3a)
        const usable = cands.filter(([k]) => live.has(k));
        let chosen: LockEntry | undefined;
        if (!picks.picks[j.pickKey] && usable.length > 0) {
          [, chosen] =
            usable.find(([k]) => k === j.key) ??
            usable.sort(([, a], [, b]) => made(b) - made(a))[0]!;
          picks.picks[j.pickKey] = {
            take: chosen.attempt,
            id: j.id,
            text: pickText(j.text),
            tried: Math.max(...cands.map(([, c]) => made(c))),
            by: 'retry',
          };
          migrated.push([chosen, chosen.attempt]);
          opts.log(
            `  ${j.id}: the take chosen with --retry (take ${chosen.attempt}) is now a pick`,
          );
        }
        for (const [, other] of cands)
          if (other !== chosen) {
            other.select = { ...(other.select as AutoSelect), retry: false };
            cleared = true;
          }
      }
      // ids shift when lines are inserted: an applied pick names its first line now
      let changed = migrated.length > 0;
      const firstLine = new Map<string, SentenceJob>();
      for (const j of jobs) if (!firstLine.has(j.pickKey)) firstLine.set(j.pickKey, j);
      for (const [k, p] of Object.entries(picks.picks)) {
        const j = firstLine.get(k);
        if (j && (p.id !== j.id || p.text !== pickText(j.text))) {
          p.id = j.id;
          p.text = pickText(j.text);
          changed = true;
        }
      }
      if (changed) savePicks();
      if (migrated.length > 0 || cleared) {
        for (const [e, n] of migrated) e.select = { pick: n, by: 'retry' };
        save();
      }
    }

    const retryIds = opts.retry ?? [];
    const exactRetry = (id: string) => retryIds.includes(id);
    const prefixRetry = (id: string) => retryIds.some((r) => id.startsWith(`${r}:`));
    /** A retry of this line: a prefix leaves the lines a person picked alone (3b plan 4). */
    const wantsRetry = (job: SentenceJob) =>
      exactRetry(job.id) || (prefixRetry(job.id) && picks.picks[job.pickKey]?.by !== 'human');
    const locked = (job: SentenceJob) => {
      const e = manifest.entries[job.key];
      return e && existsSync(join(lockDir, e.src)) ? e : undefined;
    };
    {
      // a pick key is retried once; a pick commit makes at most its one take
      const retryKeys = new Set<string>();
      const todo: SentenceJob[] = [];
      const pickTakes = new Map<SentenceJob, number>();
      let rejudges = 0;
      const heardKeys = new Set<string>();
      for (const j of jobs) {
        const e = locked(j);
        const p = usePicks ? picks.picks[j.pickKey] : undefined;
        if (wantsRetry(j)) {
          if (!usePicks || !retryKeys.has(j.pickKey)) todo.push(j);
          retryKeys.add(j.pickKey);
        } else if (p && (!e || e.attempt !== p.take)) {
          todo.push(j);
          pickTakes.set(j, mock || takeMadeOf(takesDir, takeKey(j, p.take)) ? 0 : 1);
        } else if (!e || (!p && isPickSelect(e.select))) todo.push(j);
        else if (needsAsr(e) && !heardKeys.has(j.key)) {
          heardKeys.add(j.key);
          rejudges++;
        }
      }
      estimateTime(todo, wantsRetry, pickTakes, rejudges);
    }

    const logCommitted = (job: SentenceJob, chosen: Attempt, made: number) => {
      const e = manifest.entries[job.key]!;
      opts.log(
        `  ${job.id} ${job.target.engine}:${job.target.voice} ${e.duration.toFixed(2)}s` +
          (chosen.removed > 0 ? ` (-${chosen.removed.toFixed(2)}s pauses)` : '') +
          ` cer=${chosen.assessment.cer === null ? '—' : chosen.assessment.cer.toFixed(2)}` +
          (job.emotional || isPickSelect(e.select) ? ` take ${chosen.attempt} of ${made}` : ''),
      );
    };
    /** Takes in the lock folder (mock) that were not kept. */
    const dropTried = (tried: Attempt[], keep?: Attempt) => {
      for (const t of tried)
        if (t !== keep && dirname(t.wavPath) === lockDir && existsSync(t.wavPath))
          unlinkSync(t.wavPath);
    };

    /** Commit the picked take (3b plan 2, row 3): followed even when it fails its checks. */
    const commitPick = async (job: SentenceJob, pick: PickEntry, madeBefore: number) => {
      const a = await runAttempt(job, pick.take, pick.rawSha ? { rawSha: pick.rawSha } : {});
      await settle(job, [a], false);
      const listen = `listen again (s2v takes ${scriptArg} --list --id ${job.id})`;
      if (a.synthesized)
        warnings.push(
          `${job.id}: picked take ${pick.take} was re-synthesized — it may not sound like what you chose; ${listen}`,
        );
      else if (pick.rawSha && a.rawSha && a.rawSha !== pick.rawSha)
        warnings.push(
          `${job.id}: picked take ${pick.take} now sounds different from when you chose it — ${listen}`,
        );
      if (!a.assessment.ok)
        warnings.push(
          `${job.id}: picked take ${pick.take} fails: ${a.assessment.reasons.join('; ')}`,
        );
      const prev = manifest.entries[job.key];
      const made = Math.max(madeBefore, pick.tried, pick.take, prev?.tried ?? -1);
      commit(job, a, [a], {
        tried: made,
        select: { pick: pick.take, by: pick.by },
        ...(prev?.takes ? { takes: prev.takes } : {}),
      });
      logCommitted(job, a, made + 1);
    };

    /** The budget takes and the automatic choice (3a). */
    const budgetJob = async (job: SentenceJob, before: Attempt[], madeBefore: number) => {
      let tried: Attempt[];
      let chosen: Attempt;
      let select: AutoSelect | undefined;
      if (job.emotional) {
        const b = await emotionTakes(job, 0, false);
        const c = choose(job, b.candidates, b.ctx, neighborOf(job));
        tried = b.tried;
        chosen = c.chosen;
        select = c.select ? { ...c.select, retry: false } : undefined;
      } else {
        tried = await plainTakes(job, 0);
        chosen = firstPassing(tried);
      }
      tried = [...before.filter((t) => !tried.some((x) => x.attempt === t.attempt)), ...tried];
      if (!chosen.assessment.ok)
        warnings.push(
          `${job.id}: kept attempt ${chosen.attempt} despite ${chosen.assessment.reasons.join('; ')} — "${job.text}" → heard "${chosen.heard}"`,
        );
      const made = Math.max(...tried.map((t) => t.attempt), madeBefore);
      commit(job, chosen, tried, { tried: made, ...(select ? { select } : {}) });
      logCommitted(job, chosen, tried.length);
    };

    const retriedKeys = new Set<string>();
    // pick keys a retry in this run will decide (lines before the retried one wait for it)
    const plannedRetry = new Set(
      usePicks ? jobs.filter((j) => wantsRetry(j)).map((j) => j.pickKey) : [],
    );
    const keptPickFailures: [string, string][] = [];
    /** Pick keys whose pick a retry wrote in this run (re-applied to earlier lines after the loop). */
    const changedPicks = new Set<string>();
    /** Pick keys whose pick a passing retry replaced (their earlier failure warnings are moot). */
    const replacedPicks = new Set<string>();
    for (const job of jobs) {
      const existing = locked(job);
      const entry = manifest.entries[job.key];
      // the entry this sentence had before its key changed (power added, text edited, …)
      const oldKey = previous?.sentences[job.id];
      const old = oldKey && oldKey !== job.key ? previous?.entries[oldKey] : undefined;
      const pick = usePicks ? picks.picks[job.pickKey] : undefined;
      if (prefixRetry(job.id) && !exactRetry(job.id) && pick?.by === 'human')
        opts.log(
          `  ${job.id}: your pick (take ${pick.take}) is kept — name the sentence to retry it`,
        );
      // lines sharing a pick key share their raw takes: one retry for them
      const wantRetry = wantsRetry(job) && !(usePicks && retriedKeys.has(job.pickKey));
      // takes already made from the same raw takes (the old entry when only power changed)
      const madeBefore = Math.max(
        // a 2a entry has no synthKey: count it (new seeds either way)
        ...[entry, !old?.synthKey || old.synthKey === job.synthKey ? old : undefined].map((e) =>
          e ? Math.max(e.tried ?? e.attempt, e.attempt) : -1,
        ),
      );

      // ---- 1. retry: new takes after every take made so far (3b plan 4) ----
      if (wantRetry && (entry || old || pick)) {
        retriedKeys.add(job.pickKey);
        const first = Math.max(madeBefore, pick?.tried ?? -1, lastRawTake(job.synthKey)) + 1;
        opts.log(`  ${job.id} retry requested → new takes from ${first}`);
        let tried: Attempt[];
        let chosen: Attempt;
        let passed: boolean;
        let auto: AutoSelect | undefined;
        if (job.emotional) {
          const r = await emotionTakes(job, first, true);
          const c = choose(job, r.candidates, r.ctx, neighborOf(job));
          tried = r.tried;
          chosen = c.chosen;
          passed = c.select !== null;
          if (c.select) auto = { ...c.select, retry: true };
        } else {
          tried = await plainTakes(job, first);
          chosen = firstPassing(tried);
          passed = chosen.assessment.ok;
          if (passed) auto = { n: 1, rank: 0, neighbor: false, retry: true };
        }
        const made = Math.max(...tried.map((t) => t.attempt), madeBefore, pick?.tried ?? -1);
        if (passed) {
          let select: LockEntry['select'] = auto;
          if (usePicks) {
            if (pick && pick.take !== chosen.attempt)
              opts.log(`  ${job.id}: pick take ${pick.take} → retry take ${chosen.attempt}`);
            const firstOf = jobs.find((j) => j.pickKey === job.pickKey)!;
            picks.picks[job.pickKey] = {
              take: chosen.attempt,
              id: firstOf.id,
              text: pickText(firstOf.text),
              tried: made,
              by: 'retry',
              ...(chosen.rawSha ? { rawSha: chosen.rawSha } : {}),
            };
            // stale picks of every line with this pick key (the pick names the first one)
            if (!mock)
              for (const l of pickLines)
                if (l.pickKey === job.pickKey) dropStaleWithId(picks, pickLines, l.id);
            savePicks();
            changedPicks.add(job.pickKey);
            replacedPicks.add(job.pickKey);
            select = { pick: chosen.attempt, by: 'retry' };
          }
          commit(job, chosen, tried, { tried: made, ...(select ? { select } : {}) });
          synthesized++;
          logCommitted(job, chosen, tried.length);
          continue;
        }
        const why = chosen.assessment.reasons.join('; ');
        dropTried(tried);
        if (pick) {
          // the pick stays; the lock follows it (frozen and inspect need them to agree)
          pick.tried = Math.max(pick.tried, made);
          savePicks();
          warnings.push(
            `${job.id}: no new take passed (${why}) — kept your pick (take ${pick.take})`,
          );
          changedPicks.add(job.pickKey);
          if (existing && existing.attempt === pick.take) {
            existing.tried = Math.max(existing.tried ?? existing.attempt, made);
            existing.select = { pick: pick.take, by: pick.by };
            if (await rejudge(job, existing))
              keptPickFailures.push([
                job.pickKey,
                `${job.id}: picked take ${pick.take} fails: ${existing.checks!.join('; ')}`,
              ]);
            save();
            reused++;
          } else {
            await commitPick(job, pick, made);
            synthesized++;
          }
          continue;
        }
        // a lock still holding an unpicked take chooses again (row 4), so lock and picks agree
        if (existing && !isPickSelect(existing.select) && !(await rejudge(job, existing))) {
          warnings.push(`${job.id}: no new take passed (${why}) — kept the locked take`);
          existing.tried = Math.max(existing.tried ?? existing.attempt, made);
          save();
          reused++;
          continue;
        }
        // no entry under the current key (or an unpicked one): the budget takes
        if (existing)
          warnings.push(
            `${job.id}: no new take passed (${why})${existing.asr && existing.checks?.some((c) => c.startsWith('ASR round-trip CER')) ? ' and ASR heard the locked take fail' : ''} — chose again from the first takes`,
          );
        await budgetJob(job, tried, made);
        synthesized++;
        continue;
      }
      if (wantRetry) opts.log(`  ${job.id} retry: no lock entry — synthesizing it`);

      // ---- 2–3. a pick: keep it, or commit its take ----
      if (pick) {
        if (existing && existing.attempt === pick.take) {
          let dirty = false;
          if (
            !isPickSelect(existing.select) ||
            existing.select.pick !== pick.take ||
            existing.select.by !== pick.by
          ) {
            existing.select = { pick: pick.take, by: pick.by };
            dirty = true;
          }
          // a 2a entry learns its keys
          if (!existing.synthKey || !existing.pickKey) {
            existing.synthKey = job.synthKey;
            existing.pickKey = job.pickKey;
            dirty = true;
          }
          // heard by ASR if it was not (S9a): judged, never replaced; warned below as any failure
          if (needsAsr(existing)) {
            await rejudge(job, existing);
            dirty = true;
          }
          if (opts.recheck) {
            // judged, never replaced: a person chose it
            const reasons = await recheckReasons(job, existing);
            if (reasons.length > 0)
              keptPickFailures.push([
                job.pickKey,
                `${job.id}: picked take ${pick.take} still fails: ${reasons.join('; ')}`,
              ]);
          } else if ((existing.checks?.length ?? 0) > 0)
            // every run, as for any kept failure (unless a retry replaces the pick later)
            keptPickFailures.push([
              job.pickKey,
              `${job.id}: picked take ${pick.take} fails: ${existing.checks!.join('; ')}`,
            ]);
          if (dirty) save();
          reused++;
          continue;
        }
        // a retry of this pick key comes later in this run: the re-apply after the loop commits
        if (plannedRetry.has(job.pickKey) && !retriedKeys.has(job.pickKey)) continue;
        await commitPick(job, pick, madeBefore);
        synthesized++;
        continue;
      }

      // ---- 4. the pick is gone (unpick, reverted): choose again; 5. 3a ----
      if (existing && isPickSelect(existing.select)) {
        opts.log(`  ${job.id}: take ${existing.select.pick} is no longer picked → choosing again`);
      } else if (existing) {
        // Sentences already in the lock are not checked again unless asked (Q9), except a line no
        // ASR has heard, in a run that hears (S9a).
        const wasHeard = lockAsr(existing);
        const heard = await rejudge(job, existing);
        // a line ASR heard fail is chosen again before anything saves it (--recheck saves)
        const reasons = heard ? [heard] : opts.recheck ? await recheckReasons(job, existing) : [];
        if (reasons.length === 0) {
          if (!wasHeard && lockAsr(existing)) save();
          reused++;
          continue;
        }
        opts.log(`  ${job.id} recheck failed: ${reasons.join('; ')} → re-synthesizing`);
        if (heard) {
          const before = { attempt: existing.attempt, sha: sha16(join(lockDir, existing.src)) };
          await budgetJob(job, [], madeBefore);
          synthesized++;
          const after = manifest.entries[job.key];
          if (
            after &&
            (after.attempt !== before.attempt || sha16(join(lockDir, after.src)) !== before.sha)
          )
            warnings.push(
              `${job.id}: ASR heard the locked take fail (${heard}) — chose again; the audio changed`,
            );
          continue;
        }
      }
      await budgetJob(job, [], madeBefore);
      synthesized++;
    }

    for (const [k, w] of keptPickFailures) if (!replacedPicks.has(k)) warnings.push(w);
    // every real pick looks stale to mock keys; after the loop, as a retry may have replaced one
    if (usePicks && !mock)
      for (const st of stalePicks(picks, pickLines, scriptArg)) warnings.push(st.message);

    // a retry changed a pick that earlier lines share (another speed): they follow it now
    for (const job of jobs) {
      if (!changedPicks.has(job.pickKey)) continue;
      const pick = picks.picks[job.pickKey]!;
      const e = locked(job);
      if (e && e.attempt === pick.take) {
        if (!isPickSelect(e.select) || e.select.pick !== pick.take || e.select.by !== pick.by) {
          e.select = { pick: pick.take, by: pick.by };
          save();
        }
        continue;
      }
      await commitPick(job, pick, e ? (e.tried ?? e.attempt) : -1);
      synthesized++;
    }
  } finally {
    tts.stop();
    aligner.stop();
  }
  save();
  return { manifestPath, synthesized, reused, warnings };
}

/**
 * Lines whose lock does not hold their pick (3b plan 7–8): the picked take is not committed yet, or
 * the lock holds a pick that is gone.
 */
export function unappliedPicks(
  jobs: Pick<SentenceJob, 'id' | 'key' | 'pickKey'>[],
  lock: LockManifest | null,
  picks: PicksFile,
): { id: string; message: string }[] {
  const out: { id: string; message: string }[] = [];
  for (const j of jobs) {
    const e = lock?.entries[j.key];
    const p = picks.picks[j.pickKey];
    if (!e) continue;
    if (p && e.attempt !== p.take)
      out.push({
        id: j.id,
        message: `${j.id}: picked take ${p.take} is not in the audio lock — run s2v tts`,
      });
    else if (!p && isPickSelect(e.select))
      out.push({
        id: j.id,
        message: `${j.id}: take ${e.select.pick} was picked but the pick is gone — run s2v tts`,
      });
  }
  return out;
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
 * sentence map (run `tts` first so the map is current) and leftover takes. Picks whose key no line
 * of the script has are removed too (3b plan 3), unless some paragraph cannot be planned or
 * picks.json cannot be read. Returns what was removed.
 */
export function pruneAudio(
  scriptPath: string,
  script: Script,
  lang: string,
  repoRoot: string,
): { entries: number; files: number; bytes: number; picks: string } {
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
  atomicWrite(manifestPath, JSON.stringify(m, null, 2));
  return { entries, files, bytes, picks: prunePicks(scriptPath, script, lockDir, repoRoot) };
}

function prunePicks(scriptPath: string, script: Script, lockDir: string, repoRoot: string): string {
  if (!existsSync(picksPath(lockDir))) return 'no picks';
  let file: PicksFile;
  try {
    file = readPicks(lockDir);
  } catch (e) {
    return `picks kept: ${(e as Error).message}`;
  }
  // real keys, and mock keys (picks written in mock runs and tests)
  const real = planSentences(scriptPath, script, repoRoot, { draft: false, mock: false });
  if (real.errors.length > 0)
    return `picks kept: ${real.errors.length} paragraph(s) cannot be planned (${real.errors[0]!.message})`;
  const mock = planSentences(scriptPath, script, repoRoot, { draft: false, mock: true });
  const live = new Set([...real.jobs, ...mock.jobs].map((j) => j.pickKey));
  let n = 0;
  for (const k of Object.keys(file.picks))
    if (!live.has(k)) {
      delete file.picks[k];
      n++;
    }
  if (n > 0) writePicks(lockDir, file);
  return `removed ${n} pick(s) no line uses`;
}
