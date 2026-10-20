/**
 * `character missing --apply` under the work locks (final review 16): judged again after locking,
 * more characters locked while the judgment finds them, the last judgment applied, a busy one
 * stopping it before any write.
 */
import { describe, expect, it } from 'vitest';
import { applyMissingFlow, type MissingReport } from '../src/character-gen/missing.js';

const report = (cast: string, need: boolean): MissingReport =>
  ({
    cast,
    dir: `/c/${cast}`,
    written: cast,
    checked: true,
    reason: null,
    message: null,
    managed: true,
    undefined: [],
    notInSet: need ? [{ framing: 'full', face: `${cast}-face` }] : [],
    notReady: [],
    impossible: [],
    emotional: [],
  }) as unknown as MissingReport;

function judge(...rounds: MissingReport[][]) {
  let n = 0;
  return {
    find: () => rounds[Math.min(n++, rounds.length - 1)]!,
    calls: () => n,
  };
}

describe('applyMissingFlow', () => {
  it('locks only what needs additions, judges again, and applies the last judgment', () => {
    // 1st: a needs; 2nd (a locked): b needs too; 3rd (b locked): a needs nothing any more
    const j = judge(
      [report('a', true), report('b', false), report('c', false)],
      [report('a', true), report('b', true), report('c', false)],
      [report('a', false), report('b', true), report('c', false)],
    );
    const locks: string[][] = [];
    const applied: string[] = [];
    const { added } = applyMissingFlow(
      j.find,
      (dirs) => locks.push(dirs),
      (r) => {
        applied.push(`${r.cast}:${r.notInSet.length}`);
        return [];
      },
    );
    expect(locks).toEqual([['/c/a'], ['/c/b']]);
    expect(j.calls()).toBe(3);
    // the third judgment: a has nothing to add, b has one; c was never locked or written
    expect(applied).toEqual(['a:0', 'b:1']);
    expect([...added.keys()]).toEqual(['a', 'b']);
  });

  it('a busy character found on the second judgment: nothing is written', () => {
    const j = judge([report('a', true)], [report('a', true), report('b', true)]);
    let applied = 0;
    expect(() =>
      applyMissingFlow(
        j.find,
        (dirs) => {
          if (dirs.includes('/c/b'))
            throw Object.assign(new Error('actor busy: b'), { exitCode: 74 });
        },
        () => {
          applied++;
          return [];
        },
      ),
    ).toThrow(/actor busy/);
    expect(applied).toBe(0);
  });
});
