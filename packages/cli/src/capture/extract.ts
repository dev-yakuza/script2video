/**
 * What `s2v capture --text` reads off the page (S5 plan 3): the visible text in blocks, the
 * pictures with where they are, and what cannot be read (other-origin frames, canvases). The page
 * side only walks the DOM; every string is normalized here, where it is unit-tested.
 */
import { createHash } from 'node:crypto';

/** Stands for `<br>` in raw page text (a private-use character pages do not show). */
export const BR = '\uE000';

export type TextKind =
  | 'heading'
  | 'paragraph'
  | 'list-item'
  | 'quote'
  | 'code'
  | 'table-cell'
  | 'caption'
  | 'figcaption';
export type ImageKind = 'img' | 'picture' | 'background' | 'pseudo' | 'svg-image' | 'video-poster';
export type Box = [number, number, number, number];

export interface RawPage {
  url: string;
  title: string;
  lang: string;
  scroll: [number, number];
  text: { kind: TextKind; raw: string; ruby: { base: string; reading: string }[] }[];
  images: {
    src: string;
    kind: ImageKind;
    bbox: Box;
    alt: string;
    natural: [number, number] | null;
  }[];
  opaque: {
    kind: 'iframe' | 'canvas' | 'embed' | 'object' | 'video';
    src: string | null;
    bbox: Box;
  }[];
}

/**
 * The page side, run once in the top frame (`Runtime.evaluate`). Same-origin frames are read in
 * place through `contentDocument`; it changes nothing on the page.
 */
