/**
 * `s2v character import <folder|zip> --out <dir>`: bring YMM4 「動く立ち絵」 material into a parts
 * character folder (plan section 7). The material is copied as is (never into this repository),
 * with its README / terms files; a `character.yaml` draft picks `*_00` of every folder as the
 * neutral face, and `parts.html` shows every part to choose faces from.
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { CHARACTER_YAML, IMPORTED_PARTS } from '@script2video/renderer-remotion';

/** YMM4 part folders. */
export const YMM4_FOLDERS = ['体', '顔色', '髪', '口', '目', '眉', '他', '後'];
const TERMS = /^(readme|terms|license|licence|利用規約|規約|はじめに|使い方)/i;

const nfc = (s: string) => s.normalize('NFC');
/** macOS zip leftovers (`__MACOSX/`, `._*`) and dot files are never parts. */
const hidden = (name: string) => name.startsWith('.') || name === '__MACOSX';
const isPartsDir = (dir: string) =>
  readdirSync(dir).some(
    (f) => YMM4_FOLDERS.includes(nfc(f)) && statSync(join(dir, f)).isDirectory(),
  );

/** Extract a ZIP with Japanese (cp932) names; Node has no ZIP reader. */
function unzip(zip: string): string {
  const dest = mkdtempSync(join(tmpdir(), 's2v-ymm4-'));
  const code = `
import sys, zipfile
src, dest = sys.argv[1], sys.argv[2]
for enc in ("utf-8", "cp932"):
    try:
        with zipfile.ZipFile(src, metadata_encoding=enc) as z:
            names = z.namelist()
            if enc == "utf-8" and any("\\ufffd" in n for n in names):
                raise UnicodeDecodeError(enc, b"", 0, 1, "replacement char")
            z.extractall(dest)
        break
    except UnicodeDecodeError:
        continue
`;
  const r = spawnSync('python3', ['-c', code, zip, dest], { encoding: 'utf8' });
  if (r.status !== 0)
    throw new Error(
      `could not extract ${zip} (python3 3.11+ is needed for Japanese file names): ${r.stderr.trim()}`,
    );
  return dest;
}

/** Folders under `root` that hold YMM4 parts (the root itself or its subfolders, 2 levels). */
export function findCharacters(root: string): string[] {
  if (isPartsDir(root)) return [root];
  const out: string[] = [];
  for (const a of readdirSync(root)) {
    const p = join(root, a);
    if (hidden(a) || !statSync(p).isDirectory()) continue;
    if (isPartsDir(p)) out.push(p);
    else
      for (const b of readdirSync(p)) {
        const q = join(p, b);
        if (!hidden(b) && statSync(q).isDirectory() && isPartsDir(q)) out.push(q);
      }
  }
  return out;
}

/** Part stems of a folder: files without frame suffixes (`目_00.png`, not `目_00.1.png`). */
function stems(dir: string): string[] {
  return readdirSync(dir)
    .map(nfc)
    .filter((f) => !hidden(f) && /^[^.]+\.png$/i.test(f))
    .map((f) => f.slice(0, -4))
    .sort();
}

export interface ImportResult {
  out: string;
  copied: number;
  terms: string[];
  faces: Record<string, string>;
}

