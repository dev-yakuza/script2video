/** Images fitted above the bottom subtitles (pilot-1 P2): imageFitBox, subtitleBoxTop. */
import type { TimelineCue } from '@script2video/core';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { driftsOf, KENBURNS_MAX, layerBox } from '../src/remotion/image-layout.js';
import {
  dialogueGeometry,
  imageFitBox,
  SUBTITLE_CLEARANCE,
  subtitleBoxHeight,
  subtitleBoxTop,
  type SubtitleLayoutStyle,
} from '../src/shared.js';

const metrics = (portrait: boolean, style: SubtitleLayoutStyle = {}) =>
  dialogueGeometry({ mode: 'none', left: 0, right: 0, portrait }, style).subtitle;
const wide = { width: 1920, height: 1080, bottom: 0 };
const square = { width: 1080, height: 1080, bottom: 0 };
const band16 = subtitleBoxTop(metrics(false), 1080) - SUBTITLE_CLEARANCE;

describe('subtitleBoxTop', () => {
  it('is the frame height less the gap and the full box', () => {
    const m = metrics(false);
    expect(subtitleBoxTop(m, 1080)).toBeCloseTo(1080 - 64 - subtitleBoxHeight(m));
    expect(subtitleBoxTop(m, 1080)).toBeCloseTo(853.6);
  });
});

describe('imageFitBox', () => {
  it('a portrait image in 16:9 fits above the subtitles, Ken Burns included', () => {
    const b = imageFitBox(wide, [1440, 1920], metrics(false), KENBURNS_MAX);
    expect(b.height).toBeCloseTo(band16);
    expect(b.fh).toBeCloseTo(band16 / KENBURNS_MAX);
    expect(b.fw / b.fh).toBeCloseTo(1440 / 1920);
    // centred in the height above the band: the drifted image ends at the band
    expect((b.height + b.fh * KENBURNS_MAX) / 2).toBeCloseTo(band16);
  });

  it('without Ken Burns it fills the height above the band', () => {
    const b = imageFitBox(wide, [1440, 1920], metrics(false));
    expect(b.fh).toBeCloseTo(band16);
  });

  it('a 4:3 image is fitted too', () => {
    const b = imageFitBox(wide, [1600, 1200], metrics(false), KENBURNS_MAX);
    expect(b.height).toBeCloseTo(band16);
    expect(b.fh).toBeCloseTo(band16 / KENBURNS_MAX);
  });

  it('a 16:9 image covers the frame and stays full-bleed', () => {
    for (const size of [
      [1920, 1080],
      [3840, 2160],
      [1280, 720],
    ] as [number, number][])
      expect(imageFitBox(wide, size, metrics(false), KENBURNS_MAX)).toEqual({
        fit: 1920 / size[0],
        fw: 1920,
        fh: 1080,
        height: 1080,
      });
  });

  it('a near-16:9 image counts as covering (no bars on every side)', () => {
    for (const size of [
      [1366, 768],
      [1920, 1082],
      [1920, 1078],
      [1344, 768],
    ] as [number, number][]) {
      const b = imageFitBox(wide, size, metrics(false), KENBURNS_MAX);
      const fit = Math.min(1920 / size[0], 1080 / size[1]);
      expect(b).toEqual({ fit, fw: size[0] * fit, fh: size[1] * fit, height: 1080 });
    }
  });

  it('a 21:9 image (letterboxed, reaching the band) moves above it', () => {
    const b = imageFitBox(wide, [2520, 1080], metrics(false), KENBURNS_MAX);
    expect(b.height).toBeCloseTo(band16);
    expect(b.fh * KENBURNS_MAX).toBeLessThanOrEqual(band16 + 1e-9);
    expect(b.fw).toBeLessThan(1920);
  });

  it('a letterboxed image clear of the band is unchanged', () => {
    const b = imageFitBox(wide, [4000, 1000], metrics(false), KENBURNS_MAX);
    expect(b).toEqual({ fit: 0.48, fw: 1920, fh: 480, height: 1080 });
  });

  it('subtitles in the middle or at the top change nothing', () => {
    for (const position of ['middle', 'top'] as const) {
      const b = imageFitBox(wide, [1440, 1920], metrics(false, { position }), KENBURNS_MAX);
      expect(b).toEqual({ fit: 0.5625, fw: 810, fh: 1080, height: 1080 });
    }
  });

  it('an area that already reserves the bottom, or no subtitles, changes nothing', () => {
    const reserved = { width: 1920, height: 830, bottom: 250 };
    const b = imageFitBox(reserved, [1440, 1920], metrics(false), KENBURNS_MAX);
    expect(b.height).toBe(830);
    expect(b.fh).toBe(830);
    expect(imageFitBox(wide, [1440, 1920], null, KENBURNS_MAX).fh).toBe(1080);
  });

  it('a 1:1 frame takes the band from the portrait metrics', () => {
    const m = metrics(true);
    const band = subtitleBoxTop(m, 1080) - SUBTITLE_CLEARANCE;
    expect(band).toBeCloseTo(1080 - 220 - subtitleBoxHeight(m) - 24);
    // a square image covers a square frame
    expect(imageFitBox(square, [1000, 1000], m, KENBURNS_MAX).height).toBe(1080);
    // a 16:9 image is letterboxed: same width, centred above the band
    const b = imageFitBox(square, [1920, 1080], m, KENBURNS_MAX);
    expect(b.height).toBeCloseTo(band);
    expect(b.fw).toBeCloseTo(1080);
    expect((b.height + b.fh * KENBURNS_MAX) / 2).toBeLessThanOrEqual(band);
    // a portrait image too
    const p = imageFitBox(square, [1440, 1920], m, KENBURNS_MAX);
    expect(p.fh).toBeCloseTo(band / KENBURNS_MAX);
  });
});

