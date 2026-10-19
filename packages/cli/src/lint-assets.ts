/**
 * File-based lint checks that the pure parser cannot do (PLAN 5.12): missing assets and
 * screenshots that will look soft because they are enlarged too much on screen.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import {
  bgmOf,
  castsIn,
  logoOf,
  MOTIONS,
  outputScenes,
  sceneFramings,
  listenerLookFaces,
  paragraphActing,
  sentenceFace,
  type Diagnostic,
  type Framing,
  type Lang,
  type Script,
} from '@script2video/core';
import {
  CHARACTER_YAML,
  characterFaces,
  characterSource,
  isSingle,
  imageSize,
  loadCharacterSpec,
  MAX_AVATARS,
  VIDEO_EXT,
  type CharacterSpec,
} from '@script2video/renderer-remotion';
import { importedFaceFiles, importedFaceProblems, partsFaceProblems } from './cast-faces.js';
import { isTrainedProblem, resolvePersona, resolveTrained, type PersonaRef } from './persona.js';
import { loadGraph } from './character-gen/commands.js';
import { PROVENANCE, status } from './character-gen/state.js';

const FRAME: Record<string, [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
};
/** Screen pixels per source pixel above which text in a screenshot visibly softens. */
const MAX_UPSCALE = 1.33;

export function lintAssets(script: Script, scriptDir: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  // Highest zoom used on each image (cues apply to the most recent visual).
  const maxZoom = new Map<string, { zoom: number; line: number }>();
  for (const scene of script.scenes) {
    let current: string | null = null;
    for (const block of scene.blocks) {
      if (block.kind === 'visual') {
        current = block.type === 'image' ? (block.attrs.src ?? null) : null;
        if (current && !maxZoom.has(current)) maxZoom.set(current, { zoom: 1, line: block.line });
        continue;
      }
      if (!current) continue;
      for (const s of block.sentences)
        for (const c of s.cues) {
          // `show=` switches to another image from this cue on; later zooms apply to it.
          if (c.attrs.show) {
            current = c.attrs.show;
            if (!maxZoom.has(current)) maxZoom.set(current, { zoom: 1, line: block.line });
          }
          const z = Number(c.attrs.zoom ?? 1);
          const prev = maxZoom.get(current)!;
          if (Number.isFinite(z) && z > prev.zoom)
            maxZoom.set(current, { zoom: z, line: block.line });
        }
    }
  }
  // Gallery images, video clips and narration recordings: present on disk.
  for (const scene of script.scenes)
    for (const b of scene.blocks) {
      if (b.kind === 'paragraph' && b.audio && !existsSync(resolve(scriptDir, b.audio)))
        out.push({
          severity: 'error',
          code: 'asset-missing',
          message: `recording not found: ${b.audio}`,
          line: b.line,
        });
      if (b.kind !== 'visual') continue;
      const files =
        b.type === 'gallery' || b.type === 'split'
          ? (b.images ?? []).map((i) => i.src)
          : b.type === 'video' && b.attrs.src
            ? [b.attrs.src]
            : [];
      for (const f of files)
        if (!existsSync(resolve(scriptDir, f)))
          out.push({
            severity: 'error',
            code: 'asset-missing',
            message: `${b.type} file not found: ${f}`,
            line: b.line,
          });
    }
  for (const [src, { zoom, line }] of maxZoom) {
    const abs = resolve(scriptDir, src);
    if (!existsSync(abs)) {
      out.push({
        severity: 'error',
        code: 'asset-missing',
        message: `image not found: ${src}`,
        line,
      });
      continue;
    }
    // a picture that is not PNG or JPEG: lintImageFormats says so
    const size = sizeOf(abs);
    if (!size) continue;
    const [iw, ih] = size;
    for (const [name, profile] of Object.entries(script.meta.outputs)) {
      const [fw, fh] = FRAME[profile.aspect]!;
      const fitted = Math.min(fw, fh * (iw / ih)); // on-screen width at zoom 1 ("contain")
      const upscale = (fitted * zoom) / iw;
      if (upscale > MAX_UPSCALE) {
        out.push({
          severity: 'warning',
          code: 'image-resolution',
          message: `${src} is ${iw}×${ih}; at zoom ${zoom} in "${name}" (${profile.aspect}) it is enlarged ${upscale.toFixed(1)}× and may look soft (use ≥ ${Math.ceil((fitted * zoom) / MAX_UPSCALE)} px wide or lower the zoom)`,
          line,
        });
      }
    }
  }
  return out;
}

