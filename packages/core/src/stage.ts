/**
 * Who stands on stage (acting stage 5c): the scenes an output keeps, its cast and sides, and the
 * `::enter` / `::exit` that take effect. Shared by the timeline and lint, so an ignored entrance
 * neither delays the first line nor slides. No imports of other core modules but types, so the
 * timeline, lint and inspect can all use it.
 */

import type { Diagnostic } from './diagnostics.js';
import type { OutputProfile, Paragraph, Scene, Script } from './schema.js';

/** Seconds a face is held after its line or reaction ends (renderer FACE_HOLD at 30 fps). */
export const FACE_HOLD_S = 2 / 3;
/** Seconds an entrance or exit slides (renderer STAGE_SLIDE). */
export const STAGE_SLIDE_S = 0.5;
/** Seconds of a fade transition (renderer FADE_FRAMES). */
export const FADE_S = 0.3;
/** Seconds a holding motion takes to ease out after its face hold (renderer HOLD_END). */
export const HOLD_END_S = 0.4;
/** Motions that hold their pose until the face hold ends (renderer `held`). */
export const HELD_MOTIONS: ReadonlySet<string> = new Set(['sink', 'lean', 'head-tilt']);

export type Side = 'left' | 'right';

/** The scenes an output keeps, blocks untouched (sentence ids count the original blocks). */
export function selectScenes(script: Script, profile: OutputProfile): Scene[] {
  const wanted = profile.scenes ? new Set(profile.scenes) : null;
  return script.scenes.filter((s) => !wanted || wanted.has(s.id));
}

export function includesParagraph(p: Paragraph, output: string): boolean {
  return !p.only || p.only.includes(output);
}

/** The scenes of one output with the paragraphs it leaves out (`:only`) removed. */
export function outputScenes(script: Script, output: string): Scene[] {
  const profile = script.meta.outputs[output] ?? {};
  return selectScenes(script, profile as OutputProfile).map((s) => ({
    ...s,
    blocks: s.blocks.filter((b) => b.kind !== 'paragraph' || includesParagraph(b, output)),
  }));
}

/** Cast members who speak or react anywhere in these scenes (paragraphs already filtered). */
export function castsIn(scenes: Scene[]): Set<string> {
  const out = new Set<string>();
  for (const s of scenes)
    for (const b of s.blocks)
      if (b.kind === 'paragraph') {
        out.add(b.cast);
        for (const sen of b.sentences)
          for (const r of sen.reacts ?? []) for (const k of Object.keys(r.faces)) out.add(k);
      }
  return out;
}

/** Sides as the renderer assigns them (`assignSides`): `side` wins, the rest alternate in cast order. */
export function sidesOf(cast: { key: string; side?: Side | undefined }[]): Record<string, Side> {
  let left = 0;
  let right = 0;
  const out: Record<string, Side> = {};
  for (const c of cast) {
    const s = c.side ?? (left <= right ? 'left' : 'right');
    if (s === 'left') left++;
    else right++;
    out[c.key] = s;
  }
  return out;
}

export interface StageEvent {
  kind: 'enter' | 'exit';
  cast: string;
}

export interface StageResult {
  /** The output draws characters (every cast member of it has one): entrances and exits show. */
  characterMode: boolean;
  side: Record<string, Side>;
  /** The entrances and exits that take effect, by scene id (enter first). */
  events: Map<string, StageEvent[]>;
  /** Cast members away (after an exit) while a paragraph plays. */
  absent: Map<Paragraph, Set<string>>;
  /** Sides nobody stands on while a paragraph plays. */
  empty: Map<Paragraph, Set<Side>>;
  diagnostics: Diagnostic[];
}

/**
 * The stage of one output in order (plan 3): stage events are lines, reactions, entrances and
 * exits. A side starts with its first speaker (else its first reactor), as the renderer does,
 * unless that cast's first event is an entrance. Problems only warn and keep the usual behavior:
 * an output that picks scenes cuts entrances and exits apart.
 */
