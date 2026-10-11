import { describe, expect, it } from 'vitest';
import { compressPauses, silentRuns } from '../src/pauses.js';

const RATE = 1000; // 1 sample per ms keeps the arithmetic readable

function signal(parts: [kind: 'tone' | 'quiet', ms: number][]): Int16Array {
  const out: number[] = [];
  for (const [kind, ms] of parts)
    for (let i = 0; i < ms; i++) out.push(kind === 'tone' ? (i % 2 ? 8000 : -8000) : 0);
  return Int16Array.from(out);
}

describe('compressPauses', () => {
  it('shortens only internal pauses longer than maxPause, to exactly maxPause', () => {
    const s = signal([
      ['quiet', 100],
      ['tone', 300],
      ['quiet', 1120],
      ['tone', 300],
      ['quiet', 200],
      ['tone', 300],
      ['quiet', 80],
    ]);
    const { out, removed } = compressPauses(s, RATE, 0.35);
    expect(removed).toBeCloseTo(0.77, 2);
    const runs = silentRuns(out, RATE).map(([a, b]) => b - a);
    // leading 100 and trailing 80 untouched, the 1120 ms pause becomes 350 ms, the 200 ms pause stays
    expect(runs).toEqual([100, 350, 200, 80]);
  });

  it('returns the input unchanged when no pause is too long', () => {
    const s = signal([
      ['tone', 200],
      ['quiet', 300],
      ['tone', 200],
    ]);
    expect(compressPauses(s, RATE, 0.35)).toEqual({ out: s, removed: 0 });
  });
});