/** Background music (file, credit line) and logo files. */
export function lintBgm(script: Script, scriptDir: string): Diagnostic[] {
  const bgm = bgmOf(script.meta);
  const out: Diagnostic[] = [];
  const logo = logoOf(script.meta);
  if (logo && !existsSync(resolve(scriptDir, logo.src)))
    out.push({ severity: 'error', code: 'asset-missing', message: `logo not found: ${logo.src}` });
  if (!bgm) return out;
  if (!existsSync(resolve(scriptDir, bgm.src)))
    out.push({ severity: 'error', code: 'asset-missing', message: `bgm not found: ${bgm.src}` });
  if (!bgm.credit)
    out.push({
      severity: 'warning',
      code: 'bgm-credit',
      message: 'bgm has no credit: add title / artist / license (bgm.credit) for the description',
    });
  return out;
}

/** Subtitle font files named by subtitleStyle (script-wide and per output). */
export function lintSubtitleFonts(script: Script, scriptDir: string): Diagnostic[] {
  const fonts = new Set(
    [
      script.meta.subtitleStyle?.font,
      ...Object.values(script.meta.outputs).map((o) => o.subtitleStyle?.font),
    ].filter((f): f is string => !!f),
  );
  const out: Diagnostic[] = [];
  for (const f of fonts) {
    if (!/\.(ttf|otf|woff2?)$/i.test(f))
      out.push({
        severity: 'error',
        code: 'subtitle-font',
        message: `subtitle font must be .ttf, .otf or .woff2: ${f}`,
      });
    else if (!existsSync(resolve(scriptDir, f)))
      out.push({
        severity: 'error',
        code: 'asset-missing',
        message: `subtitle font not found: ${f}`,
      });
  }
  return out;
}

/** Structure summary used to compare a translation with its original (PLAN 4.3). */
function structure(script: Script) {
  return script.scenes.map((s) => ({
    id: s.id,
    visuals: s.blocks
      .filter((b) => b.kind === 'visual')
      .map((b) => (b.kind === 'visual' ? b.type : '')),
    cues: s.blocks.reduce(
      (n, b) =>
        n + (b.kind === 'paragraph' ? b.sentences.reduce((m, x) => m + x.cues.length, 0) : 0),
      0,
    ),
  }));
}

/** Compare a translated script with the script named in `translationOf`. */
export function lintTranslation(
  script: Script,
  original: Script,
  originalName: string,
): Diagnostic[] {
  if (script.meta.allowDrift) return [];
  const a = structure(original);
  const b = structure(script);
  const out: Diagnostic[] = [];
  const warn = (message: string) =>
    out.push({ severity: 'warning', code: 'translation-drift', message });
  const ids = (x: typeof a) => x.map((s) => s.id).join(', ');
  if (ids(a) !== ids(b)) {
    warn(`scene ids differ from ${originalName}: [${ids(b)}] vs [${ids(a)}]`);
    return out;
  }
  a.forEach((sa, i) => {
    const sb = b[i]!;
    if (sa.visuals.join(',') !== sb.visuals.join(','))
      warn(`scene "${sa.id}": visuals [${sb.visuals}] differ from ${originalName} [${sa.visuals}]`);
    if (sa.cues !== sb.cues)
      warn(`scene "${sa.id}": ${sb.cues} cues vs ${sa.cues} in ${originalName}`);
  });
  return out;
}

