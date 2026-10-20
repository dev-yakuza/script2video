#!/usr/bin/env node
/**
 * s2v — script2video command line.
 *
 *   s2v --version [--json]   (the version a tool pins)
 *   s2v lint <script.md>
 *   s2v check <script.md>   (subtitles fit their boxes)
 *   s2v sentences <script.md> [--json]   (sentence ids to retry; with lock state as JSON)
 *   s2v tts <script.md> [--no-asr] [--recheck] [--retry <scene[:paragraph[:sentence]]>]...
 *   s2v takes <script.md> [--all] [--id <id>]... [--no-open] [--out-dir <dir>] | --list [--id <id>]...   (listening page | takes of each line)
 *   s2v takes pick <script.md> <id>=<take> ...   (choose a take)
 *   s2v takes unpick <script.md> <id> ...
 *   s2v inspect <script.md> --json [--hash-version 1]   (what the script is made of, hashed by kind)
 *   s2v direct <script.md> [--output youtube] [--fps 30] [--rhythm on|off] [--no-open] [--out-dir <dir>] [--json]   (direction plan and notes; --json: the notes, no page)
 *   s2v timeline <script.md> [--output youtube] [--fps 30] [--rhythm on|off]
 *   s2v snapshot <script.md> [--output youtube] [--draft] [--fps 30] [--rhythm on|off] [--out-dir <dir>] [--frozen-audio] [--frames]
 *   s2v render <script.md> [--output youtube] [--no-asr] [--recheck] [--draft] [--no-cache] [--frozen-audio] [--workers N] [--idle on|off] [--rhythm on|off] [--fps 30] [--out-dir <dir>] [--watermark proxy] [--scenes <id,…>]
 *   s2v capture <url> --out <png> [--text <json>] [--assets-dir <dir>] [--width 1280] [--height 800] [--selector <css>] [--allow-host <host>]... [--timeout 30]   (a web page: its picture and what it says)
 *   s2v audio prune <script.md>   (drop locked audio the script no longer uses)
 *   s2v export-script <script.md>   (reading script for a recording session)
 *   s2v import-recording <script.md> <take.wav> [--write]
 *   s2v dev <script.md> [--output youtube] [--video] [--no-asr]   (edit loop)
 *   s2v say [--voice qwen:Sohee] [--lang ko] [--style ...] [--script script.md] [--no-play] [--] "<sentence>"   (a sentence starting with - goes after the bare double dash)
 *   s2v voice create <voices/id.yaml> [--lang ko] [--candidates 3] [--play]
 *   s2v voice pick <voices/id.yaml> <n> [--lang ko]
 *   s2v voice check <voices/id.yaml> [--lang ko]   (judge a persona's reference clip)
 *   s2v voice train <voices/id.yaml> [--lang ko] [--min-emotion 150]   (its trained speaker, about 3 h)
 *   s2v voice refs <script.md> [--refresh]   (reference voices for the consistency checks)
 *   s2v character setup [--max-memory-gb N]   (optional image generation; Apple silicon)
 *   s2v character create <dir> [--candidates 4] [--max-memory-gb N] [--no-open]
 *   s2v character pick <dir> <n>
 *   s2v character build <dir> [--dry-run [--json]] [--layers-only] [--reset-derived] [--max-memory-gb N] [--no-open]
 *   s2v character review <dir> [--json [--no-check]] [--no-open]
 *   s2v character approve <dir> <item>... | --all [--except <item>...] [--reset-derived]
 *   s2v character redo <dir> <item>... [--seed N]
 *   s2v character missing <script.md> [--apply] [--json]
 *   s2v character import <ymm4 folder|zip> --out <characters/id> [--name <character>]
 *   s2v new <dir> [--lang ko|ja|en]   (a new video folder with a starter script)
 *   s2v pick <image>   (mark a spot on an image)
 *   s2v doctor   (is this machine ready?)
 *   s2v tts-server start   (keep the TTS server running)
 *   s2v services status [--json]   (the machine lock, the resident server and who owns each server)
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTimeline,
  directPlan,
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
  pickDrift,
  driftMessage,
  pickScenes,
  type AudioManifest,
} from '@script2video/core';
import { headlessBrowserPath, renderScenes, type Aspect } from '@script2video/renderer-remotion';
import { renderedLengthWarning } from './length.js';
import { enrichCast } from './cast-faces.js';
import { castOptions } from './cast.js';
import { buildSfxTrack, mixSoundtrack } from './soundtrack.js';
import { dropThumbnail, writePublishFiles, writeSubtitleFiles, writeThumbnail } from './publish.js';
import { timelineMouths } from './mouth.js';
import { checkSubtitles } from './check.js';
import { importCharacter } from './character-import.js';
import { ExitError } from './errors.js';
import { defaultMemoryLimitGb, setupImagegen } from './imagegen.js';
import {
  approveItems,
  buildCharacter,
  buildExitCode,
  createCharacter,
  pickCandidate,
  redoItems,
  reviewCharacter,
} from './character-gen/commands.js';
import {
  addedText,
  applyMissing,
  applyMissingFlow,
  findMissing,
  missingFails,
  missingJson,
  printMissing,
  type Added,
  type MissingReport,
} from './character-gen/missing.js';
import { buildPlan, reviewReport } from './character-gen/report.js';
import { checkDevOutput, dev } from './dev.js';
import { importRecording } from './import-recording.js';
import { doctor } from './doctor.js';
import { scaffold } from './scaffold.js';
import { checkVoice, createVoice, pickVoice } from './persona.js';
import { buildNarration, concatAndMux, ensureFonts, master, probe } from './media.js';
import {
  lintAssets,
  lintImageFormats,
  lintBgm,
  lintCast,
  lintSubtitleFonts,
  lintTranslation,
} from './lint-assets.js';
import { pick } from './pick.js';
import { runResident, say } from './say.js';
import { clearSnapshot, snapshot, type SnapshotTargets } from './snapshot.js';
import { loadAudioManifest, pruneAudio, synthesizeScript, toAudioManifest } from './tts.js';
import { listTakes, pickTakes, unpickTakes } from './takes.js';
import { buildTakesPage } from './takes-page.js';
import { openPage } from './html.js';
import { trainVoice } from './voice-train.js';
import { voiceRefs } from './voice-refs.js';
import { inspectScript } from './inspect.js';
import { directDiagnostics, directHtml, directJson, directManifest } from './direct.js';
import {
  commandOf,
  intFlag,
  langFlag,
  onOff,
  parseFor,
  parseScenesFlag,
  profileOf,
  USAGE,
  UsageError,
} from './args.js';
import { printVersion, versionInfo } from './version.js';
import { sentencesReport } from './sentences.js';
import { proxyPlacement, writeProxyPng } from './watermark.js';
import {
  cacheDirOf,
  checkOutDir,
  outDirOf,
  renderBase,
  renderWorkDir,
  snapshotPaths,
} from './paths.js';
import { scenesLint, spokenIn } from './scenes.js';
import { runCapture } from './capture/index.js';
import { acquireHeavy } from './heavy-lock.js';
import { acquireActors } from './actor-lock.js';
import { servicesStatus, printServicesStatus } from './services-status.js';
import { runMain } from './shutdown.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Frame size of each aspect at scale 1 (the renderer's). */
const FRAME_SIZE: Record<Aspect, [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
};

