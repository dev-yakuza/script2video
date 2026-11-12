import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { envSyncCheck } from '../src/doctor.js';

/**
 * A fake `uv` first on PATH: prints out.txt to stderr (where uv puts the `Would` lines), exits
 * with code.txt, and records its arguments. Like uv under FORCE_COLOR, it colors `Would` unless
 * `--color never` is passed.
 */
const FAKE_UV = `#!/bin/sh
here=$(dirname "$0")
echo "$@" > "$here/args.txt"
if [ -f "$here/sleep.txt" ]; then exec sleep 5; fi
color=1
for a in "$@"; do [ "$a" = never ] && color=0; done
if [ -n "$FORCE_COLOR" ] && [ $color = 1 ]; then
  esc=$(printf '\\033')
  sed "s/^Would/$esc[1mWould$esc[0m/" "$here/out.txt" >&2
else
  cat "$here/out.txt" >&2
fi
echo "Resolved 89 packages"
exit $(cat "$here/code.txt")
`;

describe('envSyncCheck (uv sync --dry-run)', () => {
  let bin: string;
  let project: string;
  const savedPath = process.env.PATH;
  const savedColor = process.env.FORCE_COLOR;
  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), 's2v-fake-uv-'));
    project = mkdtempSync(join(tmpdir(), 's2v-project-'));
    writeFileSync(join(bin, 'uv'), FAKE_UV, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`;
  });
  afterEach(() => {
    rmSync(join(bin, 'sleep.txt'), { force: true });
    if (savedColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = savedColor;
  });
  afterAll(() => {
    process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });
  const uv = (out: string, code = 0) => {
    writeFileSync(join(bin, 'out.txt'), out);
    writeFileSync(join(bin, 'code.txt'), String(code));
    return envSyncCheck(project);
  };

  it('in sync: ok, with a dry run that changes nothing and needs no network', async () => {
    const r = await uv('Would use project environment at: .venv\nWould make no changes\n');
    expect(r.state).toBe('ok');
    expect(readFileSync(join(bin, 'args.txt'), 'utf8').trim()).toBe(
      'sync --frozen --offline --inexact --dry-run --color never',
    );
  });

  it('a replaced environment is stale even though "no changes" is printed (packages only)', async () => {
    const r = await uv(
      'Using CPython 3.12.16\nWould replace project environment at: .venv\nWould make no changes\n',
    );
    expect(r).toEqual({
      state: 'stale',
      detail:
        'Would replace project environment at: .venv: Python or the lock changed since the environment was made',
    });
  });

  it('a missing environment says "not created"', async () => {
    const r = await uv(
      'Would create project environment at: .venv\nWould download 4 packages\nWould install 57 packages\n',
    );
    expect(r).toEqual({ state: 'missing', detail: 'not created' });
  });

  it('packages to install (or uninstall, download) are stale', async () => {
    for (const line of [
      'Would install 2 packages',
      'Would uninstall 1 package',
      'Would download 1 package',
    ]) {
      const r = await uv(`Would use project environment at: .venv\n${line}\n + numpy==2.5.4\n`);
      expect(r.state).toBe('stale');
      expect(r.detail.startsWith(`${line}: `)).toBe(true);
    }
  });

  it('a failed run shows its error line and the cause after it', async () => {
    const r = await uv(
      'warning: something\nerror: Failed to parse `uv.lock`\n  Caused by: x\n  cause: TOML parse error\n',
      2,
    );
    expect(r).toEqual({
      state: 'error',
      detail: 'error: Failed to parse `uv.lock` cause: TOML parse error',
    });
    // no error line: the last line printed
    const r2 = await uv('something went wrong\n', 1);
    expect(r2).toEqual({ state: 'error', detail: 'something went wrong' });
  });

  it('exit ≠ 0 is judged before the Would lines', async () => {
    const r = await uv('Would replace project environment at: .venv\nerror: no interpreter\n', 1);
    expect(r).toEqual({ state: 'error', detail: 'error: no interpreter' });
  });

  it('reads the lines without ANSI codes under FORCE_COLOR', async () => {
    process.env.FORCE_COLOR = '1';
    const r = await uv('Would replace project environment at: .venv\nWould make no changes\n');
    expect(r.state).toBe('stale');
    expect(r.detail).not.toContain('\x1b');
  });

  it('gives up after timeoutMs', async () => {
    writeFileSync(join(bin, 'sleep.txt'), '');
    const t = Date.now();
    const r = await envSyncCheck(project, 'uv', 200);
    expect(r.state).toBe('error');
    expect(r.detail).toMatch(/took over 0.2 s/);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('a missing uv is an error, not a crash', async () => {
    const r = await envSyncCheck(project, join(bin, 'no-such-uv'));
    expect(r.state).toBe('error');
    expect(r.detail).toMatch(/not found/);
  });
});
