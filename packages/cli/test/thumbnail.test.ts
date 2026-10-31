/** The thumbnail still without `::thumbnail` (pilot-1 P1b): thumbnailTarget and writeThumbnail. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScript, type Timeline, type TimelineScene } from '@script2video/core';
import { describe, expect, it, vi } from 'vitest';

const stills = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock('@script2video/renderer-remotion', async (orig) => ({
  ...(await orig<object>()),
  // stop before ffmpeg: what was asked for is all this test needs
  renderStills: (...args: unknown[]) => {
    stills.calls.push(args);
    return Promise.reject(new Error('rendered'));
  },
}));
const { thumbnailTarget, writeThumbnail } = await import('../src/publish.js');

type Visual = TimelineScene['visuals'][number]['visual'];
const v = (type: string, extra: Partial<Visual> = {}): Visual =>
  ({ kind: 'visual', line: 1, type, attrs: {}, ...extra }) as Visual;
const sub = { startFrame: 0, endFrame: 30, text: 'x' } as unknown as TimelineScene['subtitles'][0];

function scene(id: string, dur: number, visuals: [number, Visual][] = []): TimelineScene {
  return {
    id,
    title: id,
    startFrame: 0,
    durationFrames: dur,
    visuals: visuals.map(([startFrame, visual]) => ({ startFrame, visual })),
    audio: [],
    cues: [],
    subtitles: [sub],
    reactions: [],
    motions: [],
    framing: {},
  } as TimelineScene;
}
const timeline = (...scenes: TimelineScene[]) =>
  ({ fps: 30, output: 'youtube', scenes }) as unknown as Timeline;

describe('thumbnailTarget', () => {
  it('skips a bare scene: the middle of the next scene first visual', () => {
    const t = timeline(
      scene('intro', 900),
      scene('img', 600, [
        [0, v('image', { attrs: { src: 'a.png' } })],
        [400, v('title', { label: 'b' })],
      ]),
    );
    expect(thumbnailTarget(t, false)).toEqual({ sceneId: 'img', frame: 200 });
  });

  it('a title without a label is skipped for the next visual in the scene', () => {
    const t = timeline(
      scene('a', 600, [
        [0, v('title')],
        [200, v('bullets', { items: ['x'] })],
      ]),
    );
    expect(thumbnailTarget(t, false)).toEqual({ sceneId: 'a', frame: 400 });
  });

  it('characters are on screen throughout: scene 0 middle', () => {
    expect(thumbnailTarget(timeline(scene('a', 601), scene('b', 300)), true)).toEqual({
      sceneId: 'a',
      frame: 300,
    });
  });

  it('nothing anywhere: scene 0 middle', () => {
    expect(thumbnailTarget(timeline(scene('a', 500), scene('b', 300)), false)).toEqual({
      sceneId: 'a',
      frame: 250,
    });
  });

  it('keeps out of the fades only with fade transitions', () => {
    // first visual's span [0, 10): middle 5, inside the fade-in
    const t = timeline(
      scene('a', 600, [
        [0, v('title', { label: 'a' })],
        [10, v('title', { label: 'b' })],
      ]),
    );
    expect(thumbnailTarget(t, false, 'fade')).toEqual({ sceneId: 'a', frame: 9 });
    expect(thumbnailTarget(t, false, 'none')).toEqual({ sceneId: 'a', frame: 5 });
    // last visual near the end: clamped to dur − 1 − FADE_FRAMES
    const end = timeline(
      scene('a', 600, [
        [0, v('title')],
        [585, v('title', { label: 'b' })],
      ]),
    );
    expect(thumbnailTarget(end, false, 'fade')).toEqual({ sceneId: 'a', frame: 590 });
    expect(thumbnailTarget(end, false, 'none')).toEqual({ sceneId: 'a', frame: 592 });
  });

  it('a span too short to clear the fades keeps its middle', () => {
    const t = timeline(scene('a', 12, [[0, v('title', { label: 'a' })]]));
    expect(thumbnailTarget(t, false, 'fade')).toEqual({ sceneId: 'a', frame: 6 });
    const late = timeline(
      scene('a', 600, [
        [0, v('title')],
        [594, v('title', { label: 'b' })],
      ]),
    );
    expect(thumbnailTarget(late, false, 'fade')).toEqual({ sceneId: 'a', frame: 597 });
  });
});

describe('writeThumbnail', () => {
  const script = (body: string) =>
    parseScript(`---
lang: ko
outputs:
  youtube: { aspect: "16:9", layout: presenter }
---

${body}`).script!;
  const opts = (t: Timeline) => ({
    timeline: t,
    aspect: '16:9' as const,
    assetsRoot: '.',
    fontsDir: '.',
    workDir: mkdtempSync(join(tmpdir(), 's2v-thumb-')),
  });

  it('renders the chosen scene without its subtitles, the others untouched', async () => {
    stills.calls.length = 0;
    const t = timeline(scene('intro', 900), scene('img', 600, [[0, v('title', { label: 'x' })]]));
    const s = script('# intro {#intro}\n\n안녕.\n\n# img {#img}\n\n::title[x]\n\n둘.\n');
    await expect(writeThumbnail(s, '.', opts(t), join(opts(t).workDir, 'x.png'))).rejects.toThrow(
      'rendered',
    );
    const [o, requests] = stills.calls[0] as [{ timeline: Timeline }, { sceneId: string }[]];
    expect(requests).toMatchObject([{ sceneId: 'img', frame: 300 }]);
    expect(o.timeline.scenes.map((sc) => sc.subtitles.length)).toEqual([1, 0]);
  });

  it('an explicit ::thumbnail is used as it is', async () => {
    stills.calls.length = 0;
    const s = script('# a {#a}\n\n::thumbnail{src="missing.png"}\n\n안녕.\n');
    const t = timeline(scene('a', 300));
    // the image goes straight to ffmpeg (missing here): no still is rendered
    await expect(
      writeThumbnail(s, '/nonexistent', opts(t), join(opts(t).workDir, 'x.png')),
    ).rejects.toThrow();
    expect(stills.calls).toEqual([]);
  });
});
