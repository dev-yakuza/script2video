/**
 * `character.yaml`: parts characters (docs plan C1–C23). A folder with this file is a parts
 * character; without it, the folder holds whole images (`<face>[-talk|-half|-blink].png`).
 *
 * Generated / hand-drawn characters are layers: per view a body, an optional front layer (hands
 * in front of the head) and one head image per (head, expression) with mouth / blink parts on it.
 * Imported YMM4 material keeps its own folders and is composited into whole images.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

export const CHARACTER_YAML = 'character.yaml';
export const FRAMINGS = ['full', 'upper', 'head'] as const;
export type Framing = (typeof FRAMINGS)[number];
export type Facing = 'front' | 'left' | 'right';

/** Names of views, heads, bodies, expressions and faces (same rule as script face names). */
export const NAME = /^[a-z][a-z0-9-]*$/;
/** View / head keys may carry one trailing `@flip` (the opposite-facing twin, plan C10). */
const PAIRABLE = /^[a-z][a-z0-9-]*(@flip)?$/;
/** `view/name` keys of bodies and heads (heads may have `@flip`). */
const VIEW_ITEM = /^[a-z][a-z0-9-]*(@flip)?\/[a-z][a-z0-9-]*(@flip)?$/;
/** `view/head/expression` keys of groups. */
const GROUP_KEY = /^[a-z][a-z0-9-]*(@flip)?\/[a-z][a-z0-9-]*(@flip)?\/[a-z][a-z0-9-]*$/;
/** A YMM4 part file stem: no path separators or dots (frames are `stem.N.png`). */
const STEM = /^[^/\\.]+$/;
const xy = z.tuple([z.number(), z.number()]);
const facing = z.enum(['front', 'left', 'right']);

const viewSchema = z.object({
  facing: facing.default('front'),
  preset: z.string().optional(),
  prompt: z.string().optional(),
  /** Neck point [x, y] in canvas px: heads rotate around it and flips use its x. */
  pivot: xy.optional(),
  /**
   * `split` (default): body + head layers (head motions, head variants). `single`: one image per
   * face, mouth / blink parts on top; head motions fall back to whole-body ones. Turned views are
   * single: a headless edit of a turned reference is a second-generation edit and fails.
   */
  layers: z.enum(['split', 'single']).optional(),
});
const bodySchema = z.object({
  prompt: z.string().optional(),
  /** [dx, dy]: moves the head group when combined with this body. */
  offset: xy.optional(),
  /** Bodies with a direction (pointing) face that way; default: the view's facing. */
  facing: facing.optional(),
});
const headSchema = z.object({
  preset: z.string().optional(),
  prompt: z.string().optional(),
  facing: facing.optional(),
});
const expressionSchema = z.object({
  prompt: z.string().optional(),
  motion: z.string().optional(),
  gaze: z.enum(['toward', 'away', 'up', 'down']).optional(),
});
const groupSchema = z.object({ offset: xy.optional() });
const faceSchema = z.object({
  view: z.string().regex(PAIRABLE),
  body: z.string().regex(NAME).optional(),
  head: z.string().regex(NAME).optional(),
  expression: z.string().regex(NAME),
  motion: z.string().optional(),
});
const setSchema = z.object({
  views: z.record(z.string().regex(PAIRABLE), viewSchema).default({}),
  heads: z.record(z.string().regex(VIEW_ITEM), headSchema).default({}),
  bodies: z.record(z.string().regex(VIEW_ITEM), bodySchema).default({}),
  groups: z.record(z.string().regex(GROUP_KEY), groupSchema).default({}),
  faces: z.array(z.string().regex(NAME)),
});

const common = {
  id: z.string().optional(),
  license: z.string().optional(),
  credit: z.string().optional(),
  size: xy.optional(),
};

const layeredSchema = z.object({
  ...common,
  source: z.enum(['generated', 'drawn']),
  kind: z.string().optional(),
  style: z.string().optional(),
  eyes: z.enum(['dot', 'full']).default('full'),
  mirror: z.boolean().default(true),
  background: z.string().optional(),
  /** `name@N`: a frozen preset expanded at read time (plan 4.6). A bare name is an error. */
  preset: z
    .string()
    .regex(/^[a-z][a-z0-9-]*@\d+$/, 'preset needs a version, e.g. standard@1')
    .optional(),
  exclude: z.array(z.string()).default([]),
  views: z.record(z.string().regex(PAIRABLE), viewSchema).default({}),
  bodies: z.record(z.string().regex(VIEW_ITEM), bodySchema).default({}),
  heads: z.record(z.string().regex(VIEW_ITEM), headSchema).default({}),
  expressions: z.record(z.string().regex(NAME), expressionSchema).default({}),
  groups: z.record(z.string().regex(GROUP_KEY), groupSchema).default({}),
  faces: z.record(z.string().regex(NAME), faceSchema).default({}),
  sets: z.object({ upper: setSchema.optional(), head: setSchema.optional() }).default({}),
});

