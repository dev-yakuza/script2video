/**
 * Engine-independent media steps (PLAN 5.9 / 5.10): fonts, narration track, mastering, concat, mux.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { Timeline } from '@script2video/core';

const execFileAsync = promisify(execFile);
/** ffmpeg can be chatty on long inputs: allow a large output buffer. */
const run = (cmd: string, args: string[]) =>
  execFileAsync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
export const SAMPLE_RATE = 48000;

// ---------- fonts ----------

export function fontsDir(): string {
  return process.env.S2V_FONTS_DIR ?? join(homedir(), '.cache', 'script2video', 'fonts');
}

/** Download fonts pinned in fonts.lock.json (verified by sha256) unless already present. */
export async function ensureFonts(repoRoot: string, log: (m: string) => void): Promise<string> {
  const dir = fontsDir();
  mkdirSync(dir, { recursive: true });
  const lock = JSON.parse(readFileSync(join(repoRoot, 'fonts.lock.json'), 'utf8')) as {
    fonts: Record<string, { url: string; sha256: string }>;
  };
  for (const [name, { url, sha256 }] of Object.entries(lock.fonts)) {
    const path = join(dir, name);
    if (
      existsSync(path) &&
      createHash('sha256').update(readFileSync(path)).digest('hex') === sha256
    )
      continue;
    log(`downloading font ${name} ...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`font download failed (${res.status}): ${url}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== sha256) throw new Error(`font hash mismatch for ${name}: ${got}`);
    writeFileSync(path, buf);
  }
  return dir;
}

// ---------- wav helpers (PCM s16le, mono) ----------