function usage(): never {
  console.error(USAGE.map((l, i) => `${i === 0 ? 'usage: ' : '       '}${l}`).join('\n'));
  process.exit(2);
}

/** Outputs whose estimated length already went over maxDuration in `load()` (5d plan 2). */
const estimatedOver = new Set<string>();

function load(path: string) {
  return loadWithDiagnostics(path).script;
}

/**
 * `load`, also returning every diagnostic it printed. `keepGoing`: lint errors do not stop it
 * (only a script that does not parse) — for reports that show those errors themselves.
 */
function loadWithDiagnostics(path: string, keepGoing = false) {
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
      ...lintImageFormats(script, dirname(path)),
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
  if (!script || (!keepGoing && all.some((d) => d.severity === 'error'))) process.exit(1);
  return { script, diagnostics: all };
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

/** S2V_TAKES_ALL=6 (development, README): all six takes of emotion lines (stage 3 E7). */
const TAKES_ALL = process.env.S2V_TAKES_ALL === '6';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === '--version') {
    printVersion(REPO_ROOT, rest);
    return;
  }
  if (!command) usage();
  // Each command takes only its own flags (S3 plan 4); check them before anything runs.
  const found = commandOf(command, rest);
  if (!found) usage();
  parseFor(found.key, rest);
  const { positionals } = found;
  const file = positionals[0];
  // --rhythm changes the timing: only commands that build a timeline take it (5d plan 2).
  const rhythmOf = (value: string | undefined) => {
    const rhythm = onOff('rhythm', value);
    return rhythm === undefined ? {} : { rhythm };
  };
  if (command === 'tts-server') {
    await runResident(REPO_ROOT, (m) => console.error(m));
    return;
  }
  if (command === 'services') {
    const { values } = parseFor('services status', rest);
    const status = await servicesStatus(REPO_ROOT);
    if (values.json) process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    else printServicesStatus(status, (m) => process.stdout.write(`${m}\n`));
    return;
  }
  if (command === 'dev') {
    const { values } = parseFor('dev', rest);
    const file = positionals[0];
    if (!file) usage();
    checkDevOutput(resolve(file), values.output);
    await dev(resolve(file), {
      output: values.output,
      video: values.video === true,
      asr: !values['no-asr'],
      cliPath: fileURLToPath(import.meta.url),
      repoRoot: REPO_ROOT,
      log: (m) => console.error(m),
    });
    return;
  }
  if (command === 'new') {
    const { values } = parseFor('new', rest);
    const dir = positionals[0];
    if (!dir) usage();
    const lang = langFlag(values.lang);
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
    const { values } = parseFor('import-recording', rest);
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
    const { values } = parseFor('inspect', rest);
    const [scriptFile] = positionals;
    const hashVersion = Number(values['hash-version'] ?? 1);
    if (!scriptFile || !values.json || positionals.length !== 1) usage();
    if (!(HASH_VERSIONS as readonly number[]).includes(hashVersion)) {
      console.error(
        `--hash-version ${values['hash-version']}: supported: ${HASH_VERSIONS.join(', ')}`,
      );
      process.exit(2);
    }
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
    // it deletes wav files a synthesizing run may have just written (S8 plan 3.8)
    acquireHeavy('tts');
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
    // pick and unpick take no flags (checked above); the page and --list read these
    const { values } = parseFor('takes', sub ? [] : rest);
    const scriptFile = sub ? more[0] : first;
    if (!scriptFile) usage();
    const scriptPath = resolve(scriptFile);
    if (values.list && values['out-dir'] !== undefined)
      throw new UsageError('s2v takes: --out-dir is for the page, not --list');
    // the results folder is checked before anything runs (S2)
    const pageDir =
      sub || values.list
        ? undefined
        : checkOutDir(outDirOf(scriptPath, REPO_ROOT, values['out-dir']), scriptPath, REPO_ROOT);
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
          ...(pageDir ? { outDir: pageDir } : {}),
        });
        for (const n of r.notes) console.error(n);
        lines = [`${r.lines} line(s) → ${r.html}`];
        if (!values['no-open']) openPage(r.html);
      }
      for (const l of lines) console.log(l);
    } catch (e) {
      if (e instanceof ExitError) throw e; // busy (changed) stays 73
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    }
    return;
  }
  if (command === 'voice') {
    const [sub, yamlPath, n] = positionals;
    if (!yamlPath) usage();
    const langOf = langFlag;
    const log = (m: string) => console.error(m);
    if (sub === 'refs') {
      const { values } = parseFor('voice refs', rest);
      const scriptPath = resolve(yamlPath);
      await voiceRefs(scriptPath, load(scriptPath), REPO_ROOT, {
        refresh: values.refresh,
        log,
      });
      return;
    }
    if (sub === 'check') {
      const lang = langOf(parseFor('voice check', rest).values.lang);
      const fails = await checkVoice(resolve(yamlPath), lang, REPO_ROOT, log);
      if (fails.length) process.exitCode = 1;
      return;
    }
    if (sub === 'create') {
      const { values } = parseFor('voice create', rest);
      const lang = langOf(values.lang);
      await createVoice(resolve(yamlPath), REPO_ROOT, {
        lang,
        candidates: intFlag('candidates', values.candidates ?? '3', 1, 16),
        play: values.play,
        log,
      });
      return;
    }
    if (sub === 'pick' && n) {
      pickVoice(
        resolve(yamlPath),
        Number(n),
        langOf(parseFor('voice pick', rest).values.lang),
        log,
      );
      return;
    }
    if (sub === 'train') {
      const { values } = parseFor('voice train', rest);
      const lang = langOf(values.lang);
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
    const log = (m: string) => console.error(m);
    if (sub === 'setup' && !src) {
      const { values } = parseFor('character setup', rest);
      await setupImagegen(REPO_ROOT, {
        maxGb: memoryLimit(values['max-memory-gb']),
        explicit: values['max-memory-gb'] !== undefined,
        log: (m) => console.error(m),
      });
      return;
    }
    // --max-memory-gb watches the image model: only create and build load it
    const gen = (maxGb?: string) => ({ repoRoot: REPO_ROOT, maxGb: memoryLimit(maxGb), log });
    const items = positionals.slice(2);
    if (sub === 'create' && src) {
      const { values } = parseFor('character create', rest);
      const n = Number(values.candidates ?? 4);
      if (!Number.isInteger(n) || n < 1 || n > 16) usage();
      await createCharacter(resolve(src), {
        ...gen(values['max-memory-gb']),
        candidates: n,
        open: !values['no-open'],
      });
      return;
    }
    if (sub === 'pick' && src && items.length === 1) {
      pickCandidate(resolve(src), items[0]!, log);
      return;
    }
    if (sub === 'build' && src) {
      const { values } = parseFor('character build', rest);
      const dryRun = values['dry-run'];
      // S9b: --json is the dry run's; --layers-only builds layers only (no model, no page)
      if (values.json && !dryRun)
        throw new UsageError('s2v character build: --json needs --dry-run');
      if (dryRun && values.json && values['reset-derived'])
        throw new UsageError(
          's2v character build: --reset-derived does nothing with --dry-run --json',
        );
      if (dryRun && values['no-open'])
        throw new UsageError('s2v character build: --no-open does nothing with --dry-run');
      const layersOnly = values['layers-only'];
      if (layersOnly) {
        const extra = (['dry-run', 'json', 'no-open', 'max-memory-gb'] as const).find(
          (f) => values[f] !== undefined && values[f] !== false,
        );
        if (extra)
          throw new UsageError(`s2v character build: --layers-only does not take --${extra}`);
      }
      if (dryRun && values.json) {
        const plan = buildPlan(resolve(src), REPO_ROOT, log);
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
        return;
      }
      const r = await buildCharacter(resolve(src), {
        ...gen(values['max-memory-gb']),
        dryRun,
        resetDerived: values['reset-derived'],
        layersOnly,
        open: !values['no-open'],
      });
      const code = buildExitCode({ layersOnly }, r);
      if (code) process.exitCode = code;
      return;
    }
    if (sub === 'review' && src) {
      const { values } = parseFor('character review', rest);
      // S9b: --no-check only reads (no page), so it is a --json mode
      if (values['no-check'] && !values.json)
        throw new UsageError('s2v character review: --no-check needs --json');
      if (values['no-check'] && values['no-open'])
        throw new UsageError('s2v character review: --no-open does nothing with --no-check');
      const dir = resolve(src);
      const r = await reviewCharacter(dir, {
        ...gen(),
        open: !values['no-open'],
        check: !values['no-check'],
      });
      if (values.json)
        process.stdout.write(
          `${JSON.stringify(reviewReport(dir, r.graph, r.run, REPO_ROOT, log), null, 2)}\n`,
        );
      return;
    }
    const approve = sub === 'approve' ? parseFor('character approve', rest).values : null;
    if (approve && src && (items.length > 0 || approve.all)) {
      const values = approve;
      // `--all --except a b`: names after --except are exceptions too; with --all and no
      // --except, names are ambiguous and refused.
      if (values.all && items.length > 0 && !values.except) usage();
      await approveItems(resolve(src), values.all ? [] : items, {
        ...gen(),
        all: values.all,
        except: [...(values.except ?? []), ...(values.all ? items : [])],
        resetDerived: values['reset-derived'],
      });
      return;
    }
    if (sub === 'redo' && src && items.length > 0) {
      const { values } = parseFor('character redo', rest);
      const seed = values.seed === undefined ? undefined : Number(values.seed);
      if (seed !== undefined && !(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 32)) usage();
      redoItems(resolve(src), items, seed, log);
      return;
    }
    if (sub === 'missing' && src) {
      const { values } = parseFor('character missing', rest);
      const scriptPath = resolve(src);
      // Parse only: the lint errors (a face missing from a set) are what this command explains.
      const parsed = parseScript(readFileSync(scriptPath, 'utf8'));
      for (const d of parsed.diagnostics.items.filter((x) => x.severity === 'error'))
        console.error(formatDiagnostic(d, scriptPath));
      if (!parsed.script) process.exit(1);
      const script = parsed.script;
      enrichCast(script, dirname(scriptPath));
      const find = () => findMissing(script, dirname(scriptPath), { repoRoot: REPO_ROOT, log });
      let reports: MissingReport[];
      let added = new Map<string, Added[]>();
      if (values.apply) {
        // S8: the work lock of every character this will write, taken before any write and
        // judged again under it (final review 16)
        ({ reports, added } = applyMissingFlow(find, acquireActors, (r) => {
          const a = applyMissing(r);
          if (a.length) console.error(`${r.cast}: added ${a.map(addedText).join(', ')}`);
          return a;
        }));
      } else reports = find();
      const after = values.apply ? find() : reports;
      if (values.json)
        process.stdout.write(`${JSON.stringify(missingJson(after, added), null, 2)}\n`);
      else printMissing(after, log);
      if (missingFails(after)) process.exitCode = 1;
      return;
    }
    const imp = sub === 'import' ? parseFor('character import', rest).values : null;
    if (imp && src && imp.out) {
      const values = imp;
      const r = importCharacter(resolve(src), resolve(values.out!), {
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
  if (command === 'capture') {
    const { values } = parseFor('capture', rest);
    const code = await runCapture(file, values, headlessBrowserPath, (m) => console.error(m));
    if (code !== 0) process.exit(code);
    return;
  }
  if (!command || !file) usage();
  const path = resolve(file);

  switch (command) {
    case 'snapshot': {
      const { values } = parseFor('snapshot', rest);
      const fps = intFlag('fps', values.fps, 1);
      const rhythmOpts = rhythmOf(values.rhythm);
      const outDir = checkOutDir(outDirOf(path, REPO_ROOT, values['out-dir']), path, REPO_ROOT);
      const script = load(path);
      const log = (m: string) => console.error(m);
      const outputName = values.output;
      const profile = profileOf(script, outputName);
      const draft = values.draft;
      const lockDir = draft
        ? join(cacheDirOf(REPO_ROOT, 'draft-audio', path), script.meta.lang)
        : undefined;
      const name = `${outputName}.${script.meta.lang}`;
      const paths = snapshotPaths(outDir, outputName, script.meta.lang, draft);
      const targets: SnapshotTargets = {
        sheet: paths.sheet,
        ...(values.frames
          ? {
              frames: {
                dir: paths.frames,
                meta: {
                  output: outputName,
                  lang: script.meta.lang,
                  draft,
                  s2v_version: versionInfo(REPO_ROOT, { git: false }).id,
                  script_sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
                },
              },
            }
          : {}),
      };
      // last run's results go first: a failed run leaves none (S2 rule)
      clearSnapshot(targets);
      // Snapshot needs the timeline (audio durations + word timings): synthesize what is missing,
      // or with --frozen-audio take the lock as it is (S6).
      const tts = await synthesizeScript(path, script, REPO_ROOT, {
        takesAll: TAKES_ALL,
        asr: false,
        draft,
        frozen: values['frozen-audio'],
        ...(lockDir ? { lockDir } : {}),
        log,
      });
      if (tts.synthesized > 0) log(`tts: synthesized ${tts.synthesized}, reused ${tts.reused}`);
      const { timeline } = buildTimeline(
        script,
        outputName,
        toAudioManifest(tts.manifest, tts.lockDir),
        fps,
        rhythmOpts,
      );
      // its own work folder: a render of the same output may run beside it (S6)
      const workDir = join(
        cacheDirOf(REPO_ROOT, 'render', path),
        `${name}${draft ? '.draft' : ''}.snapshot`,
      );
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
        targets,
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
      const { values } = parseFor('say', rest);
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
      const result = await checkSubtitles(script, manifest, {
        fontsDir: fonts,
        workDir: join(cacheDirOf(REPO_ROOT, 'check', path), script.meta.lang),
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
      const { values } = parseFor('sentences', rest);
      // --json reports the lines that cannot be made (a missing recording, a speed out of range)
      const loaded = values.json ? loadWithDiagnostics(path, true) : null;
      const script = loaded ? loaded.script : load(path);
      // for tools (S9a): lock key, voice attributes, pick and lock state of every sentence; the
      // JSON is printed even when lint fails, and the exit code still says it failed
      if (values.json) {
        process.stdout.write(
          `${JSON.stringify(sentencesReport(path, script, REPO_ROOT), null, 2)}\n`,
        );
        if (loaded!.diagnostics.some((d) => d.severity === 'error')) process.exitCode = 1;
        break;
      }
      // Sentence ids (for `tts --retry`) with their text.
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
      const { values } = parseFor('tts', rest);
      const script = load(path);
      const started = Date.now();
      const result = await synthesizeScript(path, script, REPO_ROOT, {
        takesAll: TAKES_ALL,
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
    case 'direct': {
      const { values } = parseFor('direct', rest);
      const fps = intFlag('fps', values.fps, 1);
      const rhythmOpts = rhythmOf(values.rhythm);
      // S9b: --json writes no page, so the page's flags are not used
      if (values.json && (values['out-dir'] !== undefined || values['no-open']))
        throw new UsageError('s2v direct: --out-dir and --no-open are for the page, not --json');
      const resultsDir = values.json
        ? ''
        : checkOutDir(outDirOf(path, REPO_ROOT, values['out-dir']), path, REPO_ROOT);
      // --json reports even when lint fails (and exits 1), as sentences --json does
      const { script, diagnostics } = loadWithDiagnostics(path, values.json);
      const outputName = values.output;
      profileOf(script, outputName);
      const dm = directManifest(path, script, REPO_ROOT);
      const plan = directPlan(script, outputName, dm.manifest, {
        ...rhythmOpts,
        fps: fps,
      });
      if (values.json) {
        process.stdout.write(`${JSON.stringify(directJson(plan, dm), null, 2)}\n`);
        if (diagnostics.some((d) => d.severity === 'error')) process.exitCode = 1;
        break;
      }
      const html = directHtml(plan, script, {
        scriptName: basename(path),
        diagnostics: directDiagnostics(diagnostics, script, plan, dm.current),
        notes: dm.notes,
      });
      const outDir = join(resultsDir, 'direct');
      mkdirSync(outDir, { recursive: true });
      const page = join(outDir, `${outputName}.${script.meta.lang}.html`);
      writeFileSync(page, html);
      for (const n of plan.notes)
        console.error(`note: ${n.line !== undefined ? `line ${n.line}: ` : ''}${n.message}`);
      console.error(`direct: ${plan.noteCount} notes`);
      console.log(page);
      if (!values['no-open']) openPage(page);
      break;
    }
    case 'timeline': {
      const { values } = parseFor('timeline', rest);
      const fps = intFlag('fps', values.fps, 1);
      const rhythmOpts = rhythmOf(values.rhythm);
      const script = load(path);
      profileOf(script, values.output);
      const { timeline, issues, gaps } = buildTimeline(
        script,
        values.output,
        loadAudioManifest(path, script.meta.lang),
        fps,
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
      const { values } = parseFor('render', rest);
      const fps = intFlag('fps', values.fps, 1);
      const workers =
        values.workers === undefined ? undefined : intFlag('workers', values.workers, 1);
      // a frozen render synthesizes and hears nothing (final review 9)
      if (values['frozen-audio'] && (values.recheck || values['no-asr']))
        throw new UsageError(
          's2v render: --frozen-audio synthesizes nothing: --recheck and --no-asr do nothing with it',
        );
      const rhythmOpts = rhythmOf(values.rhythm);
      const idleFlag = onOff('idle', values.idle);
      if (values.watermark !== undefined && values.watermark !== 'proxy')
        throw new UsageError(`--watermark takes only proxy, not "${values.watermark}"`);
      const proxy = values.watermark === 'proxy';
      const sceneIds = parseScenesFlag(values.scenes);
      const outDir = checkOutDir(outDirOf(path, REPO_ROOT, values['out-dir']), path, REPO_ROOT);
      const { script: full, diagnostics: fullDiags } = loadWithDiagnostics(path);
      const log = (m: string) => console.error(m);
      const started = Date.now();
      const outputName = values.output;
      const profile = profileOf(full, outputName);
      // --scenes (S11): the output as if its frontmatter named these scenes; synthesis keeps the
      // whole script (the lock stays whole), everything after the audio takes the picked copy
      let script = full;
      let picked: string[] | undefined;
      if (sceneIds) {
        const r = pickScenes(full, outputName, sceneIds);
        if (!r.ok) throw new UsageError(r.message);
        script = r.script;
        picked = r.ids;
        const fresh = scenesLint(script, dirname(path), fullDiags);
        for (const d of fresh) log(`${formatDiagnostic(d, path)} (--scenes)`);
        if (fresh.some((d) => d.severity === 'error')) process.exit(1);
        for (const d of pickDrift(full, script, outputName))
          log(`warning: ${driftMessage(d, outputName)}`);
        if (spokenIn(script, outputName) === 0)
          log(
            `warning: --scenes: the picked scenes have no speech in "${outputName}" (a silent clip)`,
          );
        if (!values['frozen-audio']) {
          const n = full.scenes
            .flatMap((s) => s.blocks)
            .reduce((k, b) => k + (b.kind === 'paragraph' ? b.sentences.length : 0), 0);
          log(
            `warning: --scenes does not narrow synthesis: all ${n} sentences of the script are synthesized (use --frozen-audio after tts)`,
          );
        }
      }
      const draft = values.draft;
      const idle = idleFlag ?? script.meta.acting?.idle !== false;
      const lockDir = draft
        ? join(cacheDirOf(REPO_ROOT, 'draft-audio', path), script.meta.lang)
        : undefined;
      // the whole script, not the pick: the lock keeps every sentence (S11 plan 3.3; CI checks
      // that a frozen --scenes render leaves the lock's bytes as they were)
      const tts = await synthesizeScript(path, full, REPO_ROOT, {
        takesAll: TAKES_ALL,
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
        toAudioManifest(tts.manifest, tts.lockDir),
        fps,
        rhythmOpts,
      );
      for (const i of issues) log(`warning: ${i.sentenceId}: ${i.message}`);
      // maxDuration is the whole output's rule, not a clip's
      const long = picked
        ? null
        : renderedLengthWarning(
            outputName,
            timeline.totalFrames / timeline.fps,
            profile.maxDuration,
            estimatedOver.has(outputName),
          );
      if (long) log(`warning: ${long}`);
      // a scene pick has its own work folder: it may run beside the full render (S11)
      const workDir = renderWorkDir(REPO_ROOT, path, outputName, script.meta.lang, {
        draft,
        scenes: picked,
      });
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
        ...(workers ? { concurrency: workers } : {}),
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
      // a marked render or a scene pick is named apart: it never replaces the plain one (S13, S11)
      const out = `${renderBase(outDir, outputName, script.meta.lang, { draft, scenes: picked, proxy })}.mp4`;
      const logo = logoOf(script.meta);
      const corner = logo?.position ?? null;
      const mark = (width: number, height: number, subtitlesTop: boolean) => ({
        png: writeProxyPng(workDir, width),
        ...proxyPlacement(width, height, corner, subtitlesTop),
      });
      const [fw, fh] = FRAME_SIZE[profile.aspect as Aspect];
      const scale = draft ? 0.5 : 1;
      await concatAndMux(
        chunks.map((c) => c.path),
        mastered,
        out,
        workDir,
        proxy
          ? mark(
              Math.round(fw * scale),
              Math.round(fh * scale),
              subtitleStyleFor(script.meta, outputName)?.position === 'top',
            )
          : undefined,
      );
      const p = await probe(out);
      const ok = p.frames === timeline.totalFrames && Math.abs(p.videoSec - p.audioSec) < 0.05;
      log(
        `${ok ? 'ok' : 'CHECK FAILED'}: ${p.frames}/${timeline.totalFrames} frames, video ${p.videoSec.toFixed(3)}s, audio ${p.audioSec.toFixed(3)}s`,
      );
      log(`→ ${out} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      // a clip is no upload: subtitles only, no chapters, description or thumbnail (S11 plan 3.6)
      for (const f of picked
        ? writeSubtitleFiles(script, timeline, out.replace(/\.mp4$/, ''))
        : writePublishFiles(
            script,
            timeline,
            out.replace(/\.mp4$/, ''),
            draft,
            log,
            profile.aspect === '16:9',
          ))
        log(`→ ${f}`);
      if (picked) {
        // the thumbnail without the suffix is the full render's: leave it be
      } else if (profile.aspect === '16:9' && !draft)
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
              logo,
              assetsRoot: dirname(path),
              fontsDir: fonts,
              workDir,
            },
            out.replace(/\.mp4$/, '.thumbnail.png'),
            proxy ? mark(1280, 720, false) : undefined,
          )}`,
        );
      else if (!draft) dropThumbnail(out.replace(/\.mp4$/, '.thumbnail.png')); // not last run's (S2)
      if (!ok) process.exit(1);
      break;
    }
    default:
      usage();
  }
}

// S8 plan 3.3a: servers down and locks released, then a natural exit (process.exit would cut
// piped stdout at 64 KB); the code a command set in process.exitCode stays.
runMain(main, (e) => (e instanceof UsageError ? 2 : e instanceof ExitError ? e.exitCode : 1));
