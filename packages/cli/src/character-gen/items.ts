/**
 * The generation graph of a character (plan 4.2, 4.5, C21): which images to make, in which
 * approval round, from which input, with which instruction.
 *
 * What is needed comes from the renderer itself: every face of the full set and of `sets.<f>`
 * is resolved with `resolveFace` on both sides, so the generator makes exactly the
 * (view, body, head, expression) groups the renderer will look for. With `mirror: false` the
 * `@flip` twins are added to the spec first (C10) and resolved like any entry.
 */

import { join } from 'node:path';
import {
  FaceError,
  isSingle,
  resolveFace,
  setOf,
  type Facing,
  type Framing,
  type LayeredSpec,
} from '@script2video/renderer-remotion';
import {
  bodyPrompt,
  candidatePrompt,
  closeupPrompt,
  expressionText,
  flipPrompt,
  framePrompt,
  groupPrompt,
  HEADLESS_PROMPT,
  MOUTH_FRAMES,
  type Frame,
  type Pose,
} from './prompts.js';

export type ItemKind = 'ref' | 'closeup' | 'headless' | 'body' | 'still' | 'frame';

export interface Item {
  /** `[<set>:]<view>/ref`, `<view>/headless`, `<view>/body/<b>`, `<view>/<head>/<expr>[/<frame>]`. */
  id: string;
  set: Framing;
  round: number;
  kind: ItemKind;
  view: string;
  head?: string;
  expr?: string;
  body?: string;
  frame?: Frame;
  /** The item whose approved image is edited. */
  input: string;
  /** Items that must be approved first (the input, and a frame's still). */
  needs: string[];
  /** Seed group: frames share their still's seed (P5). */
  group: string;
  prompt: string;
  /** Where the approved source goes, relative to the character folder (plan 3.1 `_src`). */
  src: string;
  /** Close-ups are cut off by the bottom edge (background removal starts elsewhere). */
  bottomOpen: boolean;
}

export const FRONT_REF = 'front/ref';
export const ROUND_NAMES = [
  '',
  'candidates',
  'view references and close-ups',
  'headless bodies',
  'poses and head variants',
  'expression stills',
  'expression frames',
];

const opposite = (f: Facing): Facing => (f === 'left' ? 'right' : f === 'right' ? 'left' : f);
const prefix = (set: Framing) => (set === 'full' ? '' : `${set}:`);
const setRoot = (set: Framing) => (set === 'full' ? '' : join('sets', set));

/** The twin entries a `mirror: false` character needs (view, head and body keys → definitions). */
export interface Twins {
  views: Record<string, LayeredSpec['views'][string]>;
  heads: Record<string, LayeredSpec['heads'][string]>;
  bodies: Record<string, LayeredSpec['bodies'][string]>;
}

type Part = Pick<LayeredSpec, 'views' | 'heads' | 'bodies'>;

/** Twins of one set's entries (views, heads, bodies) not already written. */
function twinsOfPart(part: Part): Twins {
  const t: Twins = { views: {}, heads: {}, bodies: {} };
  for (const [v, d] of Object.entries(part.views)) {
    if (v.endsWith('@flip') || d.facing === 'front') continue;
    const { pivot: _pivot, ...rest } = d;
    t.views[`${v}@flip`] = { ...rest, facing: opposite(d.facing) };
    for (const [k, h] of Object.entries(part.heads))
      if (k.startsWith(`${v}/`))
        t.heads[`${v}@flip/${k.slice(v.length + 1)}`] = h.facing
          ? { ...h, facing: opposite(h.facing) }
          : h;
  }
  for (const [k, h] of Object.entries(part.heads))
    if (!k.endsWith('@flip') && h.facing && h.facing !== 'front')
      t.heads[`${k}@flip`] = { ...h, facing: opposite(h.facing) };
  for (const [k, b] of Object.entries(part.bodies))
    if (!k.endsWith('@flip') && b.facing && b.facing !== 'front')
      t.bodies[`${k}@flip`] = {
        ...b,
        facing: opposite(b.facing),
        ...(b.prompt ? { prompt: flipPrompt(b.prompt) } : {}),
      };
  // Entries the user (or an earlier run) already wrote win.
  for (const k of Object.keys(t.views)) if (part.views[k]) delete t.views[k];
  for (const k of Object.keys(t.heads)) if (part.heads[k]) delete t.heads[k];
  for (const k of Object.keys(t.bodies)) if (part.bodies[k]) delete t.bodies[k];
  return t;
}