export const EXTRACT = `(() => {
  const BR = ${JSON.stringify(BR)};
  const KIND = { H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading',
    H6: 'heading', P: 'paragraph', LI: 'list-item', BLOCKQUOTE: 'quote', PRE: 'code',
    TD: 'table-cell', TH: 'table-cell', CAPTION: 'caption', FIGCAPTION: 'figcaption' };
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'TITLE', 'META', 'LINK', 'RP']);
  const INLINE = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table',
    'contents', 'ruby', 'ruby-base', 'ruby-text', 'none']);
  const SVG = 'http://www.w3.org/2000/svg';
  const text = [], images = [], opaque = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.parts.length || cur.ruby.length))
      text.push({ kind: cur.kind, raw: cur.parts.join(''), ruby: cur.ruby });
  };
  const open = (kind) => { flush(); cur = { kind, parts: [], ruby: [] }; };
  const styleOf = (el, pseudo) => el.ownerDocument.defaultView.getComputedStyle(el, pseudo);
  const box = (r, ox, oy) => {
    const x = Math.floor(r.left + ox), y = Math.floor(r.top + oy);
    return [x, y, Math.ceil(r.right + ox) - x, Math.ceil(r.bottom + oy) - y];
  };
  // url("…") outside image-set(), and the candidate of each image-set() a 1x screen takes
  // (the smallest resolution from 1 up, else the largest; computed values say 2dppx, not 2x)
  const urls = (value) => {
    if (!value || value === 'none' || value === 'normal') return [];
    const out = [];
    const re = /(?:-webkit-)?image-set\\(((?:[^()]|\\([^()]*\\))*)\\)|url\\("((?:[^"\\\\]|\\\\.)*)"\\)/g;
    for (const m of value.matchAll(re)) {
      if (m[2] !== undefined) { out.push(m[2].replace(/\\\\(.)/g, '$1')); continue; }
      const cands = [...m[1].matchAll(/url\\("((?:[^"\\\\]|\\\\.)*)"\\)\\s*([\\d.]+)?(x|dppx|dpi|dpcm)?/g)]
        .map((c) => {
          const n = c[2] === undefined ? 1 : Number(c[2]);
          const res = c[3] === 'dpi' ? n / 96 : c[3] === 'dpcm' ? (n * 2.54) / 96 : n;
          return { src: c[1], res };
        });
      const up = cands.filter((c) => c.res >= 1).sort((a, b) => a.res - b.res)[0];
      const one = up || cands.sort((a, b) => b.res - a.res)[0];
      if (one) out.push(one.src.replace(/\\\\(.)/g, '$1'));
    }
    return out;
  };
  const pictures = (el, cs, ox, oy) => {
    if (cs.visibility !== 'visible') return;
    const bbox = box(el.getBoundingClientRect(), ox, oy);
    const tag = el.tagName;
    if (tag === 'IMG') {
      const src = el.currentSrc || el.src;
      if (src) images.push({ src, kind: el.parentElement && el.parentElement.tagName === 'PICTURE'
        ? 'picture' : 'img', bbox, alt: el.alt || '', natural: [el.naturalWidth, el.naturalHeight] });
    } else if (el.namespaceURI === SVG && el.localName === 'image') {
      const href = el.href && el.href.baseVal;
      if (href) images.push({ src: new URL(href, el.ownerDocument.baseURI).href, kind: 'svg-image',
        bbox, alt: '', natural: null });
    } else if (tag === 'VIDEO' && el.poster) {
      images.push({ src: el.poster, kind: 'video-poster', bbox, alt: '', natural: null });
    }
    for (const src of urls(cs.backgroundImage))
      images.push({ src, kind: 'background', bbox, alt: '', natural: null });
    for (const p of ['::before', '::after']) {
      const ps = styleOf(el, p);
      if (ps.content === 'none' || ps.content === 'normal') continue;
      for (const src of [...urls(ps.backgroundImage), ...urls(ps.content)])
        images.push({ src, kind: 'pseudo', bbox, alt: '', natural: null });
    }
  };
  const children = (node) => {
    if (node.nodeType === 1 && node.shadowRoot) return [...node.shadowRoot.childNodes];
    if (node.nodeType === 1 && node.localName === 'slot') {
      const a = node.assignedNodes({ flatten: true });
      return a.length ? a : [...node.childNodes];
    }
    return [...node.childNodes];
  };
  const visibleText = (node) => {
    const p = node.parentElement || (node.parentNode && node.parentNode.host);
    return !p || styleOf(p).visibility === 'visible';
  };
  const ruby = (el) => {
    let base = '';
    const put = () => { if (base) cur.parts.push(base); };
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { if (visibleText(c)) base += c.data; continue; }
      if (c.nodeType !== 1 || SKIP.has(c.tagName)) continue;
      if (c.tagName === 'RT') {
        cur.ruby.push({ base, reading: c.textContent || '' });
        put(); base = '';
      } else base += c.textContent || '';
    }
    put();
  };
  const visit = (node, ox, oy, kind) => {
    if (node.nodeType === 3) { if (visibleText(node)) cur.parts.push(node.data); return; }
    if (node.nodeType !== 1) return;
    const el = node, tag = el.tagName;
    if (SKIP.has(tag) || tag === 'RT' || el.getAttribute('aria-hidden') === 'true') return;
    const cs = styleOf(el);
    if (cs.display === 'none') return;
    pictures(el, cs, ox, oy);
    if (tag === 'BR') { if (cs.visibility === 'visible') cur.parts.push(BR); return; }
    if (tag === 'IFRAME' || tag === 'FRAME') {
      let doc = null;
      try { doc = el.contentDocument; } catch (e) { doc = null; }
      const r = el.getBoundingClientRect();
      if (doc && doc.body) {
        const outer = cur.kind;
        open(kind);
        // the frame's content box: its border and padding in from its edge
        visit(doc.body, ox + r.left + el.clientLeft + parseFloat(cs.paddingLeft),
          oy + r.top + el.clientTop + parseFloat(cs.paddingTop), kind);
        open(outer);
      } else opaque.push({ kind: 'iframe', src: el.src || null, bbox: box(r, ox, oy) });
      return;
    }
    if (tag === 'CANVAS' || tag === 'EMBED' || tag === 'OBJECT' || tag === 'VIDEO') {
      opaque.push({ kind: tag.toLowerCase(), src: el.src || el.data || el.currentSrc || null,
        bbox: box(el.getBoundingClientRect(), ox, oy) });
      return;
    }
    if (tag === 'RUBY') { ruby(el); return; }
    const own = KIND[tag];
    if (own || !INLINE.has(cs.display)) {
      const k = own || kind;
      const outer = cur.kind;
      open(k);
      for (const c of children(el)) visit(c, ox, oy, k);
      open(outer);
      return;
    }
    for (const c of children(el)) visit(c, ox, oy, kind);
  };
  open('paragraph');
  if (document.body) visit(document.body, scrollX, scrollY, 'paragraph');
  flush();
  return { url: location.href, title: document.title, lang: document.documentElement.lang || '',
    scroll: [scrollX, scrollY], text, images, opaque };
})()`;

/** Whitespace folded, `<br>` as a line break, no-break spaces as spaces, NFC (S5 plan 3). */
export function normalizeText(raw: string): string {
  return raw
    .split(BR)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .normalize('NFC');
}

export interface CaptureJson {
  url: string;
  status: number | null;
  title: string;
  lang: string;
  idle: boolean;
  text: { kind: TextKind; text: string; ruby: { base: string; reading: string }[] }[];
  images: {
    src: string;
    kind: ImageKind;
    bbox: Box;
    alt: string;
    inCapture: boolean;
    sha256: string | null;
  }[];
  opaque: { kind: string; src: string | null; bbox: Box; inCapture: boolean }[];
  notShown: string[];
  blocked: { url: string; reason: string }[];
  websockets: { url: string; host: string }[];
  contentHash: string | null;
}

