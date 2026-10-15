import type { Heading, Paragraph as MdParagraph, PhrasingContent, Root, RootContent } from 'mdast';
import type { ContainerDirective, LeafDirective, TextDirective } from 'mdast-util-directive';
import remarkDirective from 'remark-directive';
import remarkFrontmatter from 'remark-frontmatter';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import { decodeNumericCharacterReference } from 'micromark-util-decode-numeric-character-reference';
import YAML from 'yaml';
import { isStandardEmotion } from './acting.js';
import { Diagnostics } from './diagnostics.js';
import {
  FRAMINGS,
  frontmatterSchema,
  MOTIONS,
  type Framing,
  type MdBlock,
  type MdRun,
  SFX,
  type Acting,
  type Block,
  type Frontmatter,
  type Inline,
  type Paragraph,
  type Scene,
  type Script,
  type Visual,
} from './schema.js';
import { splitSentences } from './sentences.js';

/** Every directive name the script format reserves (PLAN 4.1). */
export const KNOWN_DIRECTIVES = [
  'title',
  'image',
  'video',
  'bullets',
  'code',
  'markdown',
  'table',
  'chart',
  'diagram',
  'quote',
  'compare',
  'split',
  'gallery',
  'thumbnail',
  'cue',
  'pause',
  'react',
  'only',
  'audio',
  'shot',
  'emo',
] as const;

/** Directives implemented in this build. Known-but-unimplemented names are errors, not no-ops. */
export const IMPLEMENTED_DIRECTIVES = new Set<string>([
  'title',
  'image',
  'bullets',
  'code',
  'table',
  'quote',
  'compare',
  'gallery',
  'chart',
  'diagram',
  'markdown',
  'split',
  'video',
  'thumbnail',
  'cue',
  'pause',
  'react',
  'only',
  'audio',
  'shot',
  'emo',
]);

const VISUAL_LEAF = new Set(['title', 'image', 'video', 'thumbnail']);
const SPEAKER_PREFIX = /^([A-Za-z_][\w-]*)(\{([^}]*)\})?:\s*/;
/** `mina{…}:` at the start of a paragraph (one line, acting stage 2 plan 1.3). */
const PREFIX_WITH_ATTRS = /^([A-Za-z_][\w-]*)\{([^}\r\n]*)\}:/;
/** Attributes of a speaker prefix. */
export const PREFIX_KEYS = ['emo', 'power', 'say', 'volume', 'speed', 'face', 'motion', 'gap'];
/** Attributes of an inline `:emo{…}`. */
export const EMO_KEYS = ['emo', 'power', 'say', 'volume', 'speed'];
const NUMBER = /^-?\d+(\.\d+)?$/;
const HEADING_ID = /\s*\{#([A-Za-z0-9_-]+)\}\s*$/;

export interface ParseResult {
  script: Script | null;
  diagnostics: Diagnostics;
  /** What the parser read from the source, for `inspect`'s closed-world checks. */
  trace?: ParseTrace;
}

/** Source positions (start offsets) the parser used; anything else it turned into text or dropped. */
export interface ParseTrace {
  /** The frontmatter as YAML parsed it, before the schema dropped unknown keys. */
  frontmatterRaw: unknown;
  /** Directive nodes the parser read as directives. */
  consumed: number[];
  /** `alex:Today`: a text directive glued back into the speaker's text. */
  shorthand: number[];
  /** Raw `{…}` of speaker prefixes (`mina{face=happy}:`). */
  speakerAttrs: { line: number; raw: string }[];
  /**
   * The source as the parser read it: `{…}:` of speaker prefixes masked (same length and lines),
   * so markup inside a `say="…"` is not read as markdown. Equal to the source without prefixes.
   */
  masked: string;
}

type Track = Omit<ParseTrace, 'frontmatterRaw' | 'masked'>;
const offsetOf = (node: { position?: { start: { offset?: number } } }) =>
  node.position?.start.offset ?? -1;

function lineOf(node: { position?: { start: { line: number } } }): number | undefined {
  return node.position?.start.line;
}

function plainText(nodes: PhrasingContent[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'text' || n.type === 'inlineCode') return n.value;
      if ('children' in n) return plainText(n.children as PhrasingContent[]);
      return '';
    })
    .join('');
}

function attrsOf(d: {
  attributes?: Record<string, string | null | undefined> | null;
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(d.attributes ?? {})) out[k] = v ?? '';
  return out;
}

/** Character references in an attribute value, decoded as micromark decodes directive attributes. */
export function decodeReferences(value: string): string {
  return value.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g, (all, ref: string) => {
    if (ref.startsWith('#')) {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      return decodeNumericCharacterReference(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
    }
    const named = decodeNamedCharacterReference(ref);
    return named === false ? all : named;
  });
}

/**
 * Attributes of a speaker prefix, strictly (acting stage 2 plan 1.2): only `key=value`,
 * `key="…"`, `key='…'` separated by spaces; anything left over or a repeated key is an error.
 */
