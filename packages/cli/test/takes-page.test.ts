/** The takes page (stage 3b-2 plan 4–5): its JS rules in node:vm, and the HTML. */
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { shellQuote } from '../src/picks.js';
import { PAGE_JS, takesPage, type PageData, type PageLine } from '../src/takes-page.js';

interface PageFns {
  shellQuote(s: string): string;
  buildCommands(data: PageData, state: Record<string, number | 'unpick'>): string[];
  restore(
    saved: Record<string, { choice: number | 'unpick'; base: { take: number; by: string } | null }>,
    data: PageData,
  ): { state: Record<string, number | 'unpick'>; saved: Record<string, unknown>; dropped: number };
  keepSound(line: PageLine): { n: number; wav: string; label: string } | null;
  buildReport(
    data: PageData,
    notes: Record<string, { memo?: string; takes?: Record<string, string> }>,
    state: Record<string, number | 'unpick'>,
  ): string;
  contextPlan(
    data: PageData,
    state: Record<string, number | 'unpick'>,
    id: string,
    wav: string,
  ): { wav: string; what: string; gapAfter: number }[];
}

function fns(): PageFns {
  const ctx: Record<string, unknown> = {};
  runInNewContext(
    `${PAGE_JS}\nthis.f = { shellQuote, buildCommands, restore, contextPlan, buildReport, keepSound };`,
    ctx,
  );
  return ctx.f as PageFns;
}

const take = (n: number, wav: string | null = `wav/t${n}.wav`) => ({
  n,
  wav,
  source: 'uncut' as const,
  ok: true,
  f0: 220,
  rate: 5,
});

function line(over: Partial<PageLine> & { id: string }): PageLine {
  const [s, b, i] = over.id.split(':');
  return {
    pickKey: `k-${over.id}`,
    text: '문장',
    para: `${s}:${b}`,
    index: Number(i),
    pauseAfter: 0,
    target: true,
    lockTake: 0,
    lockWav: `wav/${over.id}-lock.wav`,
    lockNote: 'lock: first passing take',
    reselect: false,
    pick: null,
    shared: [],
    takes: [take(0), take(1), take(2)],
    ...over,
  };
}

const data = (lines: PageLine[]): PageData => ({
  script: "/tmp/my video/it's.ko.md",
  scriptArg: shellQuote("/tmp/my video/it's.ko.md"),
  lang: 'ko',
  sentenceGap: 0.3,
  storageKey: 'k',
  build: '1',
  lines,
  notes: [],
});

describe('takes page JS', () => {
  const f = fns();

  it('quotes like picks.ts', () => {
    for (const s of ['/a/b.md', '/tmp/my video/x.md', "it's", '/영상/대본.ko.md'])
      expect(f.shellQuote(s)).toBe(shellQuote(s));
  });

  it('builds one pick and one unpick command from the choices', () => {
    const d = data([
      line({ id: 'one:0:0' }),
      line({ id: 'one:0:1', pick: { take: 2, by: 'human' } }),
      line({ id: 'one:0:2', pick: { take: 1, by: 'human' } }),
    ]);
    expect(f.buildCommands(d, {})).toEqual([]);
    // unpick of a line with no pick: nothing to do
    expect(f.buildCommands(d, { 'k-one:0:0': 'unpick' })).toEqual([]);
    const cmds = f.buildCommands(d, { 'k-one:0:0': 1, 'k-one:0:1': 'unpick', 'k-one:0:2': 1 });
    expect(cmds).toEqual([
      `s2v takes pick '/tmp/my video/it'\\''s.ko.md' one:0:0=1`,
      `s2v takes unpick '/tmp/my video/it'\\''s.ko.md' one:0:1`,
    ]);
  });

  it('pins the lock take when there is no pick, and rewrites a retry pick as a human one', () => {
    const d = data([
      line({ id: 'one:0:0', lockTake: 1 }),
      line({ id: 'one:0:1', pick: { take: 2, by: 'retry' } }),
      line({ id: 'one:0:2', pick: null, reselect: true }),
    ]);
    expect(f.buildCommands(d, { 'k-one:0:0': 1, 'k-one:0:1': 2, 'k-one:0:2': 0 })).toEqual([
      `s2v takes pick ${d.scriptArg} one:0:0=1 one:0:1=2 one:0:2=0`,
    ]);
  });

  it('gives one command per pick key, for its first line', () => {
    const a = line({ id: 'one:0:0', pickKey: 'same' });
    const b = line({ id: 'one:1:0', pickKey: 'same' });
    expect(f.buildCommands(data([a, b]), { same: 2 })).toEqual([
      `s2v takes pick ${data([]).scriptArg} one:0:0=2`,
    ]);
  });

  it('restores saved choices only while picks.json is as they were based', () => {
    const d = data([
      line({ id: 'one:0:0', pick: { take: 2, by: 'human' } }), // applied → dropped quietly
      line({ id: 'one:0:1', pick: { take: 1, by: 'retry' } }), // a choice over a retry pick
      line({ id: 'one:0:2', pick: null }), // unpick applied
      line({ id: 'one:0:3', pick: { take: 0, by: 'human' } }), // moved since → dropped, counted
      line({ id: 'one:0:4', pick: { take: 2, by: 'human' }, lockTake: 0 }), // pending tts
    ]);
    const r = f.restore(
      {
        'k-one:0:0': { choice: 2, base: null },
        'k-one:0:1': { choice: 1, base: { take: 1, by: 'retry' } },
        'k-one:0:2': { choice: 'unpick', base: { take: 1, by: 'human' } },
        'k-one:0:3': { choice: 1, base: { take: 2, by: 'human' } },
        'k-one:0:4': { choice: 0, base: { take: 2, by: 'human' } },
        'other-page': { choice: 3, base: null },
      },
      d,
    );
    expect(r.state).toEqual({ 'k-one:0:1': 1, 'k-one:0:4': 0 });
    expect(r.dropped).toBe(1);
    // keys of lines not on this page are left alone
    expect(Object.keys(r.saved).sort()).toEqual(['k-one:0:1', 'k-one:0:4', 'other-page']);
  });

  it('plays the neighbours inside the paragraph with the render gaps', () => {
    const d = data([
      line({ id: 'one:0:0', pauseAfter: 0.5, target: false, takes: [] }),
      line({ id: 'one:0:1', pauseAfter: 0.2 }),
      line({ id: 'one:0:2', pick: { take: 2, by: 'human' } }),
      line({ id: 'one:1:0' }),
    ]);
    const plan = f.contextPlan(d, {}, 'one:0:1', 'wav/x.wav');
    expect(plan.map((p) => [p.wav, p.gapAfter])).toEqual([
      ['wav/one:0:0-lock.wav', 0.8],
      ['wav/x.wav', 0.5],
      // the next line's pending pick, as the next tts will put it
      ['wav/t2.wav', 0],
    ]);
    // a chosen take of the neighbour; unpick plays its lock
    expect(f.contextPlan(d, { 'k-one:0:2': 1 }, 'one:0:1', 'x')[2]!.wav).toBe('wav/t1.wav');
    expect(f.contextPlan(d, { 'k-one:0:2': 'unpick' }, 'one:0:1', 'x')[2]!.wav).toBe(
      'wav/one:0:2-lock.wav',
    );
    // the last line of a paragraph: no next line, no gap
    expect(f.contextPlan(d, {}, 'one:0:2', 'y').map((p) => [p.wav, p.gapAfter])).toEqual([
      ['wav/one:0:1-lock.wav', 0.5],
      ['y', 0],
    ]);
  });

  it('skips a neighbour with nothing to play', () => {
    const d = data([
      line({ id: 'one:0:0', target: false, lockWav: null, takes: [] }),
      line({ id: 'one:0:1' }),
    ]);
    expect(f.contextPlan(d, {}, 'one:0:1', 'x')).toEqual([
      { wav: 'x', what: 'one:0:1', gapAfter: 0 },
    ]);
  });
});