export function importCharacter(
  source: string,
  out: string,
  opts: { name?: string; log?: (m: string) => void } = {},
): ImportResult {
  const log = opts.log ?? (() => {});
  if (existsSync(join(out, CHARACTER_YAML)))
    throw new Error(`${out} already has ${CHARACTER_YAML}; remove it or choose another --out`);
  const root = source.toLowerCase().endsWith('.zip') ? unzip(source) : source;
  try {
    const found = findCharacters(root);
    const pick = opts.name ? found.filter((d) => nfc(basename(d)) === nfc(opts.name!)) : found;
    if (pick.length !== 1)
      throw new Error(
        found.length === 0
          ? `no YMM4 part folders (${YMM4_FOLDERS.join(' ')}) found in ${source}`
          : `${found.length > 1 && !opts.name ? 'several' : 'no matching'} characters in ${source}: ${found.map((d) => nfc(basename(d))).join(', ')} — choose one with --name`,
      );
    const src = pick[0]!;
    const partsDir = join(out, IMPORTED_PARTS);
    mkdirSync(partsDir, { recursive: true });
    let copied = 0;
    const faces: Record<string, string> = {};
    for (const entry of readdirSync(src)) {
      const name = nfc(entry);
      const from = join(src, entry);
      if (!YMM4_FOLDERS.includes(name) || !statSync(from).isDirectory()) continue;
      mkdirSync(join(partsDir, name), { recursive: true });
      for (const f of readdirSync(from)) {
        if (hidden(f) || !/\.png$/i.test(f)) continue;
        // Lowercase extension: lint and render look for `stem.png` (case-sensitive file systems).
        copyFileSync(join(from, f), join(partsDir, name, nfc(f).replace(/\.png$/i, '.png')));
        copied++;
      }
      const all = stems(join(partsDir, name));
      const first = all.find((s) => /_00$/.test(s)) ?? all[0];
      if (first) faces[name] = first;
    }
    // Terms files from the character folder and the folders above it (inside the source).
    const terms: string[] = [];
    for (let d = src; d.startsWith(root); d = join(d, '..')) {
      for (const f of readdirSync(d))
        if (
          !hidden(f) &&
          TERMS.test(nfc(f)) &&
          statSync(join(d, f)).isFile() &&
          !terms.includes(nfc(f))
        ) {
          copyFileSync(join(d, f), join(out, nfc(f)));
          terms.push(nfc(f));
        }
      if (d === root) break;
    }
    if (terms.length === 0)
      log('warning: no README / terms file found: check the terms of use of this material');
    // JSON strings are valid YAML: stems like `00` stay strings, odd characters stay quoted.
    const q = (v: string) => JSON.stringify(v);
    const yaml = [
      '# Imported YMM4 material. Keep its README / terms files next to this file.',
      'source: imported',
      `license: ${q(terms.length > 0 ? `see ${terms.join(', ')}` : 'TODO: terms of use')}`,
      '# CHECK which way the drawn character looks on screen (open parts.html): front | left | right',
      'facing: front',
      'faces:',
      `  neutral: { ${Object.entries(faces)
        .map(([k, v]) => `${q(k)}: ${q(v)}`)
        .join(', ')} }`,
      '  # happy: { 目: 目_05, 口: 口_02 }   # only the folders that differ from neutral',
      '',
    ].join('\n');
    writeFileSync(join(out, CHARACTER_YAML), yaml);
    writeFileSync(join(out, 'parts.html'), partsPage(partsDir, IMPORTED_PARTS));
    log(
      'check `facing` in character.yaml: which way the drawn character looks (front | left | right)',
    );
    return { out, copied, terms, faces };
  } finally {
    if (root !== source) rmSync(root, { recursive: true, force: true });
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Thumbnails of every part, per folder, to pick faces from. */
function partsPage(dir: string, rel: string): string {
  const sections = YMM4_FOLDERS.filter((f) => existsSync(join(dir, f))).map((folder) => {
    const files = readdirSync(join(dir, folder))
      .filter((f) => !hidden(f) && f.endsWith('.png'))
      .sort();
    const items = files
      .map(
        (f) =>
          `<figure><img src="${esc(encodeURI(`${rel}/${folder}/${f}`))}" loading="lazy"><figcaption>${esc(f)}</figcaption></figure>`,
      )
      .join('');
    return `<h2>${esc(folder)}</h2><div class="grid">${items}</div>`;
  });
  return `<!doctype html><meta charset="utf-8"><title>parts</title><style>
body{font-family:sans-serif;margin:24px}.grid{display:flex;flex-wrap:wrap;gap:8px}
figure{margin:0;width:150px;text-align:center;font-size:12px}
img{width:150px;height:130px;object-fit:contain;background:repeating-conic-gradient(#ddd 0 25%,#fff 0 50%) 0 0/16px 16px}
</style><h1>parts</h1>${sections.join('')}`;
}
