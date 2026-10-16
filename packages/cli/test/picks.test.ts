import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dropStaleWithId,
  pickText,
  readPicks,
  stalePicks,
  writePicks,
  type Pick,
  type PicksFile,
} from '../src/picks.js';

const pick = (over: Partial<Pick> = {}): Pick => ({
  take: 2,
  id: 'one:0:1',
  text: '오늘은 조금 슬픈 이야기를',
  tried: 5,
  by: 'human',
  ...over,
});

describe('picks.json', () => {
  it('reads a missing file as empty, and refuses a broken one or an unknown version', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-picks-'));
    expect(readPicks(dir)).toEqual({ version: 1, picks: {} });
    writeFileSync(join(dir, 'picks.json'), '{ "version": 1, "picks": {');
    expect(() => readPicks(dir)).toThrow(/cannot read/);
    writeFileSync(join(dir, 'picks.json'), JSON.stringify({ version: 2, picks: {} }));
    expect(() => readPicks(dir)).toThrow(/version 2 is not supported/);
    writeFileSync(join(dir, 'picks.json'), JSON.stringify({ version: 1 }));
    expect(() => readPicks(dir)).toThrow(/no "picks"/);
  });

  it('writes keys sorted', () => {
    const dir = mkdtempSync(join(tmpdir(), 's2v-picks-'));
    writePicks(dir, { version: 1, picks: { b: pick(), a: pick({ take: 0 }) } });
    const text = readFileSync(join(dir, 'picks.json'), 'utf8');
    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(readPicks(dir).picks.a!.take).toBe(0);
  });
});

describe('stalePicks', () => {
  const file = (picks: Record<string, Pick>): PicksFile => ({ version: 1, picks });
  const line = (id: string, pickKey: string, text: string) => ({ id, pickKey, text });

  it('warns when the line of a pick changed, with the old and the new text', () => {
    const f = file({ old: pick() });
    const s = stalePicks(
      f,
      [line('one:0:1', 'new', '오늘은 정말 기쁜 이야기를 해 볼게요.')],
      'v.md',
    );
    expect(s).toHaveLength(1);
    expect(s[0]!.message).toMatch(
      /was for "오늘은 조금 슬픈 이야기를…", that line is now "오늘은 정말 기쁜/,
    );
    expect(s[0]!.message).toMatch(/s2v takes v\.md --list --id one:0:1/);
    expect(s[0]!.message).toMatch(/s2v takes unpick v\.md one:0:1/);
  });

  it('says the voice or acting changed when the text is the same', () => {
    const text = '오늘은 조금 슬픈 이야기를 해 볼게요.';
    const f = file({ old: pick({ text: pickText(text) }) });
    const s = stalePicks(f, [line('one:0:1', 'new', text)], 'v.md');
    expect(s[0]!.message).toMatch(/voice or acting of this line changed/);
  });

  it('never counts a pick whose key a line still has, whatever its id says', () => {
    // a line inserted before: the picked line is now one:0:2, a new line took one:0:1
    const f = file({ k: pick() });
    const lines = [line('one:0:1', 'other', '새 문장이에요.'), line('one:0:2', 'k', pick().text)];
    expect(stalePicks(f, lines, 'v.md')).toEqual([]);
    expect(dropStaleWithId(f, lines, 'one:0:1')).toBe(0);
    expect(f.picks.k).toBeDefined();
  });

  it('drops only the stale picks with the id', () => {
    const f = file({ old: pick(), other: pick({ id: 'one:0:3' }), live: pick({ id: 'one:0:1' }) });
    const lines = [line('one:0:1', 'live', '오늘은'), line('one:0:3', 'x', '다른 문장')];
    expect(dropStaleWithId(f, lines, 'one:0:1')).toBe(1);
    expect(Object.keys(f.picks).sort()).toEqual(['live', 'other']);
  });

  it('reports a pick whose id no longer exists', () => {
    const s = stalePicks(
      file({ old: pick({ id: 'two:3:0' }) }),
      [line('one:0:0', 'k', '문장')],
      'v.md',
    );
    expect(s[0]!.message).toMatch(/no longer matches any line — remove it: s2v audio prune v\.md/);
  });
});
