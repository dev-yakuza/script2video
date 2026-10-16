/**
 * A persona's trained speaker on the CLI side (acting stage 4 plan 1–3): the speaker file, lint,
 * the synthesis request and keys, the reference voice. Uses the sample dialogue's guest persona.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript, STRONG_TEMPLATES_V1, type Script } from '@script2video/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintCast } from '../src/lint-assets.js';
import { readSpeaker, resolveTrained, SPEAKER_DIM, vectorShaOf } from '../src/persona.js';
import { planSentences, synthesizeScript } from '../src/tts.js';
import { loadReference, referenceLocation, styleHash, synthesisBody } from '../src/voice-refs.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const REVISION = (
  JSON.parse(readFileSync(join(REPO, 'models.lock.json'), 'utf8')) as {
    models: Record<string, { revision: string }>;
  }
).models['qwen3-tts-1.7b-customvoice']!.revision;
const CLIP_SHA = (
  JSON.parse(
    readFileSync(join(REPO, 'videos/sample-dialogue-ko/voices/guest/ko.json'), 'utf8'),
  ) as { sha256: string }
).sha256;

const vector = (k = 1) =>
  Array.from({ length: SPEAKER_DIM }, (_, i) => Math.fround((i % 97) / 97 - 0.5) * k);

function speakerFile(over: Record<string, unknown> = {}, vec = vector()) {
  return {
    version: 1,
    vector: vec,
    model: 'qwen3-tts-1.7b-customvoice',
    revision: REVISION,
    referenceSha: CLIP_SHA,
    vectorSha: vectorShaOf(vec),
    ...over,
  };
}

/** A repo-like folder: models.lock.json, the guest persona, a script using it. */
function setup(cast: string, body: string) {
  const root = mkdtempSync(join(tmpdir(), 's2v-trained-'));
  writeFileSync(join(root, 'models.lock.json'), readFileSync(join(REPO, 'models.lock.json')));
  cpSync(join(REPO, 'videos/sample-dialogue-ko/voices'), join(root, 'voices'), {
    recursive: true,
  });
  const path = join(root, 'script.ko.md');
  const head = `---\nlang: ko\ncast:\n${cast}\noutputs:\n  youtube: { aspect: "16:9", layout: presenter }\n---\n\n# s {#s}\n\n`;
  writeFileSync(path, head + body + '\n');
  const speakerPath = join(root, 'voices', 'guest', 'ko.speaker.json');
  const write = (f: unknown) => writeFileSync(speakerPath, JSON.stringify(f));
  const script = (): Script => parseScript(readFileSync(path, 'utf8')).script!;
  return { root, path, speakerPath, write, script };
}

const TRAINED = '  guest: { voice: "persona:guest", personaModel: trained }';

describe('trained speaker file', () => {
  it('hashes a vector as tts-server/helpers.py does', () => {
    // the same vector and sha as tts-server/test_helpers.py
    const v = Array.from({ length: SPEAKER_DIM }, (_, i) => (i % 97) / 97 - 0.5);
    expect(vectorShaOf(v)).toBe('19951df2c2bbb16a0591221c3f18bdff4e47c8d7a8d72891f706b9d7ccbe6512');
  });

  it('has the float32 sha of its vector, and is refused when damaged', () => {
    const t = setup(TRAINED, 'guest: 안녕하세요.');
    t.write(speakerFile());
    expect(readSpeaker(t.speakerPath)).toMatchObject({ vectorSha: vectorShaOf(vector()) });
    // float32 rounding of the same values gives the same sha
    expect(vectorShaOf(vector().map((x) => x + 1e-12))).toBe(vectorShaOf(vector()));
    t.write(speakerFile({}, vector().slice(1)));
    expect(readSpeaker(t.speakerPath)).toMatch(/2048 finite numbers/);
    const f = speakerFile();
    f.vector[5] = 0.123;
    t.write(f);
    expect(readSpeaker(t.speakerPath)).toMatch(/vectorSha does not match/);
  });

  it('is found next to the persona yaml, or says what to run', () => {
    const t = setup(TRAINED, 'guest: 안녕하세요.');
    expect(resolveTrained('guest', 'ko', t.root)).toMatchObject({
      kind: 'missing',
      message: expect.stringMatching(/s2v voice train .*guest\.yaml --lang ko/),
    });
    t.write(speakerFile());
    expect(resolveTrained('guest', 'ko', t.root)).toMatchObject({ path: t.speakerPath });
  });

  it('refuses a speaker file that is not an object or out of float32 range', () => {
    const t = setup(TRAINED, 'guest: 안녕하세요.');
    writeFileSync(t.speakerPath, 'null');
    expect(readSpeaker(t.speakerPath)).toMatch(/not a speaker file/);
    writeFileSync(t.speakerPath, '[1,2,3]');
    expect(readSpeaker(t.speakerPath)).toMatch(/not a speaker file/);
    const big = vector();
    big[0] = 3.5e38;
    t.write({ ...speakerFile(), vector: big });
    expect(readSpeaker(t.speakerPath)).toMatch(/finite numbers/);
  });

  it('uses only the speaker file next to the persona yaml', () => {
    const t = setup(TRAINED, 'guest: 안녕하세요.');
    // a speaker file in another voices/ folder above is not this persona's
    mkdirSync(join(t.root, 'video'), { recursive: true });
    cpSync(join(t.root, 'voices'), join(t.root, 'video', 'voices'), { recursive: true });
    writeFileSync(
      join(t.root, 'voices', 'guest', 'ko.speaker.json'),
      JSON.stringify(speakerFile()),
    );
    expect(resolveTrained('guest', 'ko', join(t.root, 'video'))).toMatchObject({
      kind: 'missing',
      message: expect.stringMatching(/has no trained ko speaker/),
    });
  });

  it('lints a missing file as a warning (drafts need none), a damaged one as an error, another reference or model as a warning', () => {
    const t = setup(TRAINED, 'guest: 안녕하세요.');
    const lint = () =>
      lintCast(t.script(), t.root)
        .filter((d) => d.code === 'persona-trained')
        .map((d) => `${d.severity}: ${d.message}`);
    expect(lint()).toEqual([expect.stringMatching(/^warning: .*s2v voice train/)]);
    t.write({ ...speakerFile(), vectorSha: 'bad' });
    expect(lint()).toEqual([expect.stringMatching(/^error: .*vectorSha does not match/)]);
    t.write(speakerFile());
    expect(lint()).toEqual([]);
    t.write(speakerFile({ referenceSha: 'other', revision: 'other' }));
    expect(lint()).toEqual([
      expect.stringMatching(/^warning: .*another ko reference clip/),
      expect.stringMatching(/^warning: .*another model revision/),
    ]);
  });
});

