/**
 * Where sound effects play (PLAN 5.9), from the frame-quantized timeline:
 * - a cue's `sfx=<preset>` always plays (`sfx=none` silences the automatic one);
 * - with `sfx: auto`: a visual appearing or an image switch → whoosh, a mark → pop,
 *   a highlighted line / row / bullet → click.
 * The very first visual of the video gets none (it is there from the start).
 */

import type { Script } from './schema.js';
import type { Timeline } from './timeline.js';

export interface SfxEvent {
  /** Absolute video frame. */
  frame: number;
  name: string;
}

export function sfxEvents(script: Script, timeline: Timeline): SfxEvent[] {
  const auto = script.meta.sfx === 'auto';
  const out: SfxEvent[] = [];
  timeline.scenes.forEach((scene, si) => {
    if (auto)
      scene.visuals.forEach((v, vi) => {
        if (si === 0 && vi === 0) return;
        if (v.visual.type === 'thumbnail') return;
        out.push({ frame: scene.startFrame + v.startFrame, name: 'whoosh' });
      });
    for (const c of scene.cues) {
      const frame = scene.startFrame + c.frame;
      const explicit = c.attrs.sfx;
      if (explicit === 'none') continue;
      if (explicit) {
        out.push({ frame, name: explicit });
        continue;
      }
      if (!auto) continue;
      if (c.attrs.show) out.push({ frame, name: 'whoosh' });
      else if (c.attrs.mark) out.push({ frame, name: 'pop' });
      else if (c.attrs.line || c.attrs.row || c.attrs.highlight !== undefined)
        out.push({ frame, name: 'click' });
    }
  });
  return out.sort((a, b) => a.frame - b.frame);
}
