/**
 * `s2v voice train <voices/id.yaml> --lang ko` (acting stage 4 plan 6): train a persona's speaker
 * row so the CustomVoice model speaks with its voice and follows emotion instructions.
 *
 * The S2 recipe: neutral data (the persona's clone) → initial vector → emotion data round 1 →
 * training 1 → emotion data round 2 (normal and strong) → training 2 → `<lang>.speaker.json` and
 * its voice reference. Clips are made by the TTS server, measured with the aligner and judged by
 * the training gates (core train-gates.ts, S2's constants); `tts-server/train_speaker.py` encodes
 * and trains. Every clip, judgement and epoch is cached: running it again resumes.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  CLOSE,
  emotionFails,
  firstMax,
  intensity,
  HIGH_PITCH,
  isStandardEmotion,
  neutralBaseline,
  neutralFails,
  neutralRate,
  pickNeutral,
  REF_SEEDS,
  REF_SENTENCES,
  roundBaseline,
  STRONG_TEMPLATES_V1,
  TEMPLATES_V1,
  TRAIN_GATES,
  type Emotion,
  type Lang,
  type TrainMeasure,
} from '@script2video/core';
import { defaultMemoryLimitGb, ExitError, modelsDir, runWatched } from './imagegen.js';
import { checkVoice, resolvePersona, vectorShaOf, type PersonaRef } from './persona.js';
import { ALIGNER, Service, TTS_SERVER } from './services.js';
import { measureTrainClip, TRAIN_MEASURE_VERSION } from './train-data.js';
import { ALIGN_VERSION } from './tts.js';
import { createReference, embed, synthesisBody, type RefVoice } from './voice-refs.js';

const run = promisify(execFile);

export const TRAIN_RECIPE = 1;
const MODEL = 'qwen3-tts-1.7b-customvoice';
const EPOCHS = 20;

export interface TrainOptions {
  lang: Lang;
  /** Stop before training 2 when fewer emotion clips passed (plan 6.7; 150 for the recipe check). */
  minEmotion: number;
  log: (m: string) => void;
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

function atomicWrite(path: string, data: string | Buffer): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

/** Python processes of image generation (A6: never alongside TTS). */
export async function imagegenRunning(): Promise<string | null> {
  try {
    const { stdout } = await run('ps', ['-axo', 'pid=,command=']);
    const line = stdout
      .split('\n')
      .find((l) => /python/i.test(l) && /[\\/]imagegen[\\/]/.test(l) && !l.includes('ps -axo'));
    return line ? line.trim() : null;
  } catch {
    return null;
  }
}

/** The trainer command (tests replace it with S2V_TRAIN_CMD, a JSON array). */
function trainerCommand(repoRoot: string): { cmd: string; args: string[]; cwd: string } {
  const custom = process.env.S2V_TRAIN_CMD;
  const cwd = join(repoRoot, 'tts-server');
  if (custom) {
    const [cmd, ...args] = JSON.parse(custom) as string[];
    return { cmd: cmd!, args, cwd };
  }
  // the venv's python itself, not `uv run`: the memory watchdog must see the training process
  return { cmd: join(cwd, '.venv', 'bin', 'python'), args: ['train_speaker.py'], cwd };
}

interface Clip {
  key: string;
  wav: string;
  /** sha256 (16 hex) of the wav: the trainer's name for it. */
  sha: string;
  text: string;
  instruct?: string;
  emo?: Emotion;
  m: TrainMeasure;
}