describe('takes page: what "지금 그대로" plays', () => {
  const f = fns();
  it('plays the pending pick, else the lock', () => {
    expect(f.keepSound(line({ id: 'one:0:0', lockTake: 0 }))).toEqual({
      n: 0,
      wav: 'wav/one:0:0-lock.wav',
      label: '테이크 0 (lock)',
    });
    expect(
      f.keepSound(line({ id: 'one:0:0', lockTake: 0, pick: { take: 2, by: 'human' } })),
    ).toEqual({ n: 2, wav: 'wav/t2.wav', label: '테이크 2 (pick, tts 전)' });
    expect(f.keepSound(line({ id: 'one:0:0', lockTake: 1, reselect: true }))!.label).toBe(
      '테이크 1 (lock) — 다음 tts에서 바뀔 수 있음',
    );
    expect(f.keepSound(line({ id: 'one:0:0', lockWav: null, lockTake: null }))).toBeNull();
  });
});

describe('takes page comments', () => {
  const f = fns();
  it('collects the comments of shown lines with what was chosen', () => {
    const d = data([
      line({ id: 'one:0:0', text: '괜찮아요.', lockTake: 2, pick: { take: 1, by: 'human' } }),
      line({ id: 'one:0:1' }),
      line({ id: 'one:0:2', target: false }),
    ]);
    expect(f.buildReport(d, {}, {})).toBe('');
    expect(f.buildReport(d, { 'one:0:1': { memo: '  ', takes: { 0: '' } } }, {})).toBe('');
    const r = f.buildReport(
      d,
      {
        'one:0:0': { memo: '말끝이\n처짐', takes: { 3: '가장 자연스러움', 0: '숨소리' } },
        'one:0:2': { memo: '보이지 않는 문장' },
      },
      { 'k-one:0:0': 3 },
    );
    expect(r).toBe(
      [
        `테이크 코멘트 — ${d.script}`,
        '',
        'one:0:0 "괜찮아요." — lock 2, pick 1, 고름 3',
        '  - 메모: 말끝이 / 처짐',
        '  - 테이크 0: 숨소리',
        '  - 테이크 3: 가장 자연스러움',
      ].join('\n'),
    );
  });
});

describe('takes page HTML', () => {
  it('keeps any line text inside its JSON', () => {
    const tricky = "끝</script><script>alert(1)</script>   it's <b>";
    const d = data([line({ id: 'one:0:0', text: tricky })]);
    const html = takesPage(d);
    const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)!;
    expect((JSON.parse(m[1]!) as PageData).lines[0]!.text).toBe(tricky);
    expect(html.split('</script>')).toHaveLength(3);
  });
});
