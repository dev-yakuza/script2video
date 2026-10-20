/**
 * S4b plan R2 / R7: splitting composition into plan + run must not move a single chunk key. The
 * expected values are the composition hashes of the formula before the split (copied here), and
 * the keys are listed by hand in the order the renderer writes them.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPOSER_VERSION, ffmpegVersion } from '../src/character/compose.js';
import { resolveFace } from '../src/character/resolve.js';
import { type LayeredSpec, parseCharacterSpec } from '../src/character/spec.js';
import { preparePublicDir } from '../src/prepare.js';
import {
  characterFixture,
  EXPECTED_KEYS,
  H,
  renderOptions,
  RICH_FACES,
  W,
} from './fixtures/characters.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const fileHash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const short = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 20);

/** composeFace's hash before S4b (compose.ts at 454a4dc). */
function legacyLayered(
  dir: string,
  framing: 'full' | 'head',
  face: string,
  side: 'left' | 'right',
) {
  const spec = parseCharacterSpec(readFileSync(join(dir, 'character.yaml'), 'utf8')) as LayeredSpec;
  const resolved = resolveFace(dir, spec, framing, face, side, [W, H]);
  const { states } = resolved.head;
  const talk = existsSync(states.talk.at(-1)!) ? states.talk : states.closed;
  const half = existsSync(states.half.at(-1)!) ? states.half : talk;
  const blink = existsSync(states.blink.at(-1)!) ? states.blink : states.closed;
  const front = resolved.front && existsSync(resolved.front.file) ? resolved.front : undefined;
  const inputs = [
    ...new Set([
      ...talk,
      ...half,
      ...blink,
      ...states.closed,
      ...(resolved.body ? [resolved.body.file] : []),
      ...(front ? [front.file] : []),
    ]),
  ];
  return short({
    v: COMPOSER_VERSION,
    ffmpeg: ffmpegVersion(),
    key: resolved.key,
    canvas: resolved.canvas,
    head: { flip: resolved.head.flip, x: resolved.head.x, y: resolved.head.y },
    body: resolved.body ? { ...resolved.body, file: null } : null,
    front: front ? { ...front, file: null } : null,
    states: { closed: states.closed, half, talk, blink },
    files: inputs.map((f) => [f, fileHash(f)]),
  });
}

/** composeImported's hash before S4b, for the fixture's parts (written out by hand). */
function legacyImported(dir: string, layers: [string, number?][][], flip: boolean) {
  const p = (f: string) => join(dir, 'views', 'main', f);
  return short({
    v: COMPOSER_VERSION,
    ffmpeg: ffmpegVersion(),
    size: [8, 2],
    flip,
    layers: layers.map((ls) => ls.map(([f, o]) => [p(f), fileHash(p(f)), o ?? 1])),
  });
}

/** composeImported's hash before S4b, its layer choice copied from compose.ts at 454a4dc. */
function legacyImportedOf(dir: string, face: string, side: 'left' | 'right') {
  const spec = parseCharacterSpec(readFileSync(join(dir, 'character.yaml'), 'utf8'));
  if (spec.source !== 'imported') throw new Error('imported expected');
  const root = join(dir, 'views', 'main');
  const slot = (k: string) => (k === '後' || k === '他' ? `${k}1` : k);
  const norm = (sel: Record<string, string>) =>
    Object.fromEntries(Object.entries(sel).map(([k, v]) => [slot(k.normalize('NFC')), v]));
  const pick: Record<string, string> = {
    ...norm(spec.faces.neutral ?? {}),
    ...norm(spec.faces[face] ?? {}),
  };
  if (pick['髪']) pick['髪(半透明)'] = pick['髪'];
  const order = [
    '後3',
    '後2',
    '後1',
    '体',
    '顔色',
    '髪',
    '口',
    '目',
    '眉',
    '髪(半透明)',
    '他3',
    '他2',
    '他1',
  ];
  const folderOf = (k: string) => (k === '髪(半透明)' ? '髪' : k.replace(/[123]$/, ''));
  const fileOf = (k: string, n: string) => join(root, folderOf(k), n);
  const frames = (k: string, stem: string) => {
    const mids = readdirSync(join(root, folderOf(k)))
      .map((f) => new RegExp(`^${stem}\\.(\\d+)\\.png$`).exec(f.normalize('NFC')))
      .filter((m): m is RegExpExecArray => !!m && m[1] !== '0')
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    const open = fileOf(k, `${stem}.png`);
    const closed = existsSync(fileOf(k, `${stem}.0.png`)) ? fileOf(k, `${stem}.0.png`) : open;
    const half =
      mids.length > 0 ? fileOf(k, `${stem}.${mids[Math.floor((mids.length - 1) / 2)]}.png`) : open;
    return { open, closed, half };
  };
  const layers = (['base', 'talk', 'half', 'blink'] as const).map((state) =>
    order
      .filter((k) => pick[k])
      .map((k) => {
        const stem = pick[k]!;
        let file = fileOf(k, `${stem}.png`);
        if (k === '口') {
          const fr = frames(k, stem);
          file = state === 'talk' ? fr.open : state === 'half' ? fr.half : fr.closed;
        } else if (k === '目') {
          const fr = frames(k, stem);
          file = state === 'blink' ? fr.closed : fr.open;
        }
        return [file, fileHash(file), k === '髪(半透明)' ? 0.5 : 1];
      }),
  );
  return short({
    v: COMPOSER_VERSION,
    ffmpeg: ffmpegVersion(),
    size: [8, 2],
    flip: spec.facing === side,
    layers,
  });
}