export function parsePrefixAttrs(raw: string): { attrs: Record<string, string>; errors: string[] } {
  const attrs: Record<string, string> = {};
  const errors: string[] = [];
  const token = /\s*([A-Za-z_][\w-]*)=("([^"]*)"|'([^']*)'|([^\s"']+))/y;
  let at = 0;
  while (at < raw.length) {
    if (!raw.slice(at).trim()) break;
    token.lastIndex = at;
    const m = token.exec(raw);
    if (!m) {
      errors.push(`"${raw.slice(at).trim()}" is not key=value`);
      break;
    }
    const key = m[1]!;
    if (Object.hasOwn(attrs, key)) errors.push(`"${key}" is given twice`);
    attrs[key] = decodeReferences(m[3] ?? m[4] ?? m[5]!);
    at = token.lastIndex;
    if (at < raw.length && !/\s/.test(raw[at]!)) {
      errors.push(`"${raw.slice(at).trim()}" is not key=value`);
      break;
    }
  }
  return { attrs, errors };
}

/** Keys written in a directive's `{…}`, quoted values skipped (remark keeps only the last of a repeated key). */
function directiveKeys(rawDirective: string): string[] {
  const open = rawDirective.indexOf('{');
  const close = rawDirective.lastIndexOf('}');
  if (open < 0 || close < open) return [];
  const inner = rawDirective.slice(open + 1, close).replace(/"[^"]*"|'[^']*'/g, '""');
  return [...inner.matchAll(/(?:^|[\s{])([A-Za-z_][\w-]*)\s*=/g)].map((m) => m[1]!);
}

/**
 * Voice attributes of a prefix or an inline `:emo` (acting plan 2.1): checked and collected.
 * Returns undefined when nothing is set.
 */
function actingFrom(
  attrs: Record<string, string>,
  meta: Frontmatter,
  line: number | undefined,
  diags: Diagnostics,
  where: string,
): Acting | undefined {
  const a: Acting = {};
  if (attrs.emo !== undefined) {
    const user = Object.hasOwn(meta.acting?.emotions ?? {}, attrs.emo);
    if (isStandardEmotion(attrs.emo) || user) a.emo = attrs.emo;
    else
      diags.error(
        'emo-name',
        `${where}: emo=${attrs.emo} is not a standard emotion or one of acting.emotions`,
        line,
      );
  }
  if (attrs.power !== undefined) {
    if (attrs.power === 'weak' || attrs.power === 'strong') a.power = attrs.power;
    else
      diags.error('power-value', `${where}: power must be weak or strong: "${attrs.power}"`, line);
    if (attrs.emo === undefined)
      diags.error(
        'power-without-emo',
        `${where}: power needs emo (power=… sets how strong it is)`,
        line,
      );
  }
  if (attrs.say !== undefined) {
    if (!attrs.say.trim()) diags.error('say-chars', `${where}: say is empty`, line);
    else if (/["'}\r\n]/.test(attrs.say))
      diags.error('say-chars', `${where}: say cannot contain quotes, "}" or line breaks`, line);
    else a.say = attrs.say.trim();
  }
  if (attrs.volume !== undefined) {
    if (attrs.volume === 'soft' || attrs.volume === 'loud') a.volume = attrs.volume;
    else
      diags.error('volume-value', `${where}: volume must be soft or loud: "${attrs.volume}"`, line);
  }
  if (attrs.speed !== undefined) {
    const v = Number(attrs.speed);
    if (!NUMBER.test(attrs.speed) || v < 0.8 || v > 1.25)
      diags.error(
        'speed-value',
        `${where}: speed must be a number from 0.8 to 1.25: "${attrs.speed}"`,
        line,
      );
    else a.speed = v;
  }
  return Object.keys(a).length > 0 ? a : undefined;
}

const isMotion = (m: string) => m === 'none' || (MOTIONS as readonly string[]).includes(m);
const motionMessage = (m: string) => `motion must be one of ${MOTIONS.join(', ')} or none: "${m}"`;

function checkDirectiveName(name: string, line: number | undefined, diags: Diagnostics): boolean {
  if (!(KNOWN_DIRECTIVES as readonly string[]).includes(name)) {
    diags.error(
      'unknown-directive',
      `unknown directive "${name}". If this was meant as text, add a space after ":" or escape it as "\\:"`,
      line,
    );
    return false;
  }
  if (!IMPLEMENTED_DIRECTIVES.has(name)) {
    diags.error(
      'unimplemented-directive',
      `directive "${name}" is not implemented in this version`,
      line,
    );
    return false;
  }
  return true;
}

function cueAttrsCheck(
  attrs: Record<string, string>,
  line: number | undefined,
  diags: Diagnostics,
): void {
  for (const key of ['x', 'y'] as const) {
    if (attrs[key] === undefined) continue;
    const v = Number(attrs[key]);
    if (!Number.isFinite(v) || v < 0 || v > 1)
      diags.error('cue-range', `cue ${key}=${attrs[key]} must be within 0..1`, line);
  }
  if (attrs.zoom !== undefined) {
    const z = Number(attrs.zoom);
    if (!Number.isFinite(z) || z < 1)
      diags.error('cue-range', `cue zoom=${attrs.zoom} must be >= 1`, line);
  }
  const marks = ['circle', 'box', 'highlight', 'spotlight', 'arrow'];
  if (attrs.mark !== undefined && !marks.includes(attrs.mark))
    diags.error('cue-mark', `cue mark=${attrs.mark} must be one of ${marks.join(', ')}`, line);
  if (
    attrs.sfx !== undefined &&
    attrs.sfx !== 'none' &&
    !(SFX as readonly string[]).includes(attrs.sfx)
  )
    diags.error('cue-sfx', `cue sfx=${attrs.sfx} must be one of ${SFX.join(', ')} or none`, line);
  const dirs = ['left', 'right', 'top', 'bottom'];
  if (attrs.from !== undefined && !dirs.includes(attrs.from))
    diags.error('cue-mark', `cue from=${attrs.from} must be one of ${dirs.join(', ')}`, line);
}

function paragraphFrom(
  node: MdParagraph,
  meta: Frontmatter,
  defaultCast: string,
  diags: Diagnostics,
  track: Track,
  source: string,
  prefix: { name: string; raw: string; length: number } | undefined,
  /** a directive glued to the prefix colon: already reported (prefix-directive) */
  glued = false,
): Paragraph | null {
  const line = lineOf(node);
  const children = [...node.children];
  let cast = defaultCast;
  let gap: number | undefined;
  let face: string | undefined;
  let motion: string | undefined;
  let only: string[] | undefined;
  let acting: Acting | undefined;

  const prefixAttrs = (raw: string) => {
    track.speakerAttrs.push({ line: line ?? 0, raw });
    const { attrs, errors } = parsePrefixAttrs(raw);
    for (const e of errors) diags.error('prefix-attrs', `speaker {${raw}}: ${e}`, line);
    for (const k of Object.keys(attrs))
      if (!PREFIX_KEYS.includes(k))
        diags.error('prefix-attrs', `speaker {…} has no attribute "${k}"`, line);
    if (attrs.gap !== undefined) {
      const v = Number(attrs.gap);
      if (!NUMBER.test(attrs.gap) || v < -1.5 || v > 3)
        diags.error('gap-value', `gap must be a number from -1.5 to 3: "${attrs.gap}"`, line);
      else gap = v;
    }
    if (attrs.face !== undefined) {
      if (/^[a-z][a-z0-9-]*$/.test(attrs.face)) face = attrs.face;
      else
        diags.error(
          'face-name',
          `face must be lowercase letters, digits or -: "${attrs.face}"`,
          line,
        );
    }
    if (attrs.motion !== undefined) {
      if (isMotion(attrs.motion)) motion = attrs.motion;
      else diags.error('motion-name', motionMessage(attrs.motion), line);
    }
    acting = actingFrom(attrs, meta, line, diags, 'speaker {…}');
  };

  // `alex:Today` → remark sees text "alex" followed by text directive ":Today". Restore it.
  const first = children[0];
  const second = children[1];
  // starts like `mina{` / `mina {`: it must be read as a prefix below, or it is broken
  const s0 = node.position?.start.offset ?? 0;
  const named = /^([A-Za-z_][\w-]*)\s*\{/.exec(source.slice(s0, s0 + 256));
  let prefixRead = !!prefix;
  if (prefix && first?.type !== 'text')
    diags.error(
      'prefix-broken',
      'the speaker prefix did not parse (the line starts with markup); write name{…}: text',
      line,
    );
  if (prefix && first?.type === 'text') {
    // masked `mina{…}:` (see parseScript): the text starts with the name, the masked braces and a space
    cast = prefix.name;
    prefixAttrs(prefix.raw);
    children[0] = { ...first, value: first.value.slice(prefix.length).replace(/^\s+/, '') };
  } else if (
    first?.type === 'text' &&
    second?.type === 'textDirective' &&
    first.value.trim() in meta.cast
  ) {
    const d = second as TextDirective;
    track.shorthand.push(offsetOf(d));
    cast = first.value.trim();
    children.splice(0, 2, { type: 'text', value: d.name + plainText(d.children) });
  } else if (first?.type === 'text') {
    const m = SPEAKER_PREFIX.exec(first.value);
    if (m && m[1]! in meta.cast) {
      cast = m[1]!;
      // `{…}` reaches here only when it spans lines or the like (the one-line form is masked)
      if (m[2]) {
        prefixAttrs(m[3] ?? '');
        prefixRead = true;
      }
      children[0] = { ...first, value: first.value.slice(m[0].length) };
    }
  }

  if (named && Object.hasOwn(meta.cast, named[1]!) && !prefixRead && !glued)
    diags.error(
      'prefix-broken',
      'this paragraph starts like a speaker prefix that did not parse (name{key=value …}: text); it would be read aloud',
      line,
    );
  const inlines: Inline[] = [];
  let audio: string | undefined;
  for (const [ci, child] of children.entries()) {
    if (child.type === 'textDirective') {
      const d = child as TextDirective;
      const dLine = lineOf(d) ?? line;
      track.consumed.push(offsetOf(d));
      const next = children[ci + 1];
      if (next?.type === 'text' && /^\s*\{[^}]*=/.test(next.value))
        diags.error(
          'directive-brace',
          `:${d.name} has attributes that did not parse ({…} would be read aloud; check quotes and spaces)`,
          dLine,
        );
      if (!checkDirectiveName(d.name, dLine, diags)) continue;
      const attrs = attrsOf(d);
      if (d.name === 'cue') {
        cueAttrsCheck(attrs, dLine, diags);
        inlines.push({ type: 'cue', text: plainText(d.children), attrs });
      } else if (d.name === 'pause') {
        const seconds = Number(plainText(d.children));
        if (!Number.isFinite(seconds) || seconds <= 0)
          diags.error(
            'pause-value',
            'pause needs a positive number of seconds, e.g. :pause[0.5]',
            dLine,
          );
        else inlines.push({ type: 'pause', seconds });
      } else if (d.name === 'react') {
        const faces: Record<string, string> = {};
        const motions: Record<string, string> = {};
        for (const [who, value] of Object.entries(attrs)) {
          // `face` or `face+motion` (motion `none` turns the automatic one off)
          const [face = '', motion] = value.split('+');
          if (!(who in meta.cast))
            diags.error('react-cast', `:react names "${who}", which is not in cast`, dLine);
          else if (!/^[a-z][a-z0-9-]*$/.test(face))
            diags.error(
              'face-name',
              `face must be lowercase letters, digits or -: "${face}"`,
              dLine,
            );
          else if (motion !== undefined && !isMotion(motion))
            diags.error('motion-name', motionMessage(motion), dLine);
          else {
            faces[who] = face;
            if (motion !== undefined) motions[who] = motion;
          }
        }
        if (Object.keys(attrs).length === 0)
          diags.error('react-empty', ':react needs cast=face, e.g. :react{mina=surprised}', dLine);
        if (Object.keys(faces).length > 0)
          inlines.push({
            type: 'react',
            faces,
            ...(Object.keys(motions).length > 0 ? { motions } : {}),
          });
      } else if (d.name === 'only') {
        only = Object.keys(attrs);
        if (only.length === 0)
          diags.error(
            'only-empty',
            'only needs at least one output name, e.g. :only{youtube}',
            dLine,
          );
      } else if (d.name === 'audio') {
        audio = attrs.src;
      } else if (d.name === 'emo' && d.children.length === 0 && Object.keys(attrs).length === 0) {
        diags.error(
          'emo-attrs',
          ':emo needs emo=…, e.g. :emo{emo=sad}; to write ":emo" as text, escape it as "\\:emo"',
          dLine,
        );
      } else if (d.name === 'emo') {
        const s0 = d.position?.start.offset;
        const e0 = d.position?.end.offset;
        const keys =
          s0 !== undefined && e0 !== undefined ? directiveKeys(source.slice(s0, e0)) : [];
        for (const k of new Set(keys.filter((k, i) => keys.indexOf(k) !== i)))
          diags.error('emo-attrs', `:emo: "${k}" is given twice`, dLine);
        for (const k of Object.keys(attrs))
          if (!EMO_KEYS.includes(k))
            diags.error(
              'emo-attrs',
              attrs[k] === '' && isStandardEmotion(k)
                ? `:emo{${k}} → write :emo{emo=${k}}`
                : `:emo has no attribute "${k}"`,
              dLine,
            );
        if (d.children.length > 0)
          diags.error(
            'emo-attrs',
            ':emo takes no [text]; write :emo{emo=…} before the sentence',
            dLine,
          );
        if (attrs.emo === undefined)
          diags.error('emo-attrs', ':emo needs emo=…, e.g. :emo{emo=sad}', dLine);
        const a = actingFrom(attrs, meta, dLine, diags, ':emo');
        inlines.push({
          type: 'emo',
          acting: a ?? {},
          ...(dLine !== undefined ? { line: dLine } : {}),
        });
      } else if (d.name === 'shot') {
        diags.error(
          'shot-placement',
          "shot is a block directive: put ::shot{cast=framing} on its own line before the scene's first paragraph",
          dLine,
        );
      }
      continue;
    }
    if (child.type === 'text' || child.type === 'inlineCode')
      inlines.push({ type: 'text', value: child.value });
    else if (child.type === 'break') inlines.push({ type: 'text', value: ' ' });
    else if ('children' in child)
      inlines.push({ type: 'text', value: plainText(child.children as PhrasingContent[]) });
  }

  const issues: { line?: number; message: string; level: 'error' | 'info' }[] = [];
  let sentences = splitSentences(inlines, meta.lang, acting, issues);
  for (const i of issues)
    if (i.level === 'error') diags.error('emo-placement', i.message, i.line ?? line);
    else diags.info('emo-placement', i.message, i.line ?? line);
  if (sentences.length === 0) return null;
  if (audio) {
    // a recording: only the face (emo) and volume apply (acting plan 3.1)
    const keep = (a: Acting | undefined): Acting | undefined => {
      if (!a) return undefined;
      const { emo, volume } = a;
      const out: Acting = { ...(emo !== undefined ? { emo } : {}), ...(volume ? { volume } : {}) };
      return Object.keys(out).length > 0 ? out : undefined;
    };
    const dropped = [acting, ...sentences.map((x) => x.acting)].some(
      (a) => a && (a.power !== undefined || a.say !== undefined || a.speed !== undefined),
    );
    if ([acting, ...sentences.map((x) => x.acting)].some((a) => a?.emo !== undefined))
      diags.info(
        'recording-acting',
        'a recording keeps its own voice: emo sets the face and motion only',
        line,
      );
    if (dropped)
      diags.warn(
        'recording-acting',
        'a recording keeps its own voice: power, say and speed are ignored (emo still sets the face, volume the level)',
        line,
      );
    acting = keep(acting);
    sentences = sentences.map((x) => {
      const a = keep(x.acting);
      const { acting: _old, ...rest } = x;
      return a ? { ...rest, acting: a } : rest;
    });
  }
  return {
    kind: 'paragraph',
    line: line ?? 0,
    cast,
    ...(gap !== undefined ? { gap } : {}),
    ...(face !== undefined ? { face } : {}),
    ...(motion !== undefined ? { motion } : {}),
    ...(only ? { only } : {}),
    ...(audio ? { audio } : {}),
    ...(acting ? { acting } : {}),
    sentences,
  };
}

function visualFrom(
  node: LeafDirective | ContainerDirective,
  source: string,
  diags: Diagnostics,
): Visual | null {
  const line = lineOf(node);
  if (!checkDirectiveName(node.name, line, diags)) return null;
  if (['cue', 'pause', 'only', 'audio'].includes(node.name)) {
    diags.error(
      'inline-directive-as-block',
      `"${node.name}" must be used inline with a single colon`,
      line,
    );
    return null;
  }
  const attrs = attrsOf(node);
  if (node.type === 'leafDirective') {
    if (!VISUAL_LEAF.has(node.name)) {
      diags.error(
        'container-required',
        `"${node.name}" needs a container (:::${node.name} ... :::)`,
        line,
      );
      return null;
    }
    const label = plainText(node.children);
    if ((node.name === 'image' || node.name === 'video') && !attrs.src)
      diags.error('image-src', `${node.name} needs src=...`, line);
    return { kind: 'visual', line: line ?? 0, type: node.name, ...(label ? { label } : {}), attrs };
  }
  // container directive
  if (node.name === 'bullets') {
    const items: string[] = [];
    for (const child of node.children) {
      if (child.type !== 'list') continue;
      for (const li of child.children) {
        const text = li.children
          .map((c) => (c.type === 'paragraph' ? plainText(c.children) : ''))
          .join(' ')
          .trim();
        if (text) items.push(text);
      }
    }
    return { kind: 'visual', line: line ?? 0, type: 'bullets', attrs, items };
  }
  if (node.name === 'diagram') {
    // :::diagram wraps a ```mermaid fenced block.
    const fence = node.children.find((c) => c.type === 'code');
    if (!fence || fence.type !== 'code') {
      diags.error('diagram-fence', ':::diagram needs a ```mermaid block inside', line);
      return null;
    }
    return { kind: 'visual', line: line ?? 0, type: 'diagram', attrs, body: fence.value };
  }
  if (node.name === 'code') {
    // :::code wraps a fenced code block; the fence's language becomes attrs.lang.
    const fence = node.children.find((c) => c.type === 'code');
    if (!fence || fence.type !== 'code') {
      diags.error('code-fence', ':::code needs a fenced code block (```lang ... ```) inside', line);
      return null;
    }
    return {
      kind: 'visual',
      line: line ?? 0,
      type: 'code',
      attrs: { ...(fence.lang ? { lang: fence.lang } : {}), ...attrs },
      body: fence.value,
    };
  }
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const body = start !== undefined && end !== undefined ? source.slice(start, end) : '';
  if (node.name === 'table') {
    const rows = pipeTable(body);
    if (rows.length < 2) {
      diags.error('table-rows', ':::table needs a Markdown table (header + rows) inside', line);
      return null;
    }
    const width = rows[0]!.length;
    if (rows.some((r) => r.length !== width))
      diags.warn('table-columns', 'table rows have different numbers of cells', line);
    return { kind: 'visual', line: line ?? 0, type: 'table', attrs, rows };
  }
  if (node.name === 'markdown' || node.name === 'split') {
    const md: MdBlock[] = [];
    const images: { src: string; caption?: string }[] = [];
    const runs = (nodes: PhrasingContent[], bold = false): MdRun[] =>
      nodes.flatMap((n): MdRun[] => {
        if (n.type === 'text') return [{ text: n.value, ...(bold ? { bold } : {}) }];
        if (n.type === 'inlineCode') return [{ text: n.value, code: true }];
        if (n.type === 'strong') return runs(n.children, true);
        if (n.type === 'break') return [{ text: ' ' }];
        if ('children' in n) return runs(n.children as PhrasingContent[], bold);
        return [];
      });
    for (const child of node.children) {
      if (child.type === 'heading') md.push({ kind: 'h', runs: runs(child.children) });
      else if (child.type === 'paragraph') {
        // split: a paragraph holding only an image is the picture side.
        const imgs = child.children.filter((c) => c.type === 'image');
        if (
          node.name === 'split' &&
          imgs.length > 0 &&
          imgs.length === child.children.filter((c) => c.type !== 'text' || c.value.trim()).length
        ) {
          for (const im of imgs)
            if (im.type === 'image')
              images.push({ src: im.url, ...(im.alt ? { caption: im.alt } : {}) });
        } else md.push({ kind: 'p', runs: runs(child.children) });
      } else if (child.type === 'list')
        for (const li of child.children)
          for (const c of li.children)
            if (c.type === 'paragraph') md.push({ kind: 'li', runs: runs(c.children) });
    }
    if (md.length === 0) {
      diags.error('markdown-empty', `:::${node.name} needs text inside`, line);
      return null;
    }
    if (node.name === 'split') {
      if (images.length !== 1) {
        diags.error(
          'split-image',
          ':::split needs exactly one image (![caption](file.png)) and text',
          line,
        );
        return null;
      }
      return { kind: 'visual', line: line ?? 0, type: 'split', attrs, md, images };
    }
    return { kind: 'visual', line: line ?? 0, type: 'markdown', attrs, md };
  }
  if (node.name === 'compare') {
    const columns: { title: string; items: string[] }[] = [];
    for (const child of node.children) {
      if (child.type === 'heading') columns.push({ title: plainText(child.children), items: [] });
      else if (child.type === 'list' && columns.length > 0)
        for (const li of child.children) {
          const text = li.children
            .map((c) => (c.type === 'paragraph' ? plainText(c.children) : ''))
            .join(' ')
            .trim();
          if (text) columns[columns.length - 1]!.items.push(text);
        }
    }
    if (columns.length < 2 || columns.length > 3) {
      diags.error(
        'compare-columns',
        ':::compare needs 2–3 columns: "### title" followed by a list each',
        line,
      );
      return null;
    }
    return { kind: 'visual', line: line ?? 0, type: 'compare', attrs, columns };
  }
  if (node.name === 'gallery') {
    const images: { src: string; caption?: string }[] = [];
    for (const child of node.children)
      if (child.type === 'paragraph')
        for (const c of child.children)
          if (c.type === 'image') images.push({ src: c.url, ...(c.alt ? { caption: c.alt } : {}) });
    if (images.length < 2 || images.length > 6) {
      diags.error('gallery-images', ':::gallery needs 2–6 images (![caption](file.png))', line);
      return null;
    }
    return { kind: 'visual', line: line ?? 0, type: 'gallery', attrs, images };
  }
  if (node.name === 'chart') {
    const rows = pipeTable(body);
    const bad = rows.slice(1).filter((r) => !Number.isFinite(Number(r[1]?.replace(/,/g, ''))));
    if (rows.length < 2 || bad.length > 0) {
      diags.error(
        'chart-data',
        ':::chart needs a table "| label | value |" with numeric values',
        line,
      );
      return null;
    }
    return { kind: 'visual', line: line ?? 0, type: 'chart', attrs, rows };
  }
  if (node.name === 'quote') {
    const items = node.children
      .filter((c) => c.type === 'paragraph')
      .map((c) => (c.type === 'paragraph' ? plainText(c.children).trim() : ''))
      .filter(Boolean);
    if (items.length === 0) {
      diags.error('quote-text', ':::quote needs the quoted text inside', line);
      return null;
    }
    return { kind: 'visual', line: line ?? 0, type: 'quote', attrs, items };
  }
  return { kind: 'visual', line: line ?? 0, type: node.name, attrs, body };
}

/**
 * Cells of a Markdown pipe table (header first; the `---` separator row dropped). Inline
 * markup is reduced to plain text: `code`, **bold** and links keep only their text.
 */
export function pipeTable(source: string): string[][] {
  const plain = (cell: string) =>
    cell
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\\\|/g, '|')
      .trim();
  return source
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) =>
      l
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split(/(?<!\\)\|/)
        .map(plain),
    )
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
}

/**
 * `::shot{mina=head yuki=upper}`: framings from this scene on (PLAN character C9). Only before
 * the scene's first paragraph, so a framing never changes in the middle of a line.
 */
function shotFrom(
  node: LeafDirective | ContainerDirective,
  scene: Scene,
  meta: Frontmatter,
  diags: Diagnostics,
): void {
  const line = lineOf(node);
  if (node.type !== 'leafDirective') {
    diags.error('shot-placement', 'shot is a leaf directive: ::shot{cast=framing}', line);
    return;
  }
  if (scene.blocks.some((b) => b.kind === 'paragraph')) {
    diags.error(
      'shot-placement',
      "::shot must come before the scene's first paragraph (a framing never changes mid-scene)",
      line,
    );
    return;
  }
  const attrs = attrsOf(node);
  if (Object.keys(attrs).length === 0)
    diags.error('shot-empty', '::shot needs cast=framing, e.g. ::shot{mina=head}', line);
  for (const [who, framing] of Object.entries(attrs)) {
    if (!(who in meta.cast))
      diags.error('shot-cast', `::shot names "${who}", which is not in cast`, line);
    else if (!(FRAMINGS as readonly string[]).includes(framing))
      diags.error(
        'shot-framing',
        `framing must be one of ${FRAMINGS.join(', ')}: "${framing}"`,
        line,
      );
    else (scene.shot ??= {})[who] = framing as Framing;
  }
}

function headingTitle(h: Heading): { title: string; id?: string } {
  const raw = plainText(h.children);
  const m = HEADING_ID.exec(raw);
  return m ? { title: raw.slice(0, m.index).trim(), id: m[1]! } : { title: raw.trim() };
}

const parseTree = (source: string) =>
  unified()
    .use(remarkParse)
    .use(remarkFrontmatter, ['yaml'])
    .use(remarkDirective)
    .parse(source) as Root;

/**
 * `mina{say="a :pause *b*"}:` — remark would read markup inside the attribute value. Mask every
 * one-line speaker prefix of a cast member (braces → `x`, the colon → a space; same length and
 * lines) and parse the whole document again (acting stage 2 plan 1.3).
 */
function maskPrefixes(
  source: string,
  tree: Root,
  isCast: (name: string) => boolean,
): {
  masked: string;
  prefixes: Map<number, { name: string; raw: string; length: number }>;
  /** Lines where a directive with a label or attributes was glued to the colon (`a{…}:cue[x]{…}`). */
  glued: number[];
} {
  const prefixes = new Map<number, { name: string; raw: string; length: number }>();
  const glued: number[] = [];
  let masked = source;
  for (const node of tree.children) {
    if (node.type !== 'paragraph') continue;
    const start = node.position?.start.offset;
    if (start === undefined) continue;
    const m = PREFIX_WITH_ATTRS.exec(source.slice(start, start + 4096));
    if (!m || !isCast(m[1]!)) continue;
    const name = m[1]!;
    const braces = start + name.length;
    const colon = start + m[0].length - 1;
    // `:Today` right after the colon is plain text once masked, but `:cue[x]{…}` there would lose
    // its meaning silently: report it instead (write a space after the colon).
    const d = node.children.find((c) => c.position?.start.offset === colon);
    if (
      d?.type === 'textDirective' &&
      (d.children.length > 0 || Object.keys(d.attributes ?? {}).length > 0)
    ) {
      glued.push(node.position?.start.line ?? 0);
      continue;
    }
    masked = masked.slice(0, braces) + 'x'.repeat(colon - braces) + ' ' + masked.slice(colon + 1);
    prefixes.set(start, { name, raw: m[2]!, length: m[0].length });
  }
  return { masked, prefixes, glued };
}

const BROKEN_KEYS = PREFIX_KEYS.join('|');
/**
 * A paragraph that starts like a speaker prefix of a cast member but did not parse as one
 * (acting stage 2 plan 1.4): it would be read aloud, braces and all, by the first cast member.
 */
function brokenPrefix(raw: string, isCast: (name: string) => boolean): boolean {
  const after = new RegExp(`^([A-Za-z_][\\w-]*)\\s*[:：]\\s*\\{\\s*(${BROKEN_KEYS})\\s*=`).exec(
    raw,
  );
  if (after && isCast(after[1]!)) return true;
  return new RegExp(`^\\{\\s*(${BROKEN_KEYS})\\s*=`).test(raw);
}

export function parseScript(source: string): ParseResult {
  const diags = new Diagnostics();
  let tree = parseTree(source);

  const yamlNode = tree.children.find((n) => n.type === 'yaml');
  if (!yamlNode || yamlNode.type !== 'yaml') {
    diags.error(
      'frontmatter-missing',
      'script must start with YAML frontmatter (--- ... ---) declaring at least `lang`',
      1,
    );
    return { script: null, diagnostics: diags };
  }
  let rawMeta: unknown;
  try {
    rawMeta = YAML.parse(yamlNode.value);
  } catch (e) {
    diags.error('frontmatter-yaml', `invalid YAML: ${(e as Error).message}`, lineOf(yamlNode));
    return { script: null, diagnostics: diags };
  }
  const parsedMeta = frontmatterSchema.safeParse(rawMeta ?? {});
  if (!parsedMeta.success) {
    for (const issue of parsedMeta.error.issues) {
      diags.error(
        'frontmatter-schema',
        `${issue.path.join('.') || '(root)'}: ${issue.message}`,
        lineOf(yamlNode),
      );
    }
    return { script: null, diagnostics: diags };
  }
  const meta = parsedMeta.data;
  for (const [key, member] of Object.entries(
    (rawMeta as { cast?: Record<string, unknown> } | null)?.cast ?? {},
  )) {
    if (member && typeof member === 'object' && 'faceMotions' in member)
      diags.error(
        'frontmatter-schema',
        `cast.${key}.faceMotions is internal (set from character.yaml); remove it`,
        lineOf(yamlNode),
      );
  }
  const castKeys = Object.keys(meta.cast);
  const defaultCast = castKeys[0]!;
  const track: Track = { consumed: [], shorthand: [], speakerAttrs: [] };
  const isCast = (name: string) => Object.hasOwn(meta.cast, name);
  const { masked, prefixes, glued } = maskPrefixes(source, tree, isCast);
  if (prefixes.size > 0) tree = parseTree(masked);
  for (const line of glued)
    diags.error(
      'prefix-directive',
      'a directive right after "name{…}:" is not read; write a space after the colon',
      line,
    );

  const scenes: Scene[] = [];
  const sceneIds = new Set<string>();
  let current: Scene | null = null;
  const ensureScene = (line: number | undefined): Scene => {
    if (!current) {
      diags.warn(
        'implicit-scene',
        'content before the first "# heading" is put into an untitled scene',
        line,
      );
      current = { id: `scene-${scenes.length + 1}`, title: '', line: line ?? 1, blocks: [] };
      scenes.push(current);
    }
    return current;
  };

  for (const node of tree.children as RootContent[]) {
    const line = lineOf(node);
    switch (node.type) {
      case 'yaml':
      case 'html': // comments and raw html are ignored
        break;
      case 'heading': {
        if (node.depth !== 1) {
          diags.warn(
            'heading-depth',
            'only "# " (level 1) headings start scenes; this heading is ignored',
            line,
          );
          break;
        }
        const { title, id } = headingTitle(node);
        const sceneId = id ?? `scene-${scenes.length + 1}`;
        if (sceneIds.has(sceneId))
          diags.error('duplicate-scene-id', `scene id "${sceneId}" is used twice`, line);
        sceneIds.add(sceneId);
        current = { id: sceneId, title, line: line ?? 0, blocks: [] };
        scenes.push(current);
        break;
      }
      case 'leafDirective':
      case 'containerDirective': {
        track.consumed.push(offsetOf(node));
        if (node.name === 'shot') {
          shotFrom(node, ensureScene(line), meta, diags);
          break;
        }
        const v = visualFrom(node, source, diags);
        if (v) ensureScene(line).blocks.push(v);
        break;
      }
      case 'paragraph': {
        const start = node.position?.start.offset ?? -1;
        const prefix = prefixes.get(start);
        if (
          !prefix &&
          brokenPrefix(source.slice(start, node.position?.end.offset ?? start), isCast)
        )
          diags.error(
            'prefix-broken',
            'this paragraph starts like a speaker prefix that did not parse (one line: name{key=value …}: text); it would be read aloud',
            line,
          );
        const p = paragraphFrom(
          node,
          meta,
          defaultCast,
          diags,
          track,
          source,
          prefix,
          glued.includes(line ?? -1),
        );
        if (p) ensureScene(line).blocks.push(p);
        break;
      }
      default:
        diags.warn(
          'unsupported-block',
          `markdown block "${node.type}" is not part of the script format and is ignored`,
          line,
        );
    }
  }

  // Cross-reference checks.
  for (const [name, profile] of Object.entries(meta.outputs)) {
    for (const id of profile.scenes ?? []) {
      if (!sceneIds.has(id))
        diags.error('unknown-scene', `outputs.${name}.scenes references unknown scene "${id}"`);
    }
  }
  for (const scene of scenes) {
    for (const block of scene.blocks as Block[]) {
      if (block.kind !== 'paragraph') continue;
      for (const o of block.only ?? []) {
        if (!(o in meta.outputs))
          diags.error('unknown-output', `:only references unknown output "${o}"`, block.line);
      }
    }
  }
  for (const [key, member] of Object.entries(meta.cast)) {
    const usesPersonaOrSmall = member.voice.startsWith('persona:');
    if (member.style && usesPersonaOrSmall) {
      diags.error(
        'style-unsupported',
        `cast.${key}.style has no effect on persona voices (Base model takes no instruction)`,
      );
    }
    if (member.faceSets)
      diags.error(
        'frontmatter-schema',
        `cast.${key}.faceSets is internal; remove it`,
        lineOf(yamlNode),
      );
  }
  for (const [name] of Object.entries(meta.acting?.emotions ?? {}))
    if (isStandardEmotion(name))
      diags.error(
        'emo-name',
        `acting.emotions.${name}: "${name}" is a standard emotion; choose another name`,
        lineOf(yamlNode),
      );
  for (const [name, e] of Object.entries(meta.acting?.emotions ?? {}))
    if (e.motion !== undefined && !isMotion(e.motion))
      diags.error(
        'motion-name',
        `acting.emotions.${name}: ${motionMessage(e.motion)}`,
        lineOf(yamlNode),
      );
  for (const scene of scenes)
    for (const b of scene.blocks) {
      if (b.kind !== 'paragraph' || b.audio) continue;
      if (!isCast(b.cast) || !meta.cast[b.cast]!.voice.startsWith('persona:')) continue;
      if (b.sentences.some((x) => x.acting?.say !== undefined))
        diags.error(
          'say-unsupported',
          `say has no effect on persona voices (the Base model takes no instruction)`,
          b.line,
        );
    }
  if (!scenes.some((s) => s.blocks.some((b) => b.kind === 'paragraph'))) {
    diags.error('no-narration', 'script has no narration paragraphs');
  }

  return {
    script: { meta, scenes },
    diagnostics: diags,
    trace: { frontmatterRaw: rawMeta, ...track, masked },
  };
}