/**
 * `@flip` twins (C10): an opposite-facing copy of every turned view, every turned head and every
 * body with a direction, at the top level (full set). Pivots are not copied (the generator
 * measures them). Close-up sets have their own: `setTwinsOf`.
 */
export function twinsOf(spec: LayeredSpec): Twins {
  return spec.mirror ? { views: {}, heads: {}, bodies: {} } : twinsOfPart(spec);
}

/** Twins inside `sets.<f>` (their heads and bodies are local to the set). */
export function setTwinsOf(spec: LayeredSpec): Partial<Record<'upper' | 'head', Twins>> {
  const out: Partial<Record<'upper' | 'head', Twins>> = {};
  if (spec.mirror) return out;
  for (const f of ['upper', 'head'] as const) {
    const set = spec.sets[f];
    if (set) out[f] = twinsOfPart(set);
  }
  return out;
}

/** The yaml writes that add every missing twin (derived fields, C16). */
export function twinWrites(spec: LayeredSpec): { path: string[]; value: unknown }[] {
  const w: { path: string[]; value: unknown }[] = [];
  const add = (base: string[], t: Twins) => {
    for (const kind of ['views', 'heads', 'bodies'] as const)
      for (const [k, v] of Object.entries(t[kind])) w.push({ path: [...base, kind, k], value: v });
  };
  add([], twinsOf(spec));
  for (const [f, t] of Object.entries(setTwinsOf(spec))) add(['sets', f], t);
  return w;
}

export function withTwins(spec: LayeredSpec): LayeredSpec {
  const t = twinsOf(spec);
  const sets = { ...spec.sets };
  for (const [f, st] of Object.entries(setTwinsOf(spec)) as ['upper' | 'head', Twins][]) {
    const s = sets[f]!;
    sets[f] = {
      ...s,
      views: { ...s.views, ...st.views },
      heads: { ...s.heads, ...st.heads },
      bodies: { ...s.bodies, ...st.bodies },
    };
  }
  return {
    ...spec,
    views: { ...spec.views, ...t.views },
    heads: { ...spec.heads, ...t.heads },
    bodies: { ...spec.bodies, ...t.bodies },
    sets,
  };
}

export interface Combo {
  set: Framing;
  view: string;
  body: string;
  head: string;
  expr: string;
}

/** Every (set, view, body, head, expression) the renderer can ask for, over both sides. */
export function combos(dir: string, spec: LayeredSpec): { combos: Combo[]; errors: string[] } {
  const out = new Map<string, Combo>();
  const errors: string[] = [];
  const size: [number, number] = spec.size ?? [640, 800];
  const sets: Framing[] = ['full', ...(['upper', 'head'] as const).filter((f) => spec.sets[f])];
  for (const set of sets) {
    const names = set === 'full' ? Object.keys(spec.faces) : spec.sets[set]!.faces;
    for (const face of names)
      for (const side of ['left', 'right'] as const) {
        try {
          const k = resolveFace(dir, spec, set, face, side, size).key as Record<string, string>;
          const c: Combo = { set, view: k.view!, body: k.body!, head: k.head!, expr: k.expr! };
          out.set(`${set}|${c.view}|${c.body}|${c.head}|${c.expr}`, c);
        } catch (e) {
          if (!(e instanceof FaceError)) throw e;
          const msg = `${set}: ${e.message}`;
          if (!errors.includes(msg)) errors.push(msg);
        }
      }
  }
  return { combos: [...out.values()], errors };
}