/** Cast checks for multi-speaker videos (PLAN 5.8). */
export function lintCast(script: Script, scriptDir: string): Diagnostic[] {
  const { meta } = script;
  const out: Diagnostic[] = [];
  // Speakers, plus listeners who only react: both appear on screen.
  const speaking = new Set(
    script.scenes.flatMap((s) =>
      s.blocks.flatMap((b) =>
        b.kind === 'paragraph'
          ? [
              b.cast,
              ...b.sentences.flatMap((x) => (x.reacts ?? []).flatMap((r) => Object.keys(r.faces))),
            ]
          : [],
      ),
    ),
  );
  for (const [key, m] of Object.entries(meta.cast)) {
    if (m.avatar && !existsSync(resolve(scriptDir, m.avatar)))
      out.push({
        severity: 'error',
        code: 'asset-missing',
        message: `cast.${key}.avatar not found: ${m.avatar}`,
      });
    if (m.voice.startsWith('persona:') && speaking.has(key)) {
      const id = m.voice.slice('persona:'.length);
      const ref = resolvePersona(id, meta.lang, scriptDir);
      if (m.personaModel === 'trained')
        out.push(...lintTrained(key, id, meta.lang, scriptDir, ref));
      // Not an error: draft renders use draftVoice / Supertonic and need no reference clip.
      else if (typeof ref === 'string')
        out.push({ severity: 'warning', code: 'persona', message: ref });
    }
  }
  for (const key of speaking) {
    const m = meta.cast[key]!;
    if (!m.character) continue;
    const rel = typeof m.character === 'string' ? m.character : m.character.dir;
    const dir = resolve(scriptDir, rel);
    const err = (message: string) => out.push({ severity: 'error', code: 'character', message });
    const warn = (message: string) => out.push({ severity: 'warning', code: 'character', message });
    if (!existsSync(dir)) {
      err(`cast.${key}.character folder not found: ${rel}`);
      continue;
    }
    if (characterSource(dir) === 'parts') {
      out.push(...lintPartsCharacter(script, key, rel, dir));
      continue;
    }
    const faces = characterFaces(dir);
    const used = new Set([m.face]);
    for (const scene of script.scenes)
      for (const b of scene.blocks)
        if (b.kind === 'paragraph') {
          for (const s of b.sentences) {
            if (b.cast === key) used.add(sentenceFace(meta, b, s, 'full').drawn);
            for (const r of s.reacts ?? []) if (r.faces[key]) used.add(r.faces[key]);
          }
        }
    for (const face of used)
      if (!faces[face]?.base) err(`cast.${key}: ${rel}/${face}.png is missing (face "${face}")`);
    // a look variant the speaker talks with (acting stage 5b): without talk art the mouth stops
    const looks = new Set<string>();
    for (const scene of script.scenes)
      for (const b of scene.blocks)
        if (b.kind === 'paragraph' && b.cast === key)
          for (const f of paragraphActing(meta, b, 'full').faces)
            if (f.shown !== f.drawn) looks.add(f.shown);
    for (const face of looks)
      if (faces[face]?.base && !faces[face].talk && !faces[face].half)
        warn(
          `cast.${key}: ${rel}/${face}-talk.png is missing: the mouth does not move while it speaks with "${face}" (:look)`,
        );
    if (!Object.values(faces).some((f) => f.talk || f.half))
      warn(`cast.${key}: no <face>-talk.png in ${rel}, so the mouth will not move`);
    // Every image must share one canvas, or the character jumps when images swap.
    const sizes = new Set<string>();
    for (const files of Object.values(faces))
      for (const f of Object.values(files)) {
        const size = sizeOf(join(dir, f));
        if (size) sizes.add(size.join('×'));
        else formatError(out, `character ${rel}: ${f} must be a PNG or JPEG image`);
      }
    if (sizes.size > 1)
      warn(
        `cast.${key}: images in ${rel} have different sizes (${[...sizes].join(', ')}); use one canvas`,
      );
  }
  const machine = [...speaking].filter((k) => meta.cast[k]!.voice.startsWith('supertonic:'));
  if (machine.length > 0)
    out.push({
      severity: 'warning',
      code: 'machine-generated',
      message: `${machine.join(', ')} use${machine.length === 1 ? 's' : ''} a Supertonic voice: its license (OpenRAIL-M) requires telling viewers the voice is machine-generated. The description draft written by render includes the notice; keep it when publishing`,
    });
  const byVoice = new Map<string, string[]>();
  for (const key of speaking) {
    const m = meta.cast[key]!;
    const id = `${m.voice}|${m.style ?? ''}`;
    byVoice.set(id, [...(byVoice.get(id) ?? []), key]);
  }
  for (const [id, keys] of byVoice)
    if (keys.length > 1)
      out.push({
        severity: 'warning',
        code: 'same-voice',
        message: `${keys.join(', ')} share the voice ${id.split('|')[0]}: listeners cannot tell them apart`,
      });
  for (const [name, profile] of Object.entries(meta.outputs)) {
    if (profile.layout !== 'dialogue') continue;
    const n = new Set(
      script.scenes
        .filter((s) => !profile.scenes || profile.scenes.includes(s.id))
        .flatMap((s) =>
          s.blocks.flatMap((b) =>
            b.kind === 'paragraph' && (!b.only || b.only.includes(name)) ? [b.cast] : [],
          ),
        ),
    ).size;
    if (n < 2)
      out.push({
        severity: 'warning',
        code: 'dialogue-cast',
        message: `"${name}" uses the dialogue layout with ${n} speaker; use presenter instead`,
      });
    else if (n > MAX_AVATARS)
      out.push({
        severity: 'warning',
        code: 'dialogue-cast',
        message: `"${name}" has ${n} speakers: avatars are hidden above ${MAX_AVATARS}, only name tags tell them apart`,
      });
  }
  return out;
}

