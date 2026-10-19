/**
 * `s2v voice train` (acting stage 4 plan 6) against stub servers and a stand-in trainer: the
 * stages in order, the files they leave, resuming, and the pass-count stop. The repo root is a
 * temporary folder with a small sentence set, so nothing touches the real caches.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Lang } from '@script2video/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mockSynthesize } from '../src/mock-tts.js';
import { readSpeaker } from '../src/persona.js';
import { ALIGNER, Service, TTS_SERVER } from '../src/services.js';
import { trainVoice } from '../src/voice-train.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const GUEST = join(REPO, 'videos/sample-dialogue-ko/voices');
const REF_TEXT = (
  JSON.parse(readFileSync(join(GUEST, 'guest/ko.json'), 'utf8')) as { text: string }
).text;

/** The stand-in for train_speaker.py: records its calls, writes best.json for `train`. */
const FAKE_TRAINER = `
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const [cmd, ...args] = process.argv.slice(2);
const arg = (k) => args[args.indexOf(k) + 1];
appendFileSync(process.env.FAKE_TRAINER_LOG, cmd + '\\n');
if (cmd === 'train') {
  const v = Array.from({ length: 2048 }, (_, i) => Math.fround(((i % 13) - 6) / 10));
  const buf = Buffer.alloc(v.length * 4);
  v.forEach((x, i) => buf.writeFloatLE(x, i * 4));
  mkdirSync(arg('--out'), { recursive: true });
  writeFileSync(join(arg('--out'), 'best.json'), JSON.stringify({
    vector: v, vectorSha: createHash('sha256').update(buf).digest('hex'), epoch: 7, valLoss: 2.15,
  }));
  console.log('******** model banner');
  console.log(JSON.stringify({ event: 'epoch', epoch: 7, val: 2.15 }));
}
if (cmd === 'check' && process.env.FAKE_TRAINER_FAIL) {
  console.log(JSON.stringify({ event: 'error', message: 'the training input differs' }));
  process.exit(3);
}
if (cmd === 'check') console.log(JSON.stringify({ event: 'checked', losses: { init: 2.5 } }));
`;

function stubs(root: string) {
  const calls: string[] = [];
  const heardOf = new Map<string, string>();
  const scratch = mkdtempSync(join(tmpdir(), 's2v-train-stub-'));
  let n = 0;
  const json = (res: ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const handler = (spec: typeof TTS_SERVER) => (req: IncomingMessage, res: ServerResponse) => {
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
        calls.push(`${body.engine}|${body.seed_material}`);
        const out = join(scratch, `${++n}.wav`);
        mockSynthesize(body.text!, body.lang as Lang, 1, out);
        const wav = readFileSync(out);
        heardOf.set(createHash('sha256').update(wav).digest('hex'), body.text!);
        res.writeHead(200, {
          'content-type': 'audio/wav',
          'x-s2v-meta': '{"model":"stub","seed":1}',
        });
        return res.end(wav);
      }
      if (req.url === '/transcribe') {
        const sha = createHash('sha256').update(readFileSync(body.wav_path!)).digest('hex');
        return json(res, { text: heardOf.get(sha) ?? REF_TEXT });
      }
      if (req.url === '/pitch')
        return json(res, {
          median_hz: 110,
          voiced_ratio: 0.8,
          ending_st: 0,
          lead_s: 0,
          tail_s: 0,
          noise_s: 0,
        });
      if (req.url === '/embed') return json(res, { model: 'stub', vector: [1, 0, 0] });
      if (req.url === '/align') return json(res, { words: [] });
      json(res, { detail: 'unknown' }, 404);
    });
  };
  return {
    calls,
    scratch,
    tts: createServer(handler(TTS_SERVER)),
    aligner: createServer(handler(ALIGNER)),
  };
}

const listen = (s: Server) =>
  new Promise<number>((ok) =>
    s.listen(0, '127.0.0.1', () => ok((s.address() as AddressInfo).port)),
  );

