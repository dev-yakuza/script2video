import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { composeFace, composeImported, composite } from '../src/character/compose.js';
import { FaceError, landingX, resolveFace } from '../src/character/resolve.js';
import {
  CharacterSpecError,
  faceMotions,
  type LayeredSpec,
  parseCharacterSpec,
} from '../src/character/spec.js';

type RGBA = [number, number, number, number];

/** Write an RGBA PNG whose pixels come from `px(x, y)`. */
function writePng(path: string, w: number, h: number, px: (x: number, y: number) => RGBA): void {
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

/** Decode any image to RGBA pixels with ffmpeg. */
function pixels(path: string, w: number, h: number): (x: number, y: number) => RGBA {
  const r = spawnSync(
    'ffmpeg',
    ['-loglevel', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
    {
      maxBuffer: 1 << 26,
    },
  );
  const b = r.stdout as Buffer;
  expect(b.length).toBe(w * h * 4);
  return (x, y) => [...b.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)] as RGBA;
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const T: RGBA = [0, 0, 0, 0];
const W = 40;
const H = 50;

const spec = (yaml: string) => parseCharacterSpec(yaml) as LayeredSpec;
const BASE = `
source: drawn
views:
  front: { facing: front, pivot: [14, 30] }
  turn: { facing: right, pivot: [14, 30], layers: split }
bodies:
  front/point: { facing: right, offset: [2, -1] }
heads:
  front/glance: { facing: right }
expressions:
  neutral: {}
  happy: { motion: bounce }
  look: { gaze: toward }
groups:
  front/glance/neutral: { offset: [1, 0] }
faces:
  neutral: { view: front, expression: neutral }
  listen: { view: front, head: glance, expression: neutral }
  point: { view: front, body: point, expression: happy, motion: head-nod }
  gasp: { view: turn, expression: neutral }
  look: { view: front, expression: look }
sets:
  head:
    views: { front: {} }
    faces: [neutral]
`;

describe('character.yaml', () => {
  it('expands a versioned preset; user entries win field by field; exclude drops entries', () => {
    const s = spec(`
source: drawn
preset: test@1
exclude: [wave]
expressions:
  happy: { prompt: "big smile" }
faces:
  extra: { view: front, expression: neutral }
`);
    expect(s.expressions.happy).toEqual({ prompt: 'big smile', motion: 'bounce' });
    expect(Object.keys(s.faces).sort()).toEqual(['extra', 'happy', 'neutral']);
    expect(s.bodies).toEqual({});
    expect(faceMotions(s)).toEqual({ happy: 'bounce' });
  });

  it('wants part stems as strings and rejects paths in names and stems', () => {
    // Unquoted 00 is the number 0 in YAML: refuse it rather than look for 0.png.
    expect(() => parseCharacterSpec('source: imported\nfaces:\n  neutral: { 体: 00 }\n')).toThrow(
      /quoted string/,
    );
    const s = parseCharacterSpec('source: imported\nfaces:\n  neutral: { 体: "00" }\n');
    expect(s.source === 'imported' && s.faces.neutral).toEqual({ 体: '00' });
    expect(() =>
      parseCharacterSpec('source: imported\nfaces:\n  neutral: { 体: "../x" }\n'),
    ).toThrow(CharacterSpecError);
    expect(() => parseCharacterSpec('source: drawn\nheads:\n  "front/../../x": {}\n')).toThrow(
      CharacterSpecError,
    );
  });

  it('rejects an unversioned preset, unknown presets and bad names', () => {
    expect(() => parseCharacterSpec('source: drawn\npreset: standard\n')).toThrow(
      CharacterSpecError,
    );
    expect(() => parseCharacterSpec('source: drawn\npreset: nope@1\n')).toThrow(/unknown preset/);
    expect(() =>
      parseCharacterSpec('source: drawn\nfaces:\n  Bad: { view: front, expression: x }\n'),
    ).toThrow(CharacterSpecError);
  });

  it('standard@1: default faces turn toward the partner; exclude drops dependent faces', () => {
    const s = spec('source: generated\npreset: standard@1\n');
    expect(Object.keys(s.expressions)).toHaveLength(12);
    expect(s.faces.happy).toEqual({ view: 'turn', expression: 'happy' });
    expect(s.faces['front-happy']).toEqual({ view: 'front', expression: 'happy' });
    expect(s.faces['glance-puzzled']).toMatchObject({ head: 'glance', motion: 'head-tilt' });
    expect(s.faces.wave).toEqual({ view: 'front', body: 'wave', expression: 'happy' });
    expect(s.sets.head?.faces).toContain('moved');
    // The head close-up draws every face, with the glance head for turned ones (closeup-look).
    expect(s.sets.head?.faces).toEqual(Object.keys(s.faces));
    expect(s.sets.head?.heads['front/glance']).toEqual({ preset: 'glance', facing: 'right' });
    const x = spec('source: generated\npreset: standard@1\nexclude: [happy, glance]\n');
    for (const f of ['happy', 'front-happy', 'wave', 'glance-neutral'])
      expect(x.faces[f]).toBe(undefined);
    expect(x.sets.head?.faces).not.toContain('happy');
    expect(x.heads['front/glance']).toBe(undefined);
    expect(x.sets.head?.heads['front/glance']).toBe(undefined);
  });

  it('overriding one field of a preset entry keeps the rest (no schema default in between)', () => {
    const s = spec(
      'source: generated\npreset: standard@1\nviews:\n  turn: { pivot: [300, 200] }\n',
    );
    expect(s.views.turn).toMatchObject({
      preset: 'turn-slight',
      facing: 'right',
      pivot: [300, 200],
    });
    // Excluding the turn view: the default faces look at the viewer instead of disappearing.
    const t = spec('source: generated\npreset: standard@1\nexclude: [turn]\n');
    expect(t.faces.neutral).toEqual({ view: 'front', expression: 'neutral' });
    expect(t.sets.head?.faces).toContain('neutral');
    // Invalid values are reported, not dropped; null removes a preset set.
    expect(() => parseCharacterSpec('source: generated\npreset: standard@1\nfaces: 3\n')).toThrow(
      CharacterSpecError,
    );
    expect(spec('source: generated\npreset: standard@1\nsets: { head: null }\n').sets.head).toBe(
      undefined,
    );
    // A user-only close-up set gets the implicit front view.
    expect(
      spec('source: generated\nsets: { upper: { faces: [] } }\n').sets.upper?.views,
    ).toHaveProperty('front');
    // A user set may leave views out (the preset's are kept).
    const u = spec(
      'source: generated\npreset: standard@1\nsets:\n  head:\n    faces: [front-calm]\n',
    );
    expect(u.sets.head).toMatchObject({
      views: { front: { facing: 'front' } },
      faces: ['front-calm'],
    });
  });

  it('face motions: the face wins over its expression', () => {
    expect(faceMotions(spec(BASE))).toEqual({ point: 'head-nod' });
  });
});

describe('resolveFace (flip rule, pivots, offsets)', () => {
  const r = (
    face: string,
    side: 'left' | 'right',
    yaml = BASE,
    framing: Parameters<typeof resolveFace>[2] = 'full',
  ) => resolveFace('/c', spec(yaml), framing, face, side, [W, H]);

  it('keeps front art unflipped on both sides, at the same screen pivot', () => {
    const L = r('neutral', 'left');
    const R = r('neutral', 'right');
    expect([L.body!.flip, L.head.flip, R.body!.flip, R.head.flip]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(L.pivot).toEqual(R.pivot);
  });

  it('flips a layer group that would look toward the frame edge, about the view pivot', () => {
    // turn faces right: fine on the left, flipped on the right.
    expect(r('gasp', 'left').body!.flip).toBe(false);
    const g = r('gasp', 'right');
    expect(g.body!.flip && g.head.flip).toBe(true);
    // The neck column lands on the same screen x as unflipped art (no jump between faces).
    const m = (g.canvas[0] - W) / 2;
    expect(landingX(g.body!, 14, W)).toBe(m + 14);
    expect(landingX(g.head, 14, W)).toBe(m + 14);
    // y: pivot 30 + top margin 1 (front/point is raised 1 px by its offset).
    expect(g.pivot).toEqual([m + 14, 31]);
  });

  it('flips only the head (B≠H) and keeps it on the neck, offsets included', () => {
    const l = r('listen', 'right'); // front body, right-facing glance head on the right side
    expect([l.body!.flip, l.head.flip]).toEqual([false, true]);
    const m = (l.canvas[0] - W) / 2;
    // e.x = pivot + group dx (body not flipped → +dx); the head's neck column lands on e.x.
    expect(l.pivot).toEqual([m + 15, 31]);
    expect(landingX(l.head, 14, W)).toBe(m + 15);
  });

  it('negates dx when the body flips (B), and applies dy', () => {
    const p = r('point', 'right'); // point faces right → body flipped on the right side
    expect(p.body!.flip).toBe(true);
    const m = (p.canvas[0] - W) / 2;
    expect(p.pivot).toEqual([m + 14 - 2, 30]);
    const q = r('point', 'left');
    expect(q.pivot).toEqual([m + 14 + 2, 30]);
  });

  it('picks gaze eyes toward the partner per side', () => {
    expect(r('look', 'left').head.states.closed.at(-1)).toMatch(/eyes@screen-right\.png$/);
    expect(r('look', 'right').head.states.closed.at(-1)).toMatch(/eyes@screen-left\.png$/);
  });

  it('uses @flip twins instead of flipping when mirror is false', () => {
    const y = `${BASE}mirror: false\n`.replace(
      '  turn: { facing: right, pivot: [14, 30], layers: split }',
      '  turn: { facing: right, pivot: [14, 30], layers: split }\n  turn@flip: { facing: left, pivot: [25, 30], layers: split }',
    );
    const g = r('gasp', 'right', y);
    expect(g.body!.flip).toBe(false);
    expect(g.body!.file).toContain('/views/turn@flip/');
    expect(() => r('listen', 'right', y)).toThrow(FaceError); // no front/glance@flip
  });

  it('draws single-layer views as one flippable image without a pivot (head motions fall back)', () => {
    const y = BASE.replace(
      '  turn: { facing: right, pivot: [14, 30], layers: split }',
      '  turn: { facing: right }', // turned views default to one image
    );
    const g = r('gasp', 'right', y);
    expect(g.body).toBeUndefined();
    expect(g.pivot).toBeNull();
    expect(g.head.flip).toBe(true); // a turned single view still faces the partner
    expect(r('gasp', 'left', y).head.flip).toBe(false);
  });

  it('draws faces of a close-up set from its front view (turned faces included)', () => {
    const y = BASE.replace('    faces: [neutral]', '    faces: [neutral, gasp]');
    const h = r('gasp', 'right', y, 'head');
    expect(h.head.states.closed[0]).toContain('/sets/head/views/front/face/base/neutral/head.png');
    expect(h.head.flip).toBe(false);
  });

  it('turns the head of turned faces in the head close-up only, toward the partner', () => {
    const y = BASE.replace(
      '    faces: [neutral]',
      '    heads: { front/glance: { facing: right } }\n    faces: [neutral, gasp, listen, still, point]',
    ).replace(
      '  look: { view: front',
      '  still: { view: turn, head: base, expression: neutral }\n  look: { view: front',
    );
    const at = (face: string, side: 'left' | 'right', yy = y) => r(face, side, yy, 'head');
    const dir = (x: ReturnType<typeof at>) => x.head.states.closed[0]!.split('/face/')[1];
    for (const side of ['left', 'right'] as const) {
      expect(dir(at('gasp', side))).toBe('glance/neutral/head.png');
      expect(dir(at('listen', side))).toBe('glance/neutral/head.png');
      expect(dir(at('neutral', side))).toBe('base/neutral/head.png');
      expect(dir(at('still', side))).toBe('base/neutral/head.png'); // an explicit head stays
      expect(dir(at('point', side))).toBe('base/happy/head.png'); // a pose keeps its expression
    }
    // The glance faces the partner: flipped on the right side, as in the full framing.
    expect(at('gasp', 'right').head.flip).toBe(true);
    expect(at('gasp', 'left').head.flip).toBe(false);
    // A glance preset wins over another turned head; the upper set keeps its turned faces frontal.
    const two = y.replace(
      'heads: { front/glance: { facing: right } }',
      'heads: { front/away: { facing: right }, front/glance: { preset: glance, facing: right } }',
    );
    expect(dir(at('gasp', 'left', two))).toBe('glance/neutral/head.png');
    const upper = y.replace('  head:\n', '  upper:\n');
    expect(r('gasp', 'left', upper, 'upper').head.states.closed[0]).toContain(
      '/face/base/neutral/',
    );
  });

  it('mirror: false keeps turned faces frontal in the head close-up without a @flip twin', () => {
    const y = `${BASE}mirror: false\n`
      .replace(
        '  turn: { facing: right, pivot: [14, 30], layers: split }',
        '  turn: { facing: right }\n  turn@flip: { facing: left }',
      )
      .replace(
        '    faces: [neutral]',
        '    heads: { front/glance: { facing: right } }\n    faces: [neutral, gasp]',
      );
    for (const side of ['left', 'right'] as const)
      expect(r('gasp', side, y, 'head').head.states.closed[0]).toContain('/face/base/neutral/');
    const twin = y.replace(
      'front/glance: { facing: right } }',
      'front/glance: { facing: right }, front/glance@flip: { facing: left } }',
    );
    expect(r('gasp', 'left', twin, 'head').head.states.closed[0]).toContain(
      '/face/glance/neutral/',
    );
    expect(r('gasp', 'right', twin, 'head').head.states.closed[0]).toContain(
      '/face/glance@flip/neutral/',
    );
  });

  it('resolves faces of the head set only from its list, without a body', () => {
    const h = r('neutral', 'left', BASE, 'head');
    expect(h.body).toBeUndefined();
    expect(h.pivot).toBeNull();
    expect(h.head.states.closed[0]).toContain('/sets/head/views/front/face/base/neutral/head.png');
    expect(() => r('listen', 'left', BASE, 'head')).toThrow(FaceError);
  });
});

// Many ffmpeg runs per test: slow on loaded machines and CI runners.
describe.skipIf(!hasFfmpeg)('composition (ffmpeg)', { timeout: 30_000 }, () => {
  it('composites straight alpha exactly, including over transparent pixels', () => {
    const d = mkdtempSync(join(tmpdir(), 's2v-comp-'));
    writePng(join(d, 'a.png'), 4, 1, (x) => (x < 2 ? [255, 0, 0, 255] : T));
    writePng(join(d, 'b.png'), 4, 1, () => [0, 255, 0, 128]);
    composite(
      join(d, 'out.png'),
      [4, 1],
      [
        { file: join(d, 'a.png'), x: 0, y: 0, flip: false },
        { file: join(d, 'b.png'), x: 0, y: 0, flip: false },
      ],
    );
    const p = pixels(join(d, 'out.png'), 4, 1);
    expect(p(3, 0)).toEqual([0, 255, 0, 128]);
    const [r, g, , a] = p(0, 0);
    expect(a).toBe(255);
    expect(Math.abs(r - 127)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(1);
  });

  it('composes a flipped turn face with the head on the neck, and caches it', () => {
    const d = mkdtempSync(join(tmpdir(), 's2v-char-'));
    writeFileSync(join(d, 'character.yaml'), BASE);
    // Body: a red column at the neck x (14); head: a blue mark 3 px right of the neck.
    const body = (x: number) => (x === 14 ? ([255, 0, 0, 255] as RGBA) : T);
    for (const v of ['front', 'turn']) writePng(join(d, `views/${v}/body/stand.png`), W, H, body);
    const head = (x: number, y: number) => (x === 17 && y < 10 ? ([0, 0, 255, 255] as RGBA) : T);
    writePng(join(d, 'views/turn/face/base/neutral/head.png'), W, H, head);
    writePng(join(d, 'views/turn/face/base/neutral/mouth.png'), W, H, (x, y) =>
      x === 17 && y === 5 ? [0, 255, 0, 255] : T,
    );
    const resolved = resolveFace(d, spec(BASE), 'full', 'gasp', 'right', [W, H]);
    const cache = join(d, 'cache');
    const c = composeFace(resolved, cache);
    const [CW, CH] = c.canvas;
    const m = (CW - W) / 2;
    const mt = CH - H; // top margin (raised heads)
    const b = pixels(c.body!, CW, CH);
    const h = pixels(c.head.base, CW, CH);
    const t = pixels(c.head.talk, CW, CH);
    expect(b(m + 14, mt + 40)).toEqual([255, 0, 0, 255]); // neck column stays put
    expect(h(m + 11, mt + 2)).toEqual([0, 0, 255, 255]); // head mark mirrored about the neck
    expect(t(m + 11, mt + 5)).toEqual([0, 255, 0, 255]); // mouth part follows the head
    expect(h(m + 11, mt + 5)).toEqual([0, 0, 255, 255]);
    // half falls back to talk (no mouth.1), blink to closed (no eyes.0)
    expect(pixels(c.head.half, CW, CH)(m + 11, mt + 5)).toEqual([0, 255, 0, 255]);
    expect(composeFace(resolved, cache).hash).toBe(c.hash);
  });

  it('composites imported YMM4 faces in YMM4 order with mouth/eye frames, flipped toward the center', () => {
    const d = mkdtempSync(join(tmpdir(), 's2v-ymm4-'));
    const at = (x0: number, c: RGBA) => (x: number) => (x === x0 ? c : T);
    writePng(join(d, 'views/main/体/体_00.png'), 8, 2, () => [200, 200, 200, 255]);
    writePng(join(d, 'views/main/口/口_00.png'), 8, 2, at(1, [255, 0, 0, 255])); // open
    writePng(join(d, 'views/main/口/口_00.0.png'), 8, 2, at(1, [0, 0, 255, 255])); // closed
    writePng(join(d, 'views/main/口/口_00.1.png'), 8, 2, at(1, [0, 0, 1, 255]));
    writePng(join(d, 'views/main/口/口_00.2.png'), 8, 2, at(1, [0, 255, 0, 255])); // middle of 1..3
    writePng(join(d, 'views/main/口/口_00.3.png'), 8, 2, at(1, [0, 0, 3, 255]));
    writePng(join(d, 'views/main/目/目_00.png'), 8, 2, at(2, [9, 9, 9, 255]));
    writePng(join(d, 'views/main/目/目_00.0.png'), 8, 2, at(2, [99, 99, 99, 255]));
    const s = parseCharacterSpec(
      'source: imported\nfacing: left\nfaces:\n  neutral: { 体: 体_00, 口: 口_00, 目: 目_00 }\n',
    );
    if (s.source !== 'imported') throw new Error('expected imported');
    const left = composeImported(d, s, 'neutral', 'left', [8, 2], join(d, 'cache'));
    // facing left on the left side → flipped: x=1 lands on x=6.
    expect(pixels(left.base, 8, 2)(6, 0)).toEqual([0, 0, 255, 255]);
    expect(pixels(left.talk, 8, 2)(6, 0)).toEqual([255, 0, 0, 255]);
    expect(pixels(left.half, 8, 2)(6, 0)).toEqual([0, 255, 0, 255]);
    expect(pixels(left.blink, 8, 2)(5, 0)).toEqual([99, 99, 99, 255]);
    const right = composeImported(d, s, 'neutral', 'right', [8, 2], join(d, 'cache'));
    expect(pixels(right.base, 8, 2)(1, 0)).toEqual([0, 0, 255, 255]);
    // Hair over the eyes is drawn a second time, half transparent (YMM4 髪(半透明)).
    writePng(join(d, 'views/main/髪/髪_00.png'), 8, 2, at(2, [255, 255, 255, 255]));
    const s2 = parseCharacterSpec(
      'source: imported\nfaces:\n  neutral: { 体: 体_00, 目: 目_00, 髪: 髪_00 }\n',
    );
    if (s2.source !== 'imported') throw new Error('expected imported');
    const hair = composeImported(d, s2, 'neutral', 'right', [8, 2], join(d, 'cache2'));
    const [r, g, bl] = pixels(hair.base, 8, 2)(2, 0);
    // eye (9) drawn over the hair, then hair again at 50%: about (132, 132, 132)
    expect(Math.abs(r - 132) + Math.abs(g - 132) + Math.abs(bl - 132)).toBeLessThanOrEqual(6);
  });
});