// about 25 s alone; on a busy machine it passes 60 s in the full suite, at HEAD as well
describe.skipIf(!hasFfmpeg)('render hashes (S4b R7)', { timeout: 180_000 }, () => {
  it('keeps every key, in order, and every composition hash', () => {
    const { root, fonts } = characterFixture();
    const { hashes } = preparePublicDir(renderOptions(root, fonts));
    expect(Object.keys(hashes)).toEqual(EXPECTED_KEYS);
    const l = join(root, 'chars', 'layered');
    expect(hashes['character:a/full/smile/left']).toBe(legacyLayered(l, 'full', 'smile', 'left'));
    expect(hashes['character:a/full/angry/left']).toBe(legacyLayered(l, 'full', 'angry', 'left'));
    expect(hashes['character:a/full/away/left']).toBe(legacyLayered(l, 'full', 'away', 'left'));
    expect(hashes['character:a/head/smile/left']).toBe(legacyLayered(l, 'head', 'smile', 'left'));
    expect(hashes['character:a/head/calm/left']).toBe(legacyLayered(l, 'head', 'calm', 'left'));
    // imported, facing left on the right side: not flipped; smile borrows 体 from neutral and
    // takes 口_01 (no frames: every state uses the open mouth); angry keeps neutral's 口 frames
    const im = join(root, 'chars', 'imported');
    const smile = ['体/体_00.png', '口/口_01.png'];
    expect(hashes['character:b/full/smile/right']).toBe(
      legacyImported(
        im,
        [smile, smile, smile, smile].map((s) => s.map((f) => [f])),
        false,
      ),
    );
    const angry = (mouth: string): [string][] => [['体/体_01.png'], [mouth]];
    expect(hashes['character:b/full/angry/right']).toBe(
      legacyImported(
        im,
        [
          angry('口/口_00.0.png'),
          angry('口/口_00.png'),
          angry('口/口_00.1.png'),
          angry('口/口_00.0.png'),
        ],
        false,
      ),
    );
    // asymmetric layered art on both sides: twins, offsets, gaze, mouth and blink frames
    const rich = join(root, 'chars', 'rich');
    for (const [key, side] of [
      ['d', 'right'],
      ['e', 'left'],
    ] as const)
      for (const f of RICH_FACES)
        expect(hashes[`character:${key}/full/${f}/${side}`], `${key} ${f}`).toBe(
          legacyLayered(rich, 'full', f, side),
        );
    // every YMM4 slot kind, four middle mouth frames, flipped on one side only
    const im2 = join(root, 'chars', 'imported2');
    for (const [key, side] of [
      ['f', 'right'],
      ['g', 'left'],
    ] as const)
      for (const f of ['neutral', 'smile'])
        expect(hashes[`character:${key}/full/${f}/${side}`], `${key} ${f}`).toBe(
          legacyImportedOf(im2, f, side),
        );
    const cl = join(root, 'chars', 'classic');
    for (const f of readdirSync(cl)) expect(hashes[`character:c/${f}`]).toBe(fileHash(join(cl, f)));
  });
});
