/** Idle motion (acting stage 5a plan 4–6): blinks, listener nods, breathing — pure functions. */
import { describe, expect, it } from 'vitest';
import {
  BLINK_FRAMES,
  blinkFrames,
  breath,
  drawnFace,
  drawnFaceChanges,
  FACE_HOLD,
  faceAt,
  IDLE,
  listenerNods,
  type StageSwitch,
} from '../src/shared.js';

const FPS = 30;
type A = {
  sentenceId: string;
  cast: string;
  face: string;
  startFrame: number;
  durationFrames: number;
  contentKey?: string;
  ordinal?: number;
  question?: boolean;
};

/** Lines alternating a/b, `len` frames each with `gap` between, distinct texts. */
function dialogue(
  n: number,
  len: number,
  gap: number,
  over: (i: number) => Partial<A> = () => ({}),
) {
  return Array.from({ length: n }, (_, i): A => ({
    sentenceId: `s:${i}:0`,
    cast: i % 2 ? 'b' : 'a',
    face: 'neutral',
    startFrame: i * (len + gap),
    durationFrames: len,
    contentKey: `k${i}`,
    ordinal: 0,
    ...over(i),
  }));
}

/** Mouth of `cast`: open on even frames inside its lines in runs of `run` (a talking pattern). */
function mouthOf(audio: A[], cast: string, dur: number, run = 2): Uint8Array {
  const m = new Uint8Array(dur);
  for (const a of audio)
    if (a.cast === cast)
      for (let i = 0; i < a.durationFrames; i++)
        m[a.startFrame + i] = Math.floor(i / run) % 2 ? 0 : 2;
  return m;
}

const blinksOf = (audio: A[], dur: number, over: Partial<Parameters<typeof blinkFrames>[0]> = {}) =>
  blinkFrames({
    cast: 'a',
    sceneId: 'one',
    output: 'youtube',
    fps: FPS,
    durationFrames: dur,
    audio,
    mouth: mouthOf(audio, 'a', dur),
    faceChanges: [],
    ...over,
  });

