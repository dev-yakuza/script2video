/**
 * Opening pages (final review 13): one opener for every page s2v writes, and S2V_NO_OPEN keeps
 * all of them closed — the takes / direct pages, `s2v pick <image>` and the character pages.
 * A fake `open` / `xdg-open` first on PATH records what would have been opened.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openPage } from '../src/html.js';
import { pick } from '../src/pick.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC = join(REPO, 'packages/cli/src');

let log = '';
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  const bin = mkdtempSync(join(tmpdir(), 's2v-opener-'));
  log = join(bin, 'opened.log');
  for (const name of ['open', 'xdg-open']) {
    const f = join(bin, name);
    writeFileSync(f, `#!/bin/sh\necho "$1" >> "${log}"\n`);
    chmodSync(f, 0o755);
  }
  saved = { PATH: process.env.PATH, S2V_NO_OPEN: process.env.S2V_NO_OPEN };
  process.env.PATH = `${bin}:${process.env.PATH}`;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved))
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

/** What the fake opener got: waits up to `ms` for a first line (none expected: the full wait). */
const opened = async (ms = 3000) => {
  const end = Date.now() + ms;
  while (!existsSync(log) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
};

describe('openPage', () => {
  it('opens with the platform opener', async () => {
    delete process.env.S2V_NO_OPEN;
    openPage('/tmp/x.html');
    expect(await opened()).toEqual(['/tmp/x.html']);
  });

  it('S2V_NO_OPEN keeps every page closed, s2v pick <image> too', async () => {
    process.env.S2V_NO_OPEN = '1';
    openPage('/tmp/x.html');
    const work = mkdtempSync(join(tmpdir(), 's2v-pick-'));
    const image = join(work, 'a.png');
    writeFileSync(image, 'x');
    pick(image, work);
    expect(await opened(1000)).toEqual([]);
  });

  it('is the only opener: no command spawns open / xdg-open itself', () => {
    for (const f of ['takes-page.ts', 'pick.ts', 'main.ts', 'character-gen/commands.ts'])
      expect(readFileSync(join(SRC, f), 'utf8')).not.toMatch(/'xdg-open'/);
  });

  it('the library reads no test-only switches from the environment (options instead)', () => {
    for (const f of ['voice-train.ts', 'tts.ts'])
      expect(readFileSync(join(SRC, f), 'utf8')).not.toMatch(
        /process\.env\.S2V_(TRAIN_CMD|TRAIN_SHARED_SERVERS|TAKES_ALL)/,
      );
  });
});
