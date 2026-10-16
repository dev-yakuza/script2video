import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from '@script2video/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { takeBudgetDone } from '@script2video/core';
import { mockMeasure } from '../src/mock-tts.js';
import { neighborFor, planSentences, synthesizeScript, type LockManifest } from '../src/tts.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function setup(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 's2v-takes-'));
  mkdirSync(join(dir, 'video'));
  const path = join(dir, 'video', 'script.ko.md');
  const source = `---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\noutputs:\n  youtube: { aspect: "16:9", layout: presenter }\n---\n\n# 하나 {#one}\n\n${body}\n`;
  writeFileSync(path, source);
  let script = parseScript(source).script!;
  const rewrite = (b: string) => {
    const src = source.replace(body, b);
    writeFileSync(path, src);
    script = parseScript(src).script!;
  };
  const lock = () =>
    JSON.parse(
      readFileSync(join(dir, 'video', 'audio', 'ko', 'manifest.json'), 'utf8'),
    ) as LockManifest;
  const lockPath = join(dir, 'video', 'audio', 'ko', 'manifest.json');
  const run = async (extra: { retry?: string[]; recheck?: boolean } = {}) => {
    const logs: string[] = [];
    const r = await synthesizeScript(path, script, REPO, {
      asr: false,
      log: (m) => logs.push(m),
      ...extra,
    });
    return { ...r, logs };
  };
  const job = () => planSentences(path, script, REPO, { draft: false, mock: true }).jobs[0]!;
  return { run, lock, job, rewrite, lockPath };
}

