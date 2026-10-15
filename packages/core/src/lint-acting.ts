/**
 * Lint of the voice attributes (acting stage 2 plan 5): what each engine does with `emo`, `power`,
 * `say` and `speed`, and emotion faces a character cannot draw. Errors that make a script
 * unreadable are the parser's; these are about effects.
 */

import {
  emotionFace,
  emotionSentence,
  engineOf,
  sentenceFace,
  speedProduct,
  SUPERTONIC_SPEED as SUPERTONIC,
} from './acting.js';
import type { Diagnostic } from './diagnostics.js';
import type { Script } from './schema.js';
import { sceneFramings } from './timeline.js';

export function lintActing(script: Script): Diagnostic[] {
  const { meta } = script;
  const out: Diagnostic[] = [];
  const once = new Set<string>();
  // the same range tts plans with (every synthesized line, not only those with attributes)
  const speedCheck = (cast: string, speed: number, engine: string, line: number) => {
    if (speed < 0.5 || speed > 2)
      push({
        severity: 'error',
        code: 'speed-range',
        message: `${cast}: speed ${speed.toFixed(3)} (cast × line × emotion) is outside 0.5–2`,
        line,
      });
    else if (engine === 'supertonic' && (speed < SUPERTONIC[0]! || speed > SUPERTONIC[1]!))
      push({
        severity: 'error',
        code: 'speed-range',
        message: `${cast}: speed ${speed.toFixed(3)} is outside what Supertonic takes (${SUPERTONIC[0]!.toFixed(3)}–${SUPERTONIC[1]!.toFixed(3)})`,
        line,
      });
  };
  const push = (d: Diagnostic) => {
    const k = `${d.code}|${d.line}|${d.message}`;
    if (!once.has(k)) {
      once.add(k);
      out.push(d);
    }
  };
  for (const scene of script.scenes)
    for (const b of scene.blocks) {
      if (b.kind !== 'paragraph' || !Object.hasOwn(meta.cast, b.cast)) continue;
      const member = meta.cast[b.cast]!;
      const engine = engineOf(member);
      for (const s of b.sentences) {
        const a = s.acting;
        const line = b.line;
        if (!a) {
          if (!b.audio) speedCheck(b.cast, speedProduct(meta, member, a), engine, line);
          continue;
        }
        if (!b.audio && a.emo !== undefined && engine !== 'qwen')
          push({
            severity: 'info',
            code: 'acting-voice',
            message: `${b.cast} (${member.voice}) cannot act emotions: emo=${a.emo} changes the face and motion only`,
            line,
          });
        if (!b.audio && a.say !== undefined && engine === 'supertonic')
          push({
            severity: 'warning',
            code: 'acting-voice',
            message: `${b.cast} (${member.voice}): say is ignored (Supertonic takes no instruction)`,
            line,
          });
        if (!b.audio && a.power !== undefined && engine === 'qwen')
          push({
            severity: 'info',
            code: 'acting-power',
            message: emotionSentence(engine, a)
              ? `power=${a.power} has no audible effect on qwen voices yet (it will choose among takes)`
              : `power=${a.power} has no effect with emo=${a.emo}`,
            line,
          });
        if (!b.audio) speedCheck(b.cast, speedProduct(meta, member, a), engine, line);
      }
    }
  // emotion faces the character cannot draw: shown with the default face
  for (const [name, profile] of Object.entries(meta.outputs)) {
    const scenes = script.scenes.filter((s) => !profile.scenes || profile.scenes.includes(s.id));
    const framings = sceneFramings(meta, scenes, profile);
    scenes.forEach((scene, i) => {
      for (const b of scene.blocks) {
        if (b.kind !== 'paragraph' || (b.only && !b.only.includes(name))) continue;
        const member = meta.cast[b.cast];
        if (!member?.faceSets || b.face) continue;
        const framing = framings[i]![b.cast] ?? 'full';
        for (const s of b.sentences) {
          const want = emotionFace(meta, s.acting?.emo);
          if (!want) continue;
          const f = sentenceFace(meta, b, s, framing);
          if (f.drawn !== want)
            push({
              severity: 'info',
              code: 'emotion-face',
              message: `${b.cast} has no drawable "${want}" face in the ${framing} framing (missing, or no mouth frames): the line shows "${f.drawn}"${'any' in member.faceSets ? ` (add ${want}.png to the character folder)` : ' (s2v character missing lists faces to make)'}`,
              line: b.line,
            });
        }
      }
    });
  }
  return out;
}
