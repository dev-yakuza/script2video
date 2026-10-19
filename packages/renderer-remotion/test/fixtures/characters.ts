/**
 * Character folders and a hand-made timeline for the `hashes` order tests (S4b plan R7): one
 * layered character (two framings), one imported YMM4 character and one classic character, each
 * with a default face that is not first by name.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import type { Timeline } from '@script2video/core';
import type { CastOption, RenderOptions } from '../../src/index.js';

type RGBA = [number, number, number, number];

/** Write an RGBA PNG whose pixels come from `px(x, y)`. */
export function writePng(
  path: string,
  w: number,
  h: number,
  px: (x: number, y: number) => RGBA,
): void {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

export const W = 40;
export const H = 50;
const mark =
  (x0: number, c: RGBA): ((x: number, y: number) => RGBA) =>
  (x) =>
    x === x0 ? c : [0, 0, 0, 0];

export const LAYERED_YAML = `
source: drawn
views:
  front: { facing: front, pivot: [20, 30] }
  side: { facing: left, pivot: [16, 30], layers: split }
expressions:
  smile: {}
  angry: {}
  calm: {}
faces:
  smile: { view: front, expression: smile }
  angry: { view: front, expression: angry }
  calm: { view: front, expression: calm }
  away: { view: side, expression: smile }
sets:
  head:
    views: { front: {} }
    faces: [smile, calm]
`;

export const IMPORTED_YAML = `source: imported
facing: left
faces:
  neutral: { 体: 体_00, 口: 口_00 }
  smile: { 口: 口_01 }
  angry: { 体: 体_01 }
`;

/** Asymmetric layered art: `mirror: false` twins, offsets, gaze eyes, mouth and blink frames. */
export const RICH_YAML = `
source: drawn
mirror: false
views:
  front: { facing: front, pivot: [20, 30] }
  turn: { facing: right, pivot: [18, 30] }
  turn@flip: { facing: left, pivot: [22, 30] }
bodies:
  front/point: { facing: right, offset: [2, -1] }
  front/point@flip: { facing: left, offset: [-3, -2] }
heads:
  front/glance: { facing: right }
  front/glance@flip: { facing: left }
expressions:
  neutral: {}
  look: { gaze: toward }
  up: { gaze: up }
groups:
  front/glance/neutral: { offset: [1, 0] }
  front/glance@flip/neutral: { offset: [-1, -2] }
faces:
  neutral: { view: front, expression: neutral }
  look: { view: front, expression: look }
  up: { view: front, expression: up }
  point: { view: front, body: point, expression: neutral }
  listen: { view: front, head: glance, expression: neutral }
  gasp: { view: turn, expression: neutral }
`;

/** Every YMM4 slot kind the composer orders: back, body, mouth frames, eyes, hair, other. */
export const IMPORTED_RICH_YAML = `source: imported
facing: right
faces:
  neutral: { 体: 体_00, 口: 口_00, 目: 目_00, 髪: 髪_00, 後: 後_00, 他2: 他_02 }
  smile: { 口: 口_01 }
`;

/** Script folder with characters `chars/layered`, `chars/imported`, `chars/classic` and fonts. */
export function characterFixture(): { root: string; fonts: string } {
  const root = mkdtempSync(join(tmpdir(), 's2v-hashes-'));
  const l = join(root, 'chars', 'layered');
  mkdirSync(l, { recursive: true });
  writeFileSync(join(l, 'character.yaml'), LAYERED_YAML);
  writePng(join(l, 'views/front/body/stand.png'), W, H, mark(20, [255, 0, 0, 255]));
  ['smile', 'angry', 'calm'].forEach((e, i) => {
    writePng(join(l, `views/front/face/base/${e}/head.png`), W, H, mark(i, [0, 0, 255, 255]));
    writePng(
      join(l, `sets/head/views/front/face/base/${e}/head.png`),
      W,
      H,
      mark(i, [0, 9, 0, 255]),
    );
  });
  writePng(join(l, 'views/front/face/base/smile/mouth.png'), W, H, mark(30, [0, 255, 0, 255]));
  writePng(join(l, 'views/front/front/stand.png'), W, H, mark(5, [9, 9, 9, 255]));
  // a view facing left on the left side: mirrored (mirror: true)
  writePng(join(l, 'views/side/body/stand.png'), W, H, mark(16, [255, 0, 9, 255]));
  writePng(join(l, 'views/side/face/base/smile/head.png'), W, H, mark(12, [0, 0, 9, 255]));

  const im = join(root, 'chars', 'imported');
  writeFileSync(join(mkdirSync(im, { recursive: true }) ?? im, 'character.yaml'), IMPORTED_YAML);
  const part = (p: string, x: number) =>
    writePng(join(im, 'views/main', p), 8, 2, mark(x, [x, 1, 1, 255]));
  part('体/体_00.png', 0);
  part('体/体_01.png', 1);
  part('口/口_00.png', 2);
  part('口/口_00.0.png', 3);
  part('口/口_00.1.png', 4);
  part('口/口_01.png', 5);

  const r = join(root, 'chars', 'rich');
  mkdirSync(r, { recursive: true });
  writeFileSync(join(r, 'character.yaml'), RICH_YAML);
  let n = 0;
  const art = (p: string) => writePng(join(r, p), W, H, mark(n++ % W, [n, 7, 7, 255]));
  for (const b of ['stand', 'point', 'point@flip']) art(`views/front/body/${b}.png`);
  art('views/front/front/stand.png');
  art('views/front/front/point@flip.png');
  for (const e of ['neutral', 'look', 'up']) art(`views/front/face/base/${e}/head.png`);
  for (const f of ['mouth', 'mouth.1', 'eyes.0']) art(`views/front/face/base/neutral/${f}.png`);
  for (const f of ['eyes@screen-left', 'eyes@screen-right'])
    art(`views/front/face/base/look/${f}.png`);
  art('views/front/face/base/up/eyes@up.png');
  for (const h of ['glance', 'glance@flip']) art(`views/front/face/${h}/neutral/head.png`);
  for (const v of ['turn', 'turn@flip']) {
    art(`views/${v}/body/stand.png`);
    art(`views/${v}/face/base/neutral/head.png`);
  }

  const im2 = join(root, 'chars', 'imported2');
  mkdirSync(im2, { recursive: true });
  writeFileSync(join(im2, 'character.yaml'), IMPORTED_RICH_YAML);
  const part2 = (p: string) =>
    writePng(join(im2, 'views/main', p), 8, 2, mark(n++ % 8, [n, 3, 3, 255]));
  for (const p of [
    '体/体_00',
    '口/口_00',
    '口/口_00.0',
    '口/口_00.1',
    '口/口_00.2',
    '口/口_00.3',
    '口/口_00.4',
    '口/口_01',
    '目/目_00',
    '目/目_00.0',
    '髪/髪_00',
    '後/後_00',
    '他/他_02',
  ])
    part2(`${p}.png`);

  const cl = join(root, 'chars', 'classic');
  for (const [f, x] of [
    ['angry.png', 0],
    ['smile.png', 1],
    ['smile-talk.png', 2],
  ] as const)
    writePng(join(cl, f), 8, 8, mark(x, [1, 2, 3, 255]));

  const fonts = join(root, 'fonts');
  mkdirSync(fonts, { recursive: true });
  for (const f of [
    'NotoSansKR-Variable.ttf',
    'NotoSansJP-Variable.ttf',
    'JetBrainsMono-Variable.ttf',
  ])
    writeFileSync(join(fonts, f), '');
  return { root, fonts };
}

export const CAST: CastOption[] = [
  {
    key: 'a',
    name: 'A',
    color: '#000',
    face: 'smile',
    character: { dir: 'chars/layered', facing: 'front' },
  },
  {
    key: 'b',
    name: 'B',
    color: '#111',
    face: 'smile',
    character: { dir: 'chars/imported', facing: 'front' },
  },
  {
    key: 'c',
    name: 'C',
    color: '#222',
    face: 'smile',
    character: { dir: 'chars/classic', facing: 'left' },
  },
  // the same art on both sides (sides alternate: d right, e left, f right, g left)
  ...(['d', 'e'] as const).map((key) => ({
    key,
    name: key,
    color: '#333',
    face: 'neutral',
    character: { dir: 'chars/rich', facing: 'front' as const },
  })),
  ...(['f', 'g'] as const).map((key) => ({
    key,
    name: key,
    color: '#444',
    face: 'neutral',
    character: { dir: 'chars/imported2', facing: 'front' as const },
  })),
];

/** Faces of d and e in scene three, in timeline order (lines, then reactions). */
export const RICH_FACES = ['neutral', 'look', 'up', 'point', 'listen', 'gasp'];

const audio = (cast: string, face: string, id: string) => ({
  sentenceId: id,
  cast,
  face,
  src: 'x.wav',
  startFrame: 0,
  durationFrames: 30,
});

/** Two scenes: `a` full then head, `b` and `c` full; lines, a reaction and a look. */
export const TIMELINE = {
  fps: 30,
  lang: 'ko',
  output: 'youtube',
  totalFrames: 180,
  scenes: [
    {
      id: 'one',
      title: '',
      startFrame: 0,
      durationFrames: 60,
      visuals: [],
      audio: [
        audio('a', 'angry', 'one:0:0'),
        audio('b', 'angry', 'one:1:0'),
        audio('a', 'away', 'one:2:0'),
      ],
      cues: [],
      subtitles: [],
      reactions: [],
      motions: [],
      looks: [],
      framing: { a: 'full', b: 'full', c: 'full' },
    },
    {
      id: 'two',
      title: '',
      startFrame: 60,
      durationFrames: 60,
      visuals: [],
      audio: [audio('a', 'calm', 'two:0:0'), audio('c', 'angry', 'two:1:0')],
      cues: [],
      subtitles: [],
      reactions: [{ cast: 'b', face: 'smile', startFrame: 0, endFrame: 30 }],
      motions: [],
      looks: [],
      framing: { a: 'head', b: 'full', c: 'full' },
    },
    {
      id: 'three',
      title: '',
      startFrame: 120,
      durationFrames: 60,
      visuals: [],
      audio: [
        ...['look', 'up', 'point'].flatMap((f) => [
          audio('d', f, `three:${f}:d`),
          audio('e', f, `three:${f}:e`),
        ]),
        audio('f', 'smile', 'three:f'),
        audio('g', 'smile', 'three:g'),
      ],
      cues: [],
      subtitles: [],
      reactions: ['listen', 'gasp'].flatMap((face) =>
        ['d', 'e'].map((cast) => ({ cast, face, startFrame: 0, endFrame: 30 })),
      ),
      motions: [],
      looks: [],
      framing: { d: 'full', e: 'full', f: 'full', g: 'full' },
    },
  ],
} as unknown as Timeline;

export function renderOptions(root: string, fonts: string): RenderOptions {
  return {
    timeline: TIMELINE,
    aspect: '16:9',
    assetsRoot: root,
    fontsDir: fonts,
    workDir: join(root, 'work'),
    cast: CAST,
  };
}

/** `hashes` keys in the order the renderer writes them (chunk keys depend on it). */
export const EXPECTED_KEYS = [
  'font:NotoSansKR-Variable.ttf',
  'font:NotoSansJP-Variable.ttf',
  'font:JetBrainsMono-Variable.ttf',
  'character:a/full/smile/left',
  'character:a/full/angry/left',
  'character:a/full/away/left',
  'character:a/head/smile/left',
  'character:a/head/calm/left',
  'character:b/full/smile/right',
  'character:b/full/angry/right',
  'character:c/angry.png',
  'character:c/smile-talk.png',
  'character:c/smile.png',
  ...RICH_FACES.map((f) => `character:d/full/${f}/right`),
  ...RICH_FACES.map((f) => `character:e/full/${f}/left`),
  'character:f/full/neutral/right',
  'character:f/full/smile/right',
  'character:g/full/neutral/left',
  'character:g/full/smile/left',
];
