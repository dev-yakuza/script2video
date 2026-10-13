import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseScript } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import { importCharacter } from '../src/character-import.js';
import { lintPartsCharacter } from '../src/lint-assets.js';

/** Minimal PNG header with a given size (enough for imageSize; lint does not decode pixels). */
function png(path: string, w = 40, h = 50): void {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, b);
}

const YAML = `source: drawn
license: test
eyes: dot
views:
  front: { facing: front, pivot: [20, 30] }
  turn: { facing: right, pivot: [20, 30] }
heads:
  front/glance: { facing: right }
expressions:
  neutral: {}
  side: { gaze: toward }
faces:
  neutral: { view: front, expression: neutral }
  listen: { view: front, head: glance, expression: neutral }
  gasp: { view: turn, expression: neutral, motion: wiggle }
  odd-talk: { view: front, expression: neutral }
  look: { view: front, expression: side }
sets:
  head:
    views: { front: {} }
    faces: [neutral]
`;

function character(yaml = YAML): string {
  const dir = mkdtempSync(join(tmpdir(), 's2v-parts-'));
  writeFileSync(join(dir, 'character.yaml'), yaml);
  for (const v of ['front', 'turn']) {
    png(join(dir, `views/${v}/body/stand.png`));
    png(join(dir, `views/${v}/face/base/neutral/head.png`));
  }
  png(join(dir, 'views/front/face/glance/neutral/head.png'));
  png(join(dir, 'sets/head/views/front/face/base/neutral/head.png'));
  return dir;
}

const script = (body: string) =>
  parseScript(
    `---\nlang: ko\ncast:\n  a: { voice: "qwen:Sohee", character: c }\n  b: { voice: "qwen:Ryan" }\n---\n\n${body}`,
  ).script!;

const messages = (dir: string, body: string, severity = 'error') =>
  lintPartsCharacter(script(body), 'a', 'c', dir)
    .filter((d) => d.severity === severity)
    .map((d) => d.message);

describe('lintPartsCharacter', () => {
  it('passes a script that uses defined faces in their framings', () => {
    const dir = character(
      YAML.replace(', motion: wiggle', '')
        .replace(/ {2}odd-talk.*\n/, '')
        .replace(/eyes: dot/, 'eyes: full'),
    );
    expect(
      messages(
        dir,
        '# 하나\n\na: 안녕.\n\n# 둘\n\n::shot{a=head}\n\na: 반가워.\n\n# 셋\n\n::shot{a=full}\n\na{face=listen}: 네.\n',
      ),
    ).toEqual([]);
    // Warnings: the glance head flips alone on the right side; faces spoken without mouth frames.
    const w = messages(dir, '# 하나\n\na{face=listen}: 안녕.\n', 'warning');
    expect(w.some((x) => x.includes('flips only the head on the right side'))).toBe(true);
    expect(w.some((x) => x.includes('used for speaking but has no mouth frames'))).toBe(true);
  });

  it('keeps phase-1 scope: no bodies on turned views, gaze only on front heads', () => {
    const y = YAML.replace('heads:', 'bodies:\n  turn/wave: {}\nheads:').replace(
      '  look: { view: front, expression: side }',
      '  look: { view: turn, expression: side }',
    );
    const m = messages(character(y.replace('eyes: dot', 'eyes: full')), '# 하나\n\na: 안녕.\n');
    expect(m.some((x) => x.includes('bodies need a split front view'))).toBe(true);
    expect(m.some((x) => x.includes('gaze needs a front-facing head'))).toBe(true);
  });

  it('reports schema problems: name suffixes, dot eyes with gaze, unknown motions', () => {
    const m = messages(character(), '# 하나\n\na: 안녕.\n');
    expect(m.some((x) => x.includes('"odd-talk" must not end in -talk'))).toBe(true);
    expect(m.some((x) => x.includes('eyes: dot cannot show'))).toBe(true);
    expect(m.some((x) => x.includes('motion "wiggle"'))).toBe(true);
  });

  it('reports faces missing from the yaml or from the framing set, once for both sides', () => {
    const m = messages(
      character(),
      '# 하나\n\n::shot{a=head}\n\na{face=listen}: 안녕.\n\na{face=nope}: 반가워.\n',
    );
    expect(m.filter((x) => x.includes('"listen" is not in sets.head.faces'))).toHaveLength(1);
    expect(m.some((x) => x.includes('face "nope" is not defined'))).toBe(true);
  });

  it('with mirror: false, a turned face needs its @flip twin (sides differ per output)', () => {
    const dir = character(`${YAML}mirror: false\n`);
    const m = messages(dir, '# 하나\n\na{face=gasp}: 안녕.\n');
    expect(
      m.some((x) => x.includes('no @flip twin') || x.includes('"turn@flip" is not defined')),
    ).toBe(true);
  });

  it('reports missing images and mixed canvas sizes', () => {
    const dir = character();
    png(join(dir, 'views/front/face/glance/neutral/head.png'), 41, 50);
    const m = messages(dir, '# 하나\n\na{face=listen}: 안녕.\n\na{face=gasp}: 네.\n');
    expect(m.some((x) => x.includes('different sizes'))).toBe(true);
  });
});

