/**
 * Content keys and seeds (acting stage 5a, 5d): FNV-1a 64 of UTF-8 text, and a mixed unit value.
 * No imports, so the timeline, stage and rhythm modules can all use them.
 */

/** 64-bit FNV-1a of a string's UTF-8 bytes. */
export function fnv1a64(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  const mix = (byte: number) => {
    h = BigInt.asUintN(64, (h ^ BigInt(byte)) * 0x100000001b3n);
  };
  // UTF-8 by hand: core has no TextEncoder (no DOM or node types).
  for (const ch of s) {
    let cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // a lone surrogate, as TextEncoder
    if (cp < 0x80) mix(cp);
    else if (cp < 0x800) [0xc0 | (cp >> 6), 0x80 | (cp & 63)].forEach(mix);
    else if (cp < 0x10000)
      [0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63)].forEach(mix);
    else
      [
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 63),
        0x80 | ((cp >> 6) & 63),
        0x80 | (cp & 63),
      ].forEach(mix);
  }
  return h;
}

/**
 * 64-bit FNV-1a of `cast NUL text` (UTF-8 bytes), 16 hex characters. The idle motion of a line
 * depends on what is said, not on its lock key, so drafts and re-synthesis keep the same motion.
 */
export function textKey(cast: string, text: string): string {
  return fnv1a64(`${cast}\u0000${text}`).toString(16).padStart(16, '0');
}

/**
 * A value in [0, 1) from the given parts: FNV-1a 64 finished with murmur3's fmix64, whose top
 * bits change with every input byte (FNV alone barely moves them for a different last character).
 */
export function unitHash(...parts: (string | number)[]): number {
  let k = fnv1a64(parts.join('\u0000'));
  const m = (x: bigint) => BigInt.asUintN(64, x);
  k = m((k ^ (k >> 33n)) * 0xff51afd7ed558ccdn);
  k = m((k ^ (k >> 33n)) * 0xc4ceb9fe1a85ec53n);
  k ^= k >> 33n;
  return Number(k >> 32n) / 2 ** 32;
}

/** A sentence that ends in a question mark, closing quotes, brackets, `!`, `.`, `…` and `~` aside (`?"`, `?!`, `?…`). */
export function isQuestion(text: string): boolean {
  const t = text.replace(/[\s"'”’」』）)\]］】〉》〕｝}!！.。…~～]+$/u, '');
  return /[?？]$/.test(t);
}