describe('layerBox (ImageVisual geometry)', () => {
  const m = metrics(false);
  const cue = (frame: number, attrs: Record<string, string>): TimelineCue => ({
    frame,
    phrase: 'x',
    attrs,
  });
  const fit = (size: [number, number]) => (k: number) => imageFitBox(wide, size, m, k);
  const bottom = (b: { ty: number; h: number }) => b.ty + b.h;

  it('the drifted portrait image ends at the band on the last frame', () => {
    const drifts = driftsOf([], true, 300);
    expect(drifts).toBe(true);
    const first = layerBox(0, [], 1920, fit([1440, 1920]), drifts, 300);
    const last = layerBox(300, [], 1920, fit([1440, 1920]), drifts, 300);
    expect(bottom(first)).toBeLessThan(band16);
    expect(bottom(last)).toBeLessThanOrEqual(band16 + 1e-9);
    expect(bottom(last)).toBeCloseTo(band16);
    expect(last.h / first.h).toBeCloseTo(KENBURNS_MAX);
  });

  it('a cue that moves without zooming stops the drift and stays above the band', () => {
    const cues = [cue(30, { x: '0.5', y: '0.5', mark: 'circle' })];
    expect(driftsOf(cues, true, 300)).toBe(false);
    for (const f of [0, 60, 300]) {
      const b = layerBox(f, cues, 1920, fit([1440, 1920]), false, 300);
      expect(bottom(b)).toBeCloseTo(band16);
      expect(b.ty).toBeCloseTo(0);
    }
  });

  it('a zoom cue fills the area on purpose (the band only bounds the unzoomed fit)', () => {
    const cues = [cue(30, { x: '0.5', y: '0.5', zoom: '2' })];
    const before = layerBox(0, cues, 1920, fit([1440, 1920]), false, 300);
    expect(bottom(before)).toBeCloseTo(band16);
    const zoomed = layerBox(300, cues, 1920, fit([1440, 1920]), false, 300);
    expect(zoomed.h).toBeCloseTo(2 * band16);
  });

  it('kenburns off fits with k = 1 (the full height above the band)', () => {
    expect(driftsOf([], false, 300)).toBe(false);
    const ks: number[] = [];
    const spy = (k: number) => (ks.push(k), fit([1440, 1920])(k));
    const b = layerBox(300, [], 1920, spy, driftsOf([], false, 300), 300);
    expect(ks).toEqual([1]);
    layerBox(300, [], 1920, spy, driftsOf([], true, 300), 300);
    expect(ks).toEqual([1, KENBURNS_MAX]);
    expect(b.h).toBeCloseTo(band16);
    expect(bottom(b)).toBeCloseTo(band16);
  });

  it('Root hands the subtitle metrics to ImageVisual', () => {
    const root = readFileSync(new URL('../src/remotion/Root.tsx', import.meta.url), 'utf8');
    expect(root).toMatch(/<ImageVisual[\s\S]*?subtitle=\{m\}[\s\S]*?\/>/);
  });
});
