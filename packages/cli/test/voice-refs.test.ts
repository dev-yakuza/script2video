import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseScript, VOICE_REF_VERSION, type VoiceReference } from '@script2video/core';
import { describe, expect, it } from 'vitest';
import { Service } from '../src/services.js';
import {
  castSentences,
  ClipVectors,
  loadReference,
  lockedFailures,
  referenceLocation,
  styleHash,
  type RefVoice,
} from '../src/voice-refs.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const REVS = { 'qwen3-tts-1.7b-customvoice': 'r1', 'qwen3-tts-1.7b-base': 'b1' };
const SOHEE: RefVoice = {
  engine: 'qwen',
  voice: 'Sohee',
  lang: 'ko',
  modelName: 'qwen3-tts-1.7b-customvoice',
  style: '차분하게',
};

function writeRef(dir: string, over: Partial<VoiceReference> = {}) {
  const base = join(dir, '_qwen', 'Sohee', `ko-${styleHash('차분하게')}`);
  mkdirSync(join(dir, '_qwen', 'Sohee'), { recursive: true });
  writeFileSync(`${base}.wav`, 'clip');
  const ref = {
    version: VOICE_REF_VERSION,
    revision: 'r1',
    embedder: { model: 'qwen3-tts-1.7b-base', revision: 'b1' },
    clipSha: sha('clip'),
    ...over,
  };
  writeFileSync(`${base}.json`, JSON.stringify(ref));
  return base;
}

describe('reference voices', () => {
  it('creates preset references at the repository root, or next to the script outside one', () => {
    const root = mkdtempSync(join(tmpdir(), 's2v-refs-'));
    const video = join(root, 'videos', 'a');
    mkdirSync(video, { recursive: true });
    expect(referenceLocation(SOHEE, video).jsonPath.startsWith(join(video, 'voices'))).toBe(true);
    mkdirSync(join(root, '.git'));
    const loc = referenceLocation(SOHEE, video);
    expect(loc.exists).toBe(false);
    expect(loc.jsonPath).toBe(
      join(root, 'voices', '_qwen', 'Sohee', `ko-${styleHash('차분하게')}.json`),
    );
    // the outermost voices/ folder that exists wins over the repository root
    mkdirSync(join(root, 'videos', 'voices'));
    expect(
      referenceLocation(SOHEE, video).jsonPath.startsWith(join(root, 'videos', 'voices')),
    ).toBe(true);
    mkdirSync(join(video, 'voices'));
    expect(
      referenceLocation(SOHEE, video).jsonPath.startsWith(join(root, 'videos', 'voices')),
    ).toBe(true);
    // an existing one is found anywhere up to the root
    writeRef(join(root, 'videos', 'voices'));
    expect(referenceLocation(SOHEE, video)).toMatchObject({ exists: true });
  });

  it('keys preset references by style', () => {
    expect(styleHash('차분하게')).not.toBe(styleHash(undefined));
  });

  it('says when a reference is out of date, and only warns about model revisions', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 's2v-refs-')), 'voices');
    writeRef(dir);
    expect(loadReference(SOHEE, join(dir, '..'), REVS)).toMatchObject({
      stale: null,
      warning: null,
    });
    expect(
      loadReference(SOHEE, join(dir, '..'), { ...REVS, 'qwen3-tts-1.7b-customvoice': 'r2' }),
    ).toMatchObject({ stale: null, warning: expect.stringMatching(/--refresh/) });
    writeRef(dir, { version: VOICE_REF_VERSION + 1 });
    expect(loadReference(SOHEE, join(dir, '..'), REVS).stale).toMatch(/recipe/);
    const base = writeRef(dir);
    writeFileSync(`${base}.wav`, 'edited');
    expect(loadReference(SOHEE, join(dir, '..'), REVS).stale).toMatch(/edited/);
  });

  it('treats a persona reference made from another clip as out of date', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-refs-'));
    const persona: RefVoice = {
      engine: 'persona',
      voice: 'minsu',
      lang: 'ko',
      modelName: 'qwen3-tts-1.7b-base',
      ref: { id: 'minsu', lang: 'ko', wavPath: join(dir, 'ko.wav'), text: '…', sha256: sha('new') },
    };
    writeFileSync(join(dir, 'ko.wav'), 'new');
    writeFileSync(
      join(dir, 'ko.f0.json'),
      JSON.stringify({ version: VOICE_REF_VERSION, refSha: sha('old'), clipSha: sha('new') }),
    );
    expect(loadReference(persona, dir, REVS).stale).toMatch(/clip changed/);
  });

  it('lists the synthesized sentences of one cast member', () => {
    const { script } = parseScript(
      [
        '---',
        'title: t',
        'lang: ko',
        'cast:',
        '  a: { voice: "qwen:Sohee" }',
        '  b: { voice: "supertonic:F1" }',
        '---',
        '# s1',
        'a: 안녕하세요. 반가워요.',
        '',
        'b: 네?',
        '',
      ].join('\n'),
    );
    expect([...castSentences(script!, 'a').values()]).toEqual(['안녕하세요.', '반가워요.']);
    expect(castSentences(script!, 'b').size).toBe(1);
  });
});

