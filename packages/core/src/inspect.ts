/**
 * `s2v inspect` (Studio plan S4a, docs/inspect-plan.md): the pure part.
 *
 * Every directive attribute and frontmatter key has a kind (text, voice, presentation, asset,
 * structure); hashes are taken per kind so a reviewer only re-checks what changed. Inspect is the
 * closed-world reader: anything the table does not know (a typo'd attribute, a directive in a
 * place the parser turns into text) is an error here, while `lint` and `render` stay open.
 */

import type { Image, Parent, Root, RootContent } from 'mdast';
import type { ContainerDirective, LeafDirective, TextDirective } from 'mdast-util-directive';
import remarkDirective from 'remark-directive';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { KNOWN_DIRECTIVES, type ParseTrace } from './parse.js';
import {
  bgmSchema,
  castMemberSchema,
  frontmatterSchema,
  logoSchema,
  outputProfileSchema,
  pacingSchema,
  type MdBlock,
  type Paragraph,
  type Scene,
  type Script,
  type Visual,
} from './schema.js';

export const HASH_VERSIONS = [1] as const;

export type Kind = 'text' | 'voice' | 'presentation' | 'asset' | 'structure';

type KnownDirective = (typeof KNOWN_DIRECTIVES)[number];
type Placement = 'inline' | 'leaf' | 'container';

/**
 * Directive attributes by kind (plan 3.1a). `cast` / `output`: the keys are cast or output names.
 * Bodies and labels are read from the parsed blocks, not from here.
 */
export const DIRECTIVES: Record<
  KnownDirective,
  { placement: Placement; attrs: Record<string, Kind> | 'cast' | 'output' }
> = {
  title: { placement: 'leaf', attrs: {} },
  image: { placement: 'leaf', attrs: { src: 'asset', kenburns: 'presentation' } },
  video: { placement: 'leaf', attrs: { src: 'asset', start: 'presentation' } },
  thumbnail: { placement: 'leaf', attrs: { src: 'asset' } },
  bullets: { placement: 'container', attrs: {} },
  code: { placement: 'container', attrs: { lang: 'presentation' } },
  markdown: { placement: 'container', attrs: {} },
  split: { placement: 'container', attrs: { side: 'presentation' } },
  table: { placement: 'container', attrs: {} },
  chart: { placement: 'container', attrs: { unit: 'text' } },
  diagram: { placement: 'container', attrs: {} },
  quote: { placement: 'container', attrs: { by: 'text' } },
  compare: { placement: 'container', attrs: {} },
  gallery: { placement: 'container', attrs: {} },
  cue: {
    placement: 'inline',
    attrs: {
      x: 'presentation',
      y: 'presentation',
      zoom: 'presentation',
      mark: 'presentation',
      r: 'presentation',
      w: 'presentation',
      h: 'presentation',
      from: 'presentation',
      sfx: 'presentation',
      row: 'presentation',
      line: 'presentation',
      highlight: 'presentation',
      node: 'presentation',
      show: 'asset',
    },
  },
  pause: { placement: 'inline', attrs: {} },
  react: { placement: 'inline', attrs: 'cast' },
  look: { placement: 'inline', attrs: 'cast' },
  only: { placement: 'inline', attrs: 'output' },
  audio: { placement: 'inline', attrs: { src: 'voice' } },
  shot: { placement: 'leaf', attrs: 'cast' },
  emo: {
    placement: 'inline',
    attrs: { emo: 'voice', power: 'voice', say: 'voice', volume: 'voice', speed: 'voice' },
  },
};

/** Speaker prefix attributes (`mina{face=happy}:`). */
export const SPEAKER_ATTRS: Record<string, Kind> = {
  gap: 'presentation',
  face: 'presentation',
  motion: 'presentation',
  emo: 'voice',
  power: 'voice',
  say: 'voice',
  volume: 'voice',
  speed: 'voice',
};

