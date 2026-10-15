import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Timeline } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import { buildNarration } from '../src/media.js';
import { writePcm16 } from '../src/pauses.js';

/** One second of a 220 Hz tone at 48 kHz. */
function tone(path: string, amplitude: number): void {
  const s = new Int16Array(48000);
  for (let i = 0; i < s.length; i++)
    s[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 220 * i) / 48000));
  writePcm16(path, 48000, s);
}

describe('buildNarration', () => {
  it('adds the line gain after the loudness normalization', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-mix-'));
    tone(join(dir, 'a.wav'), 0.3);
    tone(join(dir, 'b.wav'), 0.3);
    const audio = (id: string, src: string, startFrame: number, gain?: number) => ({
      sentenceId: id,
      cast: 'host',
      face: 'neutral',
      src: join(dir, src),
      startFrame,
      durationFrames: 30,
      ...(gain !== undefined ? { gain } : {}),
    });
    const timeline = {
      fps: 30,
      lang: 'ko',
      output: 'youtube',
      totalFrames: 90,
      scenes: [
        {
          id: 's',
          title: '',
          startFrame: 0,
          durationFrames: 90,
          visuals: [],
          audio: [audio('s:0:0', 'a.wav', 0), audio('s:0:1', 'b.wav', 45, -6)],
          cues: [],
          subtitles: [],
          reactions: [],
          motions: [],
          framing: {},
        },
      ],
    } as unknown as Timeline;
    const { gains } = await buildNarration(timeline, join(dir, 'mix.wav'));
    expect(gains['s:0:1']! - gains['s:0:0']!).toBeCloseTo(-6, 1);
  });
});