const importedSchema = z.object({
  ...common,
  source: z.literal('imported'),
  /** The way the drawn character looks (screen terms). */
  facing: facing.default('front'),
  /** Face name → part file per YMM4 folder (`{ 体: 体_00, 目: 目_05 }`); others from `neutral`. */
  faces: z.record(
    z.string().regex(NAME),
    z.record(
      z.string(),
      z
        .string({ error: 'a part file stem as a quoted string, e.g. "00"' })
        .regex(STEM, 'a part file stem (no / or .)'),
    ),
  ),
});

export type LayeredSpec = z.infer<typeof layeredSchema>;
export type ImportedSpec = z.infer<typeof importedSchema>;
export type CharacterSpec = LayeredSpec | ImportedSpec;
export type ViewDef = z.infer<typeof viewSchema>;
export type BodyDef = z.infer<typeof bodySchema>;
export type HeadDef = z.infer<typeof headSchema>;
export type SetDef = z.infer<typeof setSchema>;

type PresetDef = Pick<
  Partial<LayeredSpec>,
  'views' | 'bodies' | 'heads' | 'expressions' | 'faces' | 'sets'
>;

/** The standard emotions (same IDs as the dialogue-acting plan) and their edit prompts. */
const STANDARD_EXPRESSIONS: Record<string, { prompt?: string; motion?: string }> = {
  neutral: {},
  happy: { prompt: 'Happy expression with smiling eyes', motion: 'bounce' },
  sad: { prompt: 'Sad expression with drooping eyebrows and downcast eyes', motion: 'sink' },
  angry: { prompt: 'Angry expression with furrowed eyebrows', motion: 'shake' },
  surprised: {
    prompt: 'Surprised expression with eyes wide open and raised eyebrows',
    motion: 'jump',
  },
  anxious: { prompt: 'Anxious, worried expression with raised inner eyebrows', motion: 'shiver' },
  excited: {
    prompt: 'Excited expression with sparkling wide eyes and a big smile',
    motion: 'bounce',
  },
  calm: { prompt: 'Calm, gentle expression with softly relaxed eyes and a faint smile' },
  serious: { prompt: 'Serious, focused expression with straight eyebrows' },
  puzzled: { prompt: 'Puzzled expression with one eyebrow raised' },
  moved: { prompt: 'Deeply moved expression with shining teary eyes and a soft smile' },
  playful: { prompt: 'Playful, mischievous expression with a sly grin' },
};
/** Poses on the front view (head stays in place; no hands over the chin or mouth) → expression. */
const STANDARD_POSES: Record<string, { prompt: string; expression: string; facing?: Facing }> = {
  wave: { prompt: 'raises the right hand and waves at the viewer', expression: 'happy' },
  point: {
    prompt: "points with one arm toward the viewer's right",
    expression: 'neutral',
    facing: 'right',
  },
  akimbo: { prompt: 'puts both hands on the hips', expression: 'neutral' },
  cheer: {
    prompt: 'holds both fists in front of the chest, shoulders relaxed and not raised',
    expression: 'excited',
  },
  'arms-crossed': { prompt: 'crosses the arms over the chest', expression: 'serious' },
  'hands-together': {
    prompt: 'holds both hands together in front of the chest',
    expression: 'calm',
  },
};
const GLANCE_EXPRESSIONS = ['neutral', 'surprised', 'happy', 'puzzled'];
/** Head-motion faces on split views (turned views are one image: their head motions fall back). */
const HEAD_MOTION: Record<string, string> = { puzzled: 'head-tilt' };

/**
 * `standard@1` (plan 4.6, user decision 2026-10-13): the casting library. The default face of
 * every emotion (`<expr>`) is turned slightly toward the partner (view `turn`, C9); `front-<expr>`
 * faces the viewer; `glance-<expr>` turns only the head; poses are front-view bodies.
 */
