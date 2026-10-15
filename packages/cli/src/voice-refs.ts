/**
 * Committed reference voices (acting plan 3.6) and `s2v voice refs`.
 *
 *   persona     voices/<id>/<lang>.f0.json        (the clip is the persona's reference clip)
 *   qwen        voices/_qwen/<voice>/<lang>-<style hash>.json + .wav
 *   supertonic  voices/_supertonic/<voice>/<lang>.json + .wav
 *
 * Each is measured once from 4 fixed sentences × 5 seeds and committed, so every machine checks
 * sentences against the same numbers (MPS output is not bit-identical across runs). Qwen and
 * Supertonic references are looked up like personas (up to the repository root) and created in
 * the outermost folder, so a series of videos shares one.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  consistencyReasons,
  cosine,
  medoid,
  normalizeForCer,
  REF_SEEDS,
  REF_SENTENCES,
  sentenceId,
  simFloor,
  summarizeTakes,
  VOICE_REF_VERSION,
  type Lang,
  type Script,
  type VoiceReference,
} from '@script2video/core';
import { personaSearchDirs, type PersonaRef } from './persona.js';
import { ALIGNER, Service as TtsService, TTS_SERVER, type Service } from './services.js';
import { mockEnabled } from './mock-tts.js';
import { postprocess, voiceTarget, wavDuration } from './tts.js';

const EMBED_MODEL = 'qwen3-tts-1.7b-base';

export interface RefVoice {
  engine: 'qwen' | 'persona' | 'supertonic';
  voice: string;
  lang: Lang;
  modelName: string;
  /** qwen: the cast's style instruction (part of the voice). */
  style?: string;
  ref?: PersonaRef;
}