describe('trained speaker synthesis', () => {
  const prev = process.env.S2V_TTS;
  beforeAll(() => {
    process.env.S2V_TTS = 'mock';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.S2V_TTS;
    else process.env.S2V_TTS = prev;
  });

  it('asks the server for persona-trained with the file and its sha, no clip', () => {
    const speaker = { path: '/v/guest/ko.speaker.json', vectorSha: 'abc' };
    expect(synthesisBody({ engine: 'trained', voice: 'guest', speaker })).toEqual({
      engine: 'persona-trained',
      voice: 'guest',
      speaker_path: speaker.path,
      vector_sha: 'abc',
    });
    expect(synthesisBody({ engine: 'qwen', voice: 'Sohee' })).toEqual({
      engine: 'qwen',
      voice: 'Sohee',
    });
  });

  it('acts emotion lines, with strong wording, and keys on the vector', async () => {
    const t = setup(
      TRAINED,
      'guest{emo=sad}: 오늘은 조금 슬퍼요. :emo{emo=sad power=strong}정말 슬퍼요.',
    );
    t.write(speakerFile());
    const jobs = () => planSentences(t.path, t.script(), REPO, { draft: false, mock: true }).jobs;
    const [a, b] = jobs();
    expect(a!.target.engine).toBe('trained');
    expect(a!.emotional).toBe(true);
    expect(a!.synthFields.instruct).not.toMatch(/Sound very/);
    expect(b!.synthFields.instruct).toContain(STRONG_TEMPLATES_V1.sad);
    expect((a!.synthFields as { speaker?: string }).speaker).toBe(vectorShaOf(vector()));
    expect((a!.synthFields as { ref?: string }).ref).toBeUndefined();
    // power picks a take as before: in the lock and pick keys, not the raw takes'
    expect(b!.power).toBe('strong');
    expect(b!.pickKey).not.toBe(b!.synthKey);

    const run = () => synthesizeScript(t.path, t.script(), REPO, { asr: false, log: () => {} });
    expect((await run()).synthesized).toBe(2);
    expect((await run()).synthesized).toBe(0);
    // a new vector is a new voice
    t.write(speakerFile({}, vector(0.9)));
    expect((await run()).synthesized).toBe(2);
  });

  it('drafts with the draft voice, not a trained speaker', () => {
    const t = setup(
      '  guest: { voice: "persona:guest", personaModel: trained, draftVoice: "persona:guest" }',
      'guest{emo=sad}: 오늘은 조금 슬퍼요.',
    );
    const [j] = planSentences(t.path, t.script(), REPO, { draft: true, mock: false }).jobs;
    expect(j!.target.engine).toBe('persona');
  });

  it('keys mock runs on a placeholder when the file is missing', () => {
    const t = setup(TRAINED, 'guest{emo=sad}: 오늘은 조금 슬퍼요.');
    const [j] = planSentences(t.path, t.script(), REPO, { draft: false, mock: true }).jobs;
    expect((j!.synthFields as { speaker?: string }).speaker).toBe('mock');
  });
});

describe('trained speaker reference voice', () => {
  it('lives next to the speaker file, per style, and goes stale with a new vector', () => {
    const t = setup(TRAINED, 'guest: 안녕하세요.');
    const v = {
      engine: 'trained' as const,
      voice: 'guest',
      lang: 'ko' as const,
      modelName: 'qwen3-tts-1.7b-customvoice',
      speaker: { path: t.speakerPath, vectorSha: 'new' },
    };
    expect(referenceLocation(v, t.root).jsonPath).toBe(
      join(t.root, 'voices/guest/ko.trained.json'),
    );
    expect(referenceLocation({ ...v, style: '또렷하게' }, t.root).jsonPath).toBe(
      join(t.root, `voices/guest/ko.trained-${styleHash('또렷하게')}.json`),
    );
    const loc = referenceLocation(v, t.root);
    writeFileSync(loc.clipPath, 'clip');
    writeFileSync(loc.jsonPath, JSON.stringify({ version: 1, vectorSha: 'old', clipSha: 'x' }));
    expect(loadReference(v, t.root, {}).stale).toBe('the trained speaker changed');
    // the same vector: not stale for that reason
    writeFileSync(loc.jsonPath, JSON.stringify({ version: 1, vectorSha: 'new', clipSha: 'x' }));
    expect(loadReference(v, t.root, {}).stale).not.toBe('the trained speaker changed');
  });
});
