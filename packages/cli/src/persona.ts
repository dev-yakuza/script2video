/**
 * Persona voices on disk (PLAN 5.8) and `s2v voice create | pick`.
 *
 * A persona is looked up as `voices/<id>.yaml` next to the script, then in each folder above it up
 * to the repository root (the folder holding `.git`), so one persona can be shared by every video
 * in a repository. Outside a repository only the script's folder and its parent are searched.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  normalizeForCer,
  parsePersona,
  PERSONA_ID,
  roundTripCer,
  referenceText,
  type Lang,
  type Persona,
  type PersonaClip,
} from '@script2video/core';
import { normalizeLoudness } from './media.js';
import { compressPausesInFile } from './pauses.js';
import { ALIGNER, Service, TTS_SERVER } from './services.js';
import { postprocess, wavDuration } from './tts.js';

const DESIGN_MODEL = 'qwen3-tts-1.7b-voicedesign';

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
const REF_MAX_PAUSE = 0.5;
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
}

/** Objective hints for choosing by ear: did it say the sentence, how fast, how high. */
async function checkCandidates(
  wavs: string[],
  text: string,
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
    for (const wav of wavs) {
      const { data: t } = await aligner.post<{ text: string }>('/transcribe', {
        wav_path: wav,
        lang,
      });
      const { data: p } = await aligner.post<{ median_hz: number | null }>('/pitch', {
        wav_path: wav,
      });
      const duration = wavDuration(wav);
      out.push({
        duration,
        cer: roundTripCer(text, t.text, lang),
        heard: t.text,
        f0: p.median_hz,
        rate: [...normalizeForCer(text, lang)].length / duration,
      });
    }
    return out;
  } finally {
    if (!wasRunning) aligner.stop();
  }
}

/**
 * VoiceDesign sometimes ignores the gender in the description. Typical median pitch: men about
 * 85–155 Hz, women about 165–255 Hz; flag candidates clearly on the other side.
 */
export function genderMismatch(description: string, f0: number | null): string | null {
  if (f0 === null) return null;
  const d = description.toLowerCase();
  const female = /여성|여자|female|woman|girl|女性|女の/.test(d);
  const male = !female && /남성|남자|\bmale\b|\bman\b|\bboy\b|男性|男の/.test(d);
  if (male && f0 > 180) return 'sounds female, description says male';
  if (female && f0 < 150) return 'sounds male, description says female';
  return null;
}

const describe = (c: CandidateCheck, description: string) => {
  const issues = [
    ...(c.cer > 0.15 ? ['misread'] : []),
    ...(genderMismatch(description, c.f0) ? [genderMismatch(description, c.f0)!] : []),
  ];
  return (
    `${c.duration.toFixed(1)}s, ${c.rate.toFixed(1)} chars/s, pitch ${c.f0 ? `${Math.round(c.f0)} Hz` : '?'}, ` +
    `CER ${(c.cer * 100).toFixed(0)}%${issues.length ? ` — avoid: ${issues.join(', ')}` : ''}`
  );
};

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
  // Older candidates (made before leveling) are leveled in place; the voice itself is unchanged.
  const level = async (n: number) => {
    const base = join(candDir, `${opts.lang}-${n}`);
    const c = JSON.parse(readFileSync(`${base}.json`, 'utf8')) as PersonaClip;
    if (c.lufs === REF_LUFS) return;
    await normalizeLoudness(`${base}.wav`, REF_LUFS);
    writeFileSync(
      `${base}.json`,
      JSON.stringify({ ...c, lufs: REF_LUFS, sha256: sha256File(`${base}.wav`) }, null, 2),
    );
  };
  const made: string[] = [];
  const todo: number[] = [];
  for (let n = 1; n <= opts.candidates; n++) {
    const wav = existing(n);
    if (wav) {
      await level(n);
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
      await postprocess(raw, wav, null);
      compressPausesInFile(wav, REF_MAX_PAUSE);
      await normalizeLoudness(wav, REF_LUFS);
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
        created: new Date().toISOString(),
      };
      writeFileSync(join(candDir, `${opts.lang}-${n}.json`), JSON.stringify(clip, null, 2));
      made[n - 1] = wav;
    }
  } finally {
    if (!wasRunning) service.stop();
  }
  const checks = await checkCandidates(made, text, opts.lang, repoRoot, opts.log);
  for (const [i, c] of checks.entries()) {
    opts.log(`  candidate ${i + 1}: ${describe(c, persona.description)}  ${made[i]}`);
    if (opts.play) await play(made[i]!);
  }

  const page = join(candDir, `${opts.lang}.html`);
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  writeFileSync(
    page,
    [
      `<!doctype html><meta charset=utf-8><title>${esc(id)} (${opts.lang})</title>`,
      '<style>body{font-family:system-ui;max-width:760px;margin:24px auto;padding:0 16px}' +
        'li{margin:12px 0}</style>',
      `<h1>${esc(id)} · ${opts.lang}</h1><p>${esc(persona.description)}</p><p>“${esc(text)}”</p><ol>`,
      ...made.map(
        (_, i) =>
          `<li><b>${i + 1}</b> <audio controls preload=none src="${opts.lang}-${i + 1}.wav"></audio>` +
          `<br><small>${esc(describe(checks[i]!, persona.description))}<br>heard: ${esc(checks[i]!.heard)}</small>` +
          `<br><code>s2v voice pick ${esc(yamlPath)} ${i + 1} --lang ${opts.lang}</code></li>`,
      ),
      '</ol>',
    ].join('\n'),
  );
  if (opts.candidates === 1) pickVoice(yamlPath, 1, opts.lang, opts.log);
  else opts.log(`listen: open ${page}\nthen: s2v voice pick ${yamlPath} <n> --lang ${opts.lang}`);
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
}
