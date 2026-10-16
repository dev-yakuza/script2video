/**
 * The real (non-mock) take path against stub servers (stage 3 plan 10): measuring, the take
 * cache, judging, selection and a reference that fails mid-sentence. The repo root is a temporary
 * folder, so the caches never touch the real `.s2v-cache`.
 */
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript, type Lang } from '@script2video/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mockSynthesize, mockTokens } from '../src/mock-tts.js';
import { ALIGNER, Service, TTS_SERVER } from '../src/services.js';
import { synthesizeScript, wavDuration, type LockManifest } from '../src/tts.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** A repo root with the lock files the services hash, and nothing else. */
function fakeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 's2v-repo-'));
  copyFileSync(join(REPO, 'models.lock.json'), join(root, 'models.lock.json'));
  for (const d of ['tts-server', 'aligner']) {
    mkdirSync(join(root, d));
    copyFileSync(join(REPO, d, 'uv.lock'), join(root, d, 'uv.lock'));
  }
  return root;
}

interface Calls {
  synthesize: number;
  embed: number;
  align: number;
  pitch: number;
}

/** Stub tts-server and aligner: tones for speech, fixed pitch, a constant voice vector. */
function stubs(root: string, failEmbedFrom: () => number) {
  const calls: Calls = { synthesize: 0, embed: 0, align: 0, pitch: 0 };
  const scratch = mkdtempSync(join(tmpdir(), 's2v-stub-'));
  const json = (res: import('node:http').ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const handler =
    (spec: typeof TTS_SERVER) =>
    (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = data ? (JSON.parse(data) as Record<string, string>) : {};
        if (req.url === '/health')
          return json(res, {
            id: spec.id,
            lock_hash: new Service(spec, root).expectedLockHash(),
            wrapper_version: spec.wrapper,
          });
        if (req.url === '/synthesize') {
          calls.synthesize++;
          const out = join(scratch, `${calls.synthesize}.wav`);
          mockSynthesize(body.text!, body.lang as Lang, 1, out);
          res.writeHead(200, {
            'content-type': 'audio/wav',
            'x-s2v-meta': JSON.stringify({ model: 'stub', seed: calls.synthesize }),
          });
          return res.end(readFileSync(out));
        }
        if (req.url === '/embed') {
          calls.embed++;
          if (calls.embed >= failEmbedFrom()) return json(res, { detail: 'stub failure' }, 500);
          return json(res, { model: 'stub', vector: [1, 0, 0] });
        }
        if (req.url === '/align') {
          calls.align++;
          const d = wavDuration(body.wav_path!);
          const toks = mockTokens(body.text!, body.lang as Lang);
          const step = (d - 0.2) / Math.max(1, toks.length);
          return json(res, {
            words: toks.map((t, i) => ({
              text: t,
              start: 0.1 + i * step,
              end: 0.1 + (i + 1) * step - 0.02,
            })),
          });
        }
        if (req.url === '/pitch') {
          calls.pitch++;
          return json(res, {
            median_hz: 220,
            voiced_ratio: 0.8,
            ending_st: 0,
            lead_s: 0,
            tail_s: 0,
            noise_s: 0,
          });
        }
        if (req.url === '/transcribe') return json(res, { text: '' });
        json(res, { detail: 'unknown' }, 404);
      });
    };
  const tts = createServer(handler(TTS_SERVER));
  const aligner = createServer(handler(ALIGNER));
  return { calls, tts, aligner, scratch };
}

const listen = (s: Server) =>
  new Promise<number>((ok) =>
    s.listen(0, '127.0.0.1', () => ok((s.address() as AddressInfo).port)),
  );