/** Frontmatter keys by kind (plan 3.1b); `*` is a record key (cast name, output name, word). */
export const FRONTMATTER: Record<string, Kind> = {
  title: 'text',
  lang: 'structure',
  'cast.*.voice': 'voice',
  'cast.*.style': 'voice',
  'cast.*.personaModel': 'voice',
  'cast.*.speed': 'voice',
  'cast.*.name': 'text',
  'cast.*.draftVoice': 'structure',
  'cast.*.avatar': 'asset',
  'cast.*.character': 'asset',
  'cast.*.character.dir': 'asset',
  'cast.*.character.facing': 'asset',
  'cast.*.face': 'presentation',
  'cast.*.motion': 'presentation',
  'cast.*.color': 'presentation',
  'cast.*.side': 'presentation',
  'outputs.*.aspect': 'presentation',
  'outputs.*.layout': 'presentation',
  'outputs.*.scenes': 'structure',
  'outputs.*.maxDuration': 'structure',
  'outputs.*.subtitles': 'presentation',
  'outputs.*.transition': 'presentation',
  'outputs.*.shot': 'presentation',
  'outputs.*.subtitleStyle.size': 'presentation',
  'outputs.*.subtitleStyle.position': 'presentation',
  'outputs.*.subtitleStyle.color': 'presentation',
  'outputs.*.subtitleStyle.background': 'presentation',
  'outputs.*.subtitleStyle.highlight': 'presentation',
  'outputs.*.subtitleStyle.font': 'asset',
  'pronounce.*': 'voice',
  'pacing.sentenceGap': 'presentation',
  'pacing.paragraphGap': 'presentation',
  'pacing.sceneGap': 'presentation',
  'pacing.lead': 'presentation',
  'pacing.tail': 'presentation',
  'pacing.maxPause': 'voice',
  seed: 'voice',
  targetDuration: 'structure',
  'subtitleStyle.size': 'presentation',
  'subtitleStyle.position': 'presentation',
  'subtitleStyle.color': 'presentation',
  'subtitleStyle.background': 'presentation',
  'subtitleStyle.highlight': 'presentation',
  'subtitleStyle.font': 'asset',
  bgm: 'asset',
  'bgm.src': 'asset',
  'bgm.level': 'presentation',
  'bgm.duck': 'presentation',
  'bgm.credit': 'text',
  theme: 'presentation',
  'theme.base': 'presentation',
  'theme.background': 'presentation',
  'theme.text': 'presentation',
  'theme.accent': 'presentation',
  logo: 'asset',
  'logo.src': 'asset',
  'logo.position': 'presentation',
  'logo.size': 'presentation',
  'logo.opacity': 'presentation',
  sfx: 'presentation',
  transition: 'presentation',
  translationOf: 'structure',
  allowDrift: 'structure',
  'acting.emotions.*.voice': 'voice',
  'acting.emotions.*.speed': 'voice',
  'acting.emotions.*.maxPause': 'voice',
  'acting.emotions.*.face': 'presentation',
  'acting.emotions.*.motion': 'presentation',
  'acting.idle': 'presentation',
};
const RECORDS = new Set(['cast', 'outputs', 'pronounce', 'acting.emotions']);

export interface InspectError {
  line?: number;
  message: string;
}

// ---------- closed world ----------

interface FoundDirective {
  name: string;
  placement: Placement;
  attrs: Record<string, string>;
  hasLabel: boolean;
  line: number;
  offset: number;
  /** Inside a `:::table` / `:::chart`, whose cells are read from the raw source as text. */
  inCells: boolean;
}

const PLACEMENT: Record<string, Placement> = {
  textDirective: 'inline',
  leafDirective: 'leaf',
  containerDirective: 'container',
};

export function markdownTree(source: string): Root {
  return unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkDirective)
    .parse(source) as Root;
}

/**
 * Narration paragraphs that are really something else the parser could not read: a block
 * directive or a speaker prefix with broken syntax, a pipe table outside `:::table`, attributes
 * that did not attach to their directive. They would be read aloud as text.
 */
