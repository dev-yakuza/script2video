import { describe, expect, it } from 'vitest';
import {
  endsWithQuestion,
  selectTake,
  takeBudgetDone,
  takeStrength,
  type TakeContext,
  type TakeFacts,
} from '../src/index.js';

const take = (n: number, over: Partial<TakeFacts> = {}): TakeFacts => ({
  n,
  ok: true,
  f0: 220,
  rawDuration: 2,
  rawEnding: 0,
  rate: 5,
  ...over,
});
const ctx = (over: Partial<TakeContext> = {}): TakeContext => ({
  question: false,
  refF0: 220,
  expected: 2,
  ...over,
});
// strengths 0, 1, 2, 3 semitones/2 away from the reference
const ladder = [0, 2, 4, 6].map((st, i) => take(i, { f0: 220 * 2 ** (st / 12) }));

describe('takes: budget', () => {
  it('stops at two passing takes', () => {
    expect(
      takeBudgetDone([take(0), take(1, { ok: false }), take(2)], ctx({ emotion: 'sad' })),
    ).toBe(true);
    expect(takeBudgetDone([take(0), take(1, { ok: false }), take(2, { ok: false })], ctx())).toBe(
      false,
    );
  });

  it('needs a passing take on the ending floor for an ENDING_LIFT emotion (two with power)', () => {
    const low = { rawEnding: -9 };
    const c = ctx({ emotion: 'happy' });
    expect(takeBudgetDone([take(0, low), take(1, low)], c)).toBe(false);
    expect(takeBudgetDone([take(0, low), take(1)], c)).toBe(true);
    expect(
      takeBudgetDone([take(0, low), take(1)], ctx({ emotion: 'happy', power: 'strong' })),
    ).toBe(false);
    // an unmeasurable ending does not reach the floor
    expect(takeBudgetDone([take(0, { rawEnding: null }), take(1, { rawEnding: null })], c)).toBe(
      false,
    );
    // a user emotion has no ending rule
    expect(takeBudgetDone([take(0, low), take(1, low)], ctx())).toBe(true);
  });

  it('reads the question cell of the ending floor', () => {
    expect(endsWithQuestion('진짜요?')).toBe(true);
    expect(endsWithQuestion('“진짜요？”')).toBe(true);
    expect(endsWithQuestion('진짜요.')).toBe(false);
    // angry: question floor −3.6, other −5.6
    const t = [take(0, { rawEnding: -4.5 }), take(1, { rawEnding: -4.5 })];
    expect(takeBudgetDone(t, ctx({ emotion: 'angry' }))).toBe(true);
    expect(takeBudgetDone(t, ctx({ emotion: 'angry', question: true }))).toBe(false);
  });
});

describe('takes: selection', () => {
  it('ranks by strength: weak, strong, middle, and LOW_AROUSAL takes the weakest', () => {
    expect(selectTake(ladder, ctx({ emotion: 'happy', power: 'weak' }))!.take.n).toBe(0);
    expect(selectTake(ladder, ctx({ emotion: 'happy', power: 'strong' }))!.take.n).toBe(3);
    expect(selectTake(ladder, ctx({ emotion: 'happy' }))!.take.n).toBe(2);
    expect(selectTake(ladder, ctx({ emotion: 'calm' }))!.take.n).toBe(0);
    expect(selectTake(ladder, ctx())!.take.n).toBe(2);
  });

  it('keeps passing takes only, and returns null when none passes', () => {
    const t = ladder.map((x) => ({ ...x, ok: x.n !== 3 }));
    expect(selectTake(t, ctx({ emotion: 'happy', power: 'strong' }))!.take.n).toBe(2);
    expect(
      selectTake(
        ladder.map((x) => ({ ...x, ok: false })),
        ctx(),
      ),
    ).toBeNull();
  });

  it('narrows to takes on the ending floor for an ENDING_LIFT emotion when there are any', () => {
    const t = ladder.map((x) => ({ ...x, rawEnding: x.n === 1 ? 0 : -9 }));
    expect(selectTake(t, ctx({ emotion: 'happy' }))!.take.n).toBe(1);
    const none = ladder.map((x) => ({ ...x, rawEnding: -9 }));
    expect(selectTake(none, ctx({ emotion: 'happy' }))!.n).toBe(4);
  });

  it('counts length away from the expected, capped', () => {
    expect(takeStrength(take(0, { rawDuration: 2 }), ctx())).toBe(0);
    expect(takeStrength(take(0, { rawDuration: 4 }), ctx())).toBeCloseTo(3);
    expect(takeStrength(take(0, { rawDuration: 1 }), ctx())).toBeCloseTo(3);
    // without a voice reference every take is as strong (ranked by number)
    expect(takeStrength(ladder[3]!, ctx({ refF0: null, expected: null }))).toBe(0);
  });

  it('matches the previous sentence within one rank of the target', () => {
    const prev = { f0: 220 * 2 ** (6 / 12), rate: 5 };
    const s = selectTake(ladder, ctx({ emotion: 'happy' }), prev)!;
    expect(s).toMatchObject({ rank: 2, chosenRank: 3, neighbor: true });
    // two ranks away is out of reach
    const far = selectTake(ladder, ctx({ emotion: 'calm' }), prev)!;
    expect(far).toMatchObject({ rank: 0, chosenRank: 1 });
    // equal distance keeps the target rank
    const same = selectTake([take(0), take(1)], ctx(), { f0: 220, rate: 5 })!;
    expect(same).toMatchObject({ rank: 1, chosenRank: 1, neighbor: false });
    // no f0 on either side: the rate decides
    const rates = [take(0, { f0: null, rate: 4 }), take(1, { f0: null, rate: 6 })];
    expect(selectTake(rates, ctx(), { f0: 220, rate: 4.1 })!.take.n).toBe(0);
    // the target (rank 1) has no f0: the rate decides for all
    // (with pitch for take 0 alone, take 1 would win at 1.9 against 3 + 0.1)
    const mixed = [take(0, { f0: 220, rate: 4 }), take(1, { f0: null, rate: 6 })];
    expect(selectTake(mixed, ctx(), { f0: 220 * 2 ** (3 / 12), rate: 4.1 })!.take.n).toBe(0);
    expect(selectTake(mixed, ctx(), { f0: 220, rate: 5.9 })!.take.n).toBe(1);
    // a neighbor without f0 does not compete with a target that has one
    const unvoiced = [take(0, { f0: null, rate: 4 }), take(1, { f0: 220, rate: 6 })];
    expect(selectTake(unvoiced, ctx(), { f0: 220, rate: 4.1 })).toMatchObject({
      chosenRank: 1,
      neighbor: false,
    });
  });
});
