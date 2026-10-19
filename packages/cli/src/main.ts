#!/usr/bin/env node
/**
 * s2v — script2video command line.
 *
 *   s2v lint <script.md>
 *   s2v check <script.md>
 *   s2v voice create <voices/id.yaml> [--lang ko] [--candidates 3] [--play]
 *   s2v voice pick <voices/id.yaml> <n> [--lang ko]
 *   s2v voice check <voices/id.yaml> [--lang ko]   (judge a persona's reference clip)
 *   s2v voice train <voices/id.yaml> [--lang ko] [--min-emotion 150]   (its trained speaker, ~3 h)
 *   s2v voice refs <script.md> [--refresh]   (reference voices for the consistency checks)
 *   s2v tts <script.md> [--no-asr] [--recheck] [--retry <scene[:paragraph[:sentence]]> ...]
 *   s2v sentences <script.md>   (sentence ids for --retry)
 *   s2v takes <script.md> [--all] [--id <scene[:paragraph[:sentence]]> ...] [--no-open]   (listening page)
 *   s2v takes <script.md> --list [--id <scene[:paragraph[:sentence]]> ...]   (takes of each line)
 *   s2v takes pick <script.md> <id>=<take> ... | unpick <script.md> <id> ...   (choose a take)
 *   s2v inspect <script.md> --json [--hash-version 1]   (what the script is made of, hashed by kind)
 *   s2v export-script <script.md>   (reading script for a recording session)
 *   s2v import-recording <script.md> <take.wav> [--write]   (one take → per-paragraph files)
 *   s2v timeline <script.md> [--output youtube] [--fps 30] [--rhythm on|off]
 *              (with rhythm on, the paragraph gaps go to stderr as a table)
 *   s2v render <script.md> [--output youtube|shorts] [--no-asr] [--recheck] [--draft] [--no-cache]
 *              [--frozen-audio]   (never synthesize; fail if audio is missing)
 *              [--workers N]      (browser tabs rendering in parallel)
 *              [--idle on|off]    (idle motion; overrides acting.idle)
 *              [--rhythm on|off]  (content-aware gaps; overrides acting.rhythm and the output's;
 *                                  also for snapshot and timeline)
 *   s2v audio prune <script.md>   (drop locked audio the script no longer uses)
 *   s2v dev <script.md> [--video]  (edit loop: lint → tts → snapshot on every save)
 *   s2v doctor                    (is this machine ready?)
 *   s2v character setup [--max-memory-gb N]   (optional: character image generation, Apple silicon)
 *   s2v character create <dir> [--candidates 4] | pick <dir> <n> | build <dir> [--dry-run]
 *                 | review <dir> | approve <dir> <item>...|--all [--except <item>...]
 *                 | redo <dir> <item>... [--seed N] | missing <script.md> [--apply]
 *   s2v new <dir> [--lang ko]     (a new video folder with a starter script)
 *   s2v snapshot <script.md> [--output youtube] [--draft]
 *   s2v pick <image>
 *   s2v say "<sentence>" [--voice qwen:Sohee] [--lang ko] [--style ...] [--script script.md] [--no-play]
 *   s2v tts-server start
 */