export interface LoadedReference {
  ref: VoiceReference;
  jsonPath: string;
  clipPath: string;
  /** sha256 (16 hex) of the reference file: stored on lock entries measured against it. */
  sha: string;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

export const styleHash = (style: string | undefined) => sha256(style ?? '').slice(0, 8);

export function describeVoice(v: RefVoice): string {
  return `${v.engine}:${v.voice}${v.style ? ` (style "${v.style}")` : ''} ${v.lang}`;
}

/** Where the reference of a voice is (or would be created): relative path inside a voices dir. */
function relativePath(v: RefVoice): { json: string; clip: string } {
  if (v.engine === 'qwen') {
    const base = join('_qwen', v.voice, `${v.lang}-${styleHash(v.style)}`);
    return { json: `${base}.json`, clip: `${base}.wav` };
  }
  const base = join('_supertonic', v.voice, v.lang);
  return { json: `${base}.json`, clip: `${base}.wav` };
}

export function referenceLocation(
  v: RefVoice,
  scriptDir: string,
): { jsonPath: string; clipPath: string; exists: boolean } {
  if (v.engine === 'persona') {
    if (!v.ref) throw new Error(`persona ${v.voice} has no reference clip`);
    const dir = dirname(v.ref.wavPath);
    const jsonPath = join(dir, `${v.lang}.f0.json`);
    return { jsonPath, clipPath: v.ref.wavPath, exists: existsSync(jsonPath) };
  }
  const rel = relativePath(v);
  const dirs = personaSearchDirs(scriptDir);
  for (const d of dirs)
    if (existsSync(join(d, rel.json)))
      return { jsonPath: join(d, rel.json), clipPath: join(d, rel.clip), exists: true };
  // Created in the repository root's voices/, or next to the script outside a repository.
  const inRepo = existsSync(join(dirname(dirs[dirs.length - 1]!), '.git'));
  const outer = inRepo ? dirs[dirs.length - 1]! : dirs[0]!;
  return { jsonPath: join(outer, rel.json), clipPath: join(outer, rel.clip), exists: false };
}

/**
 * The committed reference of a voice. `stale` says why it no longer describes the voice (it is
 * then made again); `warning` is a model revision change (kept: re-made only on request).
 */
export function loadReference(
  v: RefVoice,
  scriptDir: string,
  revisions: Record<string, string>,
): { loaded: LoadedReference | null; stale: string | null; warning: string | null } {
  const loc = referenceLocation(v, scriptDir);
  if (!loc.exists) return { loaded: null, stale: null, warning: null };
  const text = readFileSync(loc.jsonPath, 'utf8');
  const ref = JSON.parse(text) as VoiceReference;
  const loaded = {
    ref,
    jsonPath: loc.jsonPath,
    clipPath: loc.clipPath,
    sha: sha256(text).slice(0, 16),
  };
  if (ref.version !== VOICE_REF_VERSION)
    return { loaded, stale: `recipe v${ref.version} → v${VOICE_REF_VERSION}`, warning: null };
  if (v.engine === 'persona' && ref.refSha !== v.ref?.sha256)
    return { loaded, stale: 'the persona reference clip changed', warning: null };
  if (!existsSync(loc.clipPath) || sha256(readFileSync(loc.clipPath)) !== ref.clipSha)
    return { loaded, stale: `${loc.clipPath} is missing or was edited`, warning: null };
  const warnings = [
    ...(ref.revision !== revisions[v.modelName] ? [`${v.modelName} revision`] : []),
    ...(ref.embedder.revision !== revisions[EMBED_MODEL] ? ['speaker encoder revision'] : []),
  ];
  return {
    loaded,
    stale: null,
    warning: warnings.length
      ? `voice reference of ${describeVoice(v)} was made with another ${warnings.join(' and ')}; ` +
        `\`s2v voice refs <script> --refresh\` makes it again`
      : null,
  };
}

export interface RefServices {
  tts: Service;
  aligner: Service;
  /** Starts the servers on first use. */
  ensure: () => Promise<void>;
}

/** Synthesize the 20 takes, measure them and write the reference (and the clip for presets). */
export async function createReference(
  v: RefVoice,
  scriptDir: string,
  repoRoot: string,
  revisions: Record<string, string>,
  services: RefServices,
  log: (m: string) => void,
  /** Synthesize the takes again instead of re-measuring cached ones (`voice refs --refresh`). */
  fresh = false,
): Promise<LoadedReference> {
  const loc = referenceLocation(v, scriptDir);
  await services.ensure();
  const sentences = REF_SENTENCES[v.lang];
  // Cached takes are reused only for the same voice and the same model revision.
  const id = sha256(
    JSON.stringify([
      VOICE_REF_VERSION,
      v.engine,
      v.voice,
      v.lang,
      v.style ?? '',
      v.ref?.sha256 ?? '',
      revisions[v.modelName],
      TTS_SERVER.wrapper,
    ]),
  ).slice(0, 24);
  const work = join(repoRoot, '.s2v-cache', 'voice-refs', id);
  if (fresh) rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  log(
    `  making the voice reference of ${describeVoice(v)}: ${sentences.length * REF_SEEDS} takes ...`,
  );
  const takes: (VoiceReference['takes'][number] & { wav: string; vector: number[] })[] = [];
  for (const [s, text] of sentences.entries()) {
    for (let n = 0; n < REF_SEEDS; n++) {
      const raw = join(work, `${s}-${n}.raw.wav`);
      const metaPath = `${raw}.json`;
      let seed: number;
      if (existsSync(raw) && existsSync(metaPath)) {
        seed = (JSON.parse(readFileSync(metaPath, 'utf8')) as { seed: number }).seed;
      } else {
        const { data, headers } = await services.tts.post<Buffer>('/synthesize', {
          engine: v.engine,
          voice: v.voice,
          lang: v.lang,
          text,
          ...(v.style ? { instruct: v.style } : {}),
          speed: 1,
          ...(v.ref ? { ref_wav_path: v.ref.wavPath, ref_text: v.ref.text } : {}),
          seed_material: JSON.stringify(['voice-ref', id, s, n]),
        });
        seed = (JSON.parse(headers.get('x-s2v-meta') ?? '{}') as { seed: number }).seed;
        writeFileSync(raw, data);
        writeFileSync(metaPath, JSON.stringify({ seed }));
      }
      const wav = join(work, `${s}-${n}.wav`);
      await postprocess(raw, wav, null);
      const { data: p } = await services.aligner.post<{ median_hz: number | null }>('/pitch', {
        wav_path: wav,
      });
      const vector = await embed(services.tts, wav);
      takes.push({
        sentence: s,
        seed,
        f0: p.median_hz === null ? null : Number(p.median_hz.toFixed(1)),
        rate: Number(([...normalizeForCer(text, v.lang)].length / wavDuration(wav)).toFixed(2)),
        sim: 0,
        wav,
        vector,
      });
    }
  }
  let clipVector: number[];
  let clipTake = -1;
  if (v.engine === 'persona') {
    clipVector = await embed(services.tts, loc.clipPath);
  } else {
    clipTake = medoid(takes.map((t) => t.vector));
    clipVector = takes[clipTake]!.vector;
  }
  for (const t of takes) t.sim = Number(cosine(t.vector, clipVector).toFixed(4));
  const summary = summarizeTakes(takes);
  // The preset clip is written only once the takes are measured, never without its JSON.
  if (clipTake >= 0) {
    mkdirSync(dirname(loc.clipPath), { recursive: true });
    copyFileSync(takes[clipTake]!.wav, loc.clipPath);
  }
  // The take chosen as the clip is not compared with itself.
  const sims = takes.filter((_, i) => i !== clipTake).map((t) => t.sim);
  const ref: VoiceReference = {
    version: VOICE_REF_VERSION,
    engine: v.engine,
    voice: v.voice,
    lang: v.lang,
    ...(v.style ? { style: v.style } : {}),
    model: v.modelName,
    revision: revisions[v.modelName]!,
    ...(v.ref ? { refSha: v.ref.sha256 } : {}),
    embedder: { model: EMBED_MODEL, revision: revisions[EMBED_MODEL]! },
    clip: loc.clipPath.split(/[\\/]/).pop()!,
    clipSha: sha256(readFileSync(loc.clipPath)),
    f0: Number(summary.f0.toFixed(1)),
    sigma: Number(summary.sigma.toFixed(2)),
    rate: Number(summary.rate.toFixed(2)),
    sims,
    simFloor: Number(simFloor(sims).toFixed(4)),
    takes: takes.map(({ sentence, seed, f0, rate, sim }) => ({ sentence, seed, f0, rate, sim })),
    created: new Date().toISOString(),
  };
  mkdirSync(dirname(loc.jsonPath), { recursive: true });
  const text = `${JSON.stringify(ref, null, 2)}\n`;
  writeFileSync(loc.jsonPath, text);
  log(
    `  wrote ${loc.jsonPath}: pitch ${ref.f0} Hz ± ${ref.sigma} st, ${ref.rate} chars/s, ` +
      `similarity ≥ ${ref.simFloor} (commit it with the video)`,
  );
  return { ref, jsonPath: loc.jsonPath, clipPath: loc.clipPath, sha: sha256(text).slice(0, 16) };
}

export async function embed(tts: Service, wavPath: string): Promise<number[]> {
  return (await tts.post<{ vector: number[] }>('/embed', { wav_path: wavPath })).data.vector;
}

/** x-vectors of reference clips, computed once per process. */
export class ClipVectors {
  private cache = new Map<string, number[]>();
  constructor(private tts: Service) {}
  async get(r: LoadedReference): Promise<number[]> {
    const key = `${r.clipPath}:${r.ref.clipSha}`;
    if (!this.cache.has(key)) this.cache.set(key, await embed(this.tts, r.clipPath));
    return this.cache.get(key)!;
  }
}

/** Synthesized sentences of one cast member in the current script (id → sentence text). */
export function castSentences(script: Script, castKey: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const scene of script.scenes)
    for (const [bi, block] of scene.blocks.entries()) {
      if (block.kind !== 'paragraph' || block.audio || block.cast !== castKey) continue;
      for (const [si, s] of block.sentences.entries())
        out.set(sentenceId(scene.id, bi, si), s.text);
    }
  return out;
}

