/** `s2v sentences --json` (S9a plan 2.3), with mock audio. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from '@script2video/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sentencesReport } from '../src/sentences.js';
import { synthesizeScript, type LockManifest } from '../src/tts.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('sentences --json', { timeout: 60_000 }, () => {
  const prev = process.env.S2V_TTS;
  beforeAll(() => {
    process.env.S2V_TTS = 'mock';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.S2V_TTS;
    else process.env.S2V_TTS = prev;
  });

  it('lists every sentence with its key, acting, pick and what the lock holds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-sentences-'));
    const path = join(dir, 'v', 'script.ko.md');
    mkdirSync(dirname(path));
    const source = `---
lang: ko
cast:
  host: { voice: "qwen:Sohee" }
  slow: { voice: "qwen:Ryan", speed: 0.6 }
---

# 하나 {#a}

host{emo=happy power=strong}: 기쁜 첫 문장이에요. 둘째 문장이에요.

host: 같은 말이에요.

host: 같은 말이에요.

host: :audio{src=rec/none.wav}녹음이 없어요. 둘째도요.

slow: 이건 괜찮아요. :emo{speed=0.8}이건 너무 느려요.
`;
    writeFileSync(path, source);
    const script = parseScript(source).script!;
    // the lock comes from the lines that can be made (tts stops on the others)
    const good = parseScript(source.split('host: :audio')[0]!).script!;
    await synthesizeScript(path, good, REPO, { asr: false, log: () => {} });
    // a pick for the twice-said line: both lines share its pick key
    const lockDir = join(dirname(path), 'audio', 'ko');
    const lock = JSON.parse(readFileSync(join(lockDir, 'manifest.json'), 'utf8')) as LockManifest;
    const report0 = sentencesReport(path, script, REPO);
    const same = report0.filter((s) => s.text === '같은 말이에요.');
    expect(same).toHaveLength(2);
    expect(same[0]!.pickKey).toBe(same[1]!.pickKey);
    const held = lock.entries[same[0]!.lockKey!]!;
    writeFileSync(
      join(lockDir, 'picks.json'),
      JSON.stringify({
        version: 1,
        picks: {
          [same[0]!.pickKey!]: {
            take: held.attempt,
            id: same[0]!.id,
            text: '같은 말이에요.',
            tried: 0,
            by: 'human',
          },
        },
      }),
    );
    const report = sentencesReport(path, script, REPO);
    const by = (id: string) => report.find((s) => s.id === id)!;

    expect(report.map((s) => s.id)).toEqual([
      'a:0:0',
      'a:0:1',
      'a:1:0',
      'a:2:0',
      'a:3:0',
      'a:3:1',
      'a:4:0',
      'a:4:1',
    ]);
    expect(by('a:0:0').acting).toEqual({ emo: 'happy', power: 'strong' });
    expect(by('a:1:0').acting).toBeNull();
    // the pick shows on both lines that share its key, applied (the lock holds that take)
    for (const id of ['a:1:0', 'a:2:0'])
      expect(by(id).pick).toEqual({ take: held.attempt, by: 'human', applied: true });
    // the lock: mock audio was not heard by ASR
    const l = by('a:0:0').lock!;
    expect([l.asr, l.cer, l.heard]).toEqual([false, null, '']);
    const wav = join(lockDir, lock.entries[by('a:0:0').lockKey!]!.src);
    expect(l.wavSha256).toBe(createHash('sha256').update(readFileSync(wav)).digest('hex'));
    // a paragraph that cannot be planned: all of its sentences, its error
    for (const id of ['a:3:0', 'a:3:1']) {
      expect(by(id).lockKey).toBeNull();
      expect(by(id).error).toMatch(/recording not found/);
      expect(by(id).recorded).toBe(false);
    }
    // a sentence too slow: only it, not its paragraph (its first sentence has a key)
    expect(by('a:4:0').lockKey).not.toBeNull();
    expect(by('a:4:0').error).toBeNull();
    expect(by('a:4:1').lockKey).toBeNull();
    expect(by('a:4:1').error).toMatch(/speed/);
    // no pick, none shown
    expect(by('a:0:0').pick).toBeNull();
    // mock audio: the lock itself says not heard (heard empty, no CER)
    const raw = lock.entries[by('a:0:0').lockKey!]!;
    expect([raw.asr, raw.cer, raw.heard]).toEqual([false, null, '']);

    // a pick of a take the lock does not hold: not applied; a lock entry without its wav: none
    const p2 = JSON.parse(readFileSync(join(lockDir, 'picks.json'), 'utf8'));
    p2.picks[same[0]!.pickKey!].take = held.attempt + 5;
    writeFileSync(join(lockDir, 'picks.json'), JSON.stringify(p2));
    rmSync(join(lockDir, lock.entries[by('a:0:1').lockKey!]!.src));
    const later = sentencesReport(path, script, REPO);
    const at = (id: string) => later.find((s) => s.id === id)!;
    expect(at('a:1:0').pick!.applied).toBe(false);
    expect(at('a:0:1').lock).toBeNull();

    // an old mock lock entry (no asr, the script text as heard): not heard, no CER
    const old = JSON.parse(readFileSync(join(lockDir, 'manifest.json'), 'utf8')) as LockManifest;
    const k = by('a:0:0').lockKey!;
    delete old.entries[k]!.asr;
    old.entries[k]!.heard = '기쁜 첫 문장이에요.';
    old.entries[k]!.cer = 0;
    writeFileSync(join(lockDir, 'manifest.json'), JSON.stringify(old));
    expect(sentencesReport(path, script, REPO).find((s) => s.id === 'a:0:0')!.lock).toMatchObject({
      asr: false,
      cer: null,
      heard: '',
    });
    // and tts writes it so (the pick refers to a take that does not exist: drop it first)
    rmSync(join(lockDir, 'picks.json'));
    await synthesizeScript(path, good, REPO, { asr: false, log: () => {} });
    const fixed = (JSON.parse(readFileSync(join(lockDir, 'manifest.json'), 'utf8')) as LockManifest)
      .entries[k]!;
    expect([fixed.asr, fixed.cer, fixed.heard]).toEqual([false, null, '']);
  });

  it('the command prints JSON even when some lines cannot be made', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-sentences-cli-'));
    const path = join(dir, 'v', 'script.ko.md');
    mkdirSync(dirname(path));
    writeFileSync(
      path,
      '---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\n---\n\n# 하나 {#a}\n\nhost: 됩니다.\n\nhost: :audio{src=rec/none.wav}녹음이 없어요.\n',
    );
    // the JSON is printed and the exit code still says lint failed
    let out = '';
    let status = 0;
    try {
      execFileSync('node', [join(REPO, 'packages/cli/dist/main.js'), 'sentences', path, '--json'], {
        cwd: REPO,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, S2V_TTS: 'mock' },
      });
    } catch (e) {
      const x = e as { status: number; stdout: Buffer };
      status = x.status;
      out = x.stdout.toString();
    }
    expect(status).toBe(1);
    const report = JSON.parse(out) as { id: string; error: string | null }[];
    expect(report.map((r) => [r.id, r.error === null])).toEqual([
      ['a:0:0', true],
      ['a:1:0', false],
    ]);
  });
});
