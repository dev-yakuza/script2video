/** `s2v snapshot --frozen-audio --frames` (S6 plan): the stills' files and index, and failures. */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Timeline } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import { dropResult, framesPlan } from '../src/snapshot.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('framesPlan', () => {
  it('numbers the stills over the video and says where and why each one is', () => {
    const timeline = {
      fps: 30,
      scenes: [
        { id: 'a', title: 'A', startFrame: 0 },
        { id: 'b', title: 'B', startFrame: 300 },
      ],
    } as unknown as Timeline;
    const meta = {
      output: 'youtube',
      lang: 'ko',
      draft: false,
      s2v_version: '0.5.0+abc',
      script_sha256: 'f'.repeat(64),
    };
    const { index, stills } = framesPlan(
      timeline,
      [
        { id: 'a', points: [{ frame: 20, reasons: ['start'] }] },
        {
          id: 'b',
          points: [
            { frame: 20, reasons: ['start'] },
            { frame: 45, reasons: ['cue:"x"'] },
          ],
          capped: { total: 14 },
        },
      ],
      meta,
    );
    expect(stills.map((s) => s.file)).toEqual(['000-a-20.png', '001-b-20.png', '002-b-45.png']);
    expect(index).toMatchObject({ ...meta, fps: 30, scale: 1 });
    expect(index.scenes[1]).toEqual({
      id: 'b',
      title: 'B',
      startFrame: 300,
      frames: [
        { file: '001-b-20.png', frame: 20, seconds: 10.667, reasons: ['start'] },
        { file: '002-b-45.png', frame: 45, seconds: 11.5, reasons: ['cue:"x"'] },
      ],
      capped: { total: 14 },
    });
    expect(JSON.stringify(index)).not.toMatch(/20\d\d-\d\d-\d\d/); // no clock time
  });
});

describe('dropResult', () => {
  it('removes a file or folder, nothing that is not there, never through a link', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 's2v-drop-')));
    mkdirSync(join(dir, 'f.frames'));
    writeFileSync(join(dir, 'f.frames', 'x.png'), '');
    dropResult(join(dir, 'f.frames'));
    expect(existsSync(join(dir, 'f.frames'))).toBe(false);
    dropResult(join(dir, 'gone.png'));
    mkdirSync(join(dir, 'elsewhere'));
    symlinkSync(join(dir, 'elsewhere'), join(dir, 'link.frames'));
    expect(() => dropResult(join(dir, 'link.frames'))).toThrow(/is a link/);
    expect(existsSync(join(dir, 'elsewhere'))).toBe(true);
  });
});

describe('snapshot --frozen-audio', { timeout: 60_000 }, () => {
  it('fails without synthesizing, and leaves no result from the last run', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 's2v-frozen-')));
    const script = join(root, 'v', 'script.ko.md');
    mkdirSync(dirname(script));
    writeFileSync(
      script,
      '---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#a}\n\nhost: 안녕하세요.\n',
    );
    const out = join(root, 'out');
    mkdirSync(join(out, 'youtube.ko.frames'), { recursive: true });
    writeFileSync(join(out, 'youtube.ko.snapshot.png'), 'last run');
    let status = 0;
    let err = '';
    try {
      execFileSync(
        'node',
        [
          join(REPO, 'packages/cli/dist/main.js'),
          'snapshot',
          script,
          '--frozen-audio',
          '--frames',
          '--out-dir',
          out,
        ],
        { cwd: REPO, stdio: 'pipe', env: { ...process.env, S2V_TTS: '' } },
      );
    } catch (e) {
      const x = e as { status: number; stderr: Buffer };
      status = x.status;
      err = x.stderr.toString();
    }
    expect(status).toBe(1);
    expect(err).toMatch(/frozen/i);
    expect(err).not.toMatch(/starting|tts-server|synthesiz/i);
    expect(existsSync(join(out, 'youtube.ko.snapshot.png'))).toBe(false);
    expect(existsSync(join(out, 'youtube.ko.frames'))).toBe(false);
    // nothing synthesized (the lock folder itself may be made, as render does)
    const lock = join(dirname(script), 'audio', 'ko');
    expect(existsSync(lock) ? readdirSync(lock).filter((f) => f.endsWith('.wav')) : []).toEqual([]);
  });
});
