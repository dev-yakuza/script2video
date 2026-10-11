/** Speakers of one output, in cast order, as the renderer needs them (PLAN 5.8). */

import type { Script, Timeline } from '@script2video/core';
import { defaultCastColor, type CastOption } from '@script2video/renderer-remotion';

export function castOptions(script: Script, timeline: Timeline): CastOption[] {
  // Speakers, plus listeners who only react (they still appear on screen).
  const speaking = new Set(
    timeline.scenes.flatMap((s) => [...s.audio, ...s.reactions].map((a) => a.cast)),
  );
  return Object.entries(script.meta.cast)
    .map(([key, m], i) => ({ key, m, i }))
    .filter(({ key }) => speaking.has(key))
    .map(({ key, m, i }) => ({
      key,
      name: m.name ?? key,
      color: m.color ?? defaultCastColor(i),
      face: m.face,
      ...(m.avatar ? { avatar: m.avatar } : {}),
      ...(m.character
        ? {
            character:
              typeof m.character === 'string'
                ? { dir: m.character, facing: 'front' as const }
                : m.character,
          }
        : {}),
      ...(m.side ? { side: m.side } : {}),
    }));
}