export const emptyJson = (url: string): CaptureJson => ({
  url,
  status: null,
  title: '',
  lang: '',
  idle: false,
  text: [],
  images: [],
  opaque: [],
  notShown: [],
  blocked: [],
  websockets: [],
  contentHash: null,
});

const overlaps = (a: Box, b: Box) =>
  a[2] > 0 &&
  a[3] > 0 &&
  a[0] < b[0] + b[2] &&
  b[0] < a[0] + a[2] &&
  a[1] < b[1] + b[3] &&
  b[1] < a[1] + a[3];

/** JSON with keys sorted and no spaces: the same value, the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

const withoutQuery = (src: string) => {
  try {
    const u = new URL(src);
    u.search = '';
    u.hash = '';
    return u.href;
  } catch {
    return src;
  }
};

/**
 * What the page says, as a hash (S5 plan 3): title, lang, text and the pictures shown, each by its
 * bytes (else its address without query). Not where things are, not what was blocked.
 */
export function contentHashOf(
  json: Pick<CaptureJson, 'title' | 'lang' | 'text'>,
  shown: { src: string; sha256: string | null }[],
): string {
  const images = shown
    .filter((i) => i.sha256 !== null || !i.src.startsWith('blob:'))
    .map((i) => i.sha256 ?? withoutQuery(i.src));
  const body = canonicalJson({ title: json.title, lang: json.lang, text: json.text, images });
  return createHash('sha256').update(body).digest('hex');
}

/** The bytes of a `data:` URL (null when it is not one). */
export function dataUrlBytes(src: string): Buffer | null {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/is.exec(src);
  if (!m) return null;
  const bytes = percentDecode(m[3]!);
  return m[2] ? Buffer.from(bytes.toString('latin1'), 'base64') : bytes;
}

/** WHATWG percent-decode: %XX becomes its byte, anything else (a lone %) stays as it is. */
export function percentDecode(text: string): Buffer {
  const raw = Buffer.from(text, 'utf8');
  const out = Buffer.alloc(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    const hex = raw.subarray(i + 1, i + 3).toString('latin1');
    if (raw[i] === 0x25 && /^[0-9a-f]{2}$/i.test(hex)) {
      out[n++] = parseInt(hex, 16);
      i += 2;
    } else out[n++] = raw[i]!;
  }
  return out.subarray(0, n);
}

/**
 * The `--text` JSON from what the page gave. `bytes(src)` is the sha256 of the bytes the browser
 * got for that address (null when unknown or when it got two different ones).
 */
export function buildJson(
  raw: RawPage,
  o: {
    status: number | null;
    idle: boolean;
    region: Box;
    bytes: (src: string) => string | null;
    received: string[][];
    blocked: CaptureJson['blocked'];
    websockets: CaptureJson['websockets'];
    hashable: boolean;
  },
): CaptureJson {
  const text = raw.text
    .map((t) => ({
      kind: t.kind,
      text: normalizeText(t.raw),
      ruby: t.ruby
        .map((r) => ({ base: normalizeText(r.base), reading: normalizeText(r.reading) }))
        .filter((r) => r.base && r.reading),
    }))
    .filter((t) => t.text !== '');
  const images = raw.images.map((i) => {
    const data = dataUrlBytes(i.src);
    const sha256 = data
      ? createHash('sha256').update(data).digest('hex')
      : i.src.startsWith('blob:')
        ? null
        : o.bytes(i.src);
    return {
      src: i.src,
      kind: i.kind,
      bbox: i.bbox,
      alt: normalizeText(i.alt),
      inCapture: overlaps(i.bbox, o.region),
      sha256,
      shown: i.bbox[2] * i.bbox[3] > 1 && !(i.natural?.[0] === 1 && i.natural[1] === 1),
    };
  });
  // a fragment is never sent: compare addresses without one
  const bare = (u: string) => (u.includes('#') ? u.slice(0, u.indexOf('#')) : u);
  const srcs = new Set(raw.images.map((i) => bare(i.src)));
  const json: CaptureJson = {
    url: raw.url,
    status: o.status,
    title: normalizeText(raw.title),
    lang: raw.lang.trim(),
    idle: o.idle,
    text,
    images: images.map(({ shown: _, ...i }) => i),
    opaque: raw.opaque.map((x) => ({ ...x, inCapture: overlaps(x.bbox, o.region) })),
    notShown: [
      ...new Set(o.received.filter((urls) => !urls.some((u) => srcs.has(u))).map((u) => u[0]!)),
    ],
    blocked: o.blocked,
    websockets: o.websockets,
    contentHash: null,
  };
  if (o.hashable)
    json.contentHash = contentHashOf(
      json,
      images.filter((i) => i.shown),
    );
  return json;
}