function standardPreset(): PresetDef {
  const faces: LayeredSpec['faces'] = {};
  for (const e of Object.keys(STANDARD_EXPRESSIONS)) {
    faces[e] = { view: 'turn', expression: e };
    faces[`front-${e}`] = {
      view: 'front',
      expression: e,
      ...(HEAD_MOTION[e] ? { motion: HEAD_MOTION[e] } : {}),
    };
  }
  for (const e of GLANCE_EXPRESSIONS)
    faces[`glance-${e}`] = {
      view: 'front',
      head: 'glance',
      expression: e,
      ...(HEAD_MOTION[e] ? { motion: HEAD_MOTION[e] } : {}),
    };
  const bodies: LayeredSpec['bodies'] = {};
  for (const [p, d] of Object.entries(STANDARD_POSES)) {
    bodies[`front/${p}`] = { prompt: d.prompt, ...(d.facing ? { facing: d.facing } : {}) };
    faces[p] = { view: 'front', body: p, expression: d.expression };
  }
  return {
    views: {
      front: { facing: 'front' },
      turn: { preset: 'turn-slight', facing: 'right' },
    },
    heads: { 'front/glance': { preset: 'glance', facing: 'right' } },
    bodies,
    expressions: STANDARD_EXPRESSIONS,
    faces,
    sets: {
      // The head close-up draws every face (closeup-look plan): its turned faces and glances
      // turn the head (the same picture: no body shows), poses keep only their expression.
      head: {
        views: { front: { facing: 'front' } },
        heads: { 'front/glance': { preset: 'glance', facing: 'right' } },
        bodies: {},
        groups: {},
        faces: Object.keys(faces),
      },
    },
  };
}

/** Frozen presets: a published version never changes (new wording ships as `@2`, plan 4.6). */
export const PRESETS: Record<string, PresetDef> = {
  'standard@1': standardPreset(),
  'test@1': {
    expressions: { neutral: {}, happy: { prompt: 'smiling', motion: 'bounce' } },
    bodies: { 'front/wave': { prompt: 'wave' } },
    faces: {
      neutral: { view: 'front', expression: 'neutral' },
      happy: { view: 'front', expression: 'happy' },
      wave: { view: 'front', body: 'wave', expression: 'happy' },
    },
  },
};

/** A key's base name (`front/wave` → `wave`, `turn@flip` → `turn`) for `exclude`. */
const baseName = (key: string) => key.slice(key.lastIndexOf('/') + 1).replace(/@flip$/, '');

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Preset first, the user's entries win field by field; `exclude` drops entries by name. Works on
 * the raw yaml object before validation, so schema defaults (e.g. a view's `facing: front`) never
 * mask the preset's values when the user overrides other fields of an entry.
 */
export function expandPreset(raw: Raw): Raw {
  const name = raw.preset;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*@\d+$/.test(name)) return raw;
  const preset = PRESETS[name] as Raw | undefined;
  if (!preset)
    throw new Error(`unknown preset "${name}" (known: ${Object.keys(PRESETS).join(', ')})`);
  const drop = new Set(Array.isArray(raw.exclude) ? raw.exclude.map(String) : []);
  const merge = (base: unknown, user: unknown, filter = true): unknown => {
    // A present non-object user value goes through unchanged so validation reports it.
    if (user !== undefined && !isObj(user)) return user;
    const out: Raw = {};
    if (isObj(base))
      for (const [k, v] of Object.entries(base))
        if (!filter || !drop.has(baseName(k))) out[k] = isObj(v) ? { ...v } : v;
    if (isObj(user))
      for (const [k, v] of Object.entries(user))
        out[k] = isObj(v) && isObj(out[k]) ? { ...(out[k] as Raw), ...v } : v;
    return out;
  };
  const userFaces = isObj(raw.faces) ? raw.faces : {};
  const merged = merge(preset.faces, raw.faces);
  // A preset face on an excluded view falls back to the front view (excluding `turn` makes the
  // default faces look at the viewer); one on an excluded expression, body or head goes.
  const faces = !isObj(merged)
    ? merged
    : Object.fromEntries(
        Object.entries(merged)
          .filter(([n, f]) => {
            if (n in userFaces || !isObj(f)) return true;
            return ![f.expression, f.body, f.head].some(
              (x) => typeof x === 'string' && drop.has(x),
            );
          })
          .map(([n, f]) =>
            !(n in userFaces) && isObj(f) && typeof f.view === 'string' && drop.has(f.view)
              ? [n, { ...f, view: 'front' }]
              : [n, f],
          ),
      );
  return {
    ...raw,
    views: merge(preset.views, raw.views),
    bodies: merge(preset.bodies, raw.bodies),
    heads: merge(preset.heads, raw.heads),
    expressions: merge(preset.expressions, raw.expressions),
    faces,
    sets: mergeSets(preset.sets, raw.sets, drop, isObj(faces) ? faces : {}),
  };
}