function paragraphIssues(node: RootContent, source: string, castKeys: string[]): InspectError[] {
  if (node.type !== 'paragraph') return [];
  const line = node.position?.start.line ?? 0;
  const s = node.position?.start.offset;
  const e = node.position?.end.offset;
  const raw = s !== undefined && e !== undefined ? source.slice(s, e).trim() : '';
  const out: InspectError[] = [];
  if (raw.startsWith('::'))
    out.push({
      line,
      message: 'this line starts like a block directive but is read as narration (check its {…})',
    });
  const lines = raw.split('\n').map((l) => l.trim());
  if (lines.every((l) => l.startsWith('|') && l.length > 1 && l.endsWith('|')))
    out.push({
      line,
      message: 'a table must be inside :::table … ::: (here it would be read aloud)',
    });
  // a speaker on a later line of the same paragraph is read by the first one, prefix and all
  for (const [k, l] of lines.slice(1).entries()) {
    const later = /^([A-Za-z_][\w-]*)(\{[^}]*\})?:/.exec(l)?.[1];
    if (later && castKeys.includes(later))
      out.push({
        line: line + k + 1,
        message: `"${later}:" on a later line of this paragraph is read by its first speaker; leave an empty line before it`,
      });
  }
  const speaker = /^([A-Za-z_][\w-]*)\{[^}]*\}:/.exec(raw);
  if (speaker && !castKeys.includes(speaker[1]!))
    out.push({
      line,
      message: `"${speaker[1]}" is not in cast; this paragraph would be read with its {…}`,
    });
  // `jon: …` / `Host: …` for cast `joon` / `host`: read aloud as narration of the first cast
  const named = /^([A-Za-z_][\w-]*)\s*[:：]/.exec(raw)?.[1];
  if (
    named &&
    !castKeys.includes(named) &&
    castKeys.some((k) => k.toLowerCase() === named.toLowerCase())
  )
    out.push({
      line,
      message: `"${named}" differs from a cast name only in case; it would be read aloud by the first cast (write the cast name first to say it: \`host: Host: …\`)`,
    });
  if (
    node.children.length > 0 &&
    node.children.every((c) => c.type === 'image' || (c.type === 'text' && !c.value.trim()))
  )
    out.push({ line, message: 'an image on its own line is not shown; use ::image{src=…}' });
  const last = [...node.children].reverse().find((c) => c.type !== 'text' || c.value.trim());
  if (last?.type === 'textDirective' && last.name === 'react')
    out.push({
      line: last.position?.start.line ?? line,
      message: ':react at the end of a paragraph has no word to start from; it is dropped',
    });
  // attributes that did not attach to their directive: the parser reports them (directive-brace)
  return out;
}

/** Children a container reads; anything else in it is dropped from the render (parse.ts visualFrom). */
const CONTAINER_CHILDREN: Record<string, string[]> = {
  bullets: ['list'],
  compare: ['heading', 'list'],
  quote: ['paragraph'],
  gallery: ['paragraph'],
  markdown: ['heading', 'paragraph', 'list'],
  split: ['heading', 'paragraph', 'list'],
};

function containerIssues(node: RootContent): InspectError[] {
  if (node.type !== 'containerDirective') return [];
  const allowed = CONTAINER_CHILDREN[node.name];
  if (!allowed) return [];
  const out: InspectError[] = [];
  const bad = (c: { type: string; position?: { start: { line: number } } }, what: string) =>
    out.push({
      line: c.position?.start.line ?? 0,
      message: `:::${node.name} does not show ${what}; it would be dropped`,
    });
  for (const c of node.children) {
    if (!allowed.includes(c.type)) bad(c, `a ${c.type}`);
    else if (c.type === 'list')
      for (const li of c.children)
        for (const x of li.children)
          if (x.type !== 'paragraph') bad(x, `a ${x.type} inside a list item`);
  }
  return out;
}