describe('services', () => {
  it('refuses a running server of another wrapper version', async () => {
    const server = createServer((_, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'x', lock_hash: 'h', wrapper_version: '0.2.0' }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const s = new Service({ id: 'x', dir: 'd', port, wrapper: '0.3.0' }, '/');
    s.expectedLockHash = () => 'h';
    await expect(s.ensure()).rejects.toThrow(/version 0\.2\.0, this s2v needs 0\.3\.0/);
    server.close();
  });
});

describe('locked sentences against a new reference', () => {
  it('uses stored measurements of the same reference and re-measures the rest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-lock-'));
    for (const f of ['a.wav', 'b.wav', 'c.wav']) writeFileSync(join(dir, f), 'x');
    const calls: string[] = [];
    const fake = (vec: Record<string, number[]>) =>
      ({
        post: async (path: string, body: { wav_path: string }) => {
          calls.push(`${path} ${body.wav_path.split('/').pop()}`);
          return path === '/pitch'
            ? { data: { median_hz: 300 }, headers: new Headers() }
            : {
                data: { vector: vec[body.wav_path.split('/').pop()!] ?? [1, 0] },
                headers: new Headers(),
              };
        },
      }) as unknown as Service;
    const tts = fake({ 'c.wav': [0, 1], 'clip.wav': [1, 0] });
    const services = { tts, aligner: fake({}), ensure: async () => {} };
    const r = {
      ref: { f0: 120, sigma: 0.5, simFloor: 0.95 } as VoiceReference,
      jsonPath: '',
      clipPath: join(dir, 'clip.wav'),
      sha: 'new',
    };
    const failing = await lockedFailures(
      new Map([
        ['s:0:0', '첫째.'],
        ['s:0:1', '둘째.'],
        ['s:0:2', '셋째.'],
      ]),
      {
        dir,
        sentences: { 's:0:0': 'A', 's:0:1': 'B', 's:0:2': 'C' },
        entries: {
          A: { src: 'a.wav', f0: 120, sim: 0.99, voiceRef: 'new' },
          B: { src: 'b.wav', f0: null, sim: 0.99, voiceRef: 'old' },
          C: { src: 'c.wav', sim: 0.99, voiceRef: 'old' },
        },
      },
      r,
      services,
      new ClipVectors(tts),
    );
    // A: stored values of this reference, nothing measured; B: unmeasurable pitch is not
    // measured again; C: pitch and similarity measured (300 Hz, orthogonal vector) and failing
    expect(calls.filter((c) => c.endsWith('a.wav'))).toEqual([]);
    expect(calls).not.toContain('/pitch b.wav');
    expect(failing.map((f) => f.id)).toEqual(['s:0:2']);
    expect(failing[0]!.reasons).toHaveLength(2);
  });
});

describe('locked emotion lines', () => {
  it('judges them with the emotion pitch window and similarity floor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-lock-'));
    writeFileSync(join(dir, 'a.wav'), 'x');
    const none = { post: async () => ({ data: {}, headers: new Headers() }) } as unknown as Service;
    const services = { tts: none, aligner: none, ensure: async () => {} };
    const r = {
      ref: { f0: 120, sigma: 0.5, simFloor: 0.97, sims: [0.98, 0.99] } as VoiceReference,
      jsonPath: '',
      clipPath: join(dir, 'clip.wav'),
      sha: 'ref',
    };
    const lock = {
      dir,
      sentences: { 's:0:0': 'A' },
      // +5 semitones and 0.96: too far for a plain line, fine for a happy one
      entries: { A: { src: 'a.wav', f0: 120 * 2 ** (5 / 12), sim: 0.96, voiceRef: 'ref' } },
    };
    const lines = new Map([['s:0:0', '합격했어요!']]);
    const plain = await lockedFailures(lines, lock, r, services, new ClipVectors(none));
    expect(plain[0]!.reasons).toHaveLength(2);
    const happy = await lockedFailures(
      lines,
      lock,
      r,
      services,
      new ClipVectors(none),
      new Map([['s:0:0', 'happy']]),
    );
    expect(happy).toEqual([]);
  });
});
