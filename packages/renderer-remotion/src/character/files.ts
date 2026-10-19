/**
 * Reading character folders: image sizes, classic face files, set folders. No composition, no
 * ffmpeg — shared by the composition plan (S4b), the renderer and the CLI.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Read width/height from a PNG or JPEG header. */
export function imageSize(path: string): [number, number] {
  const b = readFileSync(path);
  if (b.length >= 4 && b.readUInt32BE(0) === 0x89504e47) {
    if (b.length < 24) throw new Error(`truncated or unsupported image (PNG/JPEG only): ${path}`);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let off = 2;
    while (off + 9 < b.length) {
      if (b[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = b[off + 1]!;
      const len = b.readUInt16BE(off + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return [b.readUInt16BE(off + 7), b.readUInt16BE(off + 5)];
      }
      off += 2 + len;
    }
  }
  throw new Error(`unsupported image format (PNG/JPEG only): ${path}`);
}

const CHARACTER_FILE = /^([a-z][a-z0-9-]*?)(?:-(talk|half|blink))?\.png$/;

export interface CharacterFiles {
  base?: string;
  talk?: string;
  half?: string;
  blink?: string;
}

/**
 * Faces in a character folder: `<face>.png` (mouth closed), `<face>-talk.png` (open),
 * `<face>-half.png` (half open), `<face>-blink.png` (eyes closed). Values are file names.
 */
export function characterFaces(dir: string): Record<string, CharacterFiles> {
  const faces: Record<string, CharacterFiles> = {};
  for (const f of readdirSync(dir).sort()) {
    const m = CHARACTER_FILE.exec(f);
    if (!m) continue;
    const face = (faces[m[1]!] ??= {});
    face[(m[2] ?? 'base') as keyof CharacterFiles] = f;
  }
  return faces;
}

/** Subfolders, skipping dot entries (`.DS_Store`, `.git`) and files. */
export function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => !f.startsWith('.') && statSync(join(dir, f)).isDirectory())
    .sort();
}

/** First `head.png` under a set's views (its size is the set canvas). */
export function findHeadImage(root: string): string | null {
  const views = join(root, 'views');
  for (const v of subdirs(views))
    for (const h of subdirs(join(views, v, 'face')))
      for (const e of subdirs(join(views, v, 'face', h))) {
        const f = join(views, v, 'face', h, e, 'head.png');
        if (existsSync(f)) return f;
      }
  return null;
}