/** Re-judge locked sentences against a reference (no re-synthesis): the ones that now fail. */
export async function lockedFailures(
  sentences: Map<string, string>,
  lock: {
    dir: string;
    sentences: Record<string, string>;
    entries: Record<string, { src: string; f0?: number | null; sim?: number; voiceRef?: string }>;
  },
  r: LoadedReference,
  services: RefServices,
  vectors: ClipVectors,
): Promise<{ id: string; text: string; reasons: string[] }[]> {
  const out: { id: string; text: string; reasons: string[] }[] = [];
  for (const [id, text] of sentences) {
    const e = lock.entries[lock.sentences[id] ?? ''];
    if (!e || !existsSync(join(lock.dir, e.src))) continue;
    const wav = join(lock.dir, e.src);
    await services.ensure();
    const f0 =
      e.f0 !== undefined
        ? e.f0
        : (await services.aligner.post<{ median_hz: number | null }>('/pitch', { wav_path: wav }))
            .data.median_hz;
    const sim =
      e.voiceRef === r.sha && e.sim !== undefined
        ? e.sim
        : cosine(await embed(services.tts, wav), await vectors.get(r));
    const reasons = consistencyReasons({ text, f0, sim }, r.ref);
    if (reasons.length) out.push({ id, text, reasons });
  }
  return out;
}