/**
 * Sets: per framing, the user's set merges over the preset's. A user `faces` list replaces the
 * preset's; the preset's list keeps only faces that still exist after `exclude`.
 */
function mergeSets(base: unknown, user: unknown, drop: Set<string>, faces: Raw): unknown {
  if (user !== undefined && !isObj(user)) return user;
  const out: Raw = {};
  const b0 = isObj(base) ? base : {};
  const u0 = isObj(user) ? user : {};
  for (const f of new Set([...Object.keys(b0), ...Object.keys(u0)])) {
    const b = b0[f];
    const u = u0[f];
    // `sets: { head: null }` (or `exclude: [head]`) removes the preset's set.
    if (f in u0 && u === null) continue;
    // `exclude: [head]` drops the preset's set; a set the user wrote stays as written.
    if (drop.has(f)) {
      if (u !== undefined) out[f] = u;
      continue;
    }
    if (!isObj(b) || (u !== undefined && !isObj(u))) {
      out[f] = u;
      continue;
    }
    const uu = isObj(u) ? u : {};
    const part = (k: string, filter: boolean) => {
      const r: Raw = {};
      if (isObj(b[k]))
        for (const [key, v] of Object.entries(b[k] as Raw))
          if (!filter || !drop.has(baseName(key))) r[key] = v;
      if (isObj(uu[k]))
        for (const [key, v] of Object.entries(uu[k] as Raw))
          r[key] = isObj(v) && isObj(r[key]) ? { ...(r[key] as Raw), ...v } : v;
      return r;
    };
    out[f] = {
      ...uu,
      views: part('views', false),
      heads: part('heads', true),
      bodies: part('bodies', true),
      groups: part('groups', false),
      faces:
        uu.faces ??
        (Array.isArray(b.faces) ? b.faces.filter((x) => typeof x === 'string' && x in faces) : []),
    };
  }
  return out;
}

export class CharacterSpecError extends Error {}

/** Parse and validate a character.yaml text (preset expanded). Throws CharacterSpecError. */
export function parseCharacterSpec(text: string, where = CHARACTER_YAML): CharacterSpec {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new CharacterSpecError(`${where}: invalid YAML: ${(e as Error).message}`);
  }
  const source = (raw as { source?: unknown } | null)?.source;
  const schema = source === 'imported' ? importedSchema : layeredSchema;
  let input: unknown = raw ?? {};
  if (source !== 'imported' && isObj(input)) {
    // Generated characters always start from a front reference: its view is implicit (also in
    // close-up sets, which have only that view).
    if (source === 'generated') {
      const withFront = (v: unknown) =>
        v === undefined ? { front: {} } : isObj(v) && !('front' in v) ? { front: {}, ...v } : v;
      input = { ...input, views: withFront(input.views) };
      const sets = (input as Raw).sets;
      if (isObj(sets))
        (input as Raw).sets = Object.fromEntries(
          Object.entries(sets).map(([f, st]) => [
            f,
            isObj(st) ? { ...st, views: withFront(st.views) } : st,
          ]),
        );
    }
    try {
      input = expandPreset(input as Raw);
    } catch (e) {
      throw new CharacterSpecError(`${where}: ${(e as Error).message}`);
    }
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new CharacterSpecError(`${where}: ${msg}`);
  }
  return parsed.data;
}

/** `parts` when the folder has a character.yaml (shared by the renderer and lint, plan C1). */
export function characterSource(dir: string): 'parts' | 'images' {
  return existsSync(join(dir, CHARACTER_YAML)) ? 'parts' : 'images';
}

export function loadCharacterSpec(dir: string): CharacterSpec {
  return parseCharacterSpec(
    readFileSync(join(dir, CHARACTER_YAML), 'utf8'),
    join(dir, CHARACTER_YAML),
  );
}

/**
 * Face → motion for the timeline: face.motion, else its expression's motion (plan C6). Null for
 * imported material: it keeps the name-based motions (surprised → jump …).
 */
export function faceMotions(spec: CharacterSpec): Record<string, string> | null {
  if (spec.source === 'imported') return null;
  const out: Record<string, string> = {};
  for (const [name, f] of Object.entries(spec.faces)) {
    const m = f.motion ?? spec.expressions[f.expression]?.motion;
    if (m) out[name] = m;
  }
  return out;
}

/** Folder of imported YMM4 parts inside a character folder (plan 3.1). */
export const IMPORTED_PARTS = join('views', 'main');
