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
  views: z.record(z.string().regex(PAIRABLE), viewSchema),
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
export type ExpressionDef = z.infer<typeof expressionSchema>;
export type FaceDef = z.infer<typeof faceSchema>;
export type SetDef = z.infer<typeof setSchema>;

type PresetDef = Pick<Partial<LayeredSpec>, 'views' | 'bodies' | 'heads' | 'expressions' | 'faces'>;

/**
 * Frozen presets. `standard@1` is defined when generation ships (plan 9, phase 3); until then
 * only the expansion mechanism exists, exercised by the test preset.
 */
export const PRESETS: Record<string, PresetDef> = {
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

/** Preset first, the user's entries win field by field; `exclude` drops entries by name. */
export function expandPreset(spec: LayeredSpec): LayeredSpec {
  if (!spec.preset) return spec;
  const preset = PRESETS[spec.preset];
  if (!preset)
    throw new Error(`unknown preset "${spec.preset}" (known: ${Object.keys(PRESETS).join(', ')})`);
  const drop = new Set(spec.exclude);
  const merge = <T extends object>(
    base: Record<string, T> | undefined,
    user: Record<string, T>,
  ): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(base ?? {})) if (!drop.has(baseName(k))) out[k] = { ...v };
    for (const [k, v] of Object.entries(user)) out[k] = { ...(out[k] ?? {}), ...v } as T;
    return out;
  };
  return {
    ...spec,
    views: merge(preset.views, spec.views) as LayeredSpec['views'],
    bodies: merge(preset.bodies, spec.bodies),
    heads: merge(preset.heads, spec.heads),
    expressions: merge(preset.expressions, spec.expressions),
    faces: merge(preset.faces, spec.faces),
  };
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
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    const msg = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new CharacterSpecError(`${where}: ${msg}`);
  }
  if (parsed.data.source === 'imported') return parsed.data;
  try {
    return expandPreset(parsed.data);
  } catch (e) {
    throw new CharacterSpecError(`${where}: ${(e as Error).message}`);
  }
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
