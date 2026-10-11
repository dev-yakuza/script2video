/**
 * Shorten long pauses inside a sentence (PLAN 5.5). TTS engines sometimes pause for 0.5–1.5 s at a
 * comma or before a loanword; pacing between sentences is ours, but pauses inside belong to the
 * engine. Any run of near-silence longer than `maxPause` is cut down to `maxPause`, keeping half of
 * it on each side so word onsets/offsets stay untouched. Runs before alignment, so word timings
 * are measured on the result.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const WINDOW_S = 0.01;

interface Pcm {
  header: Buffer;
  rate: number;
  samples: Int16Array;
}

export function readPcm16(path: string): Pcm {
  const buf = readFileSync(path);
  if (buf.readUInt16LE(22) !== 1 || buf.readUInt16LE(34) !== 16)
    throw new Error(`expected mono 16-bit wav: ${path}`);
  const rate = buf.readUInt32LE(24);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const data = Buffer.from(buf.subarray(off + 8, off + 8 + size));
      return {
        header: buf.subarray(0, 44),
        rate,
        samples: new Int16Array(data.buffer, data.byteOffset, data.length >> 1),
      };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk: ${path}`);
}

export function writePcm16(path: string, rate: number, samples: Int16Array): void {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([h, data]));
}

/** Silent runs as [startSample, endSample) where RMS stays below `thresholdDb`. */
export function silentRuns(
  samples: Int16Array,
  rate: number,
  thresholdDb = -40,
): [number, number][] {
  const win = Math.max(1, Math.round(rate * WINDOW_S));
  const limit = Math.pow(10, thresholdDb / 20) * 32768;
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < samples.length; i += win) {
    let sum = 0;
    const end = Math.min(samples.length, i + win);
    for (let j = i; j < end; j++) sum += samples[j]! * samples[j]!;
    const quiet = Math.sqrt(sum / (end - i)) < limit;
    if (quiet && start < 0) start = i;
    if (!quiet && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, samples.length]);
  return runs;
}

export function compressPauses(
  samples: Int16Array,
  rate: number,
  maxPause: number,
): { out: Int16Array; removed: number } {
  const keep = Math.round(maxPause * rate);
  const cuts: [number, number][] = [];
  for (const [a, b] of silentRuns(samples, rate)) {
    if (a === 0 || b === samples.length) continue; // edges are handled by trimming
    if (b - a > keep) cuts.push([a + (keep >> 1), b - (keep - (keep >> 1))]);
  }
  if (cuts.length === 0) return { out: samples, removed: 0 };
  const removed = cuts.reduce((n, [a, b]) => n + (b - a), 0);
  const out = new Int16Array(samples.length - removed);
  let src = 0;
  let dst = 0;
  for (const [a, b] of cuts) {
    out.set(samples.subarray(src, a), dst);
    dst += a - src;
    src = b;
  }
  out.set(samples.subarray(src), dst);
  return { out, removed: removed / rate };
}

/** Compress long pauses in a mono 16-bit wav in place. Returns seconds removed. */
export function compressPausesInFile(path: string, maxPause: number): number {
  const { rate, samples } = readPcm16(path);
  const { out, removed } = compressPauses(samples, rate, maxPause);
  if (removed > 0) writePcm16(path, rate, out);
  return removed;
}

/** RMS level (dBFS) of a time range of a mono 16-bit wav; used for non-speech detection. */
export function loudnessReader(path: string): (from: number, to: number) => number {
  const { rate, samples } = readPcm16(path);
  return (from, to) => {
    const a = Math.max(0, Math.floor(from * rate));
    const b = Math.min(samples.length, Math.ceil(to * rate));
    if (b <= a) return -120;
    let sum = 0;
    for (let i = a; i < b; i++) sum += samples[i]! * samples[i]!;
    return 20 * Math.log10(Math.max(Math.sqrt(sum / (b - a)) / 32768, 1e-6));
  };
}

/** Keep only [from, to) seconds of a mono 16-bit wav (used to cut non-speech before/after speech). */
export function cropFile(path: string, from: number, to: number): void {
  const { rate, samples } = readPcm16(path);
  const a = Math.max(0, Math.round(from * rate));
  const b = Math.min(samples.length, Math.round(to * rate));
  writePcm16(path, rate, samples.slice(a, b));
}
