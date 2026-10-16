/**
 * `s2v inspect <script> --json` (Studio plan S4a, docs/inspect-plan.md): what a script is made of
 * and one hash per kind of change, so a reviewer re-checks only what changed. Reads files and
 * `ffmpeg -version` only: nothing is synthesized or rendered, no server is started.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  ACTING_VERSION,
  actingTable,
  bgmOf,
  canonical,
  castsIn,
  closedWorldErrors,
  contentOf,
  gainFor,
  logoOf,
  outputScenes,
  paragraphActing,
  parseScript,
  presentationAttrs,
  schemaDefaults,
  sceneFramings,
  sentenceId,
  subtitleStyleFor,
  themeOf,
  withoutDefaults,
  type InspectError,
  type Script,
  type ScreenText,
} from '@script2video/core';
import {
  assignSides,
  COMPOSER_VERSION,
  defaultCastColor,
  loadCharacterSpec,
  rendererSourceHash,
} from '@script2video/renderer-remotion';
import { enrichCast } from './cast-faces.js';
import { mockEnabled } from './mock-tts.js';
import {
  ALIGN_VERSION,
  planSentences,
  POSTPROCESS_VERSION,
  RECORDING_VERSION,
  TTS_DECODING,
  TTS_WRAPPER,
  unappliedPicks,
  type LockManifest,
} from './tts.js';
import { readPicks } from './picks.js';

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hashOf = (value: unknown) => sha256(canonical(value));

export interface InspectFile {
  path: string;
  sha256: string | null;
  kind: string;
}

export interface InspectResult {
  s2v_version: string;
  hash_version: number;
  script: string;
  lang: string;
  hashes: {
    content: string;
    voice: string | null;
    audio: string | null;
    presentation_by_output: Record<string, string | null>;
    engine: Record<string, string>;
  };
  reasons: Record<string, string[]>;
  engine: Record<string, unknown>;
  outputs: {
    name: string;
    aspect: string;
    layout: string;
    thumbnail: boolean;
    chapters: boolean;
    scenes: string[];
    framing: Record<string, Record<string, string>>;
  }[];
  scenes: { id: string; title: string }[];
  screen_text: ScreenText[];
  voices: { cast: string; voice: string; engine: string; lang: string }[];
  characters: { cast: string; dir: string; source: string }[];
  faces: { output: string; cast: string; framing: string; face: string }[];
  files: InspectFile[];
}

/** Files a script refers to, hashed once; missing ones are remembered for the null reasons. */
class Files {
  private seen = new Map<string, InspectFile>();
  constructor(private scriptDir: string) {}
  /**
   * `<path>@<sha256>` of a file referenced from the script (relative to it), or `missing:<path>`.
   * The path is part of the value: pointing at another file with the same bytes is a change.
   */
  sha(path: string, kind: string): string {
    const abs = resolve(this.scriptDir, path);
    const rel = relative(this.scriptDir, abs).split('\\').join('/');
    const known = this.seen.get(rel);
    if (known) {
      if (!known.kind.split(',').includes(kind))
        known.kind = [...known.kind.split(','), kind].sort().join(',');
    } else
      this.seen.set(rel, {
        path: rel,
        sha256: existsSync(abs) && statSync(abs).isFile() ? sha256(readFileSync(abs)) : null,
        kind,
      });
    const f = this.seen.get(rel)!;
    return f.sha256 ? `${rel}@${f.sha256}` : `missing:${rel}`;
  }
  list(): InspectFile[] {
    return [...this.seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}

const missingIn = (value: unknown): string[] =>
  [...canonical(value).matchAll(/"missing:([^"]*)"/g)].map((m) => m[1]!);

/** Source files that decide what is drawn and when (plan 3.4 `renderer`). */
function rendererHash(repoRoot: string): string {
  const h = createHash('sha256').update(rendererSourceHash());
  const files = [
    join(repoRoot, 'packages', 'renderer-remotion', 'src', 'index.ts'),
    join(repoRoot, 'fonts.lock.json'),
    // CLI code that shapes the picture and the sound: mouths, cast, mix, sound effects, publishing
    ...['mouth.ts', 'cast.ts', 'cast-faces.ts', 'media.ts', 'soundtrack.ts', 'publish.ts'].map(
      (f) => join(repoRoot, 'packages', 'cli', 'src', f),
    ),
    ...readdirSync(join(repoRoot, 'packages', 'core', 'src'))
      .filter((f) => f.endsWith('.ts'))
      .sort()
      .map((f) => join(repoRoot, 'packages', 'core', 'src', f)),
  ];
  for (const f of files) h.update(relative(repoRoot, f)).update(readFileSync(f));
  return h.digest('hex');
}

function ffmpegVersion(): string | null {
  try {
    return execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' }).split('\n')[0]!.trim();
  } catch {
    return null;
  }
}

/** Parser warnings about content that is not rendered at all: errors for inspect. */
const DROPPED = new Set(['unsupported-block', 'heading-depth']);

/** Errors that make inspect refuse the script (closed world, plan 1). */
export function inspectErrors(source: string): { errors: InspectError[]; script: Script | null } {
  const parsed = parseScript(source);
  const errors: InspectError[] = parsed.diagnostics.items
    .filter((d) => d.severity === 'error' || DROPPED.has(d.code))
    .map((d) => ({ ...(d.line ? { line: d.line } : {}), message: `${d.code}: ${d.message}` }));
  if (!parsed.script || !parsed.trace) return { errors, script: null };
  // a line the parser already reported as a broken prefix is not reported twice
  const broken = new Set(
    parsed.diagnostics.items
      .filter((d) => d.code === 'prefix-broken' || d.code === 'prefix-directive')
      .map((d) => d.line),
  );
  errors.push(
    ...closedWorldErrors(source, parsed.trace, parsed.script).filter(
      (e) => !(e.line !== undefined && broken.has(e.line) && /would be read aloud/.test(e.message)),
    ),
  );
  return { errors, script: parsed.script };
}

export function inspectScript(
  scriptPath: string,
  repoRoot: string,
  hashVersion = 1,
  /** The path as given on the command line (the `script` field). */
  shownPath = scriptPath,
): { errors: InspectError[] } | { result: InspectResult } {
  if (hashVersion !== 1)
    throw new Error(`hash version ${hashVersion} is not supported (supported: 1)`);
  const source = readFileSync(scriptPath, 'utf8');
  const { errors, script } = inspectErrors(source);
  if (errors.length > 0 || !script) return { errors };
  const { meta } = script;
  const scriptDir = dirname(scriptPath);
  // the faces a character can draw decide which face an emotion line shows (as in render)
  enrichCast(script, scriptDir);
  const files = new Files(scriptDir);
  const reasons: Record<string, string[]> = {};

  // ---------- content ----------
  const content = contentOf(script);

  // ---------- voice and audio (the lock keys tts would use) ----------
  // The voice hash always describes the real voices (persona clips included); only the audio lock
  // keys follow S2V_TTS=mock, as tts does.
  const plan = planSentences(scriptPath, script, repoRoot, { draft: false, mock: false });
  const lockPlan = mockEnabled()
    ? planSentences(scriptPath, script, repoRoot, { draft: false, mock: true })
    : plan;
  const jobs = new Map(plan.jobs.map((j) => [j.id, j]));
  const recorded = new Map(
    plan.recorded.flatMap((r) =>
      r.items.map((it, index) => [it.id, { sha: r.sha, index, alignText: it.alignText }] as const),
    ),
  );
  for (const r of plan.recorded) files.sha(relative(scriptDir, r.src), 'recording');
  let voice: string | null = null;
  let audio: string | null = null;
  if (plan.errors.length > 0) {
    reasons.voice = plan.errors.map((e) => e.message);
    reasons.audio = reasons.voice;
  } else {
    const sentences: unknown[] = [];
    for (const scene of script.scenes)
      for (const [bi, block] of scene.blocks.entries()) {
        if (block.kind !== 'paragraph') continue;
        for (const [si, sentence] of block.sentences.entries()) {
          const id = sentenceId(scene.id, bi, si);
          const rec = recorded.get(id);
          // the mix level of the line (volume, power): heard, but not part of the synthesis
          const gain = gainFor(meta, block, sentence) || undefined;
          if (rec) {
            sentences.push({
              cast: block.cast,
              recording: rec.sha,
              index: rec.index,
              text: rec.alignText,
              gain,
            });
            continue;
          }
          const j = jobs.get(id)!;
          sentences.push({
            cast: block.cast,
            voice: j.member.voice,
            // cast × line × emotion speed (the cast speed when the line sets none)
            speed: j.speedProduct,
            // the instruction actually sent: cast style, emotion template, say
            style: j.synthFields.instruct || undefined,
            templates: j.template ? ACTING_VERSION : undefined,
            // power of an emotion line picks a take (stage 3 plan 1)
            power: j.power,
            gain,
            text: j.ttsText,
            seed: meta.seed,
            maxPause: meta.pacing.maxPause,
            ref: (j.synthFields as { ref?: string }).ref,
            refText: (j.synthFields as { refText?: string }).refText,
          });
        }
      }
    voice = hashOf({ lang: meta.lang, sentences });
    for (const j of plan.jobs)
      if (j.target.ref) files.sha(relative(scriptDir, j.target.ref.wavPath), 'voice');
    // audio: (lock key, wav sha) of every sentence, from the committed lock
    const lockDir = join(scriptDir, 'audio', meta.lang);
    const manifestPath = join(lockDir, 'manifest.json');
    const lock = existsSync(manifestPath)
      ? (JSON.parse(readFileSync(manifestPath, 'utf8')) as LockManifest)
      : null;
    const pairs = new Map<string, string>();
    const missing: string[] = [];
    for (const [id, key] of Object.entries(lockPlan.sentences)) {
      const e = lock?.entries[key];
      const wav = e ? join(lockDir, e.src) : null;
      if (!e || !wav || !existsSync(wav)) missing.push(id);
      // the timeline reads the word timings and duration from the entry, not only the wav
      else
        pairs.set(
          key,
          hashOf({ wav: sha256(readFileSync(wav)), duration: e.duration, words: e.words }),
        );
    }
    // a pick not in the lock yet changes the audio on the next tts (stage 3b plan 8)
    let unapplied: string[] = [];
    try {
      unapplied = unappliedPicks(lockPlan.jobs, lock, readPicks(lockDir)).map((u) => u.id);
    } catch (e) {
      reasons.audio = [(e as Error).message];
    }
    if (missing.length > 0)
      reasons.audio = [
        `${missing.length} sentence(s) not synthesized: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`,
      ];
    else if (unapplied.length > 0)
      reasons.audio = [
        `${unapplied.length} picked take(s) not applied — run s2v tts: ${unapplied.slice(0, 5).join(', ')}${unapplied.length > 5 ? ', …' : ''}`,
      ];
    else if (!reasons.audio)
      audio = hashOf([...pairs.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
  }

  // ---------- engine ----------
  const revisions = (
    JSON.parse(readFileSync(join(repoRoot, 'models.lock.json'), 'utf8')) as {
      models: Record<string, { revision: string }>;
    }
  ).models;
  const defaults = schemaDefaults();
  const engine: Record<string, unknown> = {
    tts: {
      postprocess: POSTPROCESS_VERSION,
      align: ALIGN_VERSION,
      recording: RECORDING_VERSION,
      decoding: TTS_DECODING,
      wrapper: TTS_WRAPPER,
      models: Object.fromEntries(
        Object.entries(revisions)
          .filter(([k]) => k.startsWith('qwen3-tts-') || k === 'supertonic-3')
          .map(([k, v]) => [k, v.revision]),
      ),
    },
    composer: COMPOSER_VERSION,
    renderer: rendererHash(repoRoot),
    ffmpeg: ffmpegVersion(),
    defaults_voice: defaults.voice,
    defaults_presentation: defaults.presentation,
    templates: actingTable(),
  };

  // ---------- presentation (per output) ----------
  const d = defaults.presentation as Record<string, Record<string, unknown>>;
  const theme = themeOf(meta);
  const logo = logoOf(meta);
  const bgm = bgmOf(meta);
  const common = {
    theme: canonical(theme) === canonical({ base: 'light' }) ? undefined : theme,
    sfx: meta.sfx === 'off' ? undefined : meta.sfx,
    pacing: withoutDefaults({ ...meta.pacing, maxPause: undefined }, d.pacing!),
    logo: logo && {
      ...withoutDefaults({ ...logo, src: undefined }, d.logo!),
      src: files.sha(logo.src, 'logo'),
    },
    bgm: bgm && {
      ...withoutDefaults({ ...bgm, src: undefined, credit: undefined }, d.bgm!),
      src: files.sha(bgm.src, 'bgm'),
    },
  };
  const thumb = script.scenes
    .flatMap((s) => s.blocks)
    .find((b) => b.kind === 'visual' && b.type === 'thumbnail');
  const thumbSha =
    thumb && thumb.kind === 'visual' && thumb.attrs.src
      ? files.sha(thumb.attrs.src, 'thumbnail')
      : undefined;
  const castOrder = Object.entries(meta.cast);
  const presentation: Record<string, string | null> = {};
  const outputs: InspectResult['outputs'] = [];
  const faces: InspectResult['faces'] = [];
  for (const [name, profile] of Object.entries(meta.outputs)) {
    const scenes = outputScenes(script, name);
    const framings = sceneFramings(meta, scenes, profile);
    const speaking = castsIn(scenes);
    const cast = castOrder
      .map(([key, m], i) => ({ key, m, i }))
      .filter(({ key }) => speaking.has(key))
      .map(({ key, m, i }) => ({
        key,
        color: m.color ?? defaultCastColor(i),
        face: m.face,
        motion: m.motion,
        ...(m.avatar ? { avatar: files.sha(m.avatar, 'image') } : {}),
        ...(m.side ? { side: m.side } : {}),
      }));
    const { left } = assignSides(cast);
    const castResolved = cast.map((c) => ({ ...c, side: left.includes(c) ? 'left' : 'right' }));
    const style = subtitleStyleFor(meta, name);
    const { scenes: _s, maxDuration: _m, subtitleStyle: _st, transition: _t, ...look } = profile;
    // what the renderer applies: the output's transition over the script's, and the layout's
    // default subtitle mode (word for shorts)
    const transition = profile.transition ?? meta.transition;
    if (look.subtitles === (look.layout === 'shorts' ? 'word' : 'sentence')) delete look.subtitles;
    const value = {
      common,
      output: withoutDefaults(look, d.output!),
      transition: transition === 'none' ? undefined : transition,
      subtitleStyle: { ...style, font: style.font ? files.sha(style.font, 'font') : undefined },
      cast: castResolved,
      thumbnail: profile.aspect === '16:9' ? thumbSha : undefined,
      scenes: scenes.map((scene, i) => ({
        id: scene.id,
        framing: framings[i],
        blocks: scene.blocks.flatMap((b): unknown[] => {
          if (b.kind === 'visual') {
            if (b.type === 'thumbnail') return [];
            const assetKind = b.type === 'video' ? 'video' : 'image';
            return [
              {
                v: b.type,
                attrs: presentationAttrs(b.type as never, b.attrs, (p) => files.sha(p, assetKind)),
                images: b.images?.map((im) => files.sha(im.src, 'image')),
              },
            ];
          }
          // emotion faces and motions, only where a line has an emotion and the cast is drawn
          const drawn =
            meta.cast[b.cast]?.character && b.sentences.some((s) => s.acting?.emo !== undefined)
              ? paragraphActing(meta, b, framings[i]![b.cast] ?? 'full')
              : undefined;
          return [
            {
              p: b.cast,
              gap: b.gap,
              face: b.face,
              motion: b.motion,
              faces: drawn?.faces.map((f) => f.drawn),
              runs: drawn?.runs,
              sentences: b.sentences.map((s) => ({
                pause: s.pauseAfter,
                cues: s.cues.map((c) => ({
                  start: c.start,
                  end: c.end,
                  attrs: presentationAttrs('cue', c.attrs, (p) => files.sha(p, 'image')),
                })),
                reacts: s.reacts,
              })),
            },
          ];
        }),
      })),
    };
    const why: string[] = [];
    const withArt = cast.filter((c) => meta.cast[c.key]!.character).map((c) => c.key);
    if (withArt.length > 0)
      why.push(`character art is hashed from S4b (cast ${withArt.join(', ')})`);
    const gone = missingIn(value);
    if (gone.length > 0) why.push(`missing file(s): ${[...new Set(gone)].join(', ')}`);
    presentation[name] = why.length ? null : hashOf(value);
    if (why.length) reasons[`presentation.${name}`] = why;
    outputs.push({
      name,
      aspect: profile.aspect,
      layout: profile.layout,
      thumbnail: profile.aspect === '16:9',
      chapters: profile.aspect === '16:9',
      scenes: scenes.map((s) => s.id),
      framing: Object.fromEntries(scenes.map((s, i) => [s.id, framings[i]!])),
    });
    // faces each cast shows per framing (default face, its lines, its reactions)
    const seen = new Set<string>();
    scenes.forEach((scene, i) => {
      const add = (c: string, face: string) => {
        const framing = framings[i]![c] ?? 'full';
        const k = `${c}\u0000${framing}\u0000${face}`;
        if (seen.has(k)) return;
        seen.add(k);
        faces.push({ output: name, cast: c, framing, face });
      };
      for (const c of cast) add(c.key, meta.cast[c.key]!.face);
      for (const b of scene.blocks)
        if (b.kind === 'paragraph') {
          const framing = framings[i]![b.cast] ?? 'full';
          for (const f of paragraphActing(meta, b, framing).faces) add(b.cast, f.drawn);
          for (const s of b.sentences)
            for (const r of s.reacts ?? []) for (const [c, f] of Object.entries(r.faces)) add(c, f);
        }
    });
  }

  // ---------- the rest ----------
  const characters = Object.entries(meta.cast).flatMap(([key, m]) => {
    if (!m.character) return [];
    const dir = typeof m.character === 'string' ? m.character : m.character.dir;
    const abs = resolve(scriptDir, dir);
    let source = 'missing';
    if (existsSync(abs)) {
      if (!existsSync(join(abs, 'character.yaml'))) source = 'classic';
      else
        try {
          source = loadCharacterSpec(abs).source;
        } catch {
          source = 'invalid';
        }
    }
    return [{ cast: key, dir, source }];
  });
  const voices = Object.entries(meta.cast).map(([key, m]) => ({
    cast: key,
    voice: m.voice,
    engine: m.voice.split(':')[0]!,
    lang: meta.lang,
  }));
  const version = (
    JSON.parse(readFileSync(join(repoRoot, 'packages', 'cli', 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const engineHashes = Object.fromEntries(
    Object.entries(engine).map(([k, v]) => [k, hashOf({ v })]),
  );
  return {
    result: {
      s2v_version: version,
      hash_version: 1,
      script: shownPath,
      lang: meta.lang,
      hashes: {
        content: hashOf(content.value),
        voice,
        audio,
        presentation_by_output: presentation,
        engine: engineHashes,
      },
      reasons,
      engine,
      outputs,
      scenes: script.scenes.map((s) => ({ id: s.id, title: s.title })),
      screen_text: content.screenText,
      voices,
      characters,
      faces,
      files: files.list(),
    },
  };
}