/** README / terms files that come with downloaded material. */
const TERMS_FILE = /^(readme|terms|license|licence|利用規約|規約)/i;

/** Small, best-effort list of well-known character IPs that must not be imitated (plan C20). */
const IP_NAMES = [
  'line friends',
  'kakao friends',
  'pikachu',
  'pokemon',
  'hello kitty',
  'sanrio',
  'doraemon',
  'mickey mouse',
  'snoopy',
  'rilakkuma',
];

/**
 * Faces a cast member shows, per framing, over every output (both sides are checked).
 * `wanted`: the faces lines ask for before an emotion face falls back to the default one
 * (`character missing` lists those to make).
 */
export function usedFaces(
  script: Script,
  key: string,
  which: 'drawn' | 'wanted' = 'drawn',
): Map<Framing, Set<string>> {
  const used = new Map<Framing, Set<string>>();
  for (const name of Object.keys(script.meta.outputs))
    for (const [framing, faces] of outputUsedFaces(script, name, key, which)) {
      const set = used.get(framing) ?? used.set(framing, new Set()).get(framing)!;
      for (const f of faces) set.add(f);
    }
  return used;
}

/**
 * The faces of one output (S4b plan 4.1; `inspect` hashes these): per scene framing the cast's
 * default face first, then its lines' shown faces, the reaction faces as written and the faces
 * listener looks may turn them into. Timing does not matter here, so this holds every face the
 * renderer's timeline can ask for in this output.
 */
export function outputUsedFaces(
  script: Script,
  name: string,
  key: string,
  which: 'drawn' | 'wanted' = 'drawn',
): Map<Framing, Set<string>> {
  const used = new Map<Framing, Set<string>>();
  const add = (f: Framing, face: string) =>
    (used.get(f) ?? used.set(f, new Set()).get(f)!).add(face);
  const member = script.meta.cast[key]!;
  const profile = script.meta.outputs[name]!;
  const scenes = script.scenes.filter((s) => !profile.scenes || profile.scenes.includes(s.id));
  const framings = sceneFramings(script.meta, scenes, profile);
  scenes.forEach((scene, i) => {
    const framing = framings[i]![key] ?? 'full';
    add(framing, member.face);
    for (const b of scene.blocks)
      if (b.kind === 'paragraph' && (!b.only || b.only.includes(name))) {
        if (b.cast === key)
          for (const f of paragraphActing(script.meta, b, framing).faces)
            add(framing, which === 'drawn' ? f.shown : f.wantedShown);
        for (const s of b.sentences)
          for (const r of s.reacts ?? []) if (r.faces[key]) add(framing, r.faces[key]);
        for (const l of listenerLookFaces(script.meta, b, (c) => framings[i]![c] ?? 'full'))
          if (l.cast === key) add(framing, which === 'drawn' ? l.face : l.wanted);
      }
  });
  return used;
}