describe('s2v voice train', { timeout: 300_000 }, () => {
  const env = { ...process.env };
  let root: string;
  let stub: ReturnType<typeof stubs>;
  let trainerLog: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 's2v-train-repo-'));
    copyFileSync(join(REPO, 'models.lock.json'), join(root, 'models.lock.json'));
    for (const d of ['tts-server', 'aligner']) {
      mkdirSync(join(root, d));
      copyFileSync(join(REPO, d, 'uv.lock'), join(root, d, 'uv.lock'));
    }
    // a small sentence set: 3 neutral lines, two emotions with one sentence in each set
    mkdirSync(join(root, 'tts-server', 'data'));
    copyFileSync(
      join(REPO, 'tts-server/train_speaker.py'),
      join(root, 'tts-server/train_speaker.py'),
    );
    writeFileSync(
      join(root, 'tts-server/data/train-ko.txt'),
      '오늘은 날씨가 맑아요.\n어제 본 영화가 재미있었어요.\n점심은 간단하게 먹을까요?\n',
    );
    writeFileSync(
      join(root, 'tts-server/data/emotion-ko.json'),
      JSON.stringify({
        a: { happy: ['드디어 휴가예요, 정말 신나요!'], sad: ['화분이 결국 시들어 버렸어요.'] },
        b: { happy: ['시험 결과가 정말 좋았어요!'], sad: ['친구가 멀리 이사 간대요.'] },
      }),
    );
    cpSync(GUEST, join(root, 'voices'), { recursive: true });
    // untrained: the run writes these
    for (const f of ['ko.speaker.json', 'ko.trained.json', 'ko.trained.wav'])
      rmSync(join(root, 'voices', 'guest', f), { force: true });
    trainerLog = join(root, 'trainer.log');
    writeFileSync(join(root, 'fake-trainer.mjs'), FAKE_TRAINER);
    stub = stubs(root);
    process.env.S2V_TTS_PORT = String(await listen(stub.tts));
    process.env.S2V_ALIGNER_PORT = String(await listen(stub.aligner));
    process.env.S2V_TRAIN_SHARED_SERVERS = '1';
    process.env.S2V_TRAIN_CMD = JSON.stringify([process.execPath, join(root, 'fake-trainer.mjs')]);
    process.env.FAKE_TRAINER_LOG = trainerLog;
    delete process.env.S2V_TTS;
  });
  afterAll(async () => {
    await new Promise((ok) => stub.tts.close(ok));
    await new Promise((ok) => stub.aligner.close(ok));
    for (const d of [root, stub.scratch]) rmSync(d, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
    Object.assign(process.env, env);
  });

  const train = (minEmotion: number, busy: string | null = null) => {
    const logs: string[] = [];
    return {
      logs,
      run: trainVoice(join(root, 'voices', 'guest.yaml'), root, {
        lang: 'ko',
        minEmotion,
        log: (m) => logs.push(m),
        // not the machine's processes: other tests may run a stand-in imagegen python meanwhile
        imagegenBusy: async () => busy,
      }),
    };
  };

  it('does not start while image generation runs (A6)', async () => {
    await expect(train(0, '123 python imagegen/run.py').run).rejects.toThrow(
      /image generation is running \(123 python imagegen\/run.py\)/,
    );
  });

  it('reports the error of the trainer', async () => {
    process.env.FAKE_TRAINER_FAIL = '1';
    try {
      await expect(train(0).run).rejects.toThrow(
        /the check failed: the training input differs \(exit 3\)/,
      );
    } finally {
      delete process.env.FAKE_TRAINER_FAIL;
    }
  });

  it('stops before the second training when too few emotion clips pass', async () => {
    writeFileSync(trainerLog, '');
    const t = train(1000);
    await expect(t.run).rejects.toThrow(/emotion clips passed \(needs 1000; S2 had 184\)/);
    // neutral data, round-1 data and training 1 happened; training 2 did not
    expect(readFileSync(trainerLog, 'utf8').trim().split('\n')).toEqual([
      'encode',
      'check',
      'train',
    ]);
    expect(existsSync(join(root, 'voices/guest/ko.speaker.json'))).toBe(false);
    expect(t.logs.join('\n')).toMatch(/neutral data: 3 sentences × 2 takes/);
    // the seeds name stage, round vector, power, emotion, set, sentence and take
    expect(stub.calls).toContainEqual(
      expect.stringMatching(/^persona\|train:guest:neutral:-:-:neutral:0:0$/),
    );
    expect(stub.calls).toContainEqual(
      expect.stringMatching(/^persona-trained\|train:guest:emo2:[0-9a-f]{12}:strong:happy:b:0:0$/),
    );
  });

  it('finishes from its caches, writes the speaker and its reference', async () => {
    const before = stub.calls.filter((c) => c.includes('|train:')).length;
    const t = train(0);
    const r = await t.run;
    // every clip and the first training came from the cache
    expect(stub.calls.filter((c) => c.includes('|train:')).length).toBe(before);
    expect(readFileSync(trainerLog, 'utf8').trim().split('\n')).toEqual([
      'encode',
      'check',
      'train',
      'encode',
      'check',
      'train',
    ]);
    expect(r.neutral).toBe(3);
    expect(r.emotion).toBeGreaterThan(0);
    // training 2's data: neutral (no instruction), then emotion clips with their templates
    const stage2 = readFileSync(join(dirname(r.speakerPath), 'ko.speaker.json'), 'utf8');
    expect(stage2).toContain('"recipe":1');
    const data = readdirSync(join(root, '.s2v-cache', 'voice-train', 'guest', 'ko'))
      .flatMap((h) =>
        readdirSync(join(root, '.s2v-cache', 'voice-train', 'guest', 'ko', h))
          .filter((d) => d.startsWith('train2-'))
          .map((d) => join(root, '.s2v-cache', 'voice-train', 'guest', 'ko', h, d, 'data.jsonl')),
      )
      .map((f) =>
        readFileSync(f, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { instruct?: string }),
      );
    expect(data).toHaveLength(1);
    const rows = data[0]!;
    expect(rows.slice(0, 3).every((x) => !x.instruct)).toBe(true);
    expect(rows.slice(3).every((x) => /^Sound /.test(x.instruct ?? ''))).toBe(true);
    const f = readSpeaker(r.speakerPath);
    expect(typeof f === 'string' ? f : f.vectorSha).toMatch(/^[0-9a-f]{64}$/);
    const file = JSON.parse(readFileSync(r.speakerPath, 'utf8')) as Record<string, unknown>;
    expect(file).toMatchObject({ recipe: 1, epoch: 7, valLoss: 2.15 });
    expect(existsSync(join(root, 'voices/guest/ko.trained.json'))).toBe(true);

    // once more: nothing is synthesized or trained again for the data
    writeFileSync(trainerLog, '');
    const again = train(0);
    await again.run;
    expect(readFileSync(trainerLog, 'utf8')).toBe('');
  });
});
