/**
 * File-based lint checks that the pure parser cannot do (PLAN 5.12): missing assets and
 * screenshots that will look soft because they are enlarged too much on screen.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bgmOf, logoOf, type Diagnostic, type Script } from '@script2video/core';
import { characterFaces, imageSize, MAX_AVATARS } from '@script2video/renderer-remotion';
import { resolvePersona } from './persona.js';

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
    let size: [number, number];
    try {
      size = imageSize(abs);
    } catch (e) {
      out.push({ severity: 'error', code: 'asset-format', message: (e as Error).message, line });
      continue;
    }
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
      const ref = resolvePersona(m.voice.slice('persona:'.length), meta.lang, scriptDir);
      // Not an error: draft renders use draftVoice / Supertonic and need no reference clip.
      if (typeof ref === 'string') out.push({ severity: 'warning', code: 'persona', message: ref });
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
    const faces = characterFaces(dir);
    const used = new Set([m.face]);
    for (const scene of script.scenes)
      for (const b of scene.blocks)
        if (b.kind === 'paragraph') {
          if (b.cast === key && b.face) used.add(b.face);
          for (const s of b.sentences)
            for (const r of s.reacts ?? []) if (r.faces[key]) used.add(r.faces[key]);
        }
    for (const face of used)
      if (!faces[face]?.base) err(`cast.${key}: ${rel}/${face}.png is missing (face "${face}")`);
    if (!Object.values(faces).some((f) => f.talk || f.half))
      warn(`cast.${key}: no <face>-talk.png in ${rel}, so the mouth will not move`);
    // Every image must share one canvas, or the character jumps when images swap.
    const sizes = new Set<string>();
    for (const files of Object.values(faces))
      for (const f of Object.values(files)) sizes.add(imageSize(join(dir, f)).join('×'));
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