/** The items of a character, in round order. */
export function planItems(dir: string, input: LayeredSpec): { items: Item[]; errors: string[] } {
  const spec = withTwins(input);
  const { combos: cs, errors } = combos(dir, spec);
  const items = new Map<string, Item>();
  const add = (it: Item) => {
    if (!items.has(it.id)) items.set(it.id, it);
  };
  for (const c of cs) {
    const p = prefix(c.set);
    const set = setOf(dir, spec, c.set);
    const vd = set.views[c.view]!;
    const src = (name: string) => join(setRoot(c.set), 'views', c.view, '_src', name);
    const frontRef = `${p}${FRONT_REF}`;
    const bottomOpen = c.set !== 'full';
    // The set's front reference: the picked candidate (full) or a close-up of it (round 2).
    if (c.set !== 'full')
      add({
        id: frontRef,
        set: c.set,
        round: 2,
        kind: 'closeup',
        view: 'front',
        input: FRONT_REF,
        needs: [FRONT_REF],
        group: frontRef,
        prompt: closeupPrompt(c.set),
        src: join(setRoot(c.set), 'views', 'front', '_src', 'ref.png'),
        bottomOpen,
      });
    const pose = (head: string): Pose => {
      const hd = head === 'base' ? undefined : set.heads[`${c.view}/${head}`];
      return {
        view: { preset: vd.preset, facing: vd.facing },
        ...(hd ? { head: { preset: hd.preset, facing: hd.facing } } : {}),
      };
    };
    const viewRef = `${p}${c.view}/ref`;
    if (c.view !== 'front')
      add({
        id: viewRef,
        set: c.set,
        round: 2,
        kind: 'ref',
        view: c.view,
        head: 'base',
        expr: 'neutral',
        input: frontRef,
        needs: [frontRef],
        group: viewRef,
        prompt: groupPrompt(c.set, pose('base'), expressionText('neutral', undefined)),
        src: src('ref.png'),
        bottomOpen,
      });
    const split = c.set !== 'head' && !isSingle(vd);
    if (split)
      add({
        id: `${p}${c.view}/headless`,
        set: c.set,
        round: 3,
        kind: 'headless',
        view: c.view,
        input: viewRef,
        needs: [viewRef],
        group: `${p}${c.view}/headless`,
        prompt: HEADLESS_PROMPT,
        src: src('headless.png'),
        bottomOpen,
      });
    if (c.body !== 'stand') {
      const bd = set.bodies[`${c.view}/${c.body}`]!;
      const id = `${p}${c.view}/body/${c.body}`;
      add({
        id,
        set: c.set,
        round: 4,
        kind: 'body',
        view: c.view,
        body: c.body,
        input: frontRef,
        needs: [frontRef, ...(split ? [`${p}${c.view}/headless`] : [])],
        group: id,
        prompt: bodyPrompt(c.set, pose('base'), bd.prompt ?? c.body.replace(/@flip$/, '')),
        src: src(`body-${c.body}.png`),
        bottomOpen,
      });
    }
    // The group (view, head, expression): its still and frames (P5).
    const ed = spec.expressions[c.expr];
    const exprText = expressionText(c.expr, ed?.prompt);
    const baseNeutral = c.head === 'base' && c.expr === 'neutral';
    const still = baseNeutral ? viewRef : `${p}${c.view}/${c.head}/${c.expr}`;
    if (!baseNeutral)
      add({
        id: still,
        set: c.set,
        round: c.expr === 'neutral' ? 4 : 5,
        kind: 'still',
        view: c.view,
        head: c.head,
        expr: c.expr,
        input: frontRef,
        needs: [frontRef],
        group: still,
        prompt: groupPrompt(c.set, pose(c.head), exprText),
        src: src(`still-${c.head}-${c.expr}.png`),
        bottomOpen,
      });
    // Frames edit the approved still (P1 exception, like the headless body): an edit of the front
    // reference re-turns the head by a different angle each time (test r6: 5 of 6 turn / glance
    // frames moved), and only the frame's part (mouth, eyes) is kept. Their words name only the
    // change, not the pose or the expression (prompts.ts).
    const frames: Frame[] = [...MOUTH_FRAMES, ...gazeFrames(ed?.gaze)];
    for (const f of frames)
      add({
        id: `${p}${c.view}/${c.head}/${c.expr}/${f}`,
        set: c.set,
        round: 6,
        kind: 'frame',
        view: c.view,
        head: c.head,
        expr: c.expr,
        frame: f,
        input: still,
        needs: [still],
        group: still,
        prompt: framePrompt(c.set, f, c.expr),
        src: src(`frame-${c.head}-${c.expr}-${f}.png`),
        bottomOpen,
      });
  }
  // The full front reference's own group (base/neutral) is the picked candidate: its frames edit
  // it with an empty pose prefix, which the loop above already produced.
  return { items: [...items.values()].sort((a, b) => a.round - b.round), errors };
}

function gazeFrames(gaze: string | undefined): Frame[] {
  if (!gaze) return [];
  if (gaze === 'up') return ['gaze-up'];
  if (gaze === 'down') return ['gaze-down'];
  // toward / away: the side decides the direction, so both are made (C11).
  return ['gaze-screen-left', 'gaze-screen-right'];
}

export { candidatePrompt };
