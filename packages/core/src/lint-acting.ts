/**
 * Lint of the voice attributes (acting stage 2 plan 5): what each engine does with `emo`, `power`,
 * `say` and `speed`, and emotion faces a character cannot draw. Errors that make a script
 * unreadable are the parser's; these are about effects.
 */

import {
  emotionFace,
  emotionSentence,
  actsEmotion,
  engineOf,
  listenerLookFaces,
  paragraphActing,
  sentenceFace,
  speakerLooks,
  speedProduct,
  SUPERTONIC_SPEED as SUPERTONIC,
} from './acting.js';
import type { Diagnostic } from './diagnostics.js';
import type { Script } from './schema.js';
import { sidesOf, stageEvents } from './stage.js';
import { sceneFramings } from './timeline.js';

export { sidesOf };

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
        if (!b.audio && a.emo !== undefined && !actsEmotion(engine))
          push({
            severity: 'info',
            code: 'acting-voice',
            message:
              engine === 'persona'
                ? `${b.cast} (${member.voice}) cannot act emotions as a clone: emo=${a.emo} changes the face and motion only — train it (s2v voice train) and set personaModel: trained`
                : `${b.cast} (${member.voice}) cannot act emotions: emo=${a.emo} changes the face and motion only`,
            line,
          });
        if (!b.audio && a.say !== undefined && engine === 'supertonic')
          push({
            severity: 'warning',
            code: 'acting-voice',
            message: `${b.cast} (${member.voice}): say is ignored (Supertonic takes no instruction)`,
            line,
          });
        // on an emotion line power picks the weakest / strongest take (stage 3)
        if (!b.audio && a.power !== undefined && actsEmotion(engine) && !emotionSentence(engine, a))
          push({
            severity: 'info',
            code: 'acting-power',
            message: `power=${a.power} has no effect with emo=${a.emo}`,
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
  lintLooks(script, push);
  return out;
}

/**
 * `:look` (acting stage 5b plan 5), per output in character mode: a look on a cast with no line
 * or reaction in the output (never on stage), on the speaker's own side (not shown unless it
 * reacts there too), a listener's glance (looks like its default stance), a variant the character
 * cannot draw, and the speaker's looks inside a sentence (from the next one; dropped in the last).
 */
function lintLooks(script: Script, push: (d: Diagnostic) => void): void {
  const { meta } = script;
  for (const [name, profile] of Object.entries(meta.outputs)) {
    // entrances and exits (acting stage 5c plan 6)
    const stage = stageEvents(script, name);
    for (const d of stage.diagnostics) push(d);
    const scenes = script.scenes.filter((s) => !profile.scenes || profile.scenes.includes(s.id));
    const paragraphs = scenes.flatMap((s, i) =>
      s.blocks.flatMap((b) =>
        b.kind === 'paragraph' && (!b.only || b.only.includes(name)) ? [{ b, i }] : [],
      ),
    );
    // the cast of the output as the renderer sees it: speakers and reaction targets, cast order
    const on = new Set(
      paragraphs.flatMap(({ b }) => [
        b.cast,
        ...b.sentences.flatMap((s) => (s.reacts ?? []).flatMap((r) => Object.keys(r.faces))),
      ]),
    );
    const cast = Object.keys(meta.cast).filter((k) => on.has(k));
    if (cast.length === 0 || !cast.every((k) => meta.cast[k]!.character)) continue;
    const side = sidesOf(cast.map((key) => ({ key, side: meta.cast[key]!.side })));
    const framings = sceneFramings(meta, scenes, profile);
    const facingEmpty = new Set<string>();
    for (const { b, i } of paragraphs) {
      const framing = (k: string) => framings[i]![k] ?? 'full';
      const away = stage.absent.get(b) ?? new Set<string>();
      const across = side[b.cast] === 'left' ? 'right' : 'left';
      const sceneKey = `${scenes[i]!.id}|${b.cast}`;
      const faces = b.sentences.some((x) => x.looks?.some((l) => l.looks[b.cast] === 'viewer'));
      if (stage.empty.get(b)?.has(across) && !faces && !facingEmpty.has(sceneKey)) {
        facingEmpty.add(sceneKey);
        push({
          severity: 'info',
          code: 'look-empty-side',
          message: `nobody stands on the ${across} side while ${b.cast} speaks here, so its partner stance faces an empty side: :look{${b.cast}=viewer} turns it to the viewer (output "${name}")`,
          line: b.line,
        });
      }
      const { mid, dropped } = speakerLooks(b);
      for (const line of mid)
        push({
          severity: 'info',
          code: 'look-midsentence',
          message: `${b.cast}'s own :look inside a sentence applies from the next sentence (faces change at sentence starts)`,
          line: line ?? b.line,
        });
      for (const line of dropped)
        push({
          severity: 'warning',
          code: 'look-dropped',
          message: `${b.cast}'s own :look inside the paragraph's last sentence has no sentence to apply to (dropped)`,
          line: line ?? b.line,
        });
      for (const f of paragraphActing(meta, b, framing(b.cast)).faces)
        if (f.missing) variant(b.cast, f.missing, framing(b.cast), b.line);
      const reacting = new Set(
        b.sentences.flatMap((s) => (s.reacts ?? []).flatMap((r) => Object.keys(r.faces))),
      );
      for (const s of b.sentences)
        for (const l of s.looks ?? [])
          for (const [who, look] of Object.entries(l.looks)) {
            if (who === b.cast) continue;
            const line = l.line ?? b.line;
            if (away.has(who)) {
              push({
                severity: 'info',
                code: 'look-absent',
                message: `${who} has exited (::exit) by this line in output "${name}", so it is not on stage: :look{${who}=…} shows nothing`,
                line,
              });
              continue;
            }
            if (!on.has(who)) {
              push({
                severity: 'info',
                code: 'look-absent',
                message: `${who} has no line or reaction in output "${name}", so it is never on stage: :look{${who}=…} shows nothing`,
                line,
              });
              continue;
            }
            if (side[who] === side[b.cast] && !reacting.has(who))
              push({
                severity: 'warning',
                code: 'look-side',
                message: `${who} stands on ${b.cast}'s side, which shows the speaker: :look{${who}=…} is not seen (unless ${who} reacts there)`,
                line,
              });
            if (look === 'glance')
              push({
                severity: 'info',
                code: 'look-glance-listener',
                message: `glance turns only the head toward the partner, which a listener already faces: :look{${who}=glance} looks ${framing(who) === 'head' && !('any' in (meta.cast[who]?.faceSets ?? {})) ? 'the same as' : 'almost like'} its default stance (glance pairs with viewer)`,
                line,
              });
          }
      for (const l of listenerLookFaces(meta, b, framing))
        if (l.face !== l.wanted && on.has(l.cast) && meta.cast[l.cast]?.faceSets)
          variant(l.cast, l.wanted, framing(l.cast), b.line);
    }
  }

  function variant(who: string, face: string, framing: string, line: number) {
    const sets = meta.cast[who]?.faceSets;
    push({
      severity: 'info',
      code: 'look-variant',
      message: `${who} has no drawable "${face}" face in the ${framing} framing: the look keeps the face as it is${sets && 'any' in sets ? ` (add ${face}.png to the character folder)` : ' (s2v character missing lists faces to make)'}`,
      line,
    });
  }
}