describe('stage 3 takes (mock)', () => {
  const prev = { tts: process.env.S2V_TTS, fail: process.env.S2V_TTS_MOCK_FAIL };
  beforeAll(() => {
    process.env.S2V_TTS = 'mock';
  });
  beforeEach(() => {
    delete process.env.S2V_TTS_MOCK_FAIL;
  });
  afterAll(() => {
    if (prev.tts === undefined) delete process.env.S2V_TTS;
    else process.env.S2V_TTS = prev.tts;
    if (prev.fail === undefined) delete process.env.S2V_TTS_MOCK_FAIL;
    else process.env.S2V_TTS_MOCK_FAIL = prev.fail;
  });

  it('makes three takes of an emotion line and records the choice', async () => {
    const t = setup('host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    await t.run();
    const [e] = Object.values(t.lock().entries);
    expect(Object.keys(e!.takes!)).toEqual(['0', '1', '2']);
    // sad is LOW_AROUSAL: the weakest of three passing takes
    expect(e!.select).toMatchObject({ n: 3, rank: 0, retry: false });
    expect(e!.tried).toBe(2);
    expect(e!.pickKey).toBe(t.job().pickKey);
  });

  it('keeps one take for a plain line', async () => {
    const t = setup('host: 오늘은 평범한 이야기를 해 볼게요.');
    await t.run();
    const [e] = Object.values(t.lock().entries);
    expect(Object.keys(e!.takes!)).toEqual(['0']);
    expect(e!.select).toBeUndefined();
  });

  it('makes more takes until two pass, and falls back to the fewest failures', async () => {
    const t = setup('host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    process.env.S2V_TTS_MOCK_FAIL = `${t.job().synthKey.slice(0, 8)}:0,1,3`;
    await t.run();
    let [e] = Object.values(t.lock().entries);
    expect(Object.keys(e!.takes!)).toEqual(['0', '1', '2', '3', '4']);
    expect(e!.select!.n).toBe(2);

    const u = setup('host{emo=sad}: 오늘은 정말 슬픈 이야기를 해 볼게요.');
    process.env.S2V_TTS_MOCK_FAIL = `${u.job().synthKey.slice(0, 8)}:0,1,2,3,4,5`;
    const r = await u.run();
    [e] = Object.values(u.lock().entries);
    expect(Object.keys(e!.takes!)).toHaveLength(6);
    expect(e!.select).toBeUndefined();
    expect(r.warnings.join('\n')).toMatch(/kept attempt/);
  });

  it('picks the strongest take with power=strong and the weakest with power=weak', async () => {
    const strong = setup('host{emo=sad power=strong}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    await strong.run();
    const weak = setup('host{emo=sad power=weak}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    await weak.run();
    const s = Object.values(strong.lock().entries)[0]!;
    const w = Object.values(weak.lock().entries)[0]!;
    expect(s.select).toMatchObject({ n: 3, rank: 2 });
    expect(w.select).toMatchObject({ n: 3, rank: 0 });
    // same raw takes (synthesis key), different choice
    expect(s.synthKey).toBe(w.synthKey);
  });

  it('retries with three new takes after every take made, and keeps the lock when none passes', async () => {
    const t = setup('host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    await t.run();
    const id = Object.keys(t.lock().sentences)[0]!;
    const r = await t.run({ retry: [id] });
    expect(r.synthesized).toBe(1);
    let [e] = Object.values(t.lock().entries);
    expect(Object.keys(e!.takes!)).toEqual(['3', '4', '5']);
    expect(e!.select!.retry).toBe(true);
    expect(e!.tried).toBe(5);

    process.env.S2V_TTS_MOCK_FAIL = `${t.job().synthKey.slice(0, 8)}:6,7,8`;
    const kept = await t.run({ retry: [id] });
    expect(kept).toMatchObject({ synthesized: 0, reused: 1 });
    expect(kept.warnings.join('\n')).toMatch(/kept the locked take/);
    [e] = Object.values(t.lock().entries);
    expect(e!.attempt).toBeGreaterThanOrEqual(3);
    expect(e!.attempt).toBeLessThanOrEqual(5);
    expect(e!.tried).toBe(8);
  });

  it('warns when a --retry choice is lost to a key change, and retries after the old takes', async () => {
    const t = setup('host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    await t.run();
    const id = Object.keys(t.lock().sentences)[0]!;
    await t.run({ retry: [id] });
    // the same line with power: a new lock key over the same raw takes
    t.rewrite('host{emo=sad power=weak}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    const r = await t.run();
    expect(r.warnings.join('\n')).toMatch(/chosen with --retry before is not used/);
    const again = await t.run({ retry: [id] });
    expect(again.synthesized).toBe(1);
    const e = t.lock().entries[t.lock().sentences[id]!]!;
    // after the old entry's takes (0–5): 6, 7, 8
    expect(Object.keys(e.takes!)).toEqual(['6', '7', '8']);
  });

  it('makes all six takes with S2V_TAKES_ALL but chooses as the budget does', async () => {
    const t = setup('host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    await t.run();
    const budget = Object.values(t.lock().entries)[0]!;
    const u = setup('host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    process.env.S2V_TAKES_ALL = '6';
    try {
      await u.run();
    } finally {
      delete process.env.S2V_TAKES_ALL;
    }
    const all = Object.values(u.lock().entries)[0]!;
    expect(Object.keys(all.takes!)).toHaveLength(6);
    expect(all.attempt).toBe(budget.attempt);
    expect(all.select).toEqual(budget.select);
  });

  it('makes more takes of an ENDING_LIFT line until one reaches the ending floor', async () => {
    const ctx = {
      emotion: 'happy' as const,
      power: 'strong' as const,
      question: false,
      refF0: 200,
      expected: 1,
    };
    // the budget from the same mock measurements; find a line that needs more than three takes
    const predict = (synthKey: string) => {
      const facts = [0, 1, 2, 3, 4, 5].map((n) => ({
        n,
        ok: true,
        ...mockMeasure(synthKey, n, 1, 1),
        rate: null,
      }));
      let k = 3;
      while (k < 6 && !takeBudgetDone(facts.slice(0, k), ctx)) k++;
      return k;
    };
    let found = false;
    for (const word of ['합격', '우승', '당첨', '성공', '완성', '졸업', '입학', '승진']) {
      const t = setup(`host{emo=happy power=strong}: 드디어 ${word}했어요! 정말 기뻐요.`);
      const k = predict(t.job().synthKey);
      if (k <= 3) continue;
      await t.run();
      const [e] = Object.values(t.lock().entries);
      expect(Object.keys(e!.takes!)).toHaveLength(k);
      found = true;
      break;
    }
    expect(found).toBe(true);
  });

  it('falls back to the budget when a retry fails and the key has no entry yet', async () => {
    const t = setup('host: 오늘은 평범한 이야기를 해 볼게요.');
    await t.run();
    const id = Object.keys(t.lock().sentences)[0]!;
    // the line speed changes the lock key (tempo), not the raw takes
    t.rewrite('host{speed=1.1}: 오늘은 평범한 이야기를 해 볼게요.');
    process.env.S2V_TTS_MOCK_FAIL = `${t.job().synthKey.slice(0, 8)}:1,2,3,4,5,6`;
    const r = await t.run({ retry: [id] });
    expect(r.synthesized).toBe(1);
    const e = t.lock().entries[t.lock().sentences[id]!]!;
    expect(e.attempt).toBe(0);
    expect(e.select).toBeUndefined();
  });

  it('warns when --recheck replaces a take chosen with --retry', async () => {
    const t = setup('host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    await t.run();
    const id = Object.keys(t.lock().sentences)[0]!;
    await t.run({ retry: [id] });
    // make the locked take fail its checks: a duration that makes the rate impossible
    const m = t.lock();
    m.entries[m.sentences[id]!]!.duration = 60;
    m.entries[m.sentences[id]!]!.words = [{ text: '오늘은', start: 0, end: 59 }];
    writeFileSync(t.lockPath, JSON.stringify(m));
    const r = await t.run({ recheck: true });
    expect(r.warnings.join('\n')).toMatch(/chosen with --retry is replaced/);
    // chosen again by the budget among takes 0–2, takes rewritten
    const e = t.lock().entries[t.lock().sentences[id]!]!;
    expect(e.attempt).toBeLessThanOrEqual(2);
    expect(e.select!.retry).toBe(false);
    expect(Object.keys(e.takes!)).toEqual(['0', '1', '2']);
  });

  it('falls back to the budget for an emotion line when a retry fails and the key is new', async () => {
    const t = setup('host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    await t.run();
    const id = Object.keys(t.lock().sentences)[0]!;
    t.rewrite('host{emo=sad speed=1.1}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    process.env.S2V_TTS_MOCK_FAIL = `${t.job().synthKey.slice(0, 8)}:3,4,5`;
    const r = await t.run({ retry: [id] });
    expect(r.synthesized).toBe(1);
    const e = t.lock().entries[t.lock().sentences[id]!]!;
    expect(e.attempt).toBeLessThanOrEqual(2);
    expect(e.select!.retry).toBe(false);
  });

  it('marks a plain retry only when the kept take is one of the retry takes', async () => {
    const t = setup('host: 오늘은 평범한 이야기를 또 해 볼게요.');
    await t.run();
    const id = Object.keys(t.lock().sentences)[0]!;
    t.rewrite('host{speed=1.1}: 오늘은 평범한 이야기를 또 해 볼게요.');
    // every take fails: the retry takes (1–6) and the budget takes (0–5) behind them
    process.env.S2V_TTS_MOCK_FAIL = `${t.job().synthKey.slice(0, 8)}:0,1,2,3,4,5,6`;
    await t.run({ retry: [id] });
    const e = t.lock().entries[t.lock().sentences[id]!]!;
    expect(e.select).toBeUndefined();
  });

  it('matches the previous sentence of a paragraph, the same whether it was locked before or not', async () => {
    const lines = [
      '오늘은 조금 슬픈 이야기를 해 볼게요.',
      '오래 키우던 화분이 시들었어요.',
      '친구가 먼 곳으로 이사 간대요.',
      '연락이 오지 않네요.',
      '마음이 무겁고 쓸쓸해요.',
      '다시는 볼 수 없다니 믿기지 않아요.',
    ];
    const full = `host{emo=sad}: ${lines.join(' ')}`;
    const all = setup(full);
    await all.run();
    const a = all.lock();
    const at = (l: LockManifest, id: string) => l.entries[l.sentences[id]!]!;
    // the mock pitch differs per take: matching moves the fourth sentence off its target rank
    expect(at(a, 'one:0:3').select).toMatchObject({ neighbor: true });

    // that sentence synthesized after the ones before were locked: the same take
    const step = setup(`host{emo=sad}: ${lines.slice(0, 3).join(' ')}`);
    await step.run();
    step.rewrite(full);
    const r = await step.run();
    expect(r.synthesized).toBe(3);
    const b = step.lock();
    for (const id of Object.keys(a.sentences))
      expect([at(b, id).attempt, at(b, id).select]).toEqual([at(a, id).attempt, at(a, id).select]);
  });

  it('matches only the sentence right before in the same paragraph, emotion, power and speed', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-neighbor-'));
    const path = join(dir, 'script.ko.md');
    const source =
      '---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\noutputs:\n  youtube: { aspect: "16:9", layout: presenter }\n---\n\n# 하나 {#one}\n\n' +
      'host{emo=sad}: 첫 문장이에요. 둘째 문장이에요. :emo{emo=happy}셋째 문장이에요! 넷째 문장이에요!\n\n' +
      'host{emo=happy}: 다섯째 문장이에요!\n\n' +
      'host{emo=sad}: 여섯째 문장이에요. :emo{emo=sad power=strong}일곱째 문장이에요. :emo{emo=sad speed=1.1}여덟째 문장이에요.\n\n' +
      'host: 아홉째 문장이에요. 열째 문장이에요.\n\n' +
      'host{emo=sad}: 열한째 문장이에요. :emo{emo=sad speed=1.1}열두째 문장이에요. :emo{emo=sad speed=1.1 say="속삭이듯"}열셋째 문장이에요.\n';
    writeFileSync(path, source);
    const jobs = planSentences(path, parseScript(source).script!, REPO, {
      draft: false,
      mock: true,
    }).jobs;
    const passed = { f0: 210, words: [], checks: [] };
    const calls: [string, unknown][] = [];
    const rate = (j: (typeof jobs)[number], words: unknown) => {
      calls.push([j.id, words]);
      return 4.5;
    };
    const at = (i: number, entry: Parameters<typeof neighborFor>[2] = passed) =>
      neighborFor(jobs[i]!, jobs[i - 1], entry, rate);
    expect(jobs.map((j) => j.id)).toHaveLength(13);
    expect(at(1)).toEqual({ f0: 210, rate: 4.5 });
    // the rate is the previous sentence's, from its lock words
    expect(calls).toEqual([[jobs[0]!.id, passed.words]]);
    expect(at(2)).toBeUndefined(); // the emotion changes inside the paragraph
    expect(at(3)).toEqual({ f0: 210, rate: 4.5 });
    expect(at(4)).toBeUndefined(); // a new paragraph
    expect(at(5)).toBeUndefined(); // another paragraph and emotion
    expect(at(6)).toBeUndefined(); // power differs
    expect(at(7)).toBeUndefined(); // power and speed differ
    expect(at(11)).toBeUndefined(); // speed alone differs
    expect(at(12)).toBeUndefined(); // `say` alone differs
    expect(at(9)).toBeUndefined(); // plain lines
    expect(neighborFor(jobs[1]!, jobs[0], undefined, rate)).toBeUndefined(); // no lock entry
    expect(at(1, { ...passed, checks: ['too fast'] })).toBeUndefined(); // a fallback take
    expect(at(1, { ...passed, f0: null })).toEqual({ f0: null, rate: 4.5 }); // the rate alone
  });
});