export async function trainVoice(
  yamlPath: string,
  repoRoot: string,
  opts: TrainOptions,
): Promise<{ speakerPath: string; neutral: number; emotion: number }> {
  const { lang, log } = opts;
  const id = basename(yamlPath).replace(/\.ya?ml$/, '');
  const scriptDir = dirname(dirname(yamlPath));
  const ref = resolvePersona(id, lang, scriptDir);
  if (typeof ref === 'string') throw new Error(ref);
  const refSha = ref.sha256;
  const revisions = Object.fromEntries(
    Object.entries(
      (
        JSON.parse(readFileSync(join(repoRoot, 'models.lock.json'), 'utf8')) as {
          models: Record<string, { revision: string }>;
        }
      ).models,
    ).map(([k, v]) => [k, v.revision]),
  );

  // ---------- 1. start checks ----------
  const busy = await imagegenRunning();
  if (busy)
    throw new Error(`image generation is running (${busy}); train when it is done (A6: not both)`);
  const tts = new Service(TTS_SERVER, repoRoot);
  const aligner = new Service(ALIGNER, repoRoot);
  // (tests run against stub servers: S2V_TRAIN_SHARED_SERVERS=1)
  for (const s of [tts, aligner])
    if (process.env.S2V_TRAIN_SHARED_SERVERS !== '1' && (await s.health()))
      throw new Error(
        `${s.spec.id} is already running on port ${s.spec.port} (started outside this command): stop it — training needs its memory`,
      );
  // what the training needs, checked before an hour of data making
  const snapshot = (name: string) =>
    join(modelsDir(), `${name.replace(/[^0-9A-Za-z_]/g, '_')}__${revisions[name]!.slice(0, 12)}`);
  // (a replaced trainer — tests — needs no models)
  for (const [name, inside] of [
    [MODEL, 'speech_tokenizer'],
    ['qwen3-tts-1.7b-base', ''],
  ] as const)
    if (!process.env.S2V_TRAIN_CMD && !existsSync(join(snapshot(name), inside)))
      throw new Error(
        `model ${name} is not installed: (cd tts-server && uv run --frozen python scripts/fetch_models.py ${name})`,
      );
  const trainer = trainerCommand(repoRoot);
  if (!process.env.S2V_TRAIN_CMD && !existsSync(trainer.cmd))
    throw new Error(`${trainer.cmd} not found: (cd tts-server && uv sync --frozen)`);
  log(`checking the ${lang} reference clip of ${id} ...`);
  const refFails = await checkVoice(yamlPath, lang, repoRoot, log);
  if (refFails.length > 0)
    throw new Error(`the reference clip fails its checks (${refFails.join('; ')}); fix it first`);

  const dataDir = join(repoRoot, 'tts-server', 'data');
  const neutralLines = readFileSync(join(dataDir, `train-${lang}.txt`), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const emotionSets = JSON.parse(readFileSync(join(dataDir, `emotion-${lang}.json`), 'utf8')) as {
    a: Record<string, string[]>;
    b: Record<string, string[]>;
  };
  // both sets name the same standard emotions (a typo would silently drop one)
  for (const set of ['a', 'b'] as const)
    for (const emo of Object.keys(emotionSets[set] ?? {}))
      if (!isStandardEmotion(emo) || !Array.isArray(emotionSets[set === 'a' ? 'b' : 'a']?.[emo]))
        throw new Error(
          `emotion-${lang}.json: "${emo}" in set ${set} is not a standard emotion in both sets`,
        );
  const recipeHash = sha256(
    JSON.stringify([
      TRAIN_RECIPE,
      ref.sha256,
      [MODEL, 'qwen3-tts-1.7b-base', 'qwen3-forcedaligner-0.6b', 'qwen3-asr-0.6b'].map(
        (m) => revisions[m],
      ),
      ALIGN_VERSION,
      ALIGNER.wrapper,
      TTS_SERVER.wrapper,
      TRAIN_MEASURE_VERSION,
      TRAIN_GATES,
      sha256(readFileSync(join(dataDir, `train-${lang}.txt`))),
      sha256(readFileSync(join(dataDir, `emotion-${lang}.json`))),
      TEMPLATES_V1,
      STRONG_TEMPLATES_V1,
      CLOSE,
      HIGH_PITCH,
      REF_SENTENCES[lang],
      REF_SEEDS,
    ]),
  ).slice(0, 16);
  const work = join(repoRoot, '.s2v-cache', 'voice-train', id, lang, recipeHash);
  const clipsDir = join(work, 'clips');
  mkdirSync(clipsDir, { recursive: true });
  log(`working in ${work}`);
  log(
    'about 3–3.5 h (from the S2 run): neutral data ~40 min, round baselines ~8, emotion round 1 ~25, ' +
      'training 1 ~24, emotion round 2 ~30, training 2 ~38, reference ~5; stopped, it resumes where it was',
  );

  // ---------- services ----------
  let up = false;
  const ensure = async () => {
    if (up) return;
    log('starting tts-server and aligner ...');
    await Promise.all([tts.ensure(), aligner.ensure()]);
    up = true;
  };
  const down = async () => {
    if (!up) return;
    await Promise.all([tts.stopAndWait(), aligner.stopAndWait()]);
    up = false;
  };

  try {
    // a clip: synthesized once, measured once (both cached by its key)
    const clipOf = async (
      key: string,
      text: string,
      voice: { persona: PersonaRef } | { vector: string },
      emo?: { emo: Emotion; instruct: string; reference: () => Promise<number[]> },
    ): Promise<Clip> => {
      const name = sha256(key).slice(0, 24);
      const wav = join(clipsDir, `${name}.wav`);
      const measured = join(clipsDir, `${name}.json`);
      if (!existsSync(wav)) {
        await ensure();
        const body =
          'persona' in voice
            ? synthesisBody({ engine: 'persona', voice: id, ref: voice.persona })
            : synthesisBody({
                engine: 'trained',
                voice: id,
                speaker: { path: voice.vector, vectorSha: readVectorSha(voice.vector) },
              });
        const { data } = await tts.post<Buffer>('/synthesize', {
          ...body,
          lang,
          text,
          ...(emo ? { instruct: emo.instruct } : {}),
          speed: 1,
          seed_material: key,
        });
        atomicWrite(wav, data);
      }
      const sha = sha256(readFileSync(wav)).slice(0, 16);
      let m = existsSync(measured)
        ? (JSON.parse(readFileSync(measured, 'utf8')) as { sha: string; m: TrainMeasure })
        : null;
      if (!m || m.sha !== sha) {
        await ensure();
        m = {
          sha,
          m: await measureTrainClip(
            wav,
            text,
            lang,
            { aligner, tts },
            emo ? { reference: await emo.reference() } : undefined,
          ),
        };
        atomicWrite(measured, JSON.stringify(m));
      }
      return {
        key,
        wav,
        sha,
        text,
        ...(emo ? { instruct: emo.instruct, emo: emo.emo } : {}),
        m: m.m,
      };
    };

    // ---------- 2. neutral data ----------
    log(`neutral data: ${neutralLines.length} sentences × 2 takes (persona clone) ...`);
    const neutralTakes: (Clip & { i: number })[] = [];
    for (const [i, text] of neutralLines.entries())
      for (let t = 0; t < 2; t++) {
        const key = `train:${id}:neutral:-:-:neutral:${i}:${t}`;
        neutralTakes.push({ ...(await clipOf(key, text, { persona: ref })), i });
      }
    const rates = neutralTakes.map((c) => neutralRate(c.text, c.m.seconds));
    const nBase = neutralBaseline(neutralTakes.map((c, k) => ({ f0: c.m.f0, rate: rates[k]! })));
    const judgedN = neutralTakes.map((c, k) => ({
      ...c,
      ...neutralFails(c.m, rates[k]!, nBase),
      cer: c.m.cer,
    }));
    const neutral: Clip[] = [];
    for (let i = 0; i < neutralLines.length; i++) {
      const p = pickNeutral(judgedN.filter((c) => c.i === i));
      if (p) neutral.push(p);
    }
    const failCounts: Record<string, number> = {};
    for (const c of judgedN) for (const f of c.fails) failCounts[f] = (failCounts[f] ?? 0) + 1;
    log(
      `  ${neutral.length} kept (${neutral.reduce((a, c) => a + c.m.seconds, 0).toFixed(0)} s), f0 ${nBase.f0.toFixed(0)} Hz, fails ${JSON.stringify(failCounts)}`,
    );

    // ---------- 3. initial vector ----------
    // the initial vector belongs to this neutral set (a re-made clip makes another)
    const initPath = join(
      work,
      `init-${sha256(neutral.map((c) => c.sha).join(',')).slice(0, 12)}.json`,
    );
    if (neutral.length === 0) throw new Error('no neutral clip passed: nothing to train from');
    if (!existsSync(initPath)) {
      await ensure();
      log('initial vector: x-vectors of the neutral clips ...');
      const vecs: number[][] = [];
      for (const c of neutral) vecs.push(await embed(tts, c.wav));
      const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));
      const mean = vecs[0]!.map((_, d) => vecs.reduce((a, v) => a + v[d]!, 0) / vecs.length);
      const target = vecs.reduce((a, v) => a + norm(v), 0) / vecs.length;
      const k = target / norm(mean);
      writeVector(initPath, Array.from(Float32Array.from(mean.map((x) => x * k))), {
        revision: revisions[MODEL]!,
        referenceSha: ref.sha256,
      });
    }
    // the reference clip's x-vector, only when a clip is measured (a resume may go straight to training)
    let refVector: number[] | null = null;
    const reference = async () => {
      if (!refVector) {
        await ensure();
        refVector = await embed(tts, ref.wavPath);
      }
      return refVector;
    };

    // ---------- 4–5. emotion round 1 ----------
    const round = async (vector: string, tag: string) => {
      const sha12 = readVectorSha(vector).slice(0, 12);
      const takes = [];
      for (const [s, text] of REF_SENTENCES[lang].entries())
        for (let n = 0; n < REF_SEEDS; n++)
          takes.push(await clipOf(`train:${id}:ref:${sha12}:-:ref:${s}:${n}`, text, { vector }));
      const b = roundBaseline(
        takes.map((c) => ({ f0: c.m.f0, seconds: c.m.seconds, text: c.text })),
      );
      log(`  ${tag} baseline: f0 ${b.f0.toFixed(1)} Hz, ${b.rate.toFixed(2)} chars/s`);
      return { ...b, sha12 };
    };
    const emotions = Object.keys(emotionSets.a).filter(isStandardEmotion);
    const judgeEmotion = (c: Clip, base: { f0: number; rate: number }) => ({
      c,
      j: emotionFails(c.m, c.emo!, c.text, base),
    });
    log('emotion data round 1: initial vector, normal templates ...');
    const base1 = await round(initPath, 'round 1');
    const emo1: Clip[] = [];
    for (const emo of emotions)
      for (const [i, text] of emotionSets.a[emo]!.entries()) {
        const takes = [];
        for (let t = 0; t < 2; t++) {
          const instruct = TEMPLATES_V1[emo] + CLOSE;
          const key = `train:${id}:emo1:${base1.sha12}:normal:${emo}:a:${i}:${t}`;
          takes.push(
            judgeEmotion(
              await clipOf(key, text, { vector: initPath }, { emo, instruct, reference }),
              base1,
            ),
          );
        }
        const best = firstMax(
          takes.filter((x) => x.j.fails.length === 0),
          (x) => x.c.m.sim ?? 0,
        );
        if (best) emo1.push(best.c);
      }
    log(`  ${emo1.length} kept ${JSON.stringify(perEmotion(emo1))}`);

    // ---------- 6. training 1 ----------
    const train1 = (await trainStage('train1', [...neutral, ...emo1], initPath)).vector;

    // ---------- 7. emotion round 2 ----------
    log('emotion data round 2: trained vector, normal and strong templates ...');
    const base2 = await round(train1, 'round 2');
    const emo2: Clip[] = [];
    for (const emo of emotions)
      for (const set of ['a', 'b'] as const)
        for (const [i, text] of emotionSets[set][emo]!.entries()) {
          const takes = [];
          for (const power of ['normal', 'strong'] as const) {
            const instruct =
              (power === 'strong' ? STRONG_TEMPLATES_V1[emo] : TEMPLATES_V1[emo]) + CLOSE;
            const key = `train:${id}:emo2:${base2.sha12}:${power}:${emo}:${set}:${i}:0`;
            takes.push(
              judgeEmotion(
                await clipOf(key, text, { vector: train1 }, { emo, instruct, reference }),
                base2,
              ),
            );
          }
          const best = firstMax(
            takes.filter((x) => x.j.fails.length === 0),
            (x) => intensity(x.j),
          );
          if (best) emo2.push(best.c);
        }
    const emotion = [...emo1, ...emo2];
    log(`  ${emo2.length} new, ${emotion.length} in all ${JSON.stringify(perEmotion(emotion))}`);

    // ---------- 8. the pass-count check (before training 2) ----------
    if (emotion.length < opts.minEmotion)
      throw new ExitError(
        `only ${emotion.length} emotion clips passed (needs ${opts.minEmotion}; S2 had 184): the gates or the recipe need another look — nothing was trained; --min-emotion lowers the bar`,
        1,
      );

    // ---------- 9. training 2 ----------
    const train2 = await trainStage('train2', [...neutral, ...emotion], initPath);
    const best = JSON.parse(readFileSync(train2.best, 'utf8')) as {
      vector: number[];
      vectorSha: string;
      epoch: number;
      valLoss: number;
    };
    const speakerPath = join(dirname(ref.wavPath), `${lang}.speaker.json`);
    const file = {
      version: 1,
      vector: best.vector,
      model: MODEL,
      revision: revisions[MODEL],
      referenceSha: ref.sha256,
      recipe: TRAIN_RECIPE,
      recipeHash,
      epoch: best.epoch,
      valLoss: Number(best.valLoss.toFixed(4)),
      gate: {
        neutral: { f0: Number(nBase.f0.toFixed(1)), rate: Number(nBase.rate.toFixed(2)) },
        rounds: [base1, base2].map((b) => ({
          f0: Number(b.f0.toFixed(1)),
          sigma: Number(b.sigma.toFixed(2)),
          rate: Number(b.rate.toFixed(2)),
          simMin: TRAIN_GATES.simMin,
        })),
      },
      data: { neutral: neutral.length, emotion: emotion.length },
      vectorSha: vectorShaOf(best.vector),
      created: new Date().toISOString(),
    };
    // the same vector again (a re-run): the file stays as it is (no new date in git)
    const old = existsSync(speakerPath)
      ? (JSON.parse(readFileSync(speakerPath, 'utf8')) as { vectorSha?: string })
      : null;
    if (old?.vectorSha !== file.vectorSha) {
      atomicWrite(speakerPath, `${JSON.stringify(file)}\n`);
      log(`wrote ${speakerPath} (epoch ${best.epoch}, validation ${file.valLoss})`);
    } else log(`${speakerPath} is unchanged (the same vector)`);

    // ---------- 10. its voice reference ----------
    await ensure();
    const v: RefVoice = {
      engine: 'trained',
      voice: id,
      lang,
      modelName: MODEL,
      speaker: { path: speakerPath, vectorSha: file.vectorSha },
    };
    await createReference(v, scriptDir, repoRoot, revisions, { tts, aligner, ensure }, log);
    log(`done: commit ${speakerPath} and its reference; set personaModel: trained on the cast`);
    return { speakerPath, neutral: neutral.length, emotion: emotion.length };
  } finally {
    await down();
  }

  /**
   * Encode the clips and train from `init` (cached per stage): the trainer's best epoch, and the
   * same vector as a speaker file the server reads.
   */
  async function trainStage(
    stage: string,
    clips: Clip[],
    init: string,
  ): Promise<{ best: string; vector: string }> {
    // a stage trains its own data from its own initial vector: other data, another folder (the
    // trainer resumes from what it finds there)
    const dataLines = clips
      .map((c) =>
        JSON.stringify({
          sha: c.sha,
          text: c.text,
          ...(c.instruct ? { instruct: c.instruct } : {}),
        }),
      )
      .join('\n');
    // the trainer and its epochs decide the stage, not the clips (editing it re-trains, no re-synthesis)
    const trainerSha = sha256(readFileSync(join(repoRoot, 'tts-server', 'train_speaker.py')));
    const out = join(
      work,
      `${stage}-${sha256(dataLines + readVectorSha(init) + trainerSha + EPOCHS).slice(0, 12)}`,
    );
    const best = join(out, 'best.json');
    const vectorFile = join(out, 'speaker.json');
    mkdirSync(out, { recursive: true });
    const clipsFile = join(out, 'clips.jsonl');
    const dataFile = join(out, 'data.jsonl');
    atomicWrite(
      clipsFile,
      clips.map((c) => JSON.stringify({ sha: c.sha, audio: c.wav })).join('\n') + '\n',
    );
    atomicWrite(dataFile, dataLines + '\n');
    // a finished stage is not run again
    const doneFile = join(out, 'done.json');
    if (existsSync(best) && existsSync(doneFile) && existsSync(vectorFile))
      return { best, vector: vectorFile };
    await down(); // the training process gets the memory
    const codes = join(work, 'codes');
    const python = async (args: string[], what: string) => {
      const t = trainerCommand(repoRoot);
      let failed: string | null = null;
      const r = await runWatched(t.cmd, [...t.args, ...args], {
        cwd: t.cwd,
        env: { ...process.env, S2V_LIFELINE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
        maxGb: Math.min(28, defaultMemoryLimitGb()),
        log,
        onLine: (line) => {
          if (!line.startsWith('{')) return; // model banners
          try {
            const e = JSON.parse(line) as Record<string, unknown>;
            if (e.event === 'error') failed = String(e.message);
            else if (e.event === 'epoch')
              log(`  ${stage} epoch ${String(e.epoch)}: validation ${String(e.val)}`);
            else if (e.event === 'checked') log(`  check: ${JSON.stringify(e.losses)}`);
          } catch {
            // not one of ours
          }
        },
      });
      if (r.stoppedForMemory)
        throw new ExitError(
          `${what} was stopped: it used ${r.peakGb.toFixed(1)} GB (limit ${Math.min(28, defaultMemoryLimitGb())} GB); run again to resume`,
          r.code,
        );
      if (r.code !== 0)
        throw new ExitError(
          `${what} failed${failed ? `: ${failed}` : ''} (exit ${r.code})`,
          r.code || 1,
        );
    };
    log(`${stage}: encoding ${clips.length} clips ...`);
    await python(['encode', '--clips', clipsFile, '--codes', codes], 'encoding');
    log(`${stage}: checking the training input and the initial vector ...`);
    await python(
      ['check', '--data', dataFile, '--codes', codes, '--init', init, '--lang', lang],
      'the check',
    );
    log(`${stage}: training ${EPOCHS} epochs (resumes from the last saved epoch) ...`);
    await python(
      [
        'train',
        '--data',
        dataFile,
        '--codes',
        codes,
        '--init',
        init,
        '--out',
        out,
        '--epochs',
        String(EPOCHS),
        '--lang',
        lang,
      ],
      'training',
    );
    // the trainer writes best.json; it becomes a speaker file the server reads for round 2
    const b = JSON.parse(readFileSync(best, 'utf8')) as { vector: number[] };
    writeVector(vectorFile, b.vector, { revision: revisions[MODEL]!, referenceSha: refSha });
    atomicWrite(doneFile, JSON.stringify({ done: new Date().toISOString() }));
    return { best, vector: vectorFile };
  }
}

/** A vector as a speaker file the server accepts (also the round vectors in the cache). */
function writeVector(
  path: string,
  vector: number[],
  meta: { revision: string; referenceSha: string },
): void {
  atomicWrite(
    path,
    JSON.stringify({
      version: 1,
      vector,
      model: MODEL,
      ...meta,
      vectorSha: vectorShaOf(vector),
    }),
  );
}

const readVectorSha = (path: string) =>
  (JSON.parse(readFileSync(path, 'utf8')) as { vectorSha: string }).vectorSha;

const perEmotion = (clips: Clip[]) => {
  const out: Record<string, number> = {};
  for (const c of clips) out[c.emo!] = (out[c.emo!] ?? 0) + 1;
  return out;
};