import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildTimeline,
  formatDiagnostic,
  HASH_VERSIONS,
  lintActing,
  lintLength,
  bgmOf,
  logoOf,
  themeOf,
  sentenceId,
  sfxEvents,
  subtitleStyleFor,
  lintSubtitleBudget,
  lintUnreadWords,
  parseScript,
  type AudioManifest,
  type Lang,
} from '@script2video/core';
import { renderScenes, type Aspect } from '@script2video/renderer-remotion';
import { renderedLengthWarning } from './length.js';
import { enrichCast } from './cast-faces.js';
import { castOptions } from './cast.js';
import { buildSfxTrack, mixSoundtrack } from './soundtrack.js';
import { writePublishFiles, writeThumbnail } from './publish.js';
import { timelineMouths } from './mouth.js';
import { checkSubtitles } from './check.js';
import { importCharacter } from './character-import.js';
import { defaultMemoryLimitGb, ExitError, setupImagegen } from './imagegen.js';
import {
  approveItems,
  buildCharacter,
  createCharacter,
  pickCandidate,
  redoItems,
  reviewCharacter,
} from './character-gen/commands.js';
import { applyMissing, findMissing, printMissing } from './character-gen/missing.js';
import { dev } from './dev.js';
import { importRecording } from './import-recording.js';
import { doctor } from './doctor.js';
import { scaffold } from './scaffold.js';
import { checkVoice, createVoice, pickVoice } from './persona.js';
import { buildNarration, concatAndMux, ensureFonts, master, probe } from './media.js';
import {
  lintAssets,
  lintBgm,
  lintCast,
  lintSubtitleFonts,
  lintTranslation,
} from './lint-assets.js';
import { pick } from './pick.js';
import { runResident, say } from './say.js';
import { snapshot } from './snapshot.js';
import { loadAudioManifest, pruneAudio, synthesizeScript } from './tts.js';
import { listTakes, pickTakes, unpickTakes } from './takes.js';
import { buildTakesPage, openPage } from './takes-page.js';
import { trainVoice } from './voice-train.js';
import { voiceRefs } from './voice-refs.js';
import { inspectScript } from './inspect.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function usage(): never {
  console.error(
    'usage: s2v <lint|check|sentences|tts|timeline|render|snapshot|pick|say> <file|text> [options]\n' +
      '       s2v voice create <voices/id.yaml> [--lang ko] [--candidates 3] [--play]\n' +
      '       s2v voice pick <voices/id.yaml> <n> [--lang ko]\n' +
      '       s2v voice check <voices/id.yaml> [--lang ko]\n' +
      '       s2v voice train <voices/id.yaml> [--lang ko] [--min-emotion 150]\n' +
      '       s2v voice refs <script.md> [--refresh]\n' +
      '       s2v character import <ymm4 folder|zip> --out <characters/id> [--name <character>]\n' +
      '       s2v character setup [--max-memory-gb N]   (image generation models; Apple silicon)\n' +
      '       s2v character create <dir> [--candidates 4]   (round 1: candidate front images)\n' +
      '       s2v character pick <dir> <n>   (a candidate becomes the front reference)\n' +
      '       s2v character build <dir> [--dry-run] [--reset-derived]   (the next round)\n' +
      '       s2v character review <dir>\n' +
      '       s2v character approve <dir> <item>...|--all [--except <item>...]\n' +
      '       s2v character redo <dir> <item>... [--seed N]\n' +
      '       s2v character missing <script.md> [--apply]\n' +
      '       s2v audio prune <script.md>\n' +
      '       s2v takes <script.md> [--all] [--id <id>] [--no-open] | --list [--id <id>] | takes pick <script.md> <id>=<take> ... | takes unpick <script.md> <id> ...\n' +
      '       s2v inspect <script.md> --json [--hash-version 1]\n' +
      '       s2v export-script <script.md>   (reading script for recording)\n' +
      '       s2v import-recording <script.md> <take.wav> [--write]\n' +
      '       s2v dev <script.md> [--output youtube] [--video] [--no-asr]\n' +
      '       s2v doctor\n' +
      '       s2v new <dir> [--lang ko|ja|en]\n' +
      '       s2v tts-server start',
  );
  process.exit(2);
}

/** Outputs whose estimated length already went over maxDuration in `load()` (5d plan 2). */
const estimatedOver = new Set<string>();

function load(path: string) {
  const { script, diagnostics } = parseScript(readFileSync(path, 'utf8'));
  const all = [...diagnostics.items];
  if (script) enrichCast(script, dirname(path));
  if (script) {
    let manifest: AudioManifest | undefined;
    try {
      manifest = loadAudioManifest(path, script.meta.lang);
    } catch {
      // No audio lock yet: lengths are estimated from the text.
    }
    all.push(
      ...lintAssets(script, dirname(path)),
      ...lintCast(script, dirname(path)),
      ...lintSubtitleFonts(script, dirname(path)),
      ...lintBgm(script, dirname(path)),
      ...lintActing(script),
      ...lintSubtitleBudget(script),
      ...lintUnreadWords(script),
      ...lintLength(script, manifest),
    );
  }
  if (script?.meta.translationOf) {
    const originalPath = resolve(dirname(path), script.meta.translationOf);
    const original = parseScript(readFileSync(originalPath, 'utf8')).script;
    if (original) all.push(...lintTranslation(script, original, script.meta.translationOf));
    else
      all.push({
        severity: 'error',
        code: 'translation-source',
        message: `cannot parse ${script.meta.translationOf}`,
      });
  }
  for (const d of all) {
    console.error(formatDiagnostic(d, path));
    const over = d.code === 'max-duration' ? /^"([^"]+)"/.exec(d.message) : null;
    if (over) estimatedOver.add(over[1]!);
  }
  if (!script || all.some((d) => d.severity === 'error')) process.exit(1);
  return script;
}

