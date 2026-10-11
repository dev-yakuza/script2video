/**
 * `s2v tts`: synthesize every sentence of a script into the audio lock (PLAN 5.2).
 *
 *   synthesize (tts-server) → atempo if speed≠1 (Qwen) → 48 kHz mono + trim silence (ffmpeg)
 *   → word timing (aligner /align) → ASR round-trip CER (aligner /transcribe, warn only in M1)
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
  assessSentence,
  bestAttempt,
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
import { compressPausesInFile, cropFile, loudnessReader } from './pauses.js';
import { mockEnabled, mockSynthesize } from './mock-tts.js';
import { splitRecording } from './recording.js';
import { resolvePersona, type PersonaRef } from './persona.js';
import { ALIGNER, Service, TTS_SERVER } from './services.js';

const run = promisify(execFile);
const POSTPROCESS_VERSION = 'pp3-48k-mono-trim50db-pausecap-edgecut';
/** Bump when the aligner input or mapping changes: word timings are re-measured (raw audio reused). */
const ALIGN_VERSION = 'al2-ko-numbers-spelled';
/** How recordings are cut into sentences (recording.ts). */
const RECORDING_VERSION = 'rec1-midgap';

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function hashKey(fields: unknown): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex').slice(0, 24);
}
/** Re-synthesis attempts after the first one when a sentence fails the checks (PLAN 5.2). */
const MAX_RETRIES = 3;
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
  /** Median pitch (Hz) of the voiced frames, for voice consistency across sentences. */
  f0?: number;
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

/** A sentence's median pitch may differ from its voice's median by at most this many semitones. */
export const PITCH_LIMIT_ST = 2.0;
/** Extra attempts spent on bringing a pitch outlier back in line. */
const PITCH_RETRIES = 4;

const semitones = (hz: number, ref: number) => 12 * Math.log2(hz / ref);

interface SentenceJob {
  id: string;
  text: string;
  member: CastMember;
  target: VoiceTarget;
  /** Sentences sharing a voice group are expected to sound like one speaker. */
  voiceGroup: string;
  ttsText: string;
  alignText: string;
  synthKey: string;
  synthFields: { speed: number; instruct: string };
  key: string;
  tempo: number | null;
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
  const draftVoices = ['F1', 'M1', 'F2', 'M2', 'F3', 'M3', 'F4', 'M4', 'F5', 'M5'];
  const castOrder = Object.keys(meta.cast);
  const memberFor = (castKey: string): CastMember => {
    const member = meta.cast[castKey]!;
    if (!opts.draft) return member;
    const voice =
      member.draftVoice ??
      `supertonic:${draftVoices[castOrder.indexOf(castKey) % draftVoices.length]}`;
    return { ...member, voice, style: undefined };
  };
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