/** Every directive node anywhere in the document, and images whose alt text lost a `:name`. */
function walk(
  source: string,
  castKeys: string[],
): { directives: FoundDirective[]; altLoss: number[]; issues: InspectError[] } {
  const directives: FoundDirective[] = [];
  const altLoss: number[] = [];
  const tree = markdownTree(source);
  const issues = tree.children.flatMap((c): InspectError[] => [
    ...paragraphIssues(c, source, castKeys),
    ...containerIssues(c),
    ...(c.type === 'html' && !/^\s*<!--[\s\S]*-->\s*$/.test(c.value)
      ? [
          {
            line: c.position?.start.line ?? 0,
            message: 'HTML is not part of the script format; it would be dropped',
          },
        ]
      : []),
  ]);
  const visit = (node: RootContent | Root, inCells: boolean) => {
    const placement = PLACEMENT[node.type];
    if (placement) {
      const d = node as TextDirective | LeafDirective | ContainerDirective;
      const attrs: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.attributes ?? {})) attrs[k] = v ?? '';
      directives.push({
        name: d.name,
        placement,
        attrs,
        hasLabel: placement !== 'container' && d.children.length > 0,
        line: d.position?.start.line ?? 0,
        offset: d.position?.start.offset ?? -1,
        inCells,
      });
    }
    if (node.type === 'image') {
      // `![ratio a:b](x.png)`: the parser makes `:b` a directive and the alt keeps only "ratio a".
      const img = node as Image;
      const s = img.position?.start.offset;
      const e = img.position?.end.offset;
      const raw = s !== undefined && e !== undefined ? source.slice(s, e) : '';
      const altRaw = /^!\[([\s\S]*)\]\(/.exec(raw)?.[1] ?? '';
      for (const m of altRaw.matchAll(/(?<!\\):[A-Za-z][\w-]*/g))
        if (!(img.alt ?? '').includes(m[0])) {
          altLoss.push(img.position?.start.line ?? 0);
          break;
        }
    }
    if ('children' in node) {
      const cells =
        inCells || (node.type === 'containerDirective' && ['table', 'chart'].includes(node.name));
      for (const c of (node as Parent).children) visit(c as RootContent, cells);
    }
  };
  visit(tree, false);
  return { directives, altLoss, issues };
}

const own = (o: object, k: string) => Object.hasOwn(o, k);

/** Frontmatter keys the table does not know (nested, with record keys as `*`). */
function frontmatterErrors(raw: unknown): InspectError[] {
  const errors: InspectError[] = [];
  const known = Object.keys(FRONTMATTER);
  const walkFm = (value: unknown, pattern: string, display: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const [key, v] of Object.entries(value)) {
      const child =
        pattern === '' ? key : RECORDS.has(pattern) ? `${pattern}.*` : `${pattern}.${key}`;
      const shown = display === '' ? key : `${display}.${key}`;
      const container = RECORDS.has(child) || known.some((k) => k.startsWith(`${child}.`));
      if (!own(FRONTMATTER, child) && !container)
        errors.push({ message: `frontmatter key "${shown}" is not part of the script format` });
      else if (container) walkFm(v, child, shown);
    }
  };
  walkFm(raw, '', '');
  return errors;
}

/**
 * Closed-world check (plan 3.2): every directive is one the parser read, in a place the table
 * allows, with known attributes; speaker prefixes and frontmatter use known keys only.
 */
