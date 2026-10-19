import { z } from 'zod';

export const LANGS = ['ko', 'en', 'ja'] as const;
export type Lang = (typeof LANGS)[number];

/** `qwen:<speaker>` | `persona:<id>` | `supertonic:<F1-F5|M1-M5>` */
export const voiceSpecSchema = z
  .string()
  .regex(/^(qwen:[A-Za-z_]+|persona:[a-z0-9][a-z0-9-]*|supertonic:[FM][1-5])$/, {
    message: 'voice must be qwen:<speaker>, persona:<id> or supertonic:<F1-F5|M1-M5>',
  });

export const castMemberSchema = z.object({
  voice: voiceSpecSchema,
  name: z.string().optional(),
  style: z.string().optional(),
  speed: z.number().min(0.5).max(2).default(1),
  /**
   * A persona voice as a clone of its reference (default), or as the speaker trained from it by
   * `s2v voice train` (acting stage 4): the trained speaker follows emotion instructions.
   */
  personaModel: z.enum(['clone', 'trained']).optional(),
  draftVoice: voiceSpecSchema.optional(),
  avatar: z.string().optional(),
  /**
   * Character art for the dialogue layout: a folder of same-size transparent PNGs named
   * `<face>.png` (mouth closed), `<face>-talk.png`, `<face>-half.png`, `<face>-blink.png`.
   * `facing`: the way the drawn character looks; it is mirrored to face the center.
   */
  character: z
    .union([
      z.string(),
      z.object({ dir: z.string(), facing: z.enum(['left', 'right', 'front']).default('front') }),
    ])
    .optional(),
  /** Face used when a paragraph sets none. */
  face: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .default('neutral'),
  /** `auto`: a face change brings its motion (surprised → jump …); `off`: only explicit ones. */
  motion: z.enum(['auto', 'off']).default('auto'),
  color: z.string().optional(),
  side: z.enum(['left', 'right']).optional(),
  /**
   * Internal: face → motion, filled from a parts character's `character.yaml` by the CLI. When
   * present, faces bring these motions instead of the name-based FACE_MOTION. Not for scripts.
   */
  faceMotions: z.record(z.string(), z.string()).optional(),
  /**
   * Internal: faces the cast member's character can really draw, filled by the CLI (acting stage 2
   * plan 6.1). `any`: classic characters (no framings); otherwise per framing. Not for scripts.
   */
  faceSets: z
    .union([
      z.object({ any: z.array(z.string()) }),
      z.object({
        full: z.array(z.string()).optional(),
        upper: z.array(z.string()).optional(),
        head: z.array(z.string()).optional(),
      }),
    ])
    .optional(),
});
export type CastMember = z.infer<typeof castMemberSchema>;

/** Character framings (shot sizes) a parts character can be drawn in; chosen per scene by `::shot`. */
export const FRAMINGS = ['full', 'upper', 'head'] as const;
export type Framing = (typeof FRAMINGS)[number];

/** Character motions (PLAN 5.8). `sink` and `lean` hold while their face lasts. */
export const MOTIONS = [
  'jump',
  'shake',
  'nod',
  'bounce',
  'shiver',
  'sink',
  'lean',
  /** Head only (parts characters with a head layer); others fall back to nod / lean. */
  'head-nod',
  'head-tilt',
] as const;
/** Motion a face brings by itself (cast `motion: auto`). */
export const FACE_MOTION: Record<string, string> = {
  surprised: 'jump',
  happy: 'bounce',
  angry: 'shake',
  sad: 'sink',
};

export const ASPECTS = ['16:9', '9:16', '1:1'] as const;
export const LAYOUTS = ['presenter', 'dialogue', 'fullscreen', 'shorts'] as const;

/** Subtitle look (PLAN 5.4). Frontmatter `subtitleStyle`, overridable per output. */
export const subtitleStyleSchema = z.object({
  /** Text size factor (1 = 48 px at 16:9, 56 px at 9:16). */
  size: z.number().min(0.5).max(2).optional(),
  /** bottom (default) | middle | top. Speaker-side bubbles (characters) need bottom. */
  position: z.enum(['bottom', 'middle', 'top']).optional(),
  color: z.string().optional(),
  /** Box color, or `none` for no box (the text gets an outline instead). */
  background: z.string().optional(),
  /** Color of the word being spoken (word subtitles). */
  highlight: z.string().optional(),
  /** Font file (ttf / otf / woff2) relative to the script; default (or null): bundled Noto Sans. */
  font: z.string().nullable().optional(),
});
export type SubtitleStyle = z.infer<typeof subtitleStyleSchema>;

/** Sound effect presets, synthesized (no sample files, no licenses). */
export const SFX = ['pop', 'click', 'whoosh', 'ding'] as const;

export const bgmSchema = z.object({
  /** Audio file relative to the script (looped if shorter than the video). */
  src: z.string(),
  /** Loudness of the music alone, before ducking under speech (LUFS). */
  level: z.number().min(-50).max(-10).default(-30),
  /** Lower the music while someone speaks. */
  duck: z.boolean().default(true),
  /** Attribution line for the description draft (title, artist, license). */
  credit: z.string().optional(),
});
export type Bgm = z.infer<typeof bgmSchema>;