describe('stage 3 takes against stub servers', { timeout: 120_000 }, () => {
  const env = {
    tts: process.env.S2V_TTS_PORT,
    al: process.env.S2V_ALIGNER_PORT,
    mode: process.env.S2V_TTS,
  };
  let root: string;
  /** Scripts live in subfolders of one folder whose voices/ they share (one reference per lang). */
  let scripts: string;
  let failFrom = Infinity;
  let stub: ReturnType<typeof stubs>;
  beforeAll(async () => {
    delete process.env.S2V_TTS;
    root = fakeRepo();
    scripts = mkdtempSync(join(tmpdir(), 's2v-real-'));
    mkdirSync(join(scripts, 'voices'));
    stub = stubs(root, () => failFrom);
    process.env.S2V_TTS_PORT = String(await listen(stub.tts));
    process.env.S2V_ALIGNER_PORT = String(await listen(stub.aligner));
  });
  beforeEach(() => {
    failFrom = Infinity;
  });
  afterAll(async () => {
    await new Promise((ok) => stub.tts.close(ok));
    await new Promise((ok) => stub.aligner.close(ok));
    for (const d of [root, scripts, stub.scratch]) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of [
      ['S2V_TTS_PORT', env.tts],
      ['S2V_ALIGNER_PORT', env.al],
      ['S2V_TTS', env.mode],
    ] as const)
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });

  function script(lang: Lang, body: string, at?: string) {
    const dir = at ?? mkdtempSync(join(scripts, 'v-'));
    const path = join(dir, `script.${lang}.md`);
    const source = `---\nlang: ${lang}\ncast:\n  host: { voice: "qwen:Sohee" }\noutputs:\n  youtube: { aspect: "16:9", layout: presenter }\n---\n\n# one {#one}\n\n${body}\n`;
    writeFileSync(path, source);
    const parsed = parseScript(source).script!;
    const run = async (extra: { retry?: string[] } = {}) => {
      const logs: string[] = [];
      const r = await synthesizeScript(path, parsed, root, {
        asr: false,
        log: (m) => logs.push(m),
        ...extra,
      });
      return { ...r, logs };
    };
    const lock = () =>
      JSON.parse(readFileSync(join(dir, 'audio', lang, 'manifest.json'), 'utf8')) as LockManifest;
    const lockPath = join(dir, 'audio', lang, 'manifest.json');
    return { dir, run, lock, lockPath };
  }

  it('measures takes once: a second synthesis from the cache needs no server', async () => {
    const s = script(
      'ko',
      'host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.\n\nhost: 평범한 문장입니다.',
    );
    const first = await s.run();
    expect(first.synthesized).toBe(2);
    expect(first.logs.join('\n')).toMatch(/about \d+ min for 2 sentence/);
    const entries = Object.values(s.lock().entries);
    const emotion = entries.find((e) => e.select)!;
    expect(Object.keys(emotion.takes!)).toEqual(['0', '1', '2']);
    expect(emotion.raw).toBeDefined();
    expect(emotion.sim).toBe(1);
    expect(entries.find((e) => !e.select)!.raw).toBeUndefined();

    // the lock is gone, the take cache is not: same choices, no server request
    rmSync(join(s.dir, 'audio'), { recursive: true });
    const before = { ...stub.calls };
    const again = await s.run();
    expect(again.synthesized).toBe(2);
    expect(stub.calls).toEqual(before);
    expect(again.logs.join('\n')).not.toMatch(/starting tts-server/);
    const twice = Object.values(s.lock().entries);
    expect(twice.map((e) => e.attempt).sort()).toEqual(entries.map((e) => e.attempt).sort());
  });

  it('records the raw take of an emotion line in English too (no emotion gates)', async () => {
    const s = script('en', 'host{emo=sad}: Today I have a rather sad story for you.');
    await s.run();
    const [e] = Object.values(s.lock().entries);
    expect(e!.raw).toBeDefined();
    expect(e!.lead).toBeUndefined();
    expect(Object.keys(e!.takes!)).toEqual(['0', '1', '2']);
  });

  it('judges every take without the reference when it fails mid-sentence', async () => {
    // a plain line first, so the voice reference exists
    const plain = script('ko', 'host: 기준 음성을 먼저 만듭니다.');
    await plain.run();
    const s = script('ko', 'host{emo=sad}: 갑자기 서버가 말을 듣지 않는 슬픈 날이에요.', plain.dir);
    // this run embeds the clip, then take 0, then fails on take 1
    failFrom = stub.calls.embed + 3;
    const r = await s.run();
    const e = Object.values(s.lock().entries).find((x) => x.select)!;
    expect(e.sim).toBeUndefined();
    expect(e.voiceRef).toBeUndefined();
    // every take judged the same way (all without the reference): all pass here
    expect(Object.values(e.takes!).every((t) => t.ok)).toBe(true);
    expect(r.warnings.join('\n')).toMatch(/without the voice reference/);
  });

  it('retries after the highest take in the raw cache, and re-measures a broken cache file', async () => {
    const s = script('ko', 'host{emo=sad}: 캐시를 보고 새 번호를 고르는 슬픈 문장이에요.');
    await s.run();
    const m = s.lock();
    const id = Object.keys(m.sentences)[0]!;
    // a lock written elsewhere: it knows only take 0, the raw cache here has 0–2
    const e = m.entries[m.sentences[id]!]!;
    e.attempt = 0;
    e.tried = 0;
    writeFileSync(s.lockPath, JSON.stringify(m));
    await s.run({ retry: [id] });
    expect(Object.keys(s.lock().entries[m.sentences[id]!]!.takes!)).toEqual(['3', '4', '5']);

    // a measurement file that cannot be read counts as missing
    const takes = join(root, '.s2v-cache', 'tts-takes');
    for (const f of readdirSync(takes))
      if (/^[0-9a-f]+\.[0-9a-f]+\.json$/.test(f)) writeFileSync(join(takes, f), '{broken');
    rmSync(join(s.dir, 'audio'), { recursive: true });
    const before = stub.calls.align;
    await s.run();
    expect(stub.calls.align).toBeGreaterThan(before);
  });

  it('makes a changed take wav again from its raw take (and keeps the measurement)', async () => {
    const s = script('ko', 'host{emo=sad}: 측정한 소리가 바뀌면 다시 만드는 슬픈 문장이에요.');
    const takes = join(root, '.s2v-cache', 'tts-takes');
    const earlier = new Set(readdirSync(takes));
    await s.run();
    const original = new Map<string, Buffer>();
    for (const f of readdirSync(takes))
      if (!earlier.has(f) && /^[0-9a-f]+\.wav$/.test(f)) {
        const b = readFileSync(join(takes, f));
        original.set(f, Buffer.from(b));
        b[b.length - 1] = b[b.length - 1]! ^ 1;
        writeFileSync(join(takes, f), b);
      }
    rmSync(join(s.dir, 'audio'), { recursive: true });
    const before = { ...stub.calls };
    await s.run();
    // rebuilt from the raw takes: the same sound, so the measurements still hold
    for (const [f, b] of original) expect(readFileSync(join(takes, f)).equals(b)).toBe(true);
    expect(stub.calls).toEqual(before);
  });

  it('chooses without the reference when it fails before the first take', async () => {
    const plain = script('ko', 'host: 기준 음성을 먼저 만들어 둡니다.');
    await plain.run();
    const s = script('ko', 'host{emo=sad}: 처음부터 서버가 말을 듣지 않는 날이에요.', plain.dir);
    failFrom = stub.calls.embed + 1;
    const r = await s.run();
    expect(r.warnings.join('\n')).toMatch(/without the voice reference/);
  });

  it('measures again without the raw cache: plain takes as they are, emotion takes made again', async () => {
    const s = script(
      'ko',
      'host{emo=sad}: 원본이 지워진 뒤의 슬픈 문장이에요.\n\nhost: 원본이 지워진 뒤의 평범한 문장입니다.',
    );
    const takes = join(root, '.s2v-cache', 'tts-takes');
    const earlier = new Set(readdirSync(takes));
    await s.run();
    rmSync(join(root, '.s2v-cache', 'tts-raw'), { recursive: true });
    mkdirSync(join(root, '.s2v-cache', 'tts-raw'));
    rmSync(join(s.dir, 'audio'), { recursive: true });
    // this script's measurements cannot be read: its takes are measured again
    for (const f of readdirSync(takes))
      if (!earlier.has(f) && /^[0-9a-f]+\.[0-9a-f]+\.json$/.test(f))
        writeFileSync(join(takes, f), '{broken');
    const before = stub.calls.synthesize;
    const r = await s.run();
    expect(r.synthesized).toBe(2);
    // the emotion line needs its raw takes for the raw measurement; the plain line does not
    expect(stub.calls.synthesize - before).toBe(3);
  });
});