/** Parts characters (character.yaml): schema, faces per framing and side, files, names (plan 6). */
export function lintPartsCharacter(
  script: Script,
  key: string,
  rel: string,
  dir: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const err = (message: string) =>
    out.push({ severity: 'error', code: 'character', message: `cast.${key}: ${message}` });
  const warn = (message: string) =>
    out.push({ severity: 'warning', code: 'character', message: `cast.${key}: ${message}` });
  let spec: CharacterSpec;
  try {
    spec = loadCharacterSpec(dir);
  } catch (e) {
    err((e as Error).message);
    return out;
  }
  const m = script.meta.cast[key]!;
  if (typeof m.character === 'object' && m.character.facing !== 'front')
    warn(`character.facing is ignored for ${CHARACTER_YAML} characters (set facing in the yaml)`);
  if (!spec.license) warn(`${rel}/${CHARACTER_YAML} has no license`);
  const used = usedFaces(script, key);
  const badFiles = new Set<string>(); // a file shared by faces, framings, sides: reported once
  if (spec.source === 'imported') {
    if (!readdirSync(dir).some((f) => TERMS_FILE.test(f.normalize('NFC'))))
      warn(`${rel} has no README / terms file: check the material's terms of use`);
    for (const [framing, faces] of used) {
      if (framing !== 'full')
        err(`imported characters have only the full framing (::shot ${framing})`);
      for (const f of faces) {
        const problems = importedFaceProblems(dir, spec, f);
        if (problems === null) {
          err(`face "${f}" is not defined in ${rel}/${CHARACTER_YAML}`);
          continue;
        }
        for (const p of problems) err(p);
        // the renderer reads PNG and JPEG only (S12); a neutral part is in every face: once
        for (const [, file] of importedFaceFiles(dir, spec, f))
          if (existsSync(file) && !badFiles.has(file) && !sizeOf(file)) {
            badFiles.add(file);
            formatError(
              out,
              `character ${rel}: ${relative(dir, file)} must be a PNG or JPEG image`,
            );
          }
      }
    }
    return out;
  }
  // Faces this cast member speaks with need mouth frames (others may be listening faces).
  const speaking = new Set<string>();
  for (const scene of script.scenes)
    for (const b of scene.blocks)
      if (b.kind === 'paragraph' && b.cast === key)
        for (const f of ['full', 'upper', 'head'] as const)
          for (const x of paragraphActing(script.meta, b, f).faces) speaking.add(x.shown);
  for (const name of Object.keys(spec.faces))
    if (/-(talk|half|blink)$/.test(name))
      err(`face name "${name}" must not end in -talk, -half or -blink`);
  for (const [name, e] of Object.entries(spec.expressions))
    if (e.gaze && spec.eyes === 'dot')
      err(`expression "${name}" has gaze, but eyes: dot cannot show where they look`);
  const motions = [...MOTIONS, 'none'] as readonly string[];
  for (const [name, f] of Object.entries(spec.faces))
    if (f.motion && !motions.includes(f.motion))
      err(`face "${name}" motion "${f.motion}" is not one of ${MOTIONS.join(', ')}`);
  for (const [name, e] of Object.entries(spec.expressions))
    if (e.motion && !motions.includes(e.motion))
      err(`expression "${name}" motion "${e.motion}" is not one of ${MOTIONS.join(', ')}`);
  for (const f of ['upper', 'head'] as const) {
    const s = spec.sets[f];
    if (s && Object.keys(s.views).length > 1) err(`the ${f} set must have only the front view`);
  }
  // Bodies (motions) and head offsets need a split view (body + head layers); turned views are
  // one-image (plan Q4). Gaze needs a front-facing head.
  const scopes = [
    { where: '', views: spec.views, bodies: spec.bodies, groups: spec.groups },
    ...(['upper', 'head'] as const).flatMap((f) =>
      spec.sets[f] ? [{ where: `sets.${f}.`, ...spec.sets[f]! }] : [],
    ),
  ];
  for (const sc of scopes) {
    const single = (view: string) => {
      const v = sc.views[view];
      return v ? isSingle(v) : false;
    };
    for (const key2 of Object.keys(sc.bodies)) {
      const view = key2.split('/')[0]!;
      if (single(view))
        err(
          `${sc.where}bodies.${key2} is on the one-image view "${view}"; bodies need a split front view (layers: split)`,
        );
    }
    for (const [key2, g] of Object.entries(sc.groups)) {
      const view = key2.split('/')[0]!;
      if (single(view) && g.offset && (g.offset[0] !== 0 || g.offset[1] !== 0))
        err(`${sc.where}groups.${key2}: offsets do not apply to the one-image view "${view}"`);
    }
  }
  for (const [name, f] of Object.entries(spec.faces)) {
    if (!spec.expressions[f.expression]?.gaze) continue;
    const vf = spec.views[f.view]?.facing ?? 'front';
    const hf = f.head ? (spec.heads[`${f.view}/${f.head}`]?.facing ?? vf) : vf;
    if (vf !== 'front' || hf !== 'front')
      err(`face "${name}" uses gaze on a turned view or head; gaze needs a front-facing head`);
  }
  const text = [
    spec.kind ?? '',
    ...Object.values(spec.expressions).map((e) => e.prompt ?? ''),
    ...Object.values(spec.bodies).map((b) => b.prompt ?? ''),
  ]
    .join(' ')
    .toLowerCase();
  for (const ip of IP_NAMES)
    if (text.includes(ip))
      warn(
        `"${ip}" appears in the character description: describe an original design instead (best-effort check)`,
      );
  // The head close-up flips its turned head with the whole picture on one side (no body): say
  // it once, not per face (closeup-look plan).
  const hs = spec.sets.head;
  if (
    spec.mirror &&
    used.has('head') &&
    hs &&
    Object.entries(hs.heads).some(
      ([k, h]) => !k.endsWith('@flip') && (h.facing ?? 'front') !== 'front',
    )
  )
    out.push({
      severity: 'info',
      code: 'character',
      message: `cast.${key}: the head close-up mirrors its turned head on one side: asymmetric details (a hair clip) switch sides there`,
    });
  // Every used face must resolve in its framing on both sides (sides can differ per output).
  const sizes = new Map<Framing, Set<string>>();
  for (const [framing, faces] of used)
    for (const face of faces) {
      if (!spec.faces[face]) {
        err(`face "${face}" is not defined in ${rel}/${CHARACTER_YAML}`);
        continue;
      }
      const { problems, files, optional } = partsFaceProblems(
        dir,
        spec,
        framing,
        face,
        speaking.has(face),
      );
      // Every image must share the canvas, or parts land in the wrong place.
      for (const f of [...optional, ...files]) {
        const size = sizeOf(f);
        if (size)
          (sizes.get(framing) ?? sizes.set(framing, new Set()).get(framing)!).add(size.join('×'));
        else if (!badFiles.has(f)) {
          badFiles.add(f);
          formatError(out, `character ${rel}: ${relative(dir, f)} must be a PNG or JPEG image`);
        }
      }
      // Report a problem once; name the side only when it happens on one side.
      for (const [msg, sides] of problems) {
        if (sides[0] === 'warn') warn(msg);
        else err(sides.length === 1 ? `${msg.slice(0, -1)}, ${sides[0]} side)` : msg);
      }
    }
  const full = sizes.get('full');
  if (spec.size && full && !full.has(spec.size.join('×')))
    err(
      `size: ${spec.size.join('×')} does not match the full set's images (${[...full].join(', ')})`,
    );
  for (const [framing, set] of sizes)
    if (set.size > 1)
      err(
        `images of the ${framing} set have different sizes (${[...set].join(', ')}); use one canvas`,
      );
  if (spec.source === 'generated' && existsSync(join(dir, PROVENANCE))) {
    // Plan 6: images still to generate or approve (the renderer only sees approved ones).
    try {
      const g = loadGraph(dir);
      const open = [...g.items.keys()].filter((id) => status(g, id) !== 'approved');
      if (open.length)
        warn(
          `${rel}: ${open.length} generated images are not approved yet (s2v character build / review ${rel})`,
        );
    } catch (e) {
      warn(`${rel}: generation state unreadable: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * A trained persona speaker (acting stage 4): the file must be there and intact; trained from
 * another reference clip or model revision, it still plays but should be trained again.
 */
function lintTrained(
  key: string,
  id: string,
  lang: Lang,
  scriptDir: string,
  ref: PersonaRef | string,
): Diagnostic[] {
  const t = resolveTrained(id, lang, scriptDir);
  // not trained yet: a warning (drafts and mock runs need no speaker; tts stops on it), a damaged
  // file: an error
  if (isTrainedProblem(t))
    return [
      {
        severity: t.kind === 'missing' ? 'warning' : 'error',
        code: 'persona-trained',
        message: `cast.${key}: ${t.message}`,
      },
    ];
  const out: Diagnostic[] = [];
  if (typeof ref === 'string')
    out.push({
      severity: 'warning',
      code: 'persona-trained',
      message: `cast.${key}: cannot compare the trained speaker with the current reference (${ref})`,
    });
  else if (ref.sha256 !== t.referenceSha)
    out.push({
      severity: 'warning',
      code: 'persona-trained',
      message: `cast.${key}: persona "${id}" was trained from another ${lang} reference clip — train it again (s2v voice train)`,
    });
  const revision = customVoiceRevision(scriptDir);
  if (revision && revision !== t.revision)
    out.push({
      severity: 'warning',
      code: 'persona-trained',
      message: `cast.${key}: persona "${id}" was trained for another model revision — training it again is recommended (s2v voice train)`,
    });
  return out;
}

/** The CustomVoice revision in the nearest models.lock.json above the script (null: none). */
function customVoiceRevision(scriptDir: string): string | null {
  for (let dir = resolve(scriptDir); ; dir = dirname(dir)) {
    const p = join(dir, 'models.lock.json');
    if (existsSync(p))
      try {
        return (
          (JSON.parse(readFileSync(p, 'utf8')) as { models: Record<string, { revision: string }> })
            .models['qwen3-tts-1.7b-customvoice']?.revision ?? null
        );
      } catch {
        return null;
      }
    if (dirname(dir) === dir) return null;
  }
}

/** Width and height of a PNG or JPEG, or null for anything else (S12). */
function sizeOf(path: string): [number, number] | null {
  try {
    return imageSize(path);
  } catch {
    return null;
  }
}

function formatError(out: Diagnostic[], message: string, line?: number): void {
  out.push({ severity: 'error', code: 'asset-format', message, ...(line ? { line } : {}) });
}

/** Where a script shows a file: the renderer draws pictures and plays `::video` clips. */
export interface RenderedFile {
  src: string;
  /** For the message: `::image`, `show=`, `:::gallery`, `cast.host.avatar`, … */
  place: string;
  video: boolean;
  line?: number;
}

/**
 * The files some render reads, as the renderer will (S12 plan 2): each output's scenes and
 * paragraphs, a cue's `show=` wherever it is, the avatars of the casts on stage, the logo. One
 * per file.
 */
export function renderedImages(script: Script): RenderedFile[] {
  // every output's scenes, without the paragraphs it leaves out: what some render reads, walked
  // in script order so the first line reported is the first in the file
  const perOutput = Object.keys(script.meta.outputs).map((o) => outputScenes(script, o));
  const shown = new Set(perOutput.flatMap((sc) => sc.flatMap((s) => s.blocks)));
  const scenes = script.scenes
    .map((s) => ({ ...s, blocks: s.blocks.filter((b) => shown.has(b)) }))
    .filter((s) => s.blocks.length > 0);
  const out = new Map<string, RenderedFile>();
  // a file drawn as a picture and also played as a clip is checked for both
  const add = (f: RenderedFile) => {
    const key = `${f.video}\0${f.src}`;
    if (!out.has(key)) out.set(key, f);
  };
  for (const scene of scenes) {
    for (const b of scene.blocks) {
      if (b.kind === 'visual') {
        if (b.type === 'image' && b.attrs.src)
          add({
            src: b.attrs.src,
            place: '::image',
            video: false,
            line: b.line,
          });
        else if (b.type === 'video' && b.attrs.src)
          add({
            src: b.attrs.src,
            place: '::video',
            video: true,
            line: b.line,
          });
        else if (b.type === 'gallery' || b.type === 'split')
          for (const im of b.images ?? [])
            add({
              src: im.src,
              place: `:::${b.type}`,
              video: false,
              line: b.line,
            });
        continue;
      }
      for (const sen of b.sentences)
        for (const c of sen.cues)
          if (c.attrs.show)
            add({
              src: c.attrs.show,
              place: 'show=',
              video: false,
              line: b.line,
            });
    }
  }
  for (const key of new Set(perOutput.flatMap((sc) => [...castsIn(sc)]))) {
    const avatar = script.meta.cast[key]?.avatar;
    if (avatar) add({ src: avatar, place: `cast.${key}.avatar`, video: false });
  }
  const logo = logoOf(script.meta);
  if (logo && scenes.length > 0) add({ src: logo.src, place: 'logo', video: false });
  return [...out.values()];
}

/** Pictures must be PNG or JPEG (judged by their bytes); `::video` clips a video file (S12). */
export function lintImageFormats(script: Script, scriptDir: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  // what the other checks already report missing (over every scene, as they look)
  const checked = existenceChecked(script);
  const missing = new Set<string>();
  for (const f of renderedImages(script)) {
    const abs = resolve(scriptDir, f.src);
    if (!existsSync(abs)) {
      if (!checked.has(f.src) && !missing.has(f.src))
        out.push({
          severity: 'error',
          code: 'asset-missing',
          message: `image not found: ${f.src}`,
          ...(f.line ? { line: f.line } : {}),
        });
      missing.add(f.src);
      continue;
    }
    if (f.video) {
      if (!VIDEO_EXT.test(f.src))
        formatError(out, `::video needs .mp4, .webm, .mov or .m4v: ${f.src}`, f.line);
    } else if (!sizeOf(abs))
      formatError(out, `${f.place} must be a PNG or JPEG image: ${f.src}`, f.line);
  }
  return out;
}

/**
 * Files whose absence lintAssets, lintCast and lintBgm report: `::image` and the `show=` after
 * it, gallery, split and video files, avatars, the logo.
 */
function existenceChecked(script: Script): Set<string> {
  const out = new Set<string>();
  for (const scene of script.scenes) {
    let current: string | null = null;
    for (const b of scene.blocks) {
      if (b.kind === 'visual') {
        current = b.type === 'image' ? (b.attrs.src ?? null) : null;
        if (current) out.add(current);
        if (b.type === 'gallery' || b.type === 'split')
          for (const im of b.images ?? []) out.add(im.src);
        if (b.type === 'video' && b.attrs.src) out.add(b.attrs.src);
        continue;
      }
      if (!current) continue;
      for (const sen of b.sentences)
        for (const c of sen.cues)
          if (c.attrs.show) {
            current = c.attrs.show;
            out.add(current);
          }
    }
  }
  for (const m of Object.values(script.meta.cast)) if (m.avatar) out.add(m.avatar);
  const logo = logoOf(script.meta);
  if (logo) out.add(logo.src);
  return out;
}
