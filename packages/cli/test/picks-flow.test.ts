/**
 * Stage 3b decisions with mock audio: picks in `tts` (plan 2), retry (4), frozen (7), prune (3),
 * `takes pick/unpick` (6) and inspect (8). Mock pick keys never match real ones, so the "pick no
 * longer applies" warning is tested in picks.test.ts and against stub servers.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript } from '@script2video/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { inspectScript } from '../src/inspect.js';
import type { PicksFile } from '../src/picks.js';
import { listTakes, pickTakes, unpickTakes } from '../src/takes.js';
import { buildTakesPage, type PageData } from '../src/takes-page.js';
import { planSentences, pruneAudio, synthesizeScript, type LockManifest } from '../src/tts.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function setup(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 's2v-picks-'));
  mkdirSync(join(dir, 'video'));
  const path = join(dir, 'video', 'script.ko.md');
  const head = `---\nlang: ko\ncast:\n  host: { voice: "qwen:Sohee" }\noutputs:\n  youtube: { aspect: "16:9", layout: presenter }\n---\n\n# 하나 {#one}\n\n`;
  let script = parseScript(head + body).script!;
  writeFileSync(path, `${head}${body}\n`);
  const rewrite = (b: string) => {
    writeFileSync(path, `${head}${b}\n`);
    script = parseScript(head + b).script!;
  };
  const audio = join(dir, 'video', 'audio', 'ko');
  const lock = () => JSON.parse(readFileSync(join(audio, 'manifest.json'), 'utf8')) as LockManifest;
  const picksFile = join(audio, 'picks.json');
  const picks = () =>
    existsSync(picksFile) ? (JSON.parse(readFileSync(picksFile, 'utf8')) as PicksFile).picks : {};
  const run = async (extra: { retry?: string[]; recheck?: boolean; frozen?: boolean } = {}) => {
    const logs: string[] = [];
    const r = await synthesizeScript(path, script, REPO, {
      asr: false,
      log: (m) => logs.push(m),
      ...extra,
    });
    return { ...r, logs };
  };
  const jobs = () => planSentences(path, script, REPO, { draft: false, mock: true }).jobs;
  const entry = (id: string) => {
    const l = lock();
    return l.entries[l.sentences[id]!]!;
  };
  const pick = (...args: string[]) => pickTakes(path, script, REPO, args);
  const unpick = (...ids: string[]) => unpickTakes(path, script, REPO, ids);
  const list = (...ids: string[]) => listTakes(path, script, REPO, ids);
  return {
    dir,
    path,
    run,
    lock,
    picks,
    picksFile,
    jobs,
    entry,
    pick,
    unpick,
    list,
    rewrite,
    script: () => script,
  };
}

const SAD = 'host{emo=sad}: 오늘은 조금 슬픈 이야기를 해 볼게요.';

describe('stage 3b picks (mock)', () => {
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

  it('commits the picked take, keeps it, and merges the take records', async () => {
    const t = setup(SAD);
    await t.run();
    const auto = t.entry('one:0:0');
    const other = [0, 1, 2].find((n) => n !== auto.attempt)!;
    expect(t.pick(`one:0:0=${other}`).join('\n')).toMatch(/run s2v tts .* to apply/);
    expect(t.picks()[t.jobs()[0]!.pickKey]).toMatchObject({
      take: other,
      by: 'human',
      id: 'one:0:0',
    });

    const r = await t.run();
    expect(r.synthesized).toBe(1);
    const e = t.entry('one:0:0');
    expect(e).toMatchObject({ attempt: other, select: { pick: other, by: 'human' }, tried: 2 });
    // the budget's records stay next to the picked take
    expect(Object.keys(e.takes!).sort()).toEqual(['0', '1', '2']);

    const again = await t.run();
    expect(again).toMatchObject({ synthesized: 0, reused: 1 });
  });

  it('follows a pick that fails its checks, with one warning', async () => {
    const t = setup(SAD);
    await t.run();
    process.env.S2V_TTS_MOCK_FAIL = `${t.jobs()[0]!.synthKey.slice(0, 8)}:4`;
    // take 4 was never made: refused
    expect(() => t.pick('one:0:0=4')).toThrow(/take 4 was never made/);
    await t.run({ retry: ['one:0:0'] });
    const out = t.pick('one:0:0=4').join('\n');
    expect(out).toMatch(/take 4 failed its checks — picked anyway/);
    const r = await t.run();
    const w = r.warnings.filter((x) => x.startsWith('one:0:0'));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/picked take 4 fails: .*mock failure/);
    expect(t.entry('one:0:0').checks!.length).toBeGreaterThan(0);
    // and on every later run, like any kept failure
    const later = await t.run();
    expect(later.warnings.join('\n')).toMatch(/picked take 4 fails/);
  });

  it('chooses again after unpick, and after picks.json is reverted', async () => {
    const t = setup(SAD);
    await t.run();
    const auto = t.entry('one:0:0').attempt;
    const other = [0, 1, 2].find((n) => n !== auto)!;
    t.pick(`one:0:0=${other}`);
    await t.run();
    expect(t.unpick('one:0:0')).toContain('one:0:0: unpicked');
    expect(t.unpick('one:0:0')).toEqual(['one:0:0: no pick']);
    const r = await t.run();
    expect(r.logs.join('\n')).toMatch(/no longer picked → choosing again/);
    expect(t.entry('one:0:0')).toMatchObject({ attempt: auto, select: { retry: false } });

    t.pick(`one:0:0=${other}`);
    await t.run();
    rmSync(t.picksFile); // git checkout of an older picks.json
    await t.run();
    expect(t.entry('one:0:0').attempt).toBe(auto);
  });

  it('keeps a pick over a speed change and when a line is inserted before it', async () => {
    const t = setup(SAD);
    await t.run();
    const other = [0, 1, 2].find((n) => n !== t.entry('one:0:0').attempt)!;
    t.pick(`one:0:0=${other}`);
    await t.run();
    t.rewrite('host{emo=sad speed=1.1}: 오늘은 조금 슬픈 이야기를 해 볼게요.');
    await t.run();
    expect(t.entry('one:0:0')).toMatchObject({ attempt: other, select: { pick: other } });
    t.rewrite(
      'host{emo=sad speed=1.1}: 새 문장을 먼저 말해요. 오늘은 조금 슬픈 이야기를 해 볼게요.',
    );
    const r = await t.run();
    expect(t.entry('one:0:1')).toMatchObject({ attempt: other, select: { pick: other } });
    // the pick names its line again
    expect(Object.values(t.picks())[0]!.id).toBe('one:0:1');
    expect(r.warnings.join('\n')).not.toMatch(/pick/);
  });

  it('applies one pick to lines sharing a pick key, and refuses two takes for them', async () => {
    const t = setup(`${SAD}\n\nhost{emo=sad speed=1.1}: 오늘은 조금 슬픈 이야기를 해 볼게요.`);
    await t.run();
    const [a, b] = t.jobs();
    expect(a!.pickKey).toBe(b!.pickKey);
    expect(() => t.pick('one:0:0=1', 'one:1:0=2')).toThrow(/same line and voice/);
    t.pick('one:1:0=1');
    // the first line names the pick
    expect(Object.values(t.picks())[0]!.id).toBe('one:0:0');
    await t.run();
    expect(t.entry('one:0:0').attempt).toBe(1);
    expect(t.entry('one:1:0').attempt).toBe(1);
  });

  it('re-applies a retry pick to an earlier line with the same pick key', async () => {
    const t = setup(`${SAD}\n\nhost{emo=sad speed=1.1}: 오늘은 조금 슬픈 이야기를 해 볼게요.`);
    await t.run();
    const r = await t.run({ retry: ['one:1:0'] });
    const take = t.entry('one:1:0').attempt;
    expect(take).toBeGreaterThanOrEqual(3);
    expect(t.entry('one:0:0')).toMatchObject({
      attempt: take,
      select: { pick: take, by: 'retry' },
    });
    expect(r.synthesized).toBe(2);
  });

  it('a prefix retry leaves human picks alone, a named sentence replaces them', async () => {
    const t = setup(`${SAD}\n\nhost{emo=happy}: 와, 정말 잘됐네요!`);
    await t.run();
    t.pick('one:0:0=1');
    await t.run();
    const r = await t.run({ retry: ['one'] });
    expect(r.logs.join('\n')).toMatch(/one:0:0: your pick \(take 1\) is kept/);
    expect(t.entry('one:0:0').attempt).toBe(1);
    expect(t.entry('one:1:0').select).toMatchObject({ by: 'retry' });
    // naming the sentence replaces the human pick
    await t.run({ retry: ['one:0:0'] });
    expect(t.entry('one:0:0').select).toMatchObject({ by: 'retry' });
    expect(t.picks()[t.jobs()[0]!.pickKey]!.by).toBe('retry');
  });

  it('follows the pick when a retry passes nothing, and starts after the pick', async () => {
    const t = setup(SAD);
    await t.run();
    const auto = t.entry('one:0:0').attempt;
    const other = [0, 1, 2].find((n) => n !== auto)!;
    t.pick(`one:0:0=${other}`);
    // the lock still holds the automatic take; the retry passes nothing
    process.env.S2V_TTS_MOCK_FAIL = `${t.jobs()[0]!.synthKey.slice(0, 8)}:3,4,5`;
    const r = await t.run({ retry: ['one:0:0'] });
    expect(r.warnings.join('\n')).toMatch(/kept your pick/);
    expect(t.entry('one:0:0')).toMatchObject({ attempt: other, tried: 5 });
    expect(t.picks()[t.jobs()[0]!.pickKey]!.tried).toBe(5);

    // another machine: no lock, only the pick — the retry starts after pick.tried
    rmSync(join(t.dir, 'video', 'audio', 'ko', 'manifest.json'));
    delete process.env.S2V_TTS_MOCK_FAIL;
    const r2 = await t.run({ retry: ['one:0:0'] });
    expect(r2.logs.join('\n')).toMatch(/new takes from 6/);
  });

  it('turns a 3a retry choice into a pick once', async () => {
    const t = setup(SAD);
    await t.run();
    // a lock made by 3a: the retry's choice lives only in select.retry
    const m = t.lock();
    const key = m.sentences['one:0:0']!;
    m.entries[key]!.select = { n: 3, rank: 0, neighbor: false, retry: true };
    m.entries[key]!.attempt = 1;
    writeFileSync(join(t.dir, 'video', 'audio', 'ko', 'manifest.json'), JSON.stringify(m));
    const r = await t.run();
    expect(r.logs.join('\n')).toMatch(/--retry \(take 1\) is now a pick/);
    expect(t.picks()[t.jobs()[0]!.pickKey]).toMatchObject({ take: 1, by: 'retry' });
    expect(t.entry('one:0:0').select).toEqual({ pick: 1, by: 'retry' });
    // unpick: chosen again, not moved back
    t.unpick('one:0:0');
    const again = await t.run();
    expect(again.logs.join('\n')).not.toMatch(/is now a pick/);
    expect(t.picks()).toEqual({});
  });

  it('frozen audio fails on picks the lock does not hold, and writes nothing', async () => {
    const t = setup(SAD);
    await t.run();
    const other = [0, 1, 2].find((n) => n !== t.entry('one:0:0').attempt)!;
    t.pick(`one:0:0=${other}`);
    await expect(t.run({ frozen: true })).rejects.toThrow(
      /picked take \d is not in the audio lock/,
    );
    await t.run();
    rmSync(t.picksFile);
    await expect(t.run({ frozen: true })).rejects.toThrow(/was picked but the pick is gone/);
    expect(existsSync(t.picksFile)).toBe(false);
  });

  it('a draft neither reads nor writes picks', async () => {
    const t = setup(SAD);
    await t.run();
    mkdirSync(dirname(t.picksFile), { recursive: true });
    writeFileSync(t.picksFile, '{ broken');
    await expect(t.run()).rejects.toThrow(/cannot read/);
    const logs: string[] = [];
    await synthesizeScript(t.path, t.script(), REPO, {
      asr: false,
      draft: true,
      log: (m) => logs.push(m),
    });
    expect(readFileSync(t.picksFile, 'utf8')).toBe('{ broken');
  });

  it('prune keeps picks of the script (mock keys too) and drops the rest', async () => {
    const t = setup(SAD);
    await t.run();
    t.pick('one:0:0=1');
    const f = JSON.parse(readFileSync(t.picksFile, 'utf8')) as PicksFile;
    f.picks.gone = { take: 0, id: 'one:9:0', text: '없는 문장', tried: 0, by: 'human' };
    writeFileSync(t.picksFile, JSON.stringify(f));
    const r = pruneAudio(t.path, t.script(), 'ko', REPO);
    expect(r.picks).toMatch(/removed 1 pick/);
    expect(Object.keys(t.picks())).toEqual([t.jobs()[0]!.pickKey]);
  });

  it('prune keeps every pick when a paragraph cannot be planned', async () => {
    const t = setup(SAD);
    await t.run();
    t.pick('one:0:0=1');
    t.rewrite(`${SAD}\n\nhost: :audio{src="missing.wav"}녹음한 문장이에요.`);
    const r = pruneAudio(t.path, t.script(), 'ko', REPO);
    expect(r.picks).toMatch(/picks kept: 1 paragraph/);
    expect(Object.keys(t.picks())).toHaveLength(1);
  });

  it('refuses ids that are not one synthesized sentence, and a broken picks.json', async () => {
    const t = setup(SAD);
    await t.run();
    expect(() => t.pick('one:0=1')).toThrow(/scene:paragraph:sentence/);
    expect(() => t.pick('one:5:0=1')).toThrow(/no such sentence/);
    expect(() => t.pick('one:0:0')).toThrow(/write <id>=<take>/);
    writeFileSync(t.picksFile, JSON.stringify({ version: 9, picks: {} }));
    expect(() => t.pick('one:0:0=1')).toThrow(/version 9/);
  });

  it('lists the takes with the lock and the pick', async () => {
    const t = setup(SAD);
    await t.run();
    t.pick('one:0:0=2');
    const out = t.list('one').join('\n');
    expect(out).toMatch(
      /^one:0:0 "오늘은 조금 슬픈 이야기를 해 볼게요…" · emo=sad · lock: take \d · pick: take 2 \(human\)/,
    );
    expect(out).toMatch(/take 2 \[(lock,)?pick\]/);
    expect(t.list('two')).toEqual(['no lines match']);
  });

  it('inspect leaves the audio hash out while a pick is not applied', async () => {
    const t = setup(SAD);
    await t.run();
    const before = inspectScript(t.path, REPO, 1);
    expect('result' in before && before.result.hashes.audio).toBeTruthy();
    const other = [0, 1, 2].find((n) => n !== t.entry('one:0:0').attempt)!;
    t.pick(`one:0:0=${other}`);
    const pending = inspectScript(t.path, REPO, 1);
    expect('result' in pending && pending.result.hashes.audio).toBeNull();
    expect('result' in pending && pending.result.reasons.audio![0]).toMatch(
      /1 picked take\(s\) not applied/,
    );
    await t.run();
    const after = inspectScript(t.path, REPO, 1);
    expect('result' in after && after.result.hashes.audio).toBeTruthy();
  });

  it('retries lines sharing a pick key once', async () => {
    const t = setup(`${SAD}\n\nhost{emo=sad speed=1.1}: 오늘은 조금 슬픈 이야기를 해 볼게요.`);
    await t.run();
    const r = await t.run({ retry: ['one'] });
    expect(r.logs.filter((l) => /retry requested/.test(l))).toHaveLength(1);
    expect(t.entry('one:1:0').attempt).toBe(t.entry('one:0:0').attempt);
    expect(t.entry('one:0:0').attempt).toBeGreaterThanOrEqual(3);
  });

  it('moves one 3a retry choice per pick key, and none after unpick', async () => {
    const t = setup(SAD);
    await t.run();
    const m = t.lock();
    const key = m.sentences['one:0:0']!;
    const e = m.entries[key]!;
    e.select = { n: 3, rank: 0, neighbor: false, retry: true };
    e.attempt = 1;
    // the same line retried at another speed: another lock key, the same pick key
    m.entries.otherspeed = { ...e, attempt: 0, tried: 7, select: { ...e.select, retry: true } };
    writeFileSync(join(t.dir, 'video', 'audio', 'ko', 'manifest.json'), JSON.stringify(m));
    await t.run();
    // the current key's choice wins
    expect(t.picks()[t.jobs()[0]!.pickKey]).toMatchObject({ take: 1 });
    t.unpick('one:0:0');
    const again = await t.run();
    expect(again.logs.join('\n')).not.toMatch(/is now a pick/);
    expect(t.picks()).toEqual({});
  });

  it('frozen audio lets a 3a retry choice through and moves nothing', async () => {
    const t = setup(SAD);
    await t.run();
    const m = t.lock();
    m.entries[m.sentences['one:0:0']!]!.select = { n: 3, rank: 0, neighbor: false, retry: true };
    writeFileSync(join(t.dir, 'video', 'audio', 'ko', 'manifest.json'), JSON.stringify(m));
    await t.run({ frozen: true });
    expect(existsSync(t.picksFile)).toBe(false);
    expect(t.entry('one:0:0').select).toMatchObject({ retry: true });
  });

  it('follows the pick when a retry passes nothing and the lock has no entry', async () => {
    const t = setup(SAD);
    await t.run();
    t.pick('one:0:0=1');
    rmSync(join(t.dir, 'video', 'audio', 'ko', 'manifest.json'));
    process.env.S2V_TTS_MOCK_FAIL = `${t.jobs()[0]!.synthKey.slice(0, 8)}:3,4,5`;
    const r = await t.run({ retry: ['one:0:0'] });
    expect(r.logs.join('\n')).toMatch(/new takes from 3/);
    expect(t.entry('one:0:0')).toMatchObject({ attempt: 1, select: { pick: 1, by: 'human' } });
  });

  it('gives a 2a entry its keys when its take is picked', async () => {
    const t = setup(SAD);
    await t.run();
    const m = t.lock();
    const e = m.entries[m.sentences['one:0:0']!]!;
    delete e.synthKey;
    delete e.pickKey;
    writeFileSync(join(t.dir, 'video', 'audio', 'ko', 'manifest.json'), JSON.stringify(m));
    t.pick(`one:0:0=${e.attempt}`);
    const r = await t.run();
    expect(r.synthesized).toBe(0);
    expect(t.entry('one:0:0')).toMatchObject({
      pickKey: t.jobs()[0]!.pickKey,
      select: { pick: e.attempt, by: 'human' },
    });
  });

  it('mock runs leave real picks alone, and prune keeps them', async () => {
    const t = setup(SAD);
    await t.run();
    const real = planSentences(t.path, t.script(), REPO, { draft: false, mock: false }).jobs[0]!;
    writeFileSync(
      t.picksFile,
      JSON.stringify({
        version: 1,
        picks: { [real.pickKey]: { take: 2, id: 'one:0:0', text: 'x', tried: 2, by: 'human' } },
      }),
    );
    const r = await t.run();
    expect(r.warnings.join('\n')).not.toMatch(/pick/);
    expect(pruneAudio(t.path, t.script(), 'ko', REPO).picks).toMatch(/removed 0 pick/);
    expect(Object.keys(t.picks())).toEqual([real.pickKey]);
  });

  it('prune and inspect do not stop on a broken picks.json', async () => {
    const t = setup(SAD);
    await t.run();
    writeFileSync(t.picksFile, '{ broken');
    expect(pruneAudio(t.path, t.script(), 'ko', REPO).picks).toMatch(/picks kept: .*cannot read/);
    expect(readFileSync(t.picksFile, 'utf8')).toBe('{ broken');
    const r = inspectScript(t.path, REPO, 1);
    expect('result' in r && r.result.hashes.audio).toBeNull();
    expect('result' in r && r.result.reasons.audio![0]).toMatch(/cannot read/);
  });

  it('refuses recorded paragraphs and paragraphs that cannot be planned', async () => {
    const t = setup(
      `${SAD}\n\nhost: :audio{src=r.wav}녹음한 문장이에요.\n\nhost: :audio{src=missing.wav}없는 녹음이에요.`,
    );
    writeFileSync(join(t.dir, 'video', 'r.wav'), 'x');
    expect(() => t.pick('one:1:0=0')).toThrow(/recorded paragraph has no takes/);
    expect(() => t.pick('one:2:0=0')).toThrow(/recording not found/);
  });

  it('a pick made before the first 3b run also retires the 3a retry choices', async () => {
    const t = setup(SAD);
    await t.run();
    const m = t.lock();
    const e = m.entries[m.sentences['one:0:0']!]!;
    e.select = { n: 3, rank: 0, neighbor: false, retry: true };
    m.entries.otherspeed = { ...e, attempt: 2, select: { ...e.select, retry: true } };
    writeFileSync(join(t.dir, 'video', 'audio', 'ko', 'manifest.json'), JSON.stringify(m));
    t.pick('one:0:0=0');
    await t.run();
    expect(t.lock().entries.otherspeed!.select).toMatchObject({ retry: false });
    t.unpick('one:0:0');
    const again = await t.run();
    expect(again.logs.join('\n')).not.toMatch(/is now a pick/);
    expect(t.picks()).toEqual({});
  });

  it('a failed retry after unpick chooses again, so frozen audio passes', async () => {
    const t = setup(SAD);
    await t.run();
    await t.run({ retry: ['one:0:0'] });
    t.unpick('one:0:0');
    process.env.S2V_TTS_MOCK_FAIL = `${t.jobs()[0]!.synthKey.slice(0, 8)}:6,7,8`;
    await t.run({ retry: ['one:0:0'] });
    expect(t.entry('one:0:0').select).toMatchObject({ retry: false });
    await t.run({ frozen: true });
  });

  it('a line before the retried one waits for the retry instead of committing the old pick', async () => {
    const t = setup(`${SAD}\n\nhost{emo=sad speed=1.1}: 오늘은 조금 슬픈 이야기를 해 볼게요.`);
    await t.run();
    process.env.S2V_TTS_MOCK_FAIL = `${t.jobs()[0]!.synthKey.slice(0, 8)}:0`;
    t.pick('one:0:0=0');
    const r = await t.run({ retry: ['one:1:0'] });
    expect(r.warnings.join('\n')).not.toMatch(/picked take 0 fails/);
    const take = t.entry('one:1:0').attempt;
    expect(t.entry('one:0:0').attempt).toBe(take);
    expect(take).toBeGreaterThanOrEqual(3);
  });

  it('does not turn an orphaned 3a retry entry into a pick', async () => {
    const t = setup(SAD);
    await t.run();
    const m = t.lock();
    const e = m.entries[m.sentences['one:0:0']!]!;
    m.entries.orphan = {
      ...e,
      attempt: 2,
      select: { n: 3, rank: 0, neighbor: false, retry: true },
    };
    writeFileSync(join(t.dir, 'video', 'audio', 'ko', 'manifest.json'), JSON.stringify(m));
    await t.run();
    expect(t.picks()).toEqual({});
    expect(t.lock().entries.orphan!.select).toMatchObject({ retry: false });
  });

  it('the page shows emotion lines and picked lines, or all, or the ids asked', async () => {
    const t = setup(`${SAD}\n\nhost: 평범한 첫 문장이에요. 평범한 둘째 문장이에요.`);
    await t.run();
    t.pick('one:1:1=0');
    // the page goes to <repo>/out: a temporary repo root
    copyFileSync(join(REPO, 'models.lock.json'), join(t.dir, 'models.lock.json'));
    const shown = async (all: boolean, ids: string[]) => {
      const r = await buildTakesPage(t.path, t.script(), t.dir, { all, ids, log: () => {} });
      const html = readFileSync(r.html, 'utf8');
      const data = JSON.parse(
        /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)![1]!,
      ) as PageData;
      return { data, notes: r.notes };
    };
    const def = await shown(false, []);
    expect(def.data.lines.filter((l) => l.target).map((l) => l.id)).toEqual(['one:0:0', 'one:1:1']);
    // the line before a shown one is carried for the context playback
    expect(def.data.lines.filter((l) => !l.target).map((l) => l.id)).toEqual(['one:1:0']);
    expect(def.notes.join('\n')).toMatch(/S2V_TTS=mock/);
    // mock: no take cache, the lock take only
    expect(def.data.lines[0]!.takes.map((x) => [x.n, x.source])).toEqual([
      [def.data.lines[0]!.lockTake, 'lock'],
    ]);
    expect((await shown(true, [])).data.lines.filter((l) => l.target)).toHaveLength(3);
    expect(
      (await shown(false, ['one:1:0'])).data.lines.filter((l) => l.target).map((l) => l.id),
    ).toEqual(['one:1:0']);
  });
});