export function closedWorldErrors(
  source: string,
  trace: ParseTrace,
  script: Script,
): InspectError[] {
  const errors: InspectError[] = [];
  const consumed = new Set(trace.consumed);
  const shorthand = new Set(trace.shorthand);
  const castKeys = Object.keys(script.meta.cast);
  // the parser's view: speaker prefixes masked, so a `say="… :pause …"` is not a directive
  const { directives, altLoss, issues } = walk(trace.masked, castKeys);
  errors.push(...issues);
  const outputs = script.meta.outputs;
  for (const d of directives) {
    const at = { line: d.line };
    const known = own(DIRECTIVES, d.name);
    if (shorthand.has(d.offset)) {
      // `alex:Today`: the parser glues the name back into the text and drops the rest.
      if (Object.keys(d.attrs).length > 0 || d.hasLabel)
        errors.push({ ...at, message: `"${d.name}" after a speaker name loses its {…} or […]` });
      continue;
    }
    if (d.inCells && d.placement === 'inline' && !known) continue; // `key:value` in a table cell
    if (!consumed.has(d.offset)) {
      errors.push({
        ...at,
        message: d.inCells
          ? `:${d.name} inside a table cell is drawn as text; write \`a:b\` in backticks for text`
          : `:${d.name} is not read in this place (inside emphasis, a link, a heading, a list, a quote or another directive); it would be shown as text or dropped`,
      });
      continue;
    }
    if (!known) continue; // the parser already reported it (unknown-directive)
    const spec = DIRECTIVES[d.name as KnownDirective];
    if (spec.placement !== d.placement) {
      const how = { inline: `:${d.name}`, leaf: `::${d.name}`, container: `:::${d.name}` };
      errors.push({ ...at, message: `${d.name} must be written as ${how[spec.placement]}` });
      continue;
    }
    for (const [k, v] of Object.entries(d.attrs)) {
      if (spec.attrs === 'cast') {
        if (!castKeys.includes(k))
          errors.push({ ...at, message: `${d.name}: "${k}" is not in cast` });
      } else if (spec.attrs === 'output') {
        if (!own(outputs, k)) errors.push({ ...at, message: `only: "${k}" is not an output` });
        else if (v !== '') errors.push({ ...at, message: `only{${k}} takes no value` });
      } else if (!own(spec.attrs, k))
        errors.push({ ...at, message: `${d.name} has no attribute "${k}"` });
      else if (NUMERIC.has(k) && !/^-?\d+(\.\d+)?$/.test(v))
        errors.push({ ...at, message: `${d.name} ${k}=${v} is not a number` });
    }
  }
  for (const line of altLoss)
    errors.push({
      line,
      message: 'image caption contains ":name", which the parser drops; escape it as "\\:"',
    });
  // speaker prefix attributes are checked strictly by the parser (prefix-attrs, gap-value)
  for (const key of castKeys)
    if (key in Object.prototype) errors.push({ message: `cast name "${key}" is reserved` });
  // `constructor: …` matches `in meta.cast` in the parser without being a cast member
  for (const scene of script.scenes)
    for (const b of scene.blocks)
      if (b.kind === 'paragraph') {
        if (!own(script.meta.cast, b.cast))
          errors.push({ line: b.line, message: `"${b.cast}" is not in cast` });
        // a speaker prefix or attributes that did not parse end up in the spoken text
        // only where a broken prefix lands (the start of the paragraph), so quoted code such as
        // `{x=1}` later in a sentence can still be read
        const first = b.sentences[0]?.text ?? '';
        const spoken = /^\s*([A-Za-z_][\w-]*\s*[:：]?\s*)?\{\s*[A-Za-z_][\w-]*\s*=/.test(first)
          ? b.sentences[0]
          : undefined;
        if (spoken)
          errors.push({
            line: b.line,
            message: `"{…=…}" would be read aloud in "${spoken.text.slice(0, 40)}" (check the speaker prefix or directive syntax)`,
          });
      }
  for (const key of Object.keys(outputs))
    if (key in Object.prototype) errors.push({ message: `output name "${key}" is reserved` });
  errors.push(...frontmatterErrors(trace.frontmatterRaw));
  return errors;
}

// ---------- hashing ----------

/** Canonical JSON: sorted object keys, no undefined / null values, finite numbers only. */
export function canonical(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new Error(`cannot hash ${v}`);
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => (x === undefined || x === null ? null : norm(x)));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x !== undefined && x !== null) out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/** Screen text is compared as seen: NFC, LF line ends. */
const text = (s: string) => s.normalize('NFC').replace(/\r\n?/g, '\n');

// ---------- content ----------

