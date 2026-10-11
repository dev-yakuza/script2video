import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTimeline, parseScript } from '@script2video/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAudioManifest, synthesizeScript } from '../src/tts.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('mock TTS end to end (script → audio lock → timeline)', () => {
  const prev = process.env.S2V_TTS;
  beforeAll(() => {
    process.env.S2V_TTS = 'mock';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.S2V_TTS;
    else process.env.S2V_TTS = prev;
  });

  it('builds a timeline with cues and subtitles for a two-speaker script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-mock-'));
    mkdirSync(join(dir, 'video'));
    const path = join(dir, 'video', 'script.ko.md');
    const source = `---
lang: ko
cast:
  host: { voice: "qwen:Sohee" }
  guest: { voice: "persona:nobody" }
outputs:
  youtube: { aspect: "16:9", layout: dialogue }
---

# 하나 {#one}

:::bullets
- 첫째
- 둘째
:::

host: :cue[첫째]{highlight=0} 항목을 봅니다. 그다음은 둘째입니다.

guest: :react{host=happy}좋아요.
`;
    writeFileSync(path, source);
    const script = parseScript(source).script!;
    const r = await synthesizeScript(path, script, REPO, { asr: false, log: () => {} });
    expect(r.synthesized).toBe(3);
    const manifest = loadAudioManifest(path, 'ko');
    const { timeline, issues } = buildTimeline(script, 'youtube', manifest);
    expect(issues).toEqual([]);
    const scene = timeline.scenes[0]!;
    expect(scene.audio.map((a) => a.cast)).toEqual(['host', 'host', 'guest']);
    expect(scene.cues).toHaveLength(1);
    expect(scene.subtitles.length).toBeGreaterThanOrEqual(3);
    expect(scene.reactions).toHaveLength(1);
    // Second run reuses the locked mock audio.
    const again = await synthesizeScript(path, script, REPO, { asr: false, log: () => {} });
    expect(again).toMatchObject({ synthesized: 0, reused: 3 });
  });
});