/** `--max-memory-gb` (default: max(24 GB, 60 % of RAM)). */
function memoryLimit(value: string | undefined): number {
  if (value === undefined) return defaultMemoryLimitGb();
  const n = Number(value);
  if (!Number.isFinite(n) || n < 8) {
    console.error('--max-memory-gb must be a number of GB, at least 8');
    process.exit(2);
  }
  return n;
}

function parseCli(rest: string[]) {
  return parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      'no-asr': { type: 'boolean', default: false },
      recheck: { type: 'boolean', default: false },
      retry: { type: 'string', multiple: true },
      draft: { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      'frozen-audio': { type: 'boolean', default: false },
      video: { type: 'boolean', default: false },
      workers: { type: 'string' },
      write: { type: 'boolean', default: false },
      output: { type: 'string', default: 'youtube' },
      fps: { type: 'string', default: '30' },
      voice: { type: 'string' },
      lang: { type: 'string' },
      style: { type: 'string' },
      script: { type: 'string' },
      'no-play': { type: 'boolean', default: false },
      play: { type: 'boolean', default: false },
      candidates: { type: 'string' },
      out: { type: 'string' },
      name: { type: 'string' },
      'max-memory-gb': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'reset-derived': { type: 'boolean', default: false },
      all: { type: 'boolean', default: false },
      except: { type: 'string', multiple: true },
      seed: { type: 'string' },
      apply: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'hash-version': { type: 'string' },
      list: { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      'min-emotion': { type: 'string' },
      id: { type: 'string', multiple: true },
      idle: { type: 'string' },
      rhythm: { type: 'string' },
    },
  });
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  let parsed: ReturnType<typeof parseCli>;
  try {
    parsed = parseCli(rest);
  } catch (e) {
    console.error((e as Error).message);
    usage();
  }
  const { values, positionals } = parsed;
  const file = positionals[0];
  // --rhythm changes the timing: only commands that build a timeline take it (5d plan 2).
  let rhythm: boolean | undefined;
  if (values.rhythm !== undefined) {
    if (!['render', 'snapshot', 'timeline'].includes(command ?? ''))
      throw new Error(`--rhythm is for render, snapshot and timeline, not ${command}`);
    if (values.rhythm !== 'on' && values.rhythm !== 'off')
      throw new Error(`--rhythm must be on or off, not "${values.rhythm}"`);
    rhythm = values.rhythm === 'on';
  }
  const rhythmOpts = rhythm === undefined ? {} : { rhythm };
  if (command === 'tts-server' && file === 'start') {
    await runResident(REPO_ROOT, (m) => console.error(m));
    return;
  }
  if (command === 'dev') {
    const file = positionals[0];
    if (!file) usage();
    await dev(resolve(file), {
      output: values.output!,
      video: values.video === true,
      asr: !values['no-asr'],
      cliPath: fileURLToPath(import.meta.url),
      repoRoot: REPO_ROOT,
      log: (m) => console.error(m),
    });
    return;
  }
  if (command === 'new') {
    const dir = positionals[0];
    if (!dir) usage();
    const lang = (values.lang ?? 'ko') as Lang;
    const script = scaffold(resolve(dir), lang);
    console.error(`created ${script}\nnext: s2v lint ${script} && s2v render ${script} --draft`);
    return;
  }
  if (command === 'doctor') {
    const checks = await doctor(REPO_ROOT);
    for (const c of checks) {
      const mark = c.ok ? 'ok  ' : c.optional ? 'warn' : 'FAIL';
      console.log(`${mark}  ${c.name.padEnd(36)} ${c.detail}`);
      if (!c.ok && c.fix) console.log(`      → ${c.fix}`);
    }
    const failed = checks.filter((c) => !c.ok && !c.optional).length;
    console.log(failed ? `\n${failed} required check(s) failed` : '\nready');
    if (failed) process.exit(1);
    return;
  }
  if (command === 'import-recording') {
    const [scriptFile, recording] = positionals;
    if (!scriptFile || !recording) usage();
    const scriptPath = resolve(scriptFile);
    const script = load(scriptPath);
    const files = await importRecording(scriptPath, script, resolve(recording), REPO_ROOT, {
      write: values.write === true,
      log: (m) => console.error(m),
    });
    console.error(
      `wrote ${files.length} paragraph files under rec/${values.write ? ' and added :audio to the script' : '; add :audio{src=...} (or run again with --write)'}`,
    );
    return;
  }
  if (command === 'inspect') {
    const [scriptFile] = positionals;
    const hashVersion = Number(values['hash-version'] ?? 1);
    if (!scriptFile || !values.json || positionals.length !== 1) usage();
    if (!(HASH_VERSIONS as readonly number[]).includes(hashVersion)) {
      console.error(
        `--hash-version ${values['hash-version']}: supported: ${HASH_VERSIONS.join(', ')}`,
      );
      process.exit(2);
    }
    // only --json and --hash-version: any other flag (even at its default value) is a mistake
    const flags = process.argv
      .slice(3)
      .filter((a) => a.startsWith('--'))
      .map((a) => a.slice(2).split('=')[0]!);
    if (flags.some((f) => f !== 'json' && f !== 'hash-version')) usage();
    if (values['hash-version'] !== undefined && !/^\d+$/.test(values['hash-version'])) usage();
    const scriptPath = resolve(scriptFile);
    if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) {
      console.error(`${scriptFile}: no such file`);
      process.exit(2);
    }
    const r = inspectScript(scriptPath, REPO_ROOT, hashVersion, scriptFile);
    if ('errors' in r) {
      for (const e of r.errors)
        console.error(`${scriptPath}${e.line ? `:${e.line}` : ''} error ${e.message}`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(r.result, null, 2)}\n`);
    return;
  }
  if (command === 'audio') {
    const [sub, scriptFile] = positionals;
    if (sub !== 'prune' || !scriptFile) usage();
    const scriptPath = resolve(scriptFile);
    const script = load(scriptPath);
    const r = pruneAudio(scriptPath, script, script.meta.lang, REPO_ROOT);
    console.error(
      `removed ${r.entries} unused entries and ${r.files} files (${(r.bytes / 1e6).toFixed(1)} MB) from audio/${script.meta.lang}`,
    );
    console.error(r.picks);
    return;
  }
  if (command === 'takes') {
    // `s2v takes pick|unpick <script> …` or `s2v takes <script> --list` (not `s2v pick <image>`)
    const [first, ...more] = positionals;
    const sub = first === 'pick' || first === 'unpick' ? first : null;
    const scriptFile = sub ? more[0] : first;
    if (!scriptFile) usage();
    const scriptPath = resolve(scriptFile);
    const script = load(scriptPath);
    try {
      let lines: string[];
      if (sub === 'pick') lines = pickTakes(scriptPath, script, REPO_ROOT, more.slice(1));
      else if (sub === 'unpick') lines = unpickTakes(scriptPath, script, REPO_ROOT, more.slice(1));
      else if (values.list) lines = listTakes(scriptPath, script, REPO_ROOT, values.id ?? []);
      else {
        const r = await buildTakesPage(scriptPath, script, REPO_ROOT, {
          all: values.all,
          ids: values.id ?? [],
          log: (m) => console.error(m),
        });
        for (const n of r.notes) console.error(n);
        lines = [`${r.lines} line(s) → ${r.html}`];
        if (!values['no-open']) openPage(r.html);
      }
      for (const l of lines) console.log(l);
    } catch (e) {
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }
  if (command === 'voice') {
    const [sub, yamlPath, n] = positionals;
    const lang = (values.lang ?? 'ko') as Lang;
    if (!yamlPath || !['ko', 'ja', 'en'].includes(lang)) usage();
    const log = (m: string) => console.error(m);
    if (sub === 'refs') {
      const scriptPath = resolve(yamlPath);
      await voiceRefs(scriptPath, load(scriptPath), REPO_ROOT, {
        refresh: values.refresh === true,
        log,
      });
      return;
    }
    if (sub === 'check') {
      const fails = await checkVoice(resolve(yamlPath), lang, REPO_ROOT, log);
      if (fails.length) process.exitCode = 1;
      return;
    }
    if (sub === 'create') {
      await createVoice(resolve(yamlPath), REPO_ROOT, {
        lang,
        candidates: Math.max(1, Number(values.candidates ?? 3)),
        play: values.play === true,
        log,
      });
      return;
    }
    if (sub === 'pick' && n) {
      pickVoice(resolve(yamlPath), Number(n), lang, log);
      return;
    }
    if (sub === 'train') {
      // acting stage 4: Korean first (ja and en after their sentence sets are tried, E6)
      if (lang !== 'ko') throw new Error('voice train supports --lang ko for now');
      const raw = values['min-emotion'] ?? '150';
      const minEmotion = Number(raw);
      if (!/^\d+$/.test(raw) || !Number.isInteger(minEmotion)) usage();
      await trainVoice(resolve(yamlPath), REPO_ROOT, { lang, minEmotion, log });
      return;
    }
    usage();
  }
  if (command === 'character') {
    const [sub, src] = positionals;
    if (sub === 'setup' && !src) {
      await setupImagegen(REPO_ROOT, {
        maxGb: memoryLimit(values['max-memory-gb']),
        explicit: values['max-memory-gb'] !== undefined,
        log: (m) => console.error(m),
      });
      return;
    }
    const gen = {
      repoRoot: REPO_ROOT,
      maxGb: memoryLimit(values['max-memory-gb']),
      log: (m: string) => console.error(m),
    };
    const items = positionals.slice(2);
    if (sub === 'create' && src) {
      const n = Number(values.candidates ?? 4);
      if (!Number.isInteger(n) || n < 1 || n > 16) usage();
      await createCharacter(resolve(src), { ...gen, candidates: n });
      return;
    }
    if (sub === 'pick' && src && items.length === 1) {
      pickCandidate(resolve(src), items[0]!, gen.log);
      return;
    }
    if (sub === 'build' && src) {
      await buildCharacter(resolve(src), {
        ...gen,
        dryRun: values['dry-run'] === true,
        resetDerived: values['reset-derived'] === true,
      });
      return;
    }
    if (sub === 'review' && src) {
      await reviewCharacter(resolve(src), gen);
      return;
    }
    if (sub === 'approve' && src && (items.length > 0 || values.all)) {
      // `--all --except a b`: names after --except are exceptions too; with --all and no
      // --except, names are ambiguous and refused.
      if (values.all && items.length > 0 && !values.except) usage();
      await approveItems(resolve(src), values.all ? [] : items, {
        ...gen,
        all: values.all === true,
        except: [...(values.except ?? []), ...(values.all ? items : [])],
        resetDerived: values['reset-derived'] === true,
      });
      return;
    }
    if (sub === 'redo' && src && items.length > 0) {
      const seed = values.seed === undefined ? undefined : Number(values.seed);
      if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32)) usage();
      redoItems(resolve(src), items, seed, gen.log);
      return;
    }
    if (sub === 'missing' && src) {
      const scriptPath = resolve(src);
      // Parse only: the lint errors (a face missing from a set) are what this command explains.
      const parsed = parseScript(readFileSync(scriptPath, 'utf8'));
      for (const d of parsed.diagnostics.items.filter((x) => x.severity === 'error'))
        console.error(formatDiagnostic(d, scriptPath));
      if (!parsed.script) process.exit(1);
      const script = parsed.script;
      enrichCast(script, dirname(scriptPath));
      const reports = findMissing(script, dirname(scriptPath));
      if (values.apply)
        for (const r of reports) {
          const added = applyMissing(r);
          if (added.length) console.error(`${r.cast}: added ${added.join(', ')}`);
        }
      const n = printMissing(
        values.apply ? findMissing(script, dirname(scriptPath)) : reports,
        gen.log,
      );
      if (n > 0) process.exitCode = 1;
      return;
    }
    if (sub === 'import' && src && values.out) {
      const r = importCharacter(resolve(src), resolve(values.out), {
        ...(values.name ? { name: values.name } : {}),
        log: (m) => console.error(m),
      });
      console.error(
        `imported ${r.copied} parts into ${r.out}${r.terms.length ? ` (with ${r.terms.join(', ')})` : ''}\n` +
          `next: pick faces in ${join(r.out, 'parts.html')} and edit ${join(r.out, 'character.yaml')}`,
      );
      return;
    }
    usage();
  }
  if (!command || !file) usage();
  const path = resolve(file);

  switch (command) {
    case 'snapshot': {
      const script = load(path);
      const log = (m: string) => console.error(m);
      const outputName = values.output!;
      const profile = script.meta.outputs[outputName];
      if (!profile) throw new Error(`unknown output "${outputName}"`);
      const videoId = basename(dirname(path));
      const draft = values.draft === true;
      const lockDir = draft
        ? join(REPO_ROOT, '.s2v-cache', 'draft-audio', videoId, script.meta.lang)
        : undefined;
      // Snapshot needs the timeline (audio durations + word timings); synthesize what is missing.
      const tts = await synthesizeScript(path, script, REPO_ROOT, {
        asr: false,
        draft,
        ...(lockDir ? { lockDir } : {}),
        log,
      });
      if (tts.synthesized > 0) log(`tts: synthesized ${tts.synthesized}, reused ${tts.reused}`);
      const { timeline } = buildTimeline(
        script,
        outputName,
        loadAudioManifest(path, script.meta.lang, lockDir),
        Number(values.fps),
        rhythmOpts,
      );
      const workDir = join(
        REPO_ROOT,
        '.s2v-cache',
        'render',
        videoId,
        `${outputName}.${script.meta.lang}`,
      );
      const outDir = join(REPO_ROOT, 'out', videoId);
      mkdirSync(outDir, { recursive: true });
      const sheet = await snapshot(
        {
          timeline,
          aspect: profile.aspect as Aspect,
          subtitleMode: profile.subtitles ?? (profile.layout === 'shorts' ? 'word' : 'sentence'),
          layout: profile.layout,
          cast: castOptions(script, timeline),
          mouths: timelineMouths(timeline),
          subtitleStyle: subtitleStyleFor(script.meta, outputName),
          transition: profile.transition ?? script.meta.transition,
          theme: themeOf(script.meta),
          logo: logoOf(script.meta),
          assetsRoot: dirname(path),
          fontsDir: await ensureFonts(REPO_ROOT, log),
          workDir,
          log,
        },
        join(outDir, `${outputName}.${script.meta.lang}.snapshot.png`),
      );
      log(`→ ${sheet}`);
      break;
    }
    case 'pick': {
      console.error(
        `opened ${pick(path, REPO_ROOT)} — click for a circle, drag for a box; attributes are copied`,
      );
      break;
    }
    case 'say': {
      const script = values.script ? load(resolve(values.script)) : null;
      const firstCast = script ? Object.values(script.meta.cast)[0] : undefined;
      await say(file, REPO_ROOT, {
        voice: values.voice ?? firstCast?.voice ?? 'qwen:Sohee',
        lang: (values.lang ?? script?.meta.lang ?? 'ko') as 'ko' | 'en' | 'ja',
        style: values.style ?? (values.voice ? undefined : firstCast?.style),
        pronounce: script?.meta.pronounce ?? {},
        maxPause: script?.meta.pacing.maxPause ?? 0.35,
        play: !values['no-play'],
        log: (m) => console.error(m),
      });
      break;
    }
    case 'check': {
      const script = load(path);
      const log = (m: string) => console.error(m);
      let manifest: AudioManifest | undefined;
      try {
        manifest = loadAudioManifest(path, script.meta.lang);
      } catch {
        // No audio yet: subtitle groups come from the text.
      }
      const fonts = await ensureFonts(REPO_ROOT, log);
      const videoId = basename(dirname(path));
      const result = await checkSubtitles(script, manifest, {
        fontsDir: fonts,
        workDir: join(REPO_ROOT, '.s2v-cache', 'check', videoId, script.meta.lang),
        assetsRoot: dirname(path),
        log,
      });
      for (const d of result.diagnostics) console.error(formatDiagnostic(d, path));
      if (result.diagnostics.length > 0) process.exit(1);
      console.error(`${file}: ${result.checked} subtitles fit (${result.source})`);
      break;
    }
    case 'export-script': {
      // A reading script for a recording session: one block per paragraph with the file name to
      // record it as; then add :audio{src=...} to the paragraph (see the reference).
      const script = load(path);
      const lines = [`# ${script.meta.title ?? basename(path)}`, ''];
      for (const scene of script.scenes) {
        lines.push(`## ${scene.title}`, '');
        scene.blocks.forEach((b, bi) => {
          if (b.kind !== 'paragraph') return;
          const name = script.meta.cast[b.cast]?.name ?? b.cast;
          lines.push(
            `**${name}** — \`rec/${scene.id}-${bi}.wav\`${b.audio ? ' (recorded)' : ''}`,
            '',
            b.sentences.map((x) => x.text).join(' '),
            '',
          );
        });
      }
      process.stdout.write(lines.join('\n'));
      break;
    }
    case 'sentences': {
      // Sentence ids (for `tts --retry`) with their text.
      const script = load(path);
      for (const scene of script.scenes)
        scene.blocks.forEach((b, bi) => {
          if (b.kind !== 'paragraph') return;
          b.sentences.forEach((x, si) =>
            console.log(`${sentenceId(scene.id, bi, si)}\t${b.cast}\t${x.text}`),
          );
        });
      break;
    }
    case 'lint': {
      load(path);
      console.error(`${file}: ok`);
      break;
    }
    case 'tts': {
      const script = load(path);
      const started = Date.now();
      const result = await synthesizeScript(path, script, REPO_ROOT, {
        asr: !values['no-asr'],
        recheck: values.recheck,
        ...(values.retry ? { retry: values.retry } : {}),
        log: (m) => console.error(m),
      });
      for (const w of result.warnings) console.error(`warning: ${w}`);
      console.error(
        `synthesized ${result.synthesized}, reused ${result.reused} in ${((Date.now() - started) / 1000).toFixed(1)}s → ${result.manifestPath}`,
      );
      break;
    }
    case 'timeline': {
      const script = load(path);
      const { timeline, issues, gaps } = buildTimeline(
        script,
        values.output!,
        loadAudioManifest(path, script.meta.lang),
        Number(values.fps),
        rhythmOpts,
      );
      for (const i of issues) console.error(`warning: ${i.sentenceId}: ${i.message}`);
      if (gaps) {
        console.error('rhythm: paragraph gaps (line, seconds, ×factor, rules)');
        for (const g of gaps)
          console.error(
            `  ${g.sceneId}:${g.line}  ${g.seconds.toFixed(2)}s  ×${g.factor.toFixed(2)}  ${g.rules.join(' ')}`,
          );
      }
      process.stdout.write(JSON.stringify(timeline, null, 2) + '\n');
      break;
    }
    case 'render': {
      const script = load(path);
      const log = (m: string) => console.error(m);
      const started = Date.now();
      const outputName = values.output!;
      const profile = script.meta.outputs[outputName];
      if (!profile) throw new Error(`unknown output "${outputName}"`);
      const draft = values.draft === true;
      if (values.idle !== undefined && values.idle !== 'on' && values.idle !== 'off')
        throw new Error(`--idle must be on or off, not "${values.idle}"`);
      const idle =
        values.idle !== undefined ? values.idle === 'on' : script.meta.acting?.idle !== false;
      const videoId = basename(dirname(path));
      const lockDir = draft
        ? join(REPO_ROOT, '.s2v-cache', 'draft-audio', videoId, script.meta.lang)
        : undefined;
      const tts = await synthesizeScript(path, script, REPO_ROOT, {
        asr: !values['no-asr'],
        recheck: values.recheck,
        frozen: values['frozen-audio'],
        draft,
        ...(lockDir ? { lockDir } : {}),
        log,
      });
      for (const w of tts.warnings) log(`warning: ${w}`);
      log(`tts: synthesized ${tts.synthesized}, reused ${tts.reused}`);
      const { timeline, issues } = buildTimeline(
        script,
        outputName,
        loadAudioManifest(path, script.meta.lang, lockDir),
        Number(values.fps),
        rhythmOpts,
      );
      for (const i of issues) log(`warning: ${i.sentenceId}: ${i.message}`);
      const long = renderedLengthWarning(
        outputName,
        timeline.totalFrames / timeline.fps,
        profile.maxDuration,
        estimatedOver.has(outputName),
      );
      if (long) log(`warning: ${long}`);
      const suffix = draft ? '.draft' : '';
      const workDir = join(
        REPO_ROOT,
        '.s2v-cache',
        'render',
        videoId,
        `${outputName}.${script.meta.lang}${suffix}`,
      );
      const outDir = join(REPO_ROOT, 'out', videoId);
      mkdirSync(workDir, { recursive: true });
      mkdirSync(outDir, { recursive: true });
      const fonts = await ensureFonts(REPO_ROOT, log);
      const chunks = await renderScenes({
        timeline,
        aspect: profile.aspect as Aspect,
        subtitleMode: profile.subtitles ?? (profile.layout === 'shorts' ? 'word' : 'sentence'),
        layout: profile.layout,
        cast: castOptions(script, timeline),
        mouths: timelineMouths(timeline),
        subtitleStyle: subtitleStyleFor(script.meta, outputName),
        transition: profile.transition ?? script.meta.transition,
        theme: themeOf(script.meta),
        logo: logoOf(script.meta),
        assetsRoot: dirname(path),
        fontsDir: fonts,
        workDir,
        ...(draft ? { scale: 0.5 } : {}),
        idle,
        noCache: values['no-cache'],
        ...(values.workers ? { concurrency: Math.max(1, Number(values.workers)) } : {}),
        log,
      });
      log(
        `video: ${chunks.filter((c) => !c.cached).length} scenes rendered, ${chunks.filter((c) => c.cached).length} cached`,
      );
      const narration = join(workDir, 'narration.wav');
      const { gains } = await buildNarration(timeline, narration);
      const perCast = new Map<string, number[]>();
      for (const sc of timeline.scenes)
        for (const a of sc.audio)
          perCast.set(a.cast, [...(perCast.get(a.cast) ?? []), gains[a.sentenceId]!]);
      log(
        `levels: ${[...perCast]
          .map(
            ([c, g]) =>
              `${c} ${Math.min(...g) >= 0 ? '+' : ''}${Math.min(...g).toFixed(1)}..${Math.max(...g).toFixed(1)} dB`,
          )
          .join(', ')}`,
      );
      // Music and sound effects under the narration.
      const bgm = bgmOf(script.meta);
      const effects = sfxEvents(script, timeline);
      let toMaster = narration;
      if (bgm || effects.length > 0) {
        const sfxPath = effects.length > 0 ? join(workDir, 'sfx.wav') : null;
        if (sfxPath)
          await buildSfxTrack(effects, timeline.fps, timeline.totalFrames, REPO_ROOT, sfxPath);
        toMaster = join(workDir, 'mix.wav');
        const r = await mixSoundtrack({
          narration,
          seconds: timeline.totalFrames / timeline.fps,
          bgm: bgm ? { ...bgm, path: resolve(dirname(path), bgm.src) } : null,
          sfx: sfxPath,
          out: toMaster,
        });
        log(
          `soundtrack: ${effects.length} effect(s)${bgm ? `, music ${r.bgmGainDb! >= 0 ? '+' : ''}${r.bgmGainDb!.toFixed(1)} dB to ${bgm.level} LUFS${bgm.duck ? ', ducked' : ''}` : ''}`,
        );
      }
      const mastered = join(workDir, 'master.wav');
      const m = await master(toMaster, mastered);
      log(
        `audio: ${m.lufs.toFixed(1)} LUFS, true peak ${m.truePeak.toFixed(1)} dBFS (${m.passes} pass)`,
      );
      const out = join(outDir, `${outputName}.${script.meta.lang}${suffix}.mp4`);
      await concatAndMux(
        chunks.map((c) => c.path),
        mastered,
        out,
        workDir,
      );
      const p = await probe(out);
      const ok = p.frames === timeline.totalFrames && Math.abs(p.videoSec - p.audioSec) < 0.05;
      log(
        `${ok ? 'ok' : 'CHECK FAILED'}: ${p.frames}/${timeline.totalFrames} frames, video ${p.videoSec.toFixed(3)}s, audio ${p.audioSec.toFixed(3)}s`,
      );
      log(`→ ${out} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      for (const f of writePublishFiles(
        script,
        timeline,
        out.replace(/\.mp4$/, ''),
        draft,
        log,
        profile.aspect === '16:9',
      ))
        log(`→ ${f}`);
      if (profile.aspect === '16:9' && !draft)
        log(
          `→ ${await writeThumbnail(
            script,
            dirname(path),
            {
              timeline,
              aspect: '16:9',
              layout: profile.layout,
              cast: castOptions(script, timeline),
              mouths: timelineMouths(timeline),
              subtitleStyle: subtitleStyleFor(script.meta, outputName),
              theme: themeOf(script.meta),
              logo: logoOf(script.meta),
              assetsRoot: dirname(path),
              fontsDir: fonts,
              workDir,
            },
            out.replace(/\.mp4$/, '.thumbnail.png'),
          )}`,
        );
      if (!ok) process.exit(1);
      break;
    }
    default:
      usage();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(e instanceof ExitError ? e.exitCode : 1);
});