/** Colors of visuals and backgrounds: a base theme plus optional overrides. */
export const themeSchema = z.union([
  z.enum(['light', 'dark']),
  z.object({
    base: z.enum(['light', 'dark']).default('light'),
    background: z.string().optional(),
    text: z.string().optional(),
    accent: z.string().optional(),
  }),
]);
export type ThemeSpec = z.infer<typeof themeSchema>;

export const logoSchema = z.object({
  /** Image file relative to the script (PNG with transparency works best). */
  src: z.string(),
  position: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-right'),
  /** Width as a fraction of the frame width. */
  size: z.number().min(0.02).max(0.4).default(0.08),
  opacity: z.number().min(0.1).max(1).default(0.9),
});
export type Logo = z.infer<typeof logoSchema>;

export const outputProfileSchema = z.object({
  aspect: z.enum(ASPECTS),
  layout: z.enum(LAYOUTS).default('presenter'),
  scenes: z.array(z.string()).optional(),
  maxDuration: z.number().positive().optional(),
  /** `word` highlights the word being spoken (Shorts style); default: word for the shorts layout. */
  subtitles: z.enum(['sentence', 'word']).optional(),
  subtitleStyle: subtitleStyleSchema.optional(),
  /** Scene boundaries: `fade` dips to the background color. */
  transition: z.enum(['none', 'fade']).optional(),
  /** `full`: ignore `::shot` and draw every character full-length in this output. */
  shot: z.literal('full').optional(),
});
export type OutputProfile = z.infer<typeof outputProfileSchema>;

/** A user-defined emotion (frontmatter `acting.emotions`, acting plan 2.6). */
export const userEmotionSchema = z.object({
  /** Voice instruction (qwen), like a standard emotion's template. */
  voice: z.string().min(1),
  face: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/)
    .optional(),
  motion: z.string().optional(),
  /** Tempo factor, multiplied with the cast and line `speed`. */
  speed: z.number().min(0.5).max(2).optional(),
  /** Longest pause allowed inside a take (seconds) instead of the default gate. */
  maxPause: z.number().min(0.2).max(2).optional(),
});
export type UserEmotion = z.infer<typeof userEmotionSchema>;

export const actingSchema = z.object({
  emotions: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), userEmotionSchema).optional(),
  /** Idle motion (acting stage 5a): breathing, blinks, listener nods. Absent = on. */
  idle: z.boolean().optional(),
});

export const pacingSchema = z.object({
  sentenceGap: z.number().min(0).default(0.3),
  paragraphGap: z.number().min(0).default(0.6),
  sceneGap: z.number().min(0).default(0.8),
  lead: z.number().min(0).default(1.3),
  tail: z.number().min(0).default(3.0),
  /** Longest pause kept inside a sentence; longer engine pauses are shortened to this. */
  maxPause: z.number().min(0.1).max(2).default(0.35),
});
export type Pacing = z.infer<typeof pacingSchema>;

export const frontmatterSchema = z.object({
  title: z.string().optional(),
  lang: z.enum(LANGS),
  cast: z.record(z.string().regex(/^[A-Za-z_][\w-]*$/), castMemberSchema).default({
    host: { voice: 'qwen:Sohee', speed: 1, face: 'neutral', motion: 'auto' },
  }),
  outputs: z
    .record(z.string(), outputProfileSchema)
    .default({ youtube: { aspect: '16:9', layout: 'presenter' } }),
  pronounce: z.record(z.string(), z.string()).default({}),
  pacing: pacingSchema.default(pacingSchema.parse({})),
  seed: z.number().int().min(0).default(0),
  targetDuration: z.number().positive().optional(),
  subtitleStyle: subtitleStyleSchema.optional(),
  bgm: z.union([z.string(), bgmSchema]).optional(),
  theme: themeSchema.default('light'),
  logo: z.union([z.string(), logoSchema]).optional(),
  /** `auto`: sound effects on visual changes, marks and highlights; cue `sfx=` always plays. */
  sfx: z.enum(['off', 'auto']).default('off'),
  /** Scene boundaries for every output (an output's `transition` wins). */
  transition: z.enum(['none', 'fade']).default('none'),
  translationOf: z.string().optional(),
  allowDrift: z.boolean().default(false),
  /** Acting (acting plan 2.6). No default: scripts without it keep the same parsed meta. */
  acting: actingSchema.optional(),
});
export type Frontmatter = z.infer<typeof frontmatterSchema>;

/** Inline content of a narration paragraph, in reading order. */
export type Inline =
  | { type: 'text'; value: string }
  | { type: 'cue'; text: string; attrs: Record<string, string> }
  | { type: 'pause'; seconds: number }
  /** Listener reactions: cast key → face, from the word after this point. */
  | { type: 'react'; faces: Record<string, string>; motions?: Record<string, string> }
  /** `:emo{…}`: the voice attributes from the next sentence on. */
  | { type: 'emo'; acting: Acting; line?: number }
  /** `:look{cast=partner|viewer|glance}`: where characters look from here (acting stage 5b). */
  | { type: 'look'; looks: Record<string, LookValue>; line?: number };