/**
 * `s2v voice refs <script>`: the reference of every voice the script uses — show it, make the
 * missing or out-of-date ones (`--refresh`: all of them), and list the locked sentences that a new
 * reference would now reject. Locked audio is never re-made here (`tts --recheck` does that).
 */
export async function voiceRefs(
  scriptPath: string,
  script: Script,
  repoRoot: string,
  opts: { refresh: boolean; log: (m: string) => void },
): Promise<void> {
  if (mockEnabled()) throw new Error('voice refs needs the models; unset S2V_TTS=mock');
  const { meta } = script;
  const scriptDir = dirname(scriptPath);
  const revisions = Object.fromEntries(
    Object.entries(
      (
        JSON.parse(readFileSync(join(repoRoot, 'models.lock.json'), 'utf8')) as {
          models: Record<string, { revision: string }>;
        }
      ).models,
    ).map(([k, v]) => [k, v.revision]),
  );
  const tts = new TtsService(TTS_SERVER, repoRoot);
  const aligner = new TtsService(ALIGNER, repoRoot);
  let started = false;
  const services: RefServices = {
    tts,
    aligner,
    ensure: async () => {
      if (started) return;
      opts.log('starting tts-server and aligner ...');
      await Promise.all([tts.ensure(), aligner.ensure()]);
      started = true;
    },
  };
  const vectors = new ClipVectors(tts);
  const lockDir = join(scriptDir, 'audio', meta.lang);
  const manifestPath = join(lockDir, 'manifest.json');
  const lock = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        sentences: Record<string, string>;
        entries: Record<
          string,
          { src: string; f0?: number | null; sim?: number; voiceRef?: string }
        >;
      })
    : null;
  const done = new Set<string>();
  const madeNow = new Set<string>();
  try {
    for (const [castKey, member] of Object.entries(meta.cast)) {
      const sentences = castSentences(script, castKey);
      if (sentences.size === 0) continue;
      const t = voiceTarget(member, meta.lang, scriptDir);
      const v: RefVoice = {
        engine: t.engine,
        voice: t.voice,
        lang: meta.lang,
        modelName: t.modelName,
        ...(t.engine === 'qwen' && member.style ? { style: member.style } : {}),
        ...(t.ref ? { ref: t.ref } : {}),
      };
      // Cast members sharing a voice share its reference: made once per run.
      const key = JSON.stringify([v.engine, v.voice, v.style ?? '', v.ref?.sha256 ?? '']);
      const { loaded, stale, warning } = loadReference(v, scriptDir, revisions);
      let r = loaded;
      let made = false;
      if (!done.has(key) && (!loaded || stale || opts.refresh)) {
        if (stale) opts.log(`${castKey}: reference out of date (${stale})`);
        r = await createReference(
          v,
          scriptDir,
          repoRoot,
          revisions,
          services,
          opts.log,
          opts.refresh,
        );
        made = true;
      }
      // Every cast member of a voice made in this run gets its locked sentences judged.
      made ||= madeNow.has(key);
      if (made) madeNow.add(key);
      done.add(key);
      const ref = r!.ref;
      opts.log(
        `${castKey}: ${describeVoice(v)} → ${r!.jsonPath}\n` +
          `  pitch ${ref.f0} Hz ± ${ref.sigma} st, ${ref.rate} chars/s, similarity ≥ ${ref.simFloor}`,
      );
      if (warning && !made) opts.log(`  warning: ${warning}`);
      if (!made || !lock) continue;
      const failing = await lockedFailures(
        sentences,
        { dir: lockDir, ...lock },
        r!,
        services,
        vectors,
      );
      if (failing.length === 0) opts.log('  every locked sentence passes against it');
      else {
        opts.log(
          `  ${failing.length} locked sentence(s) fail against it (kept; \`s2v tts --recheck\` re-makes them):`,
        );
        for (const f of failing)
          opts.log(`    ${f.id} "${f.text.slice(0, 20)}": ${f.reasons.join('; ')}`);
      }
    }
  } finally {
    tts.stop();
    aligner.stop();
  }
}