export interface ScreenText {
  scene: string;
  /** Block number inside the scene (0-based); absent for script-wide text. */
  block?: number;
  directive: string;
  attr: string;
  text: string;
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

const mdOf = (md: MdBlock[] | undefined) =>
  (md ?? []).map((b) => ({
    k: b.kind,
    runs: b.runs.map((r) => ({ t: text(r.text), b: r.bold, c: r.code })),
  }));
const mdText = (b: MdBlock) => text(b.runs.map((r) => r.text).join(''));

function visualContent(v: Visual): unknown {
  const t = (s: string | undefined) => (s === undefined ? undefined : text(s));
  switch (v.type) {
    case 'title':
    case 'image':
    case 'video':
    case 'thumbnail':
      return { label: t(v.label) };
    case 'quote':
      return { items: v.items?.map(text), by: t(v.attrs.by) };
    case 'table':
      return { rows: v.rows?.map((r) => r.map(text)) };
    case 'chart':
      return { rows: v.rows?.map((r) => r.map(text)), unit: t(v.attrs.unit) };
    case 'bullets':
      return { items: v.items?.map(text) };
    case 'compare':
      return {
        columns: v.columns?.map((c) => ({ title: text(c.title), items: c.items.map(text) })),
      };
    case 'gallery':
      return { captions: v.images?.map((im) => t(im.caption) ?? '') };
    case 'split':
      return { md: mdOf(v.md), captions: v.images?.map((im) => t(im.caption) ?? '') };
    case 'markdown':
      return { md: mdOf(v.md) };
    default:
      return { body: t(v.body) };
  }
}

function visualScreenText(v: Visual, push: (attr: string, s: string) => void) {
  const label = (s?: string) => s && push('label', s);
  switch (v.type) {
    case 'title':
    case 'image':
    case 'video':
    case 'thumbnail':
      label(v.label);
      break;
    case 'quote':
      v.items?.forEach((s) => push('text', s));
      if (v.attrs.by) push('by', v.attrs.by);
      break;
    case 'table':
    case 'chart':
      v.rows?.forEach((r) => r.forEach((c) => push('cell', c)));
      if (v.type === 'chart' && v.attrs.unit) push('unit', v.attrs.unit);
      break;
    case 'bullets':
      v.items?.forEach((s) => push('item', s));
      break;
    case 'compare':
      v.columns?.forEach((c) => {
        push('title', c.title);
        c.items.forEach((s) => push('item', s));
      });
      break;
    case 'gallery':
    case 'split':
    case 'markdown':
      v.md?.forEach((b) => push(b.kind, mdText(b)));
      v.images?.forEach((im) => im.caption && push('caption', im.caption));
      break;
    default:
      if (v.body) push('body', v.body);
  }
}

/** Content hash input (plan 3.3) and the flat screen text list for Studio's checks. */
export function contentOf(script: Script): { value: unknown; screenText: ScreenText[] } {
  const { meta } = script;
  const speaking = castsIn(script.scenes);
  const names = Object.keys(meta.cast)
    .filter((k) => speaking.has(k))
    .map((k) => ({ cast: k, name: text(meta.cast[k]!.name ?? k) }));
  const bgm = typeof meta.bgm === 'object' ? meta.bgm.credit : undefined;
  const screenText: ScreenText[] = [];
  if (meta.title)
    screenText.push({ scene: '', directive: 'frontmatter', attr: 'title', text: text(meta.title) });
  for (const n of names)
    screenText.push({ scene: '', directive: 'speaker', attr: n.cast, text: n.name });
  if (bgm)
    screenText.push({ scene: '', directive: 'description', attr: 'bgm.credit', text: text(bgm) });
  const scenes = script.scenes.map((scene) => {
    if (scene.title)
      screenText.push({
        scene: scene.id,
        directive: 'heading',
        attr: 'title',
        text: text(scene.title),
      });
    const blocks = scene.blocks.map((b, bi) => {
      if (b.kind === 'paragraph') {
        for (const s of b.sentences)
          screenText.push({
            scene: scene.id,
            block: bi,
            directive: 'paragraph',
            attr: b.cast,
            text: text(s.text),
          });
        return { p: b.cast, sentences: b.sentences.map((s) => text(s.text)) };
      }
      visualScreenText(b, (attr, s) =>
        screenText.push({ scene: scene.id, block: bi, directive: b.type, attr, text: text(s) }),
      );
      return { v: b.type, ...(visualContent(b) as object) };
    });
    return { title: text(scene.title), blocks };
  });
  return {
    value: {
      lang: meta.lang,
      title: meta.title === undefined ? undefined : text(meta.title),
      names: names.map((n) => n.name),
      credit: bgm === undefined ? undefined : text(bgm),
      scenes,
    },
    screenText,
  };
}

// ---------- presentation helpers ----------

/** The scenes of one output with the paragraphs it leaves out (`:only`) removed. */
export function outputScenes(script: Script, output: string): Scene[] {
  const profile = script.meta.outputs[output];
  const wanted = profile?.scenes ? new Set(profile.scenes) : null;
  return script.scenes
    .filter((s) => !wanted || wanted.has(s.id))
    .map((s) => ({
      ...s,
      blocks: s.blocks.filter(
        (b) =>
          b.kind !== 'paragraph' ||
          !(b as Paragraph).only ||
          (b as Paragraph).only!.includes(output),
      ),
    }));
}

/** Numeric directive attributes: `Number` normalization (`2.0` = `2`). */
const NUMERIC = new Set(['x', 'y', 'zoom', 'r', 'w', 'h', 'start', 'highlight', 'speed']);

/**
 * Presentation / asset attributes of a directive with their defaults removed; asset values are
 * mapped through `asset` (file sha). Text and voice attributes are left to their own hashes.
 */
export function presentationAttrs(
  name: KnownDirective,
  attrs: Record<string, string>,
  asset: (path: string) => string,
): Record<string, string | number> {
  const spec = DIRECTIVES[name].attrs;
  const out: Record<string, string | number> = {};
  if (typeof spec === 'string') return out;
  for (const [k, v] of Object.entries(attrs)) {
    const kind = spec[k];
    if (kind === 'asset') out[k] = asset(v);
    else if (kind === 'presentation') out[k] = NUMERIC.has(k) ? Number(v) : v;
  }
  if (name === 'image') {
    if (out.kenburns !== 'off') delete out.kenburns;
  }
  if (name === 'video' && out.start === 0) delete out.start;
  if (name === 'split' && out.side !== 'right') delete out.side;
  return out;
}

// ---------- defaults (plan 3.6) ----------

/** Schema defaults, by kind: what a script leaves out equals what it could have written. */
export function schemaDefaults(): {
  voice: Record<string, unknown>;
  presentation: Record<string, unknown>;
} {
  const pacing = pacingSchema.parse({});
  const { voice: _v, ...cast } = castMemberSchema.parse({ voice: 'qwen:Sohee' });
  const { aspect: _a, ...output } = outputProfileSchema.parse({ aspect: '16:9' });
  const { src: _b, ...bgm } = bgmSchema.parse({ src: 'x' });
  const { src: _l, ...logo } = logoSchema.parse({ src: 'x' });
  const top = frontmatterSchema.parse({ lang: 'ko' });
  return {
    voice: {
      'pacing.maxPause': pacing.maxPause,
      'cast.*.speed': cast.speed,
      seed: top.seed,
    },
    presentation: {
      pacing: { ...pacing, maxPause: undefined },
      cast: { face: cast.face, motion: cast.motion },
      output,
      bgm,
      logo,
      theme: top.theme,
      sfx: top.sfx,
      transition: top.transition,
      idle: true,
    },
  };
}

/** Remove keys whose value equals the default (shallow). */
export function withoutDefaults<T extends Record<string, unknown>>(
  value: T,
  defaults: Record<string, unknown>,
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    if (canonical(v) !== canonical(defaults[k])) out[k] = v;
  return out as Partial<T>;
}