/** Where a character looks (acting plan 2.5): its default stance, the viewer, or a glance. */
export const LOOK_VALUES = ['partner', 'viewer', 'glance'] as const;
export type LookValue = (typeof LOOK_VALUES)[number];

/** How a line is spoken (acting plan 2.1): set by the speaker prefix or an inline `:emo`. */
export interface Acting {
  emo?: string;
  power?: 'weak' | 'strong';
  /** Free direction for this line (qwen only). */
  say?: string;
  volume?: 'soft' | 'loud';
  speed?: number;
}

export interface Cue {
  /** Character range [start, end) of the cue phrase inside `Sentence.text`. */
  start: number;
  end: number;
  attrs: Record<string, string>;
}

export interface Sentence {
  /** Display text (what the subtitle shows). Directives are already resolved to plain text. */
  text: string;
  cues: Cue[];
  /** Explicit pause (seconds) requested right after this sentence via `:pause`. */
  pauseAfter?: number;
  /** `:react{cast=face}` points: character offset in `text` and the faces to show from there. */
  reacts?: { at: number; faces: Record<string, string>; motions?: Record<string, string> }[];
  /** `:look{cast=value}` points: character offset in `text`, where each cast looks from there. */
  looks?: { at: number; looks: Record<string, LookValue>; line?: number }[];
  /** The voice attributes this sentence is spoken with (prefix or the last `:emo`). */
  acting?: Acting;
  /** An inline `:emo` starts at this sentence. */
  actingChange?: true;
}

export interface Paragraph {
  kind: 'paragraph';
  line: number;
  cast: string;
  gap?: number;
  /** Character face while this paragraph is spoken (`mina{face=happy}:`). */
  face?: string;
  /** Character motion at the start of this paragraph (`mina{motion=jump}:`; `none` = no motion). */
  motion?: string;
  only?: string[];
  audio?: string;
  /** Voice attributes of the speaker prefix (`mina{emo=sad}:`). */
  acting?: Acting;
  sentences: Sentence[];
}

/** A run of text in a markdown card. */
export interface MdRun {
  text: string;
  bold?: boolean;
  code?: boolean;
}
export interface MdBlock {
  kind: 'h' | 'p' | 'li';
  runs: MdRun[];
}

export interface Visual {
  kind: 'visual';
  line: number;
  type: string;
  label?: string;
  attrs: Record<string, string>;
  /** List items for list-like containers (bullets) and quote paragraphs. */
  items?: string[];
  /** Table cells, header row first (also chart data: label | value). */
  rows?: string[][];
  /** compare: one column per `### heading` with its list items. */
  columns?: { title: string; items: string[] }[];
  /** gallery: images (relative to the script) with optional captions. */
  images?: { src: string; caption?: string }[];
  /** markdown: simplified rich text (headings, paragraphs, list items). */
  md?: MdBlock[];
  /** Raw body for other containers (code, table, chart ...). */
  body?: string;
}

export type Block = Paragraph | Visual;

export interface Scene {
  id: string;
  title: string;
  line: number;
  /** `::shot{mina=head}` at the start of the scene: framings set here (others are inherited). */
  shot?: Record<string, Framing>;
  /** `::enter{mina}` / `::exit{mina}` before the scene's first paragraph (acting stage 5c). */
  stage?: { kind: 'enter' | 'exit'; cast: string; line: number }[];
  blocks: Block[];
}

export interface Script {
  meta: Frontmatter;
  scenes: Scene[];
}

/** The subtitle style of one output: the script's, overridden by the output's. */
export function subtitleStyleFor(
  meta: Frontmatter,
  output: string,
): Omit<SubtitleStyle, 'font'> & { font?: string } {
  const { font, ...rest } = { ...meta.subtitleStyle, ...meta.outputs[output]?.subtitleStyle };
  return font ? { ...rest, font } : rest;
}

/** The script's background music, with defaults filled in. */
export function bgmOf(meta: Frontmatter): Bgm | null {
  if (!meta.bgm) return null;
  return bgmSchema.parse(typeof meta.bgm === 'string' ? { src: meta.bgm } : meta.bgm);
}

/** The theme as `{ base, ...overrides }`. */
export function themeOf(meta: Frontmatter): {
  base: 'light' | 'dark';
  background?: string;
  text?: string;
  accent?: string;
} {
  const t = meta.theme;
  if (typeof t === 'string') return { base: t };
  const { base, ...rest } = t;
  return { base, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
}

/** The logo with defaults filled in, or null. */
export function logoOf(meta: Frontmatter): Logo | null {
  if (!meta.logo) return null;
  return logoSchema.parse(typeof meta.logo === 'string' ? { src: meta.logo } : meta.logo);
}