export function stageEvents(script: Script, output: string): StageResult {
  const { meta } = script;
  const scenes = outputScenes(script, output);
  const talkers = castsIn(scenes);
  const cast = Object.keys(meta.cast).filter((k) => talkers.has(k));
  const characterMode = cast.length > 0 && cast.every((k) => meta.cast[k]!.character);
  const side = sidesOf(cast.map((key) => ({ key, side: meta.cast[key]!.side })));
  const result: StageResult = {
    characterMode,
    side,
    events: new Map(),
    absent: new Map(),
    empty: new Map(),
    diagnostics: [],
  };
  const warn = (severity: Diagnostic['severity'], code: string, message: string, line: number) =>
    result.diagnostics.push({ severity, code, message: `${message} (output "${output}")`, line });
  const directives = scenes.flatMap((s) => s.stage ?? []);
  if (directives.length === 0) return result;
  if (!characterMode) {
    for (const d of directives)
      warn(
        'info',
        'stage-avatar',
        `::${d.kind}{${d.cast}} shows nothing: this output draws no characters`,
        d.line,
      );
    return result;
  }

  // Entrances that can take effect, by scene: the checks that do not depend on who stands
  // where. Only these count as stage events (an ignored one must not empty a side).
  const order = Object.keys(meta.cast);
  const candidates = new Map<Scene, NonNullable<Scene['stage']>>();
  for (const s of scenes) {
    const enters = (s.stage ?? []).filter((d) => d.kind === 'enter');
    // Two entrances on one side: the later cast (cast order) takes it.
    const lastOnSide = new Map<Side, string>();
    for (const d of [...enters].sort((a, b) => order.indexOf(a.cast) - order.indexOf(b.cast)))
      if (talkers.has(d.cast)) lastOnSide.set(side[d.cast]!, d.cast);
    const firstSpeaker = new Map<Side, string>();
    for (const b of s.blocks)
      if (b.kind === 'paragraph' && !firstSpeaker.has(side[b.cast]!))
        firstSpeaker.set(side[b.cast]!, b.cast);
    const ok: NonNullable<Scene['stage']> = [];
    for (const d of enters) {
      const sd = side[d.cast];
      if (!sd || !talkers.has(d.cast)) {
        warn(
          'warning',
          'stage-silent',
          `${d.cast} has no line or reaction in this output: ::enter{${d.cast}} is ignored`,
          d.line,
        );
        continue;
      }
      if (lastOnSide.get(sd) !== d.cast) {
        warn(
          'warning',
          'enter-side-order',
          `${d.cast} and ${lastOnSide.get(sd)} enter the same side (${sd}) in one scene: only ${lastOnSide.get(sd)} enters`,
          d.line,
        );
        continue;
      }
      // Another speaker of that side first would take the side right away (it steps in as usual).
      const fs = firstSpeaker.get(sd);
      if (fs && fs !== d.cast) {
        warn(
          'warning',
          'enter-side-order',
          `${fs} speaks on the ${sd} side of this scene before ${d.cast}: ::enter{${d.cast}} is ignored (${fs} steps in as usual)`,
          d.line,
        );
        continue;
      }
      ok.push(d);
    }
    candidates.set(s, ok);
  }

  // Each cast member's first stage event, and each side's first occupant (renderer rule).
  type Ev = { kind: 'line' | 'react' | 'enter' | 'exit'; cast: string };
  const firstEvent = new Map<string, Ev['kind']>();
  const note = (e: Ev) => {
    if (!firstEvent.has(e.cast)) firstEvent.set(e.cast, e.kind);
  };
  const firstOf: Record<Side, { line?: string; react?: string }> = { left: {}, right: {} };
  for (const s of scenes) {
    for (const d of candidates.get(s)!) note(d);
    for (const b of s.blocks) {
      if (b.kind !== 'paragraph') continue;
      note({ kind: 'line', cast: b.cast });
      firstOf[side[b.cast]!].line ??= b.cast;
      for (const sen of b.sentences)
        for (const r of sen.reacts ?? [])
          for (const k of Object.keys(r.faces)) {
            note({ kind: 'react', cast: k });
            firstOf[side[k]!].react ??= k;
          }
    }
    for (const d of s.stage ?? []) if (d.kind === 'exit') note(d);
  }
  const occupant: Record<Side, string | null> = { left: null, right: null };
  for (const sd of ['left', 'right'] as const) {
    const first = firstOf[sd].line ?? firstOf[sd].react ?? null;
    occupant[sd] = first && firstEvent.get(first) === 'enter' ? null : first;
  }

  const absent = new Set<string>();
  const seenOnStage = new Set<string>();
  const warnedAbsent = new Set<string>();
  for (const s of scenes) {
    const valid: StageEvent[] = [];
    const entered = new Set<string>();
    for (const d of candidates.get(s)!) {
      const sd = side[d.cast]!;
      const isFirst = firstEvent.get(d.cast) === 'enter' && !seenOnStage.has(d.cast);
      if (!isFirst && occupant[sd] === d.cast) {
        warn(
          'warning',
          'enter-occupant',
          `${d.cast} already stands on the ${sd} side: ::enter{${d.cast}} is ignored`,
          d.line,
        );
        continue;
      }
      occupant[sd] = d.cast;
      absent.delete(d.cast);
      warnedAbsent.delete(d.cast);
      entered.add(d.cast);
      valid.push({ kind: 'enter', cast: d.cast });
    }
    for (const c of entered) seenOnStage.add(c);
    for (const b of s.blocks) {
      if (b.kind !== 'paragraph') continue;
      result.absent.set(b, new Set(absent));
      const sd = side[b.cast]!;
      if (absent.has(b.cast)) {
        if (!warnedAbsent.has(b.cast))
          warn(
            'warning',
            'stage-absent',
            `${b.cast} exited and speaks again without ::enter{${b.cast}}: it steps in as usual`,
            b.line,
          );
        absent.delete(b.cast);
        warnedAbsent.delete(b.cast);
      }
      occupant[sd] = b.cast;
      seenOnStage.add(b.cast);
      for (const sen of b.sentences)
        for (const r of sen.reacts ?? [])
          for (const k of Object.keys(r.faces)) {
            seenOnStage.add(k);
            if (absent.has(k) && !warnedAbsent.has(k)) {
              warnedAbsent.add(k);
              warn(
                'warning',
                'stage-absent',
                `${k} exited and reacts without ::enter{${k}}: it steps in for the reaction`,
                b.line,
              );
            }
          }
      const empty = new Set<Side>();
      for (const x of ['left', 'right'] as const) if (occupant[x] === null) empty.add(x);
      result.empty.set(b, empty);
    }
    for (const d of (s.stage ?? []).filter((x) => x.kind === 'exit')) {
      const sd = side[d.cast];
      if (!sd || !talkers.has(d.cast)) {
        warn(
          'warning',
          'stage-silent',
          `${d.cast} has no line or reaction in this output: ::exit{${d.cast}} is ignored`,
          d.line,
        );
        continue;
      }
      if (occupant[sd] !== d.cast) {
        warn(
          'warning',
          'exit-not-occupant',
          `${d.cast} does not stand on the ${sd} side at the end of this scene${occupant[sd] ? ` (${occupant[sd]} does)` : ''}: ::exit{${d.cast}} is ignored`,
          d.line,
        );
        continue;
      }
      occupant[sd] = null;
      absent.add(d.cast);
      valid.push({ kind: 'exit', cast: d.cast });
    }
    if (valid.length > 0) result.events.set(s.id, valid);
  }
  return result;
}
