/**
 * The PROXY mark (S13 plan): a red band with block letters, put on a render that a person did
 * not approve (Studio's proxy mode). Drawn here as a PNG because many ffmpeg builds lack
 * drawtext; no dependency (stored deflate, a CRC table).
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 5×7 block letters, one string per row ('#' = on). */
const GLYPHS: Record<string, string[]> = {
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  X: ['#...#', '#...#', '.#.#.', '..#..', '.#.#.', '#...#', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
};
const WORD = 'PROXY';
/** Grid columns of the word: 5 per letter, 1 between letters. */
const COLS = WORD.length * 6 - 1;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const x of data) {
    a = (a + x) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** zlib stream of stored (uncompressed) blocks: the same bytes whatever zlib Node carries. */
function storedZlib(data: Uint8Array): Buffer {
  const parts: Buffer[] = [Buffer.from([0x78, 0x01])];
  for (let off = 0; ; off += 65535) {
    const block = data.subarray(off, Math.min(off + 65535, data.length));
    const last = off + 65535 >= data.length;
    const head = Buffer.alloc(5);
    head[0] = last ? 1 : 0;
    head.writeUInt16LE(block.length, 1);
    head.writeUInt16LE(~block.length & 0xffff, 3);
    parts.push(head, Buffer.from(block));
    if (last) break;
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(adler32(data));
  parts.push(tail);
  return Buffer.concat(parts);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Band size for a frame width: 24% wide, a quarter as tall (S13 plan 2.2). */
export function proxySize(width: number): { w: number; h: number; k: number } {
  const w = Math.round(width * 0.24);
  const h = Math.round(w / 4);
  const p = Math.round(h * 0.15);
  const k = Math.max(1, Math.min(Math.floor((w - 2 * p) / COLS), Math.floor((h - 2 * p) / 7)));
  return { w, h, k };
}

/** The PROXY band as an RGBA PNG for a frame `width` px wide. */
export function proxyPng(width: number): Buffer {
  const { w, h, k } = proxySize(width);
  const band = [220, 38, 38, Math.round(255 * 0.7)];
  const ink = [255, 255, 255, 255];
  const x0 = Math.floor((w - COLS * k) / 2);
  const y0 = Math.floor((h - 7 * k) / 2);
  const on = (x: number, y: number): boolean => {
    const gx = Math.floor((x - x0) / k);
    const gy = Math.floor((y - y0) / k);
    if (x < x0 || y < y0 || gx >= COLS || gy >= 7) return false;
    const letter = WORD[Math.floor(gx / 6)];
    const col = gx % 6;
    return col < 5 && GLYPHS[letter!]![gy]![col] === '#';
  };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      const px = on(x, y) ? ink : band;
      raw.set(px, row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', storedZlib(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export type LogoCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

/**
 * Where the band goes on a `width`×`height` frame: the corner away from the logo (left unless
 * the logo is on the left), at the top unless the subtitles are; even pixels (yuv420p chroma).
 */
export function proxyPlacement(
  width: number,
  height: number,
  logo: LogoCorner | null,
  subtitlesTop: boolean,
): { x: number; y: number } {
  const { w, h } = proxySize(width);
  const even = (n: number) => Math.max(0, Math.floor(n / 2) * 2);
  const margin = Math.round(width * 0.02);
  const left = !(logo === 'top-left' || logo === 'bottom-left');
  return {
    x: even(left ? margin : width - w - margin),
    y: even(subtitlesTop ? height - h - margin : margin),
  };
}

/** Writes the band for this width into the work folder; returns its path. */
export function writeProxyPng(workDir: string, width: number): string {
  const path = join(workDir, `proxy-${width}.png`);
  writeFileSync(path, proxyPng(width));
  return path;
}
