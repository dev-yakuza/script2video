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
import type { PicksFile } from '../src/picks.js';
import { listTakes, pickTakes, unpickTakes } from '../src/takes.js';
import { buildTakesPage, type PageData } from '../src/takes-page.js';
import { integratedLoudness } from '../src/media.js';
import {
  makeTakeWav,
  planSentences,
  synthesizeScript,
  takeKeyOf,
  wavDuration,
  type LockManifest,
} from '../src/tts.js';

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
    return { dir, run, lock, lockPath, path, parsed };
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

  // ---------- stage 3b: picks ----------
  /** A sad line synthesized, and a take other than the automatic one picked. */
  async function picked(text: string) {
    const s = script('ko', `host{emo=sad}: ${text}`);
    await s.run();
    const job = planSentences(s.path, s.parsed, root, { draft: false, mock: false }).jobs[0]!;
    const e = s.lock().entries[s.lock().sentences['one:0:0']!]!;
    const n = [0, 1, 2].find((x) => x !== e.attempt)!;
    pickTakes(s.path, s.parsed, root, [`one:0:0=${n}`]);
    const takes = join(root, '.s2v-cache', 'tts-takes');
    const tk = takeKeyOf(job, 0.35, n);
    const raw = join(
      root,
      '.s2v-cache',
      'tts-raw',
      n === 0 ? `${job.synthKey}.wav` : `${job.synthKey}.a${n}.wav`,
    );
    const picksPath = join(s.dir, 'audio', 'ko', 'picks.json');
    const picks = () => JSON.parse(readFileSync(picksPath, 'utf8')) as PicksFile;
    const measures = () =>
      readdirSync(takes).filter((f) => new RegExp(`^${tk}\\.[0-9a-f]{24}\\.json$`).test(f));
    const entry = () => s.lock().entries[s.lock().sentences['one:0:0']!]!;
    return { s, job, n, takes, tk, raw, picksPath, picks, measures, entry };
  }

  it('commits a picked take from its take wav when the raw take is gone', async () => {
    const p = await picked('원본이 없어도 고른 테이크를 써요.');
    expect(p.picks().picks[p.job.pickKey]!.rawSha).toMatch(/^[0-9a-f]{16}$/);
    rmSync(p.raw);
    const before = stub.calls.synthesize;
    const r = await p.s.run();
    expect(stub.calls.synthesize).toBe(before);
    expect(p.entry()).toMatchObject({ attempt: p.n, select: { pick: p.n, by: 'human' } });
    expect(p.entry().raw).toBeDefined();
    expect(r.warnings.join('\n')).not.toMatch(/re-synthesized|sounds different/);
  });

  it('borrows the raw measurement of a picked take measured under another key', async () => {
    const p = await picked('다른 측정 키로 잰 원본 값을 빌려요.');
    rmSync(p.raw);
    const [m] = p.measures();
    // as if ALIGN_VERSION had changed: the measurement is under another key
    writeFileSync(join(p.takes, `${p.tk}.${'0'.repeat(24)}.json`), readFileSync(join(p.takes, m!)));
    rmSync(join(p.takes, m!));
    const before = { ...stub.calls };
    await p.s.run();
    expect(stub.calls.synthesize).toBe(before.synthesize);
    expect(stub.calls.align).toBeGreaterThan(before.align);
    expect(p.entry().raw).toBeDefined();
    expect(p.entry().checks).toEqual([]);
  });

  it('follows a picked take with no raw measurement anywhere, without synthesizing', async () => {
    const p = await picked('원본 측정이 하나도 남지 않은 테이크예요.');
    rmSync(p.raw);
    for (const f of p.measures()) rmSync(join(p.takes, f));
    const before = stub.calls.synthesize;
    const r = await p.s.run();
    expect(stub.calls.synthesize).toBe(before);
    expect(p.entry().attempt).toBe(p.n);
    expect(r.warnings.filter((w) => w.startsWith('one:0:0'))).toEqual([
      expect.stringMatching(new RegExp(`picked take ${p.n} fails: .*emotion gates not measured`)),
    ]);
  });

  it('re-synthesizes a picked take only when nothing of it is cached, and says so', async () => {
    const p = await picked('아무것도 남지 않은 테이크를 다시 만들어요.');
    rmSync(p.raw);
    rmSync(join(p.takes, `${p.tk}.wav`));
    const before = stub.calls.synthesize;
    const r = await p.s.run();
    expect(stub.calls.synthesize).toBe(before + 1);
    expect(r.warnings.join('\n')).toMatch(
      new RegExp(`one:0:0: picked take ${p.n} was re-synthesized .*--list --id one:0:0`),
    );
    expect(r.warnings.join('\n')).not.toMatch(/sounds different/);
  });

  it('rebuilds a picked take from its raw take when the take wav came from another one', async () => {
    const p = await picked('원본이 고른 것과 같으면 다시 만들어요.');
    const madePath = join(p.takes, `${p.tk}.json`);
    const made = JSON.parse(readFileSync(madePath, 'utf8')) as { rawSha: string };
    writeFileSync(madePath, JSON.stringify({ ...made, rawSha: 'ffffffffffffffff' }));
    const before = stub.calls.synthesize;
    const r = await p.s.run();
    expect(stub.calls.synthesize).toBe(before);
    expect(r.warnings.join('\n')).not.toMatch(/sounds different|re-synthesized/);
    expect(JSON.parse(readFileSync(madePath, 'utf8')).rawSha).toBe(made.rawSha);
  });

  it('warns when a picked take now comes from another raw take', async () => {
    const p = await picked('고른 뒤에 원본이 바뀐 테이크예요.');
    const f = p.picks();
    f.picks[p.job.pickKey]!.rawSha = '0123456789abcdef';
    writeFileSync(p.picksPath, JSON.stringify(f));
    const r = await p.s.run();
    expect(r.warnings.join('\n')).toMatch(
      new RegExp(`one:0:0: picked take ${p.n} now sounds different from when you chose it`),
    );
  });

  it('warns about a pick whose line changed until the line is picked again or unpicked', async () => {
    const p = await picked('대사가 바뀌기 전의 문장이에요.');
    await p.s.run();
    const changed = script('ko', 'host{emo=sad}: 대사가 바뀐 뒤의 문장이에요.', p.s.dir);
    const r = await changed.run();
    expect(r.warnings.join('\n')).toMatch(
      /one:0:0: your pick \(take \d\) was for "대사가 바뀌기 전의 문장이에요\.…", that line is now "대사가 바뀐 뒤의 문장이에요\.…"/,
    );
    pickTakes(changed.path, changed.parsed, root, ['one:0:0=0']);
    const after = await changed.run();
    expect(after.warnings.join('\n')).not.toMatch(/your pick/);
    expect(Object.keys(p.picks().picks)).toHaveLength(1);

    // unpick also drops a stale pick of the line
    const again = script('ko', 'host{emo=sad}: 대사가 또 바뀐 문장이에요.', p.s.dir);
    expect((await again.run()).warnings.join('\n')).toMatch(/your pick/);
    unpickTakes(again.path, again.parsed, root, ['one:0:0']);
    expect((await again.run()).warnings.join('\n')).not.toMatch(/your pick/);
    expect(p.picks().picks).toEqual({});
  });

  it('a retry replaces the stale pick of its line and records the raw take', async () => {
    const p = await picked('다시 만들기 전의 문장이에요.');
    await p.s.run();
    const changed = script('ko', 'host{emo=sad}: 다시 만든 뒤의 문장이에요.', p.s.dir);
    await changed.run();
    await changed.run({ retry: ['one:0:0'] });
    const all = Object.values(p.picks().picks);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ by: 'retry', rawSha: expect.stringMatching(/^[0-9a-f]{16}$/) });
  });

  it('lists take wavs, and raw takes without a take wav', async () => {
    const p = await picked('목록에 나오는 테이크들이에요.');
    rmSync(join(p.takes, `${p.tk}.wav`));
    const out = listTakes(p.s.path, p.s.parsed, root, ['one:0:0']).join('\n');
    expect(out).toMatch(new RegExp(`take ${p.n} \\[pick\\]  pass f0 220 rate [\\d.]+  raw only`));
    expect(out).toMatch(/take \d \[lock\] {2}pass .*tts-takes\/[0-9a-f]{24}\.wav/);
  });

  it('keeps a pick over a speed change without warning (same raw take)', async () => {
    const p = await picked('속도가 바뀌어도 같은 테이크예요.');
    await p.s.run();
    const faster = script(
      'ko',
      'host{emo=sad speed=1.1}: 속도가 바뀌어도 같은 테이크예요.',
      p.s.dir,
    );
    const before = stub.calls.synthesize;
    const r = await faster.run();
    expect(stub.calls.synthesize).toBe(before);
    const e = faster.lock().entries[faster.lock().sentences['one:0:0']!]!;
    expect(e).toMatchObject({ attempt: p.n, select: { pick: p.n } });
    expect(r.warnings.join('\n')).not.toMatch(/sounds different|re-synthesized|your pick/);
  });

  // ---------- stage 3b-2: the listening page ----------
  const page = async (s: { path: string; parsed: ReturnType<typeof parseScript>['script'] }) => {
    const r = await buildTakesPage(s.path, s.parsed!, root, { all: false, ids: [], log: () => {} });
    const html = readFileSync(r.html, 'utf8');
    const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)!;
    return { ...r, dir: dirname(r.html), data: JSON.parse(m[1]!) as PageData };
  };
  const cacheFiles = () =>
    ['tts-takes', 'tts-raw']
      .flatMap((d) => readdirSync(join(root, '.s2v-cache', d)).map((f) => `${d}/${f}`))
      .sort();

  it('builds the page from the caches, without a server and without writing them', async () => {
    const p = await picked('청취 페이지에 나오는 테이크예요.');
    const calls = { ...stub.calls };
    const before = cacheFiles();
    const r = await page(p.s);
    expect(stub.calls).toEqual(calls);
    expect(cacheFiles()).toEqual(before);
    const l = r.data.lines.find((x) => x.id === 'one:0:0')!;
    expect(l).toMatchObject({ target: true, pick: { take: p.n, by: 'human' } });
    expect(l.takes.map((t) => t.n)).toEqual([0, 1, 2]);
    for (const t of l.takes) expect(readFileSync(join(r.dir, t.wav!)).length).toBeGreaterThan(44);
    expect(l.takes.find((t) => t.n === l.lockTake)!.source).toBe('lock');
    // the page's level is render's: −20 LUFS, less a page-wide cut when something would clip
    const cut = r.notes.map((n) => /all wavs (-[\d.]+) dB/.exec(n)).find(Boolean);
    const lufs = (await integratedLoudness(join(r.dir, l.lockWav!))).lufs;
    expect(Math.abs(lufs - (-20 + (cut ? Number(cut[1]) : 0)))).toBeLessThan(1);
  });

  it('makes a raw-only take as tts makes it, in the page folder only', async () => {
    const p = await picked('원본만 남은 테이크도 들을 수 있어요.');
    const takeWav = join(p.takes, `${p.tk}.wav`);
    const tts = readFileSync(takeWav);
    const again = join(stub.scratch, 'again.wav');
    await makeTakeWav(p.raw, again, p.job.tempo, 0.35);
    expect(readFileSync(again).equals(tts)).toBe(true);
    rmSync(takeWav);
    const before = cacheFiles();
    const r = await page(p.s);
    expect(cacheFiles()).toEqual(before);
    const t = r.data.lines.find((x) => x.id === 'one:0:0')!.takes.find((x) => x.n === p.n)!;
    expect(t.source).toBe('raw');
    expect(readFileSync(join(r.dir, t.wav!)).length).toBeGreaterThan(44);
  });

  it('shows a take with nothing cached as not playable, and stops on unreadable files', async () => {
    const p = await picked('캐시가 없는 테이크는 들을 수 없어요.');
    rmSync(p.raw);
    rmSync(join(p.takes, `${p.tk}.wav`));
    const r = await page(p.s);
    expect(r.data.lines[0]!.takes.find((x) => x.n === p.n)).toMatchObject({
      wav: null,
      source: 'none',
    });
    writeFileSync(p.picksPath, '{ broken');
    await expect(page(p.s)).rejects.toThrow(/cannot read/);
    rmSync(p.picksPath);
    writeFileSync(p.s.lockPath, '{ half');
    await expect(page(p.s)).rejects.toThrow(/is tts running/);
  });
});