describe('blinkFrames', () => {
  const audio = dialogue(80, 45, 15); // 1.5 s lines, 0.5 s gaps: 2 s segments
  const dur = 80 * 60;
  const mouth = mouthOf(audio, 'a', dur);
  const blinks = blinksOf(audio, dur);

  it('is deterministic', () => {
    expect(blinksOf(audio, dur)).toEqual(blinks);
  });

  it('never shows closed eyes on an open mouth, nor past the scene end', () => {
    for (const b of blinks) {
      expect(b + BLINK_FRAMES).toBeLessThanOrEqual(dur);
      for (let i = b; i < b + BLINK_FRAMES; i++) expect(mouth[i]).toBe(0);
    }
  });

  it('spaces clock blinks 2 s or more, and longer than 6 s only when nothing could be placed', () => {
    // No doubles or face changes here would be closer than 2 s, except doubles (end + 3 frames).
    const clock = blinks.filter((b, i) => i === 0 || b - blinks[i - 1]! > BLINK_FRAMES + 3);
    for (let i = 1; i < clock.length; i++) {
      const gap = clock[i]! - clock[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(2 * FPS);
      if (gap > 6 * FPS)
        for (let f = clock[i - 1]! + 6 * FPS; f < clock[i]!; f++) {
          const free = [0, 1, 2, 3].every((k) => mouth[f + k] === 0);
          expect(free).toBe(false);
        }
    }
    expect(clock.length).toBeGreaterThan(dur / FPS / 6);
  });

  it('keeps blinking through a scene of short lines (no long blink-free stretch)', () => {
    const quick = dialogue(200, 20, 10); // 1 s segments
    const d = 200 * 30;
    const m = mouthOf(quick, 'a', d);
    const b = blinksOf(quick, d);
    for (let i = 1; i < b.length; i++) {
      if (b[i]! - b[i - 1]! <= 6 * FPS) continue;
      for (let f = b[i - 1]! + 6 * FPS; f < b[i]!; f++)
        expect([0, 1, 2, 3].every((k) => m[f + k] === 0)).toBe(false);
    }
  });

  it('doubles about 10% of the blinks', () => {
    const long = dialogue(400, 45, 15);
    const b = blinksOf(long, 400 * 60);
    const doubles = b.filter((x, i) => i > 0 && x - b[i - 1]! === BLINK_FRAMES + 3).length;
    const ratio = doubles / (b.length - doubles);
    expect(ratio).toBeGreaterThan(0.04);
    expect(ratio).toBeLessThan(0.18);
  });

  it('changing a line keeps every blink before it', () => {
    const j = 40;
    const changed = audio.map((a, i) => (i === j ? { ...a, contentKey: 'other' } : a));
    const after = blinksOf(changed, dur);
    const start = audio[j]!.startFrame;
    expect(after.filter((b) => b < start)).toEqual(blinks.filter((b) => b < start));
    // and the clock really depends on what is said
    const all = audio.map((a) => ({ ...a, contentKey: `x${a.contentKey}` }));
    expect(blinksOf(all, dur)).not.toEqual(blinks);
  });

  it('depends on the output and the scene', () => {
    expect(blinksOf(audio, dur, { output: 'shorts' })).not.toEqual(blinks);
    expect(blinksOf(audio, dur, { sceneId: 'two' })).not.toEqual(blinks);
  });

  it('adds a blink at a face change, unless a clock blink is within 1 s', () => {
    const quiet: A[] = [];
    const d = 30 * FPS;
    const base = blinksOf(quiet, d);
    const far = [...base, d].reduce(
      (best, b, i, all) => {
        const prev = i ? all[i - 1]! : 0;
        return b - prev > best.gap ? { gap: b - prev, at: Math.round((b + prev) / 2) } : best;
      },
      { gap: 0, at: 0 },
    );
    expect(far.gap).toBeGreaterThan(2 * FPS + 2);
    const withFace = blinksOf(quiet, d, { faceChanges: [far.at] });
    expect(withFace).toContain(far.at);
    expect(withFace.length).toBe(base.length + 1);
    const nearClock = blinksOf(quiet, d, { faceChanges: [base[0]! + 10] });
    expect(nearClock).toEqual(base);
  });
});

describe('blinkFrames spread', () => {
  it('varies the interval within one segment (no metronome)', () => {
    const b = blinksOf([], 60 * FPS);
    const gaps = b.slice(1).map((x, i) => (x - b[i]!) / FPS);
    const mean = gaps.reduce((a, x) => a + x, 0) / gaps.length;
    const sd = Math.sqrt(gaps.reduce((a, x) => a + (x - mean) ** 2, 0) / gaps.length);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeGreaterThan(2);
    expect(sd).toBeGreaterThan(0.6);
  });

  it('keeps face-change blinks apart from other blinks', () => {
    const d = 30 * FPS;
    const base = blinksOf([], d);
    const gap = base.findIndex((x, i) => i > 0 && x - base[i - 1]! > 4 * FPS);
    const at = base[gap - 1]! + 2 * FPS;
    const b = blinksOf([], d, { faceChanges: [at, at + 2] });
    for (let i = 1; i < b.length; i++)
      expect(b[i]! - b[i - 1]!).toBeGreaterThanOrEqual(BLINK_FRAMES + IDLE.blink.doubleGap);
    expect(b).toContain(at);
    expect(b).not.toContain(at + BLINK_FRAMES);
  });
});

describe('faces', () => {
  const audio: A[] = [
    { sentenceId: 's', cast: 'a', face: 'happy', startFrame: 10, durationFrames: 20 },
  ];

  it('holds a line face FACE_HOLD frames, a reaction wins when later', () => {
    expect(faceAt('a', 'neutral', 9, audio, [])).toBe('neutral');
    expect(faceAt('a', 'neutral', 10, audio, [])).toBe('happy');
    expect(faceAt('a', 'neutral', 30 + FACE_HOLD - 1, audio, [])).toBe('happy');
    expect(faceAt('a', 'neutral', 30 + FACE_HOLD, audio, [])).toBe('neutral');
    const r = [{ cast: 'a', face: 'sad', startFrame: 15, endFrame: 18 }];
    expect(faceAt('a', 'neutral', 16, audio, r)).toBe('sad');
  });

  it('falls back to the default face, then the first face of the art', () => {
    expect(drawnFace('happy', 'neutral', ['neutral', 'happy'])).toBe('happy');
    expect(drawnFace('angry', 'neutral', ['smile', 'neutral'])).toBe('neutral');
    expect(drawnFace('angry', 'neutral', ['smile', 'sad'])).toBe('smile');
  });

  it('reports changes of the drawn face only', () => {
    const input = { key: 'a', defaultFace: 'neutral', audio, reactions: [], durationFrames: 100 };
    expect(drawnFaceChanges({ ...input, available: ['neutral', 'happy'] })).toEqual([
      10,
      30 + FACE_HOLD,
    ]);
    expect(drawnFaceChanges({ ...input, available: ['neutral'] })).toEqual([]);
  });
});

describe('listenerNods', () => {
  const sw = (keys: string[], frame = -1000): StageSwitch => ({ frame, keys });
  const stage = { left: [sw(['a'])], right: [sw(['b'])] };
  const run = (audio: A[], over: Partial<Parameters<typeof listenerNods>[0]> = {}) =>
    listenerNods({
      sceneId: 'one',
      output: 'youtube',
      durationFrames: Math.max(...audio.map((a) => a.startFrame + a.durationFrames)) + 60,
      audio,
      reactions: [],
      motions: [],
      stage,
      hasHead: () => false,
      ...over,
    });
  // Long gaps so the listener is never about to speak.
  const many = dialogue(600, 40, 40);
  const nods = run(many);

  it('nods the listener at the end of the other side’s line, by chance (IDLE.nod.pct), every second line at most', () => {
    expect(nods.length).toBeGreaterThan(0);
    for (const n of nods) {
      const line = many.find((a) => a.startFrame + a.durationFrames === n.frame)!;
      expect(line.cast).not.toBe(n.cast);
      expect(n).toMatchObject({ head: false, length: IDLE.nod.body });
    }
    for (const cast of ['a', 'b']) {
      const own = nods.filter((n) => n.cast === cast).map((n) => n.frame);
      const lines = many.filter((a) => a.cast !== cast).map((a) => a.startFrame + a.durationFrames);
      for (let i = 1; i < own.length; i++)
        expect(lines.filter((e) => e > own[i - 1]! && e <= own[i]!).length).toBeGreaterThanOrEqual(
          2,
        );
    }
    // chance p with one line of rest after a nod: p / (1 + p) of a listener's candidate lines
    const p = IDLE.nod.pct / 100;
    expect(Math.abs(nods.length / 600 - p / (1 + p))).toBeLessThan(0.07);
    expect(run(many)).toEqual(nods);
  });

  it('never nods after a question', () => {
    const q = many.map((a) => ({ ...a, question: true }));
    expect(run(q)).toEqual([]);
  });

  it('skips a listener who reacts, holds a motion, speaks or is about to speak', () => {
    const n = nods[0]!;
    expect(
      run(many, {
        reactions: [{ cast: n.cast, face: 'x', startFrame: n.frame - 5, endFrame: n.frame }],
      }),
    ).not.toContainEqual(n);
    expect(
      run(many, {
        motions: [{ cast: n.cast, motion: 'lean', startFrame: n.frame - 5, endFrame: n.frame - 1 }],
      }),
    ).not.toContainEqual(n);
    expect(
      run(many, {
        motions: [{ cast: n.cast, motion: 'jump', startFrame: n.frame - 5, endFrame: n.frame - 1 }],
      }),
    ).toContainEqual(n);
    const soon = many.map((a) =>
      a.cast === n.cast && a.startFrame === n.frame + 40 ? { ...a, startFrame: n.frame + 10 } : a,
    );
    expect(run(soon)).not.toContainEqual(n);
  });

  it('skips a listener speaking at the end, or reacting from within the nod', () => {
    const n = nods[0]!;
    const talking = many.map((a) =>
      a.cast === n.cast && a.startFrame === n.frame + 40
        ? { ...a, startFrame: n.frame - 5, durationFrames: 30 }
        : a,
    );
    expect(run(talking)).not.toContainEqual(n);
    expect(
      run(many, {
        reactions: [{ cast: n.cast, face: 'x', startFrame: n.frame + 8, endFrame: n.frame + 30 }],
      }),
    ).not.toContainEqual(n);
  });

  it('never overlaps two nods of one listener', () => {
    // a talks in very short sentences: line spacing alone would let b nod every 8 frames
    const short = dialogue(400, 4, 0, () => ({ cast: 'a' }));
    const fast = run(short.map((a, i) => ({ ...a, startFrame: i * 4 })));
    const own = fast.filter((x) => x.cast === 'b');
    expect(own.length).toBeGreaterThan(5);
    for (let i = 1; i < own.length; i++)
      expect(own[i]!.frame).toBeGreaterThanOrEqual(own[i - 1]!.frame + own[i - 1]!.length);
  });

  it('skips a listener stepping in or out, and a nod the scene end would cut', () => {
    const n = nods[0]!;
    const side = n.cast === 'a' ? 'left' : 'right';
    const out = { ...stage, [side]: [sw([n.cast]), sw(['c'], n.frame + 5)] };
    expect(run(many, { stage: out })).not.toContainEqual(n);
    const into = { ...stage, [side]: [sw(['c']), sw([n.cast], n.frame - 3)] };
    expect(run(many, { stage: into })).not.toContainEqual(n);
    expect(run(many, { durationFrames: n.frame + 10 }).some((x) => x.frame === n.frame)).toBe(
      false,
    );
  });

  it('skips a listener sliding in (an entrance takes STAGE_SLIDE frames, not STAGE_LEAD)', () => {
    const n = nods[0]!;
    const side = n.cast === 'a' ? 'left' : 'right';
    const at = n.frame - 12; // past STAGE_LEAD, inside STAGE_SLIDE
    const rising = { ...stage, [side]: [sw([]), sw([n.cast], at)] };
    expect(run(many, { stage: rising })).toContainEqual(n);
    const sliding = {
      ...stage,
      [side]: [sw([]), { ...sw([n.cast], at), move: { key: n.cast, kind: 'enter' as const } }],
    };
    expect(run(many, { stage: sliding })).not.toContainEqual(n);
  });

  it('skips a nod that would still run when its listener slides out', () => {
    const n = nods[0]!;
    const side = n.cast === 'a' ? 'left' : 'right';
    const leaving = {
      ...stage,
      [side]: [
        sw([n.cast]),
        { ...sw([], n.frame + 5), move: { key: n.cast, kind: 'exit' as const } },
      ],
    };
    expect(run(many, { stage: leaving })).not.toContainEqual(n);
  });

  it('uses the head nod (24 frames) when the listener has a head layer', () => {
    const h = run(many, { hasHead: () => true });
    expect(h.map((x) => x.frame)).toEqual(nods.map((x) => x.frame));
    expect(h[0]).toMatchObject({ head: true, length: IDLE.nod.head });
  });

  it('lets each member of a reacting group nod on its own', () => {
    const group = { left: [sw(['a', 'c'])], right: [sw(['b'])] };
    const g = run(many, { stage: group });
    expect(g.some((x) => x.cast === 'c')).toBe(true);
  });
});

describe('breath', () => {
  const at = (frame: number, speaking = 0, cast = 'a') =>
    breath({
      cast,
      output: 'youtube',
      sceneId: 'one',
      frame,
      fps: FPS,
      durationFrames: 900,
      speaking,
    });

  it('stays within 0–0.6%, halves while speaking, and is 0 at the scene edges', () => {
    let max = 0;
    for (let f = 0; f < 900; f++) {
      const b = at(f);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(IDLE.breath.amplitude);
      expect(at(f, 1)).toBeCloseTo(b / 2, 12);
      max = Math.max(max, b);
    }
    expect(max).toBeGreaterThan(IDLE.breath.amplitude * 0.9);
    expect(at(0)).toBe(0);
    expect(at(899)).toBe(0);
  });

  it('has a 3.5–4.5 s period per character', () => {
    for (const cast of ['a', 'b', 'c', 'd']) {
      const xs = Array.from({ length: 600 }, (_, f) => at(100 + f, 0, cast));
      const peaks = xs.flatMap((x, i) =>
        i > 0 && i < 599 && x > xs[i - 1]! && x >= xs[i + 1]! ? [i] : [],
      );
      for (let i = 1; i < peaks.length; i++) {
        const T = (peaks[i]! - peaks[i - 1]!) / FPS;
        expect(T).toBeGreaterThanOrEqual(3.4);
        expect(T).toBeLessThanOrEqual(4.6);
      }
    }
  });
});

describe('chunkKey', () => {
  it('changes with idle and the output name', async () => {
    const { chunkKey } = await import('../src/index.js');
    const scene = {
      id: 'one',
      title: '',
      startFrame: 0,
      durationFrames: 30,
      visuals: [],
      audio: [],
      cues: [],
      subtitles: [],
      reactions: [],
      motions: [],
      framing: {},
    };
    const opts = (idle: boolean | undefined, output: string) => ({
      timeline: { fps: 30, lang: 'ko' as const, output, totalFrames: 30, scenes: [scene] },
      aspect: '16:9' as const,
      assetsRoot: '.',
      fontsDir: '.',
      workDir: '.',
      ...(idle === undefined ? {} : { idle }),
    });
    const key = (idle: boolean | undefined, output = 'youtube') =>
      chunkKey(scene, opts(idle, output), {}, null);
    expect(key(undefined)).toBe(key(true));
    expect(key(false)).not.toBe(key(true));
    expect(key(true, 'shorts')).not.toBe(key(true));
  });
});

describe('looks (acting stage 5b)', () => {
  const audio: A[] = [
    { sentenceId: 's', cast: 'b', face: 'happy', startFrame: 100, durationFrames: 30 },
  ];
  const look = (startFrame: number, endFrame: number, face: string, hold?: true) => ({
    cast: 'b',
    face,
    startFrame,
    endFrame,
    ...(hold ? { hold } : {}),
  });

  it('shows the most recent of lines, reactions and looks; a look ended by another is not held', () => {
    const looks = [look(10, 40, 'front-neutral'), look(40, 60, 'glance-neutral', true)];
    expect(faceAt('b', 'neutral', 9, audio, [], looks)).toBe('neutral');
    expect(faceAt('b', 'neutral', 39, audio, [], looks)).toBe('front-neutral');
    expect(faceAt('b', 'neutral', 40, audio, [], looks)).toBe('glance-neutral');
    expect(faceAt('b', 'neutral', 60 + FACE_HOLD - 1, audio, [], looks)).toBe('glance-neutral');
    expect(faceAt('b', 'neutral', 60 + FACE_HOLD, audio, [], looks)).toBe('neutral');
    // its own line is more recent than the look
    expect(faceAt('b', 'neutral', 100, audio, [], [look(90, 120, 'front-neutral', true)])).toBe(
      'happy',
    );
    // a not-held look stops at its end
    expect(faceAt('b', 'neutral', 39, audio, [], [look(10, 40, 'front-neutral')])).toBe(
      'front-neutral',
    );
    expect(faceAt('b', 'neutral', 40, audio, [], [look(10, 40, 'front-neutral')])).toBe('neutral');
  });

  it('blinks when a look changes the drawn face', () => {
    const changes = drawnFaceChanges({
      key: 'b',
      defaultFace: 'neutral',
      available: ['neutral', 'front-neutral'],
      audio: [],
      reactions: [],
      looks: [look(10, 40, 'front-neutral')],
      durationFrames: 100,
    });
    expect(changes).toEqual([10, 40]);
  });
});