  // ---------- jobs ----------
  const jobs: SentenceJob[] = [];
  const recorded: {
    src: string;
    sha: string;
    items: { id: string; key: string; text: string; alignText: string }[];
  }[] = [];
  for (const scene of script.scenes) {
    for (const [bi, block] of scene.blocks.entries()) {
      if (block.kind !== 'paragraph') continue;
      if (block.audio) {
        // Your own recording instead of TTS (see recording.ts).
        const src = resolve(dirname(scriptPath), block.audio);
        if (!existsSync(src)) throw new Error(`recording not found: ${block.audio}`);
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
          manifest.sentences[id] = key;
          return { id, key, text: sentence.text, alignText };
        });
        recorded.push({ src, sha, items });
        continue;
      }
      const member = memberFor(block.cast);
      // Mock runs need no persona reference clips (CI has none).
      const target: VoiceTarget =
        mock && member.voice.startsWith('persona:')
          ? { engine: 'persona', voice: member.voice.slice(8), modelName: 'qwen3-tts-1.7b-base' }
          : voiceTarget(member, meta.lang, dirname(scriptPath));
      for (const [si, sentence] of block.sentences.entries()) {
        const ttsText = toTtsText(sentence.text, meta.pronounce).tts;
        // Two-level key: the raw TTS output depends only on synthesis inputs; post-processing
        // (tempo, trim, pause compression, alignment) can change without re-running the model.
        const synthFields = {
          ...(mock ? { mock: 1 } : {}),
          engine: target.engine,
          model: models[target.modelName]!.revision,
          wrapper: '0.1.0',
          voice: target.voice,
          // persona: the exact reference clip and its sentence define the voice
          ...(target.ref ? { ref: target.ref.sha256, refText: target.ref.text } : {}),
          instruct: target.engine === 'qwen' ? (member.style ?? '') : '',
          lang: meta.lang,
          speed: target.engine === 'supertonic' ? member.speed : 1,
          seed: meta.seed,
          decoding: 'sampling-default',
          text: ttsText,
        };
        const synthKey = hashKey(synthFields);
        const tempo = target.engine !== 'supertonic' && member.speed !== 1 ? member.speed : null;
        const key = hashKey({
          synthKey,
          postprocess: POSTPROCESS_VERSION,
          align: ALIGN_VERSION,
          tempo,
          maxPause: meta.pacing.maxPause,
        });
        const id = sentenceId(scene.id, bi, si);
        manifest.sentences[id] = key;
        jobs.push({
          id,
          text: sentence.text,
          member,
          target,
          voiceGroup: `${target.engine}:${target.voice}:${target.ref?.sha256 ?? ''}:${synthFields.instruct}:${member.speed}`,
          ttsText,
          alignText: toAlignText(sentence.text, meta.pronounce, meta.lang).tts,
          synthKey,
          synthFields,
          key,
          tempo,
        });
      }
    }
  }

  // ---------- one attempt: synthesize → post-process → align → ASR → assess ----------
  const runAttempt = async (job: SentenceJob, attempt: number): Promise<Attempt> => {
    if (mock) {
      const wavPath = join(lockDir, `${job.key}.try${attempt}.wav`);
      const words = mockSynthesize(job.alignText, meta.lang, job.member.speed, wavPath);
      const assessment = assessSentence({
        text: job.text,
        lang: meta.lang,
        duration: wavDuration(wavPath),
        words,
        cer: null,
        speed: job.member.speed,
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
        speed: job.member.speed,
        loudness: loudnessReader(wavPath),
      });
    let assessment = assess();
    // Non-speech sound before the first / after the last word (laughs, breaths — common on very
    // short sentences) is cut away instead of re-synthesizing; inside words it cannot be.
    const edgeOnly = /before the first word|after the last word/;
    if (!assessment.ok && words.length > 0 && assessment.reasons.some((r) => edgeOnly.test(r))) {
      const from = Math.max(0, words[0]!.start - EDGE_PAD_LEAD_S);
      const to = Math.min(wavDuration(wavPath), words[words.length - 1]!.end + EDGE_PAD_TAIL_S);
      cropFile(wavPath, from, to);
      words = words.map((w) => ({ ...w, start: Math.max(0, w.start - from), end: w.end - from }));
      assessment = assess();
      opts.log(
        `  ${job.id} attempt ${attempt}: cut non-speech outside the words (kept ${from.toFixed(2)}–${to.toFixed(2)}s)`,
      );
    }
    const f0 = (await aligner.post<{ median_hz: number | null }>('/pitch', { wav_path: wavPath }))
      .data.median_hz;
    return { attempt, wavPath, words, heard, removed, info, assessment, f0 };
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
      ...(chosen.f0 ? { f0: Number(chosen.f0.toFixed(1)) } : {}),
    };
    save();
  };

  try {
    // ---------- pass 1: every sentence passes the per-sentence checks ----------
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
        const check = opts.recheck
          ? assessSentence({
              text: job.text,
              lang: meta.lang,
              duration: existing.duration,
              words: existing.words,
              cer: opts.asr ? existing.cer : null,
              speed: job.member.speed,
              loudness: loudnessReader(join(lockDir, existing.src)),
            })
          : null;
        if (!check || check.ok) {
          reused++;
          continue;
        }
        opts.log(`  ${job.id} recheck failed: ${check.reasons.join('; ')} → re-synthesizing`);
      }
      const tried: Attempt[] = [];
      for (let attempt = first; attempt <= first + MAX_RETRIES; attempt++) {
        const a = await runAttempt(job, attempt);
        tried.push(a);
        if (a.assessment.ok) break;
        opts.log(
          `  ${job.id} attempt ${attempt}: ${a.assessment.reasons.join('; ')}${attempt < first + MAX_RETRIES ? ' → retrying' : ''}`,
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

    if (opts.draft || mock) return { manifestPath, synthesized, reused, warnings };
    // ---------- pass 2: one speaker should keep one pitch across sentences ----------
    // Sentences are sampled independently, so an LLM TTS sometimes picks a clearly different pitch
    // for one sentence and it sounds like another person. Measure each sentence's median F0, and
    // re-synthesize the ones too far from their voice's median.
    for (const job of jobs) {
      const e = manifest.entries[job.key]!;
      if (e.f0 === undefined) {
        await ensureServices();
        const hz = (
          await aligner.post<{ median_hz: number | null }>('/pitch', {
            wav_path: join(lockDir, e.src),
          })
        ).data.median_hz;
        if (hz) e.f0 = Number(hz.toFixed(1));
      }
    }
    save();
    const groups = new Map<string, SentenceJob[]>();
    for (const job of jobs)
      groups.set(job.voiceGroup, [...(groups.get(job.voiceGroup) ?? []), job]);
    for (const [group, members] of groups) {
      const pitched = members.filter((j) => manifest.entries[j.key]!.f0);
      if (pitched.length < 3) continue;
      const logs = pitched
        .map((j) => Math.log2(manifest.entries[j.key]!.f0!))
        .sort((a, b) => a - b);
      const ref = Math.pow(2, logs[Math.floor(logs.length / 2)]!);
      for (const job of pitched) {
        const e = manifest.entries[job.key]!;
        const dev = semitones(e.f0!, ref);
        if (Math.abs(dev) <= PITCH_LIMIT_ST) continue;
        opts.log(
          `  ${job.id} pitch ${e.f0}Hz is ${dev > 0 ? '+' : ''}${dev.toFixed(1)} st from ${group.split(':')[1]}'s median ${ref.toFixed(0)}Hz → re-synthesizing`,
        );
        const tried: Attempt[] = [];
        let best: Attempt | null = null;
        for (let k = 1; k <= PITCH_RETRIES; k++) {
          const a = await runAttempt(job, e.attempt + k);
          tried.push(a);
          const d = a.f0 ? Math.abs(semitones(a.f0, ref)) : Infinity;
          if (a.assessment.ok && (!best || d < Math.abs(semitones(best.f0!, ref)))) best = a;
          if (a.assessment.ok && d <= PITCH_LIMIT_ST) break;
        }
        if (best && Math.abs(semitones(best.f0!, ref)) < Math.abs(dev)) {
          commit(job, best, tried);
          synthesized++;
          opts.log(
            `  ${job.id} pitch now ${best.f0!.toFixed(0)}Hz (${semitones(best.f0!, ref) > 0 ? '+' : ''}${semitones(best.f0!, ref).toFixed(1)} st)`,
          );
        } else {
          for (const t of tried) if (existsSync(t.wavPath)) unlinkSync(t.wavPath);
          warnings.push(
            `${job.id}: pitch stays ${dev.toFixed(1)} st from the voice median after ${PITCH_RETRIES} attempts`,
          );
        }
      }
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