describe('lintPartsCharacter (fallbacks, imported keys)', () => {
  it('warns when a head motion falls back on a one-image view', () => {
    const y = YAML.replace(', motion: wiggle', ', motion: head-tilt').replace(
      '  turn: { facing: right, pivot: [20, 30] }',
      '  turn: { facing: right }',
    );
    const dir = character(y);
    const w = messages(dir, '# 하나\n\na{face=gasp}: 안녕.\n', 'warning');
    expect(w.some((x) => x.includes('it plays as lean (whole body)'))).toBe(true);
  });

  it('rejects face keys that are not YMM4 part folders', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-imp-'));
    writeFileSync(
      join(dir, 'character.yaml'),
      'source: imported\nfaces:\n  neutral: { "顔": "顔_01" }\n',
    );
    png(join(dir, 'views/main/顔/顔_01.png'));
    const m = messages(dir, '# 하나\n\na: 안녕.\n');
    expect(m.some((x) => x.includes('"顔" is not a YMM4 part folder'))).toBe(true);
  });
});

describe('character import (YMM4)', () => {
  const material = () => {
    const root = mkdtempSync(join(tmpdir(), 's2v-ymm4-src-'));
    const c = join(root, 'pack', 'サンプル');
    for (const f of [
      '体/体_00.png',
      '体/体_01.png',
      '目/目_00.png',
      '目/目_00.0.png',
      '口/口_00.png',
      '口/口_00.0.png',
    ])
      png(join(c, f.normalize('NFD')));
    writeFileSync(join(root, 'pack', 'README.txt'), 'readme');
    writeFileSync(join(root, 'pack', 'TERMS.txt'), 'terms');
    return root;
  };

  it('copies parts with NFC names, the terms files, and drafts character.yaml', () => {
    const out = join(mkdtempSync(join(tmpdir(), 's2v-ymm4-out-')), 'c');
    const src = material();
    // macOS zips carry __MACOSX/ copies and ._ files: never parts.
    png(join(src, '__MACOSX', 'pack', 'サンプル', '体', '._体_00.png'));
    png(join(src, 'pack', 'サンプル', '体', '._体_00.png'));
    const r = importCharacter(src, out);
    expect(r.copied).toBe(6);
    expect(r.terms.sort()).toEqual(['README.txt', 'TERMS.txt']);
    expect(existsSync(join(out, 'views', 'main', '目', '目_00.0.png'))).toBe(true);
    const yaml = readFileSync(join(out, 'character.yaml'), 'utf8');
    expect(yaml).toContain('source: imported');
    expect(yaml).toContain('neutral: { "体": "体_00", "口": "口_00", "目": "目_00" }');
    expect(existsSync(join(out, 'parts.html'))).toBe(true);
    expect(() => importCharacter(material(), out)).toThrow(/already has character.yaml/);
  });

  const py311 =
    spawnSync('python3', ['-c', 'import sys; sys.exit(sys.version_info < (3, 11))']).status === 0;
  it.skipIf(!py311)('extracts ZIPs with cp932 (Shift-JIS) file names', () => {
    const d = mkdtempSync(join(tmpdir(), 's2v-zip-'));
    const zip = join(d, 'pack.zip');
    // Store names as cp932 bytes without the UTF-8 flag, as old Japanese zip tools do.
    const code = `
import zipfile, sys
zipfile.ZipInfo._encodeFilenameFlags = lambda self: (self.filename.encode("cp932"), self.flag_bits & ~0x800)
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for n in ["キャラ/体/体_00.png", "キャラ/目/目_00.png", "キャラ/口/口_00.png"]:
        z.writestr(n, b"\\x89PNG\\r\\n\\x1a\\n" + b"\\0" * 16)
`;
    expect(spawnSync('python3', ['-c', code, zip]).status).toBe(0);
    const out = join(d, 'out');
    const r = importCharacter(zip, out);
    expect(r.copied).toBe(3);
    expect(existsSync(join(out, 'views', 'main', '体', '体_00.png'))).toBe(true);
  });
});