function readPcm16(path: string): { rate: number; samples: Int16Array } {
  const buf = readFileSync(path);
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  if (channels !== 1 || bits !== 16) throw new Error(`expected mono 16-bit wav: ${path}`);
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const data = buf.subarray(off + 8, off + 8 + size);
      return {
        rate,
        samples: new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2)),
      };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk: ${path}`);
}

function writeFloatWav(path: string, samples: Float32Array, rate: number): void {
  const data = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) data.writeFloatLE(samples[i]!, i * 4);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20); // IEEE float
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/**
 * Place every sentence wav at its frame-derived position (PLAN 3: audio times come from frames).
 * Sentence wavs are already 48 kHz mono from the TTS post-processing step.
 */
/**
 * Every sentence is brought to the same loudness before mixing: TTS engines and voices differ a
 * lot (a cloned persona keeps its reference clip's level, often 10–15 dB below a preset
 * speaker), and so do single sentences of one voice. Gain is clamped so a near-silent take is not
 * blown up; sentences too short to measure keep their speaker's median gain.
 */
export const SPEECH_LUFS = -20;
export const MAX_BOOST_DB = 20;
export const MAX_CUT_DB = 12;
/** The normalizing gain is clamped so a near-silent take is not blown up (render and `s2v takes`). */
export const clampGain = (db: number) => Math.max(-MAX_CUT_DB, Math.min(MAX_BOOST_DB, db));
/** Median as render takes it for the per-speaker fallback gain. */
export const medianOf = (v: number[]) =>
  [...v].sort((x, y) => x - y)[Math.floor(v.length / 2)] ?? 0;

/** Integrated loudness per sentence wav (LUFS), cached next to the mix by path + size + mtime. */
async function sentenceLoudness(paths: string[], cachePath: string) {
  const cache: Record<string, number | null> = existsSync(cachePath)
    ? (JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, number | null>)
    : {};
  const out = new Map<string, number | null>();
  for (const p of new Set(paths)) {
    const st = statSync(p);
    const id = `${p}|${st.size}|${st.mtimeMs}`;
    if (!(id in cache)) {
      try {
        const { lufs } = await integratedLoudness(p);
        cache[id] = lufs > -70 ? lufs : null; // below the absolute gate: too short / silent
      } catch {
        cache[id] = null;
      }
    }
    out.set(p, cache[id]!);
  }
  writeFileSync(cachePath, JSON.stringify(cache));
  return out;
}

export async function buildNarration(
  timeline: Timeline,
  outPath: string,
): Promise<{ seconds: number; gains: Record<string, number> }> {
  const total = Math.ceil((timeline.totalFrames / timeline.fps) * SAMPLE_RATE);
  const mix = new Float32Array(total);
  const audio = timeline.scenes.flatMap((s) => s.audio.map((a) => ({ scene: s, a })));
  const loud = await sentenceLoudness(
    audio.map(({ a }) => a.src),
    join(dirname(outPath), 'loudness.json'),
  );
  // Fallback for unmeasurable sentences: the median gain of the same speaker.
  const byCast = new Map<string, number[]>();
  for (const { a } of audio) {
    const l = loud.get(a.src);
    if (l != null) byCast.set(a.cast, [...(byCast.get(a.cast) ?? []), SPEECH_LUFS - l]);
  }
  const gains: Record<string, number> = {};
  for (const { scene, a } of audio) {
    const l = loud.get(a.src);
    // the line's own level (volume, power) goes on top of the normalization (acting plan 3.4);
    // the per-speaker fallback above is taken without it
    const db =
      clampGain(l != null ? SPEECH_LUFS - l : medianOf(byCast.get(a.cast) ?? [])) + (a.gain ?? 0);
    gains[a.sentenceId] = Number(db.toFixed(1));
    const g = 10 ** (db / 20);
    const { rate, samples } = readPcm16(a.src);
    if (rate !== SAMPLE_RATE) throw new Error(`expected ${SAMPLE_RATE} Hz: ${a.src}`);
    const at = Math.round(((scene.startFrame + a.startFrame) / timeline.fps) * SAMPLE_RATE);
    for (let i = 0; i < samples.length && at + i < total; i++)
      mix[at + i]! += (samples[i]! / 32768) * g;
  }
  writeFloatWav(outPath, mix, SAMPLE_RATE);
  return { seconds: total / SAMPLE_RATE, gains };
}

// ---------- mastering ----------

export async function integratedLoudness(
  path: string,
): Promise<{ lufs: number; truePeak: number }> {
  const { stderr } = await run('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i',
    path,
    '-af',
    // framelog=quiet: no per-100 ms log line (an hour of audio would flood stderr).
    'ebur128=peak=true:framelog=quiet',
    '-f',
    'null',
    '-',
  ]);
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1]);
  const truePeak = Number(/Peak:\s+(-?[\d.]+) dBFS/.exec(summary)?.[1]);
  if (!Number.isFinite(lufs)) throw new Error(`could not measure loudness of ${path}`);
  return { lufs, truePeak };
}

/**
 * Linear gain to the target loudness, then a true-peak limiter approximated by 4× oversampling
 * (alimiter only sees sample peaks). Up to 3 passes, correcting the gain before the limiter.
 */
export async function master(
  input: string,
  output: string,
  targetLufs = -14,
  limitDb = -1.5,
): Promise<{ lufs: number; truePeak: number; passes: number }> {
  const measured = await integratedLoudness(input);
  let gain = targetLufs - measured.lufs;
  const limit = Math.pow(10, limitDb / 20).toFixed(3);
  let result = measured;
  let passes = 0;
  for (; passes < 3; passes++) {
    const filters = [
      `volume=${gain.toFixed(2)}dB`,
      `aresample=${SAMPLE_RATE * 4}`,
      `alimiter=level=0:latency=1:limit=${limit}`,
      `aresample=${SAMPLE_RATE}`,
    ].join(',');
    await run('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-i',
      input,
      '-af',
      filters,
      '-c:a',
      'pcm_f32le',
      output,
    ]);
    result = await integratedLoudness(output);
    if (Math.abs(result.lufs - targetLufs) <= 0.5) break;
    gain += targetLufs - result.lufs;
  }
  return { ...result, passes: passes + 1 };
}

// ---------- concat + mux ----------

export async function concatAndMux(
  chunks: string[],
  audio: string,
  output: string,
  workDir: string,
): Promise<void> {
  const list = join(workDir, 'concat.txt');
  writeFileSync(list, chunks.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  // written beside and moved in place: a failed mux leaves the last video, not half of one
  // (the name still ends in .mp4 for ffmpeg to pick the muxer)
  const tmp = output.replace(/\.mp4$/, '') + '.tmp.mp4';
  try {
    await muxTo(list, audio, tmp);
    renameSync(tmp, output);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

async function muxTo(list: string, audio: string, output: string): Promise<void> {
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-i',
    audio,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'copy',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    output,
  ]);
}

export async function probe(
  path: string,
): Promise<{ frames: number; videoSec: number; audioSec: number }> {
  const { stdout: v } = await run('ffprobe', [
    '-v',
    'error',
    '-count_packets',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=nb_read_packets,duration',
    '-of',
    'json',
    path,
  ]);
  const { stdout: a } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'a:0',
    '-show_entries',
    'stream=duration',
    '-of',
    'json',
    path,
  ]);
  const vs = (JSON.parse(v) as { streams: { nb_read_packets: string; duration: string }[] })
    .streams[0]!;
  const as = (JSON.parse(a) as { streams: { duration: string }[] }).streams[0]!;
  return {
    frames: Number(vs.nb_read_packets),
    videoSec: Number(vs.duration),
    audioSec: Number(as.duration),
  };
}

/** Bring a wav to `lufs` (linear gain, limited to -1 dBFS peaks); returns the gain in dB. */
export async function normalizeLoudness(path: string, lufs: number): Promise<number> {
  const { lufs: now } = await integratedLoudness(path);
  const db = lufs - now;
  if (Math.abs(db) < 0.5) return 0;
  const tmp = `${path}.norm.wav`;
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-i',
    path,
    '-af',
    `volume=${db.toFixed(2)}dB,alimiter=limit=0.891:level=false`,
    '-c:a',
    'pcm_s16le',
    tmp,
  ]);
  renameSync(tmp, path);
  return db;
}
