/**
 * S4b plan R7 without ffmpeg: composition is replaced by a stub, so only the order in which the
 * renderer writes `hashes` (it is part of every chunk key) is checked.
 */
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { characterFixture, EXPECTED_KEYS, renderOptions } from './fixtures/characters.js';

vi.mock('../src/character/compose.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/character/compose.js')>();
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const png = join(mkdtempSync(join(tmpdir(), 's2v-stub-')), 'x.png');
  writeFileSync(png, '');
  const layered = (r: { canvas: [number, number]; baseWidth: number; baseHeight: number }) => ({
    body: png,
    head: { base: png, talk: png, half: png, blink: png },
    pivot: null,
    canvas: r.canvas,
    baseWidth: r.baseWidth,
    baseHeight: r.baseHeight,
    hash: 'stub',
  });
  const imported = () => ({ base: png, talk: png, half: png, blink: png, hash: 'stub' });
  return {
    ...real,
    composeFace: (r: Parameters<typeof layered>[0]) => layered(r),
    composeImported: imported,
    composePlanned: (p: { resolved: Parameters<typeof layered>[0] }) => layered(p.resolved),
    composeImportedPlanned: imported,
  };
});

const { preparePublicDir } = await import('../src/prepare.js');

describe('render hashes order (S4b R7, no ffmpeg)', () => {
  it('writes the keys in the same order', () => {
    const { root, fonts } = characterFixture();
    const { hashes } = preparePublicDir(renderOptions(root, fonts));
    expect(Object.keys(hashes)).toEqual(EXPECTED_KEYS);
  });
});
