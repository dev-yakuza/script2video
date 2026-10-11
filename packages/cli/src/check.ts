/**
 * `s2v check` (PLAN 5.12): lay every subtitle out with the real subtitle component in Chromium
 * and report the ones that need more lines than the box shows (the rest would be hidden).
 *
 * Uses the timeline's subtitle groups when every sentence of the output has audio, otherwise
 * groups from the text alone (no TTS needed).
 */

import {
  buildTimeline,
  sentenceId,
  subtitleStyleFor,
  textSubtitles,
  type AudioManifest,
  type Diagnostic,
  type Script,
  type Timeline,
} from '@script2video/core';
import {
  assignSides,
  dialogueShape,
  measureSubtitleLines,
  stagePlan,
  type Aspect,
  type DialogueShape,
} from '@script2video/renderer-remotion';

interface Item {
  output: string;
  sceneId: string;
  text: string;
  line?: number;
}

function reactingCast(script: Script): string[] {
  return script.scenes.flatMap((s) =>
    s.blocks.flatMap((b) =>
      b.kind === 'paragraph'
        ? b.sentences.flatMap((x) => (x.reacts ?? []).flatMap((r) => Object.keys(r.faces)))
        : [],
    ),
  );
}

/** Largest group per side: from the stage plan (timeline) or each :react point (text only). */
function crowdSizes(
  script: Script,
  cast: { key: string; side?: 'left' | 'right' | undefined }[],
  timeline: Timeline | null,
): Record<'left' | 'right', number> {
  const { left } = assignSides(cast);
  const sideOf = Object.fromEntries(
    cast.map((c) => [c.key, left.some((l) => l.key === c.key) ? 'left' : 'right'] as const),
  );
  const max = { left: 0, right: 0 };
  if (timeline) {
    for (const scene of stagePlan(timeline.scenes, sideOf))
      for (const side of ['left', 'right'] as const)
        for (const sw of scene[side]) max[side] = Math.max(max[side], sw.keys.length);
    return max;
  }
  for (const s of script.scenes)
    for (const b of s.blocks)
      if (b.kind === 'paragraph')
        for (const x of b.sentences)
          for (const r of x.reacts ?? [])
            for (const side of ['left', 'right'] as const) {
              const who = new Set(Object.keys(r.faces).filter((k) => sideOf[k] === side));
              if (sideOf[b.cast] === side) who.add(b.cast);
              max[side] = Math.max(max[side], who.size);
            }
  return max;
}

function hasAllAudio(script: Script, manifest: AudioManifest): boolean {
  return script.scenes.every((scene) =>
    scene.blocks.every(
      (b, bi) =>
        b.kind !== 'paragraph' ||
        b.sentences.every((_, si) => manifest[sentenceId(scene.id, bi, si)] !== undefined),
    ),
  );
}

export async function checkSubtitles(
  script: Script,
  manifest: AudioManifest | undefined,
  opts: { fontsDir: string; workDir: string; assetsRoot: string; log?: (m: string) => void },
): Promise<{ checked: number; source: 'timeline' | 'text'; diagnostics: Diagnostic[] }> {
  const { meta } = script;
  const useTimeline = manifest !== undefined && hasAllAudio(script, manifest);
  // Group by everything that changes the subtitle box: aspect, and dialogue avatars beside it.
  const byGroup = new Map<
    string,
    {
      aspect: Aspect;
      shape: Omit<DialogueShape, 'portrait'>;
      style: ReturnType<typeof subtitleStyleFor>;
      items: Item[];
    }
  >();
  for (const [output, profile] of Object.entries(meta.outputs)) {
    let items: Item[];
    let speakers: Set<string>;
    let timeline: Timeline | null = null;
    if (useTimeline) {
      timeline = buildTimeline(script, output, manifest).timeline;
      items = timeline.scenes.flatMap((s) =>
        s.subtitles.map((st) => ({ output, sceneId: s.id, text: st.text })),
      );
      speakers = new Set(
        timeline.scenes.flatMap((s) => [...s.audio, ...s.reactions].map((a) => a.cast)),
      );
    } else {
      const groups = textSubtitles(script, output);
      items = groups.map((g) => ({ output, sceneId: g.sceneId, text: g.text, line: g.line }));
      speakers = new Set([...groups.map((g) => g.cast), ...reactingCast(script)]);
    }
    const cast = Object.entries(meta.cast)
      .filter(([key]) => speakers.has(key))
      .map(([key, m]) => ({ key, character: m.character, side: m.side }));
    const shape = dialogueShape(profile.layout, cast);
    if (shape.mode === 'character') {
      // Conservative: measure at the most crowded moment (a group reacting beside the box).
      const crowd = crowdSizes(script, cast, timeline);
      shape.left = Math.max(shape.left, crowd.left);
      shape.right = Math.max(shape.right, crowd.right);
    }
    const style = subtitleStyleFor(meta, output);
    const id = `${profile.aspect}/${JSON.stringify(shape)}/${JSON.stringify(style)}`;
    const group = byGroup.get(id) ?? { aspect: profile.aspect, shape, style, items: [] };
    group.items.push(...items);
    byGroup.set(id, group);
  }

  // Measure each distinct text once per group.
  const groups = [...byGroup.values()].map((g) => ({
    ...g,
    texts: [...new Set(g.items.map((i) => i.text))],
  }));
  opts.log?.(
    `measuring ${groups.reduce((n, g) => n + g.texts.length, 0)} subtitles (${useTimeline ? 'timeline' : 'text only'}) ...`,
  );
  const measured = await measureSubtitleLines({
    lang: meta.lang,
    groups: groups.map(({ aspect, shape, style, texts }) => ({ aspect, shape, style, texts })),
    assetsRoot: opts.assetsRoot,
    fontsDir: opts.fontsDir,
    workDir: opts.workDir,
  });

  const diagnostics: Diagnostic[] = [];
  groups.forEach((g, gi) => {
    const result = new Map(g.texts.map((t, i) => [t, measured[gi]![i]!]));
    const reported = new Set<string>();
    for (const item of g.items) {
      const m = result.get(item.text)!;
      if (m.lines <= m.maxLines || reported.has(item.text)) continue;
      reported.add(item.text);
      const outputs = g.items
        .filter((i) => i.text === item.text)
        .map((i) => i.output)
        .filter((o, k, a) => a.indexOf(o) === k);
      diagnostics.push({
        severity: 'error',
        code: 'subtitle-overflow',
        message: `scene "${item.sceneId}" (${outputs.join(', ')}, ${g.aspect}): subtitle needs ${m.lines} lines, only ${m.maxLines} are shown: "${item.text}"`,
        ...(item.line !== undefined ? { line: item.line } : {}),
      });
    }
  });
  return {
    checked: groups.reduce((n, g) => n + g.texts.length, 0),
    source: useTimeline ? 'timeline' : 'text',
    diagnostics,
  };
}
