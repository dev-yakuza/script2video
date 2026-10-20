/** `render --watermark proxy` (S13 plan): the band, where it goes, and that it is in the video. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from '@script2video/core';
import { imageSize } from '@script2video/renderer-remotion';
import { describe, expect, it } from 'vitest';
import { concatAndMux } from '../src/media.js';
import { writeThumbnail } from '../src/publish.js';
import { crc32, proxyPlacement, proxyPng, proxySize, writeProxyPng } from '../src/watermark.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const probe = (args: string[]) =>
  execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' }).trim();

/** Mean V (red pushes it up) of a region of the frame at `t` seconds. */
function meanV(file: string, crop: string, t = 0.5): number {
  const dir = mkdtempSync(join(tmpdir(), 's2v-v-'));
  const txt = join(dir, 'v.txt');
  ff([
    '-ss',
    String(t),
    '-i',
    file,
    '-frames:v',
    '1',
    '-vf',
    `crop=${crop},signalstats,metadata=mode=print:key=lavfi.signalstats.VAVG:file=${txt}`,
    '-f',
    'null',
    '-',
  ]);
  return Number(/VAVG=([\d.]+)/.exec(readFileSync(txt, 'utf8'))![1]);
}

// pure work, but past 5 s beside the other test files on a busy machine
describe('the PROXY band', { timeout: 30_000 }, () => {
  it('is a PNG the size the plan says, the same bytes each time', () => {
    expect(crc32(Buffer.from('IEND')).toString(16)).toBe('ae426082');
    expect(proxySize(1920)).toEqual({ w: 461, h: 115, k: 11 });
    expect(proxySize(1280)).toEqual({ w: 307, h: 77, k: 7 });
    expect(proxySize(1080)).toEqual({ w: 259, h: 65, k: 6 });
    expect(proxySize(540)).toEqual({ w: 130, h: 33, k: 3 });
    const dir = mkdtempSync(join(tmpdir(), 's2v-mark-'));
    const png = writeProxyPng(dir, 1920);
    expect(imageSize(png)).toEqual([461, 115]);
    expect(proxyPng(1920).equals(proxyPng(1920))).toBe(true);
    expect(probe(['-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', png])).toBe('rgba');
    // decoded to the end, not only its header (several stored blocks at this width)
    for (const w of [540, 1920, 3840]) ff(['-i', writeProxyPng(dir, w), '-f', 'null', '-']);
  });

  it('goes to the corner away from the logo, down when subtitles are on top, on even pixels', () => {
    expect(proxyPlacement(1920, 1080, 'top-right', false)).toEqual({ x: 38, y: 38 });
    expect(proxyPlacement(1920, 1080, null, false)).toEqual({ x: 38, y: 38 });
    expect(proxyPlacement(1920, 1080, 'bottom-left', false).x).toBe(1420);
    expect(proxyPlacement(1920, 1080, 'top-left', false)).toEqual({
      x: 1420, // 1920 - 461 - 38 = 1421, rounded down to even
      y: 38,
    });
    expect(proxyPlacement(1080, 1920, 'bottom-right', true)).toEqual({
      x: 22,
      y: 1832,
    });
    for (const p of [
      proxyPlacement(540, 960, 'top-left', true),
      proxyPlacement(960, 540, null, false),
    ])
      expect([p.x % 2, p.y % 2]).toEqual([0, 0]);
  });
});

describe('the band in the video', { timeout: 120_000 }, () => {
  it('re-encodes every frame with the band, one video stream, the same length', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 's2v-mux-')));
    // two chunks made like the renderer's (H.264, yuv420p, 30 fps, one closed GOP each)
    for (const n of [0, 1])
      ff([
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=320x180:r=30:d=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-bf',
        '0',
        '-g',
        '100000',
        '-video_track_timescale',
        '15360',
        join(dir, `c${n}.mp4`),
      ]);
    ff(['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '2', join(dir, 'a.wav')]);
    const chunks = [join(dir, 'c0.mp4'), join(dir, 'c1.mp4')];
    const plain = join(dir, 'plain.mp4');
    const marked = join(dir, 'marked.proxy.mp4');
    await concatAndMux(chunks, join(dir, 'a.wav'), plain, dir);
    const at = proxyPlacement(320, 180, 'top-right', false);
    await concatAndMux(chunks, join(dir, 'a.wav'), marked, dir, {
      png: writeProxyPng(dir, 320),
      ...at,
    });
    const frames = (f: string) =>
      probe([
        '-select_streams',
        'v',
        '-count_packets',
        '-show_entries',
        'stream=nb_read_packets',
        '-of',
        'csv=p=0',
        f,
      ]);
    expect(frames(marked)).toBe(frames(plain));
    expect(
      probe(['-show_entries', 'stream=codec_type', '-of', 'csv=p=0', marked]).split('\n'),
    ).toEqual(['video', 'audio']);
    const { w, h } = proxySize(320);
    const band = `${w}:${h}:${at.x}:${at.y}`;
    expect(meanV(marked, band, 1.5) - meanV(plain, band, 1.5)).toBeGreaterThan(20);
    // the opposite corner is untouched (within encoding noise)
    const away = `${w}:${h}:${320 - w}:${180 - h}`;
    expect(Math.abs(meanV(marked, away) - meanV(plain, away))).toBeLessThan(2);
  });

  it('the thumbnail from a picture gets it too', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 's2v-thumb-')));
    ff(['-f', 'lavfi', '-i', 'color=c=gray:s=640x360', '-frames:v', '1', join(dir, 'pic.png')]);
    const script = parseScript(
      '---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#a}\n\n::thumbnail{src=pic.png}\n\nhost: 안녕.\n',
    ).script!;
    const opts = {} as Parameters<typeof writeThumbnail>[2];
    const plain = await writeThumbnail(script, dir, opts, join(dir, 'plain.png'));
    const at = proxyPlacement(1280, 720, null, false);
    const marked = await writeThumbnail(script, dir, opts, join(dir, 'marked.png'), {
      png: writeProxyPng(dir, 1280),
      ...at,
    });
    const band = `${proxySize(1280).w}:${proxySize(1280).h}:${at.x}:${at.y}`;
    expect(meanV(marked, band, 0) - meanV(plain, band, 0)).toBeGreaterThan(20);
    expect(probe(['-show_entries', 'stream=pix_fmt', '-of', 'csv=p=0', marked])).toBe('rgb24');
  });

  it('render takes --watermark proxy only', () => {
    let status = 0;
    try {
      execFileSync(
        'node',
        [
          join(REPO, 'packages/cli/dist/main.js'),
          'render',
          'videos/sample-ko/script.ko.md',
          '--watermark',
          'nope',
        ],
        { cwd: REPO, stdio: 'pipe' },
      );
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
  });
});
