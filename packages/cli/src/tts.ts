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
  assessSentence,
  emotionGateFailures,
  GATES,
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
import { mockEnabled, mockSynthesize } from './mock-tts.js';
import { splitRecording } from './recording.js';
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
/** Takes per sentence when they keep failing the checks (acting plan 3.5, Q4). */
const MAX_ATTEMPTS = 6;
/** Padding kept around the aligned speech when cutting non-speech at the edges. */
const EDGE_PAD_LEAD_S = 0.1;
const EDGE_PAD_TAIL_S = 0.2;

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
  tempo: number | null;
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
        const key = hashKey({
          synthKey,
          postprocess: POSTPROCESS_VERSION,
          align: ALIGN_VERSION,
          tempo,
          maxPause: meta.pacing.maxPause,
        });
        plan.sentences[id] = key;
        const emotional = emotionSentence(target.engine, acting, opts.draft);
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
          tempo,
          ...(acting ? { acting } : {}),
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
            await ensureServices();
            await vectors.get(r!);
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
      return { r, sim: cosine(await embed(tts, wavPath), await vectors.get(r)) };
    } catch (e) {
      return unchecked(refVoice(job), e);
    }
  };
  /** Pitch and similarity of a take against its voice reference. */
  const emoOf = (job: SentenceJob) =>
    job.emotional && job.acting?.emo ? { emo: job.acting.emo } : {};
  const consistency = async (job: SentenceJob, wavPath: string, f0: number | null) => {
    const s = await similarity(job, wavPath);
    if (!s) return { sim: null, voiceRef: null, reasons: [] };
    return {
      sim: s.sim,
      voiceRef: s.r.sha,
      reasons: consistencyReasons({ text: job.text, f0, sim: s.sim, ...emoOf(job) }, s.r.ref),
    };
  };
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
    const trimmed = join(dir, `${job.synthKey}.a${attempt}.wav`);
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

  // ---------- one attempt: synthesize → post-process → align → ASR → assess ----------
  const runAttempt = async (job: SentenceJob, attempt: number): Promise<Attempt> => {
    if (mock) {
      const wavPath = join(lockDir, `${job.key}.try${attempt}.wav`);
      const words = mockSynthesize(job.alignText, meta.lang, job.speedProduct, wavPath);
      const assessment = assessSentence({
        text: job.text,
        lang: meta.lang,
        duration: wavDuration(wavPath),
        words,
        cer: null,
        speed: job.speedProduct,
        loudness: loudnessReader(wavPath),
      });
      return {
        attempt,
        wavPath,
        words,
        heard: job.text,
        removed: 0,
        info: { model: 'mock', seed: 0 },
        assessment,
        f0: null,
        ending: null,
        sim: null,
        voiceRef: null,
      };
    }
    await ensureServices();
    const raw = join(
      rawDir,
      attempt === 0 ? `${job.synthKey}.wav` : `${job.synthKey}.a${attempt}.wav`,
    );
    const rawMeta = `${raw}.json`;
    let info: { model: string; seed: number };
    if (existsSync(raw) && existsSync(rawMeta)) {
      info = JSON.parse(readFileSync(rawMeta, 'utf8')) as typeof info;
    } else {
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
        seed_material: `${job.synthKey}:${attempt}`,
      });
      info = JSON.parse(headers.get('x-s2v-meta') ?? '{}') as typeof info;
      writeFileSync(raw, wav);
      writeFileSync(rawMeta, JSON.stringify(info));
    }
    const wavPath = join(lockDir, `${job.key}.try${attempt}.wav`);
    await postprocess(raw, wavPath, job.tempo);
    const removed = compressPausesInFile(wavPath, meta.pacing.maxPause);
    const { data: aligned } = await aligner.post<{ words: AlignedWord[] }>('/align', {
      wav_path: wavPath,
      text: job.alignText,
      lang: meta.lang,
    });
    let heard = '';
    let cer: number | null = null;
    if (opts.asr) {
      heard = (
        await aligner.post<{ text: string }>('/transcribe', { wav_path: wavPath, lang: meta.lang })
      ).data.text;
      cer = roundTripCer(job.text, heard, meta.lang, meta.pronounce);
    }
    let words = aligned.words;
    const assess = () =>
      assessSentence({
        text: job.text,
        lang: meta.lang,
        duration: wavDuration(wavPath),
        words,
        cer,
        speed: job.speedProduct,
        loudness: loudnessReader(wavPath),
      });
    let assessment = assess();
    let cropped = false;
    const crop = () => {
      const from = Math.max(0, words[0]!.start - EDGE_PAD_LEAD_S);
      const to = Math.min(wavDuration(wavPath), words[words.length - 1]!.end + EDGE_PAD_TAIL_S);
      cropFile(wavPath, from, to);
      words = words.map((w) => ({ ...w, start: Math.max(0, w.start - from), end: w.end - from }));
      cropped = true;
      assessment = assess();
      opts.log(
        `  ${job.id} attempt ${attempt}: cut non-speech outside the words (kept ${from.toFixed(2)}–${to.toFixed(2)}s)`,
      );
    };
    // Non-speech sound before the first / after the last word (laughs, breaths — common on very
    // short sentences) is cut away instead of re-synthesizing; inside words it cannot be.
    const edgeOnly = /before the first word|after the last word/;
    if (!assessment.ok && words.length > 0 && assessment.reasons.some((r) => edgeOnly.test(r)))
      crop();
    let pitch = (await aligner.post<PitchResult>('/pitch', { wav_path: wavPath })).data;
    // emotion lines: sound before / after the voice is cut away too when it fails the edge gate
    const tempo = job.tempo ?? 1;
    const edgeFails = () =>
      pitch.lead_s * tempo > GATES.edgeS || pitch.tail_s * tempo > GATES.edgeS;
    if (gated(job) && !cropped && words.length > 0 && edgeFails()) {
      crop();
      pitch = (await aligner.post<PitchResult>('/pitch', { wav_path: wavPath })).data;
    }
    const f0 = pitch.median_hz;
    let emotion: Attempt['emotion'];
    if (gated(job)) {
      const r = await measureRaw(job, raw, attempt);
      emotion = {
        chars: charsOf(job),
        rawDuration: r.duration,
        rawPause: r.pause,
        ending: r.ending,
        lead: pitch.lead_s * tempo,
        tail: pitch.tail_s * tempo,
        noise: pitch.noise_s * tempo,
      };
      const ref = await referenceFor(job);
      const failures = emotionGateFailures(
        emotion,
        { multiplier: job.multiplier, maxPause: job.maxPause, synthSpeed: job.synthFields.speed },
        ref?.ref.rate ?? null,
      );
      if (failures.length)
        assessment = { ...assessment, ok: false, reasons: [...assessment.reasons, ...failures] };
    }
    let sim: number | null = null;
    let voiceRef: string | null = null;
    if (checkVoices) {
      const c = await consistency(job, wavPath, f0);
      sim = c.sim;
      voiceRef = c.voiceRef;
      if (c.reasons.length)
        assessment = {
          ...assessment,
          ok: false,
          reasons: [...assessment.reasons, ...c.reasons],
        };
    }
    return {
      attempt,
      wavPath,
      words,
      heard,
      removed,
      info,
      assessment,
      f0,
      ending: pitch.ending_st,
      sim,
      voiceRef,
      ...(emotion ? { emotion } : {}),
    };
  };

  const commit = (job: SentenceJob, chosen: Attempt, tried: Attempt[]) => {
    const src = `${job.key}.wav`;
    renameSync(chosen.wavPath, join(lockDir, src));
    for (const t of tried) if (t !== chosen && existsSync(t.wavPath)) unlinkSync(t.wavPath);
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
      ...(chosen.emotion
        ? {
            raw: {
              duration: Number(chosen.emotion.rawDuration.toFixed(3)),
              pause: Number(chosen.emotion.rawPause.toFixed(2)),
              ending:
                chosen.emotion.ending !== null ? Number(chosen.emotion.ending.toFixed(2)) : null,
            },
            lead: Number(chosen.emotion.lead.toFixed(3)),
            tail: Number(chosen.emotion.tail.toFixed(3)),
            noise: Number(chosen.emotion.noise.toFixed(3)),
          }
        : {}),
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
    for (const job of jobs) {
      const existing = manifest.entries[job.key];
      // A retry starts after the kept take, so every retry gives new takes (new seeds).
      const first = retried(job.id) && existing ? existing.attempt + 1 : 0;
      if (first > 0) opts.log(`  ${job.id} retry requested → new takes from attempt ${first}`);
      if (first === 0 && existing && existsSync(join(lockDir, existing.src))) {
        // Sentences already in the lock are not checked again unless asked (Q9).
        const reasons = opts.recheck ? await recheckReasons(job, existing) : [];
        if (reasons.length === 0) {
          reused++;
          continue;
        }
        opts.log(`  ${job.id} recheck failed: ${reasons.join('; ')} → re-synthesizing`);
      }
      const tried: Attempt[] = [];
      const last = first + MAX_ATTEMPTS - 1;
      for (let attempt = first; attempt <= last; attempt++) {
        const a = await runAttempt(job, attempt);
        tried.push(a);
        if (a.assessment.ok) break;
        opts.log(
          `  ${job.id} attempt ${attempt}: ${a.assessment.reasons.join('; ')}${attempt < last ? ' → retrying' : ''}`,
        );
      }
      const chosen = tried[tried.length - 1]!.assessment.ok
        ? tried[tried.length - 1]!
        : bestAttempt(tried, meta.lang);
      if (!chosen.assessment.ok) {
        warnings.push(
          `${job.id}: kept attempt ${chosen.attempt} despite ${chosen.assessment.reasons.join('; ')} — "${job.text}" → heard "${chosen.heard}"`,
        );
      }
      commit(job, chosen, tried);
      synthesized++;
      const e = manifest.entries[job.key]!;
      opts.log(
        `  ${job.id} ${job.target.engine}:${job.target.voice} ${e.duration.toFixed(2)}s` +
          (chosen.removed > 0 ? ` (-${chosen.removed.toFixed(2)}s pauses)` : '') +
          ` cer=${(chosen.assessment.cer ?? 0).toFixed(2)}`,
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
